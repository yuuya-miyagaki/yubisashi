// イベントの受け口。判断は core.js、ブラウザ側は relay/ に任せ、ここは Claude Code とのやり取りだけを書く
import {
  READY_MS, STALL_MS, STALL_CHECK_MS, KEY_LENGTH, GUIDE_HEAD, WRITE_TOOLS, CHOICE_OPEN, CHOICE_STOP, CHOICE_KEEP,
  USAGE, MSG, parseArgs, expandPath, newMark, keyFromBytes, findMarks, nextDraftNumber, draftSeparator, headOf,
  relPath, isPersonOrigin, targetName, startedText, failedText, relayDownText, statusReport,
  buildRequest, buildDraft, buildReply, judgeAnswer, statusBody, splitLines,
  SURVEY_MS, relDir, notHtmlText, noPageText, surveyFailedText, startChoices, choiceOf, rememberLast, lastOf, parseSurvey,
} from './core.js'

const YUBI_COMMAND = {
  name: 'yubi',
  description: '指差し：ブラウザで部品を選んで UI の直しを頼む（/yubi だけで選べる・/yubi 3000・/yubi ./site・file:/// も可・/yubi 止める）',
  argumentHint: '[番号|フォルダ|HTML|file:///…|止める]（なしなら選ぶ）',
  immediate: true,
}
const TEMPLATE_NAMES = ['request', 'draft', 'guide']
const LAST_KEY = 'last'

// 人がいない実行（claude -p・SDK）か
let headless = false
let home = ''
let root = ''
// 会話の名前（届け先の表示に使う）
let title = ''
// このターミナルの合言葉。最初の /yubi で作り、中継役を起こし直しても変えない
let key = null
// 動いている中継役（{ port, socket, mode, target, root, label, stream }）。無ければ null
let relay = null
// ready を待っている中継役の流れ
let starting = null
// 中継役の世代。止めた・付け替えたら進め、古い流れの知らせは捨てる
let relayGen = 0
// 文の型（{ request, draft, guide }）
let tpl = null
// この会話で出した印（印 → { head }）。/clear で空にする
let marks = new Map()
// 送る前の依頼の列（{ mark, head, text }）
let queue = []
// 送ったがまだ始まっていない依頼の印
let inFlight = null
// Claude が作業中か（turn.start で true、本筋の turn.complete で false）
let busy = false
// 見張っている作業（{ turnId, mark, edited, seenAt }）
let watching = null
// 答えの無い許可の一覧（{ agent, tool, key }）。道具の呼び出しが終わるたびに、当たるものを1つ外す
let pending = []
// 選択肢（AskUserQuestion）の画面が出ているか
let askOpen = false
let stallTimer = null
// 前に開いたブラウザの場所（同じ場所なら開き直さない）
let lastOpened = null
// 送った依頼を送った時刻（始まらないまま止まったときの回復に使う）
let inFlightAt = 0
// 最後に送った丸の状態（待ちの数を変えて送り直すため）
let lastView = { state: 'idle' }
// 直前の質問の選択肢（返事の番号から文を作るため）
let lastChoices = []
// ブラウザに質問が出ているか（出ている間は待ちの依頼を送らない。次の作業が始まったら閉じる）
let questionOpen = false
let stats = { pages: 0, sent: 0 }

export function register(on) {
  on('session.start', async ($, e, next) => {
    headless = e.isInteractive === false
    await registerCommand($)
    try { home = (await $.env.get('HOME')) ?? '' } catch { home = '' }
    resetWatch()
    return next(e)
  })
  // /clear の後も /yubi を使えるように、SessionStart（/clear のときも来る）で登録し直す
  on('classic.SessionStart', async ($, e, next) => {
    await registerCommand($)
    if (typeof e.session_title === 'string') title = e.session_title
    return next(e)
  })
  on('classic.UserPromptSubmit', ($, e, next) => {
    if (typeof e.session_title === 'string') title = e.session_title
    return next(e)
  })
  // /clear・/resume は同じ窓の別の会話（印を忘れる）。それ以外は窓を閉じた（中継役を止める）
  on('session.end', ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      title = ''
      marks = new Map()
      queue = []
      lastChoices = []
      resetWatch()
      later($, () => push($, { state: 'idle' }))
    } else {
      stopRelay()
    }
    return next(e)
  })
  on('command.run', { command: 'yubi' }, ($, e) => runCommand($, e))
  // 使う人が下書きを Enter で送ったら、進め方を1回だけ添える（文は変えない）
  on('prompt.submit', ($, e, next) => {
    const text = String(e.text ?? '')
    if (!tpl || !isPersonOrigin(e.origin)) return next(e)
    if (findMarks(text, marks).length === 0 || text.includes(GUIDE_HEAD)) return next(e)
    return next({ ...e, context: [...(e.context ?? []), String(tpl.guide).trim()] })
  })
  on('turn.start', ($, e, next) => {
    later($, () => onTurnStart($, e))
    return next(e)
  })
  // 許可の画面。結果は変えない（AskUserQuestion の画面は tool.call で拾う）
  on('classic.PermissionRequest', ($, e, next) => {
    if (watching && e.tool_name !== 'AskUserQuestion') {
      pending.push({ agent: e.agent_id ?? '', tool: e.tool_name, key: callKey(e.tool_input) })
      later($, () => onLook($))
    }
    return next(e)
  })
  // 道具は見るだけ。受け取った答えをそのまま返す
  on('tool.call', async ($, e, next) => {
    const w = watching
    if (w) {
      w.running += 1
      if (e.tool === 'AskUserQuestion' && !e.agentId) {
        askOpen = true
        later($, () => onLook($))
      } else {
        later($, () => touch($))
      }
    }
    let result
    try {
      result = await next(e)
    } finally {
      if (w && watching === w) {
        w.running = Math.max(0, w.running - 1)
        const was = isLooking()
        if (e.tool === 'AskUserQuestion' && !e.agentId) askOpen = false
        const rest = dropPending(pending, { agent: e.agentId ?? '', tool: e.tool, key: callKey(e) })
        if (rest !== null) pending = rest
        const resume = was && !isLooking()
        later($, () => onToolDone($, e, result, resume))
      }
    }
    return result
  })
  on('turn.complete', async ($, e, next) => {
    try {
      return await next(e)
    } finally {
      if (!e.agentId) later($, () => onTurnComplete($, e))
    }
  })
}

function later($, fn) {
  $.clock.after(0, () => { void Promise.resolve().then(fn).catch(() => {}) })
}

function reasonOf(err) {
  const text = String((err && err.message) || err || '').slice(0, 120)
  return text || '理由不明'
}

async function registerCommand($) {
  try {
    await $.command.register(YUBI_COMMAND)
  } catch {
    // 断られても会話は止めない
  }
}

function stopStall() {
  if (stallTimer) { stallTimer.cancel(); stallTimer = null }
}

function resetWatch() {
  watching = null
  pending = []
  askOpen = false
  inFlight = null
  inFlightAt = 0
  busy = false
  questionOpen = false
}

function isLooking() {
  return pending.length > 0 || askOpen
}

// board と同じ見分け方：道具の呼び出しの「要の値」
function callKey(input) {
  if (input === null || typeof input !== 'object') return ''
  for (const k of ['file_path', 'command', 'notebook_path', 'url']) {
    if (typeof input[k] === 'string') return input[k]
  }
  return ''
}

// 許可の一覧から、終わった呼び出しに当たるものを1つ外した一覧。当たるものが無ければ null
function dropPending(list, done) {
  let i = list.findIndex(p => p.agent === done.agent && p.tool === done.tool && p.key === done.key)
  if (i < 0) i = list.findIndex(p => p.agent === done.agent && p.tool === done.tool)
  return i < 0 ? null : [...list.slice(0, i), ...list.slice(i + 1)]
}

function noStartText(err) {
  const why = reasonOf(err)
  return /ENOENT|not found/i.test(why) ? MSG.noNode : failedText(why)
}

// ---- /yubi ----

async function runCommand($, e) {
  if (headless) return { text: MSG.headless }
  return runArgs($, e.args)
}

// /yubi の引数（と、選ぶ画面の「その他」に書いた文）を読んで動く
async function runArgs($, raw) {
  const a = parseArgs(raw)
  if (a.kind === 'usage') return { text: USAGE }
  if (a.kind === 'https') return { text: MSG.https }
  if (a.kind === 'remote') return { text: MSG.remote }
  if (a.kind === 'stop') {
    if (!relay && !starting) return { text: MSG.notRunning }
    stopRelay()
    return { text: MSG.stopped }
  }
  if (a.kind === 'status') {
    if (relay) return showStatus($)
    const base = await $.session.root()
    return chooseStart($, { dir: base, withServers: true, withLast: true, emptyText: noPageText(folderName(base)) })
  }
  if (a.kind === 'port') {
    if (relay && a.port === relay.port) return { text: MSG.loop }
    return startRelay($, { target: a.port, open: '/' })
  }
  return startFromPath($, a.alt ? [a.path, a.alt] : [a.path])
}

// 元の文字のパスから探し、無ければ読み替えたパス（alt）で探す
async function startFromPath($, paths) {
  const base = await $.session.root()
  let full = ''
  let st = null
  for (const p of paths) {
    full = expandPath(p, base, home)
    try { st = await $.fs.stat(full) } catch { st = null }
    if (st) break
  }
  if (st && st.kind === 'dir') {
    if (!(await $.fs.exists(`${full}/index.html`))) {
      return chooseStart($, { dir: full, head: MSG.noIndexPick, emptyText: `${MSG.noHtmlIn}${emptyDirName(full, base)}` })
    }
    return startRelay($, { root: full, open: '/', page: `${full}/index.html` })
  }
  if (st && st.kind === 'file' && /\.html?$/i.test(full)) return openFile($, full)
  if (st && st.kind === 'file') {
    // HTML でない物（提案書の .md など）は、同じフォルダの HTML から選ぶ（§22-4）
    const cut = full.lastIndexOf('/')
    const dir = full.slice(0, cut) || '/'
    return chooseStart($, { dir, head: notHtmlText(full.slice(cut + 1).normalize('NFC')), emptyText: `${MSG.noHtmlIn}${emptyDirName(dir, base)}` })
  }
  // 探したパスを見せる（どう読んだかが分からないと、打ち直し方が分からない）
  if (!st) return { text: `${MSG.notFound}${expandPath(paths[0], base, home)}\n\n${USAGE}` }
  return { text: USAGE }
}

// .html のファイルを開く（そのファイルのフォルダを配る）
function openFile($, full) {
  const cut = full.lastIndexOf('/')
  return startRelay($, { root: full.slice(0, cut) || '/', open: '/' + encodeURIComponent(full.slice(cut + 1)), page: full })
}

// 空のときの文に出すフォルダ。作業フォルダそのものなら、その名前（'.' では分かりにくい）
function emptyDirName(dir, base) {
  const r = relDir(dir, base, home)
  return r === '.' ? folderName(base) : r
}

function folderName(p) {
  return (String(p).replace(/\/+$/, '').split('/').pop() || String(p)).normalize('NFC')
}

// 選ぶ画面で開くページを決める（§22-3・22-4）。dir の中を探す。head は問いの頭の一言（HTML でないときなど）
async function chooseStart($, { dir, head = '', withServers = false, withLast = false, emptyText }) {
  const base = await $.session.root()
  const got = await runSurvey($, dir, withServers)
  if (got.error) return { text: `${surveyFailedText(got.error)}\n\n${USAGE}` }
  let last = null
  if (withLast) {
    last = lastOf(await readLast($), base)
    if (last && last.kind === 'file') {
      let st = null
      try { st = await $.fs.stat(last.path) } catch { st = null }
      if (!st || st.kind !== 'file') last = null
    }
  }
  const choices = startChoices({ head, last, servers: got.servers, files: got.files, cut: got.cut, root: base, home })
  if (!choices) return { text: `${emptyText}\n\n${USAGE}` }
  let answer = null
  try {
    answer = await $.ui.ask(choices.question, { header: '指差し', options: choices.options })
  } catch {
    answer = null
  }
  const pick = choiceOf(answer, choices)
  if (pick.kind === 'cancel') return { text: MSG.cancelled }
  if (pick.kind === 'port') return startRelay($, { target: pick.port, open: '/' })
  if (pick.kind === 'file') return openFile($, pick.path)
  return runArgs($, pick.text)
}

// survey.mjs を呼ぶ。3秒で待つのをやめる（命令は2秒で自分で終わる）
async function runSurvey($, dir, withServers) {
  const argv = ['node', `${$.plugin.root}/relay/survey.mjs`, '--root', dir, withServers ? '--servers' : '--no-servers']
  const timeout = new Promise(resolve => {
    $.clock.after(SURVEY_MS, () => resolve({ error: '3秒以内に答えがありませんでした' }))
  })
  const run = (async () => {
    try {
      const r = await $.process.run(argv, { cwd: dir, timeoutMs: SURVEY_MS })
      const o = parseSurvey(r && r.stdout)
      if (o) return o
      const why = r && r.exitCode !== 0 && String((r && r.stderr) || '').trim() ? crashReason(r.stderr) : ''
      return { error: why ? reasonOf(why) : '答えが読めませんでした' }
    } catch (err) {
      const why = reasonOf(err)
      return { error: /ENOENT|not found/i.test(why) ? 'Node が見つかりません' : why }
    }
  })()
  return Promise.race([run, timeout])
}

async function readLast($) {
  try {
    return await $.store.get(LAST_KEY)
  } catch {
    return null
  }
}

// 前回のページを書く（作業フォルダごと）。書けなくても始めることは止めない
async function rememberPage($, opt) {
  const entry = opt.target ? { kind: 'port', port: opt.target } : opt.page ? { kind: 'file', path: opt.page } : null
  if (!entry) return
  try {
    await $.store.set(LAST_KEY, rememberLast(await readLast($), root, entry, await $.clock.now()))
  } catch {
    // 前回を覚えられないだけ
  }
}

// 元のフォルダ（~/claude-mods/yubisashi/template）を先に読み、無ければ読み込まれた場所の template を読む
async function loadTemplates($) {
  const dirs = []
  if (home) dirs.push(`${home}/claude-mods/yubisashi/template`)
  const pluginRoot = $.plugin.root
  if (pluginRoot) dirs.push(`${pluginRoot}/template`)
  for (const dir of dirs) {
    const got = {}
    for (const name of TEMPLATE_NAMES) {
      try {
        const t = await $.fs.read(`${dir}/${name}.md`)
        if (typeof t === 'string' && t.trim()) got[name] = t
      } catch {
        // 次の場所を読む
      }
    }
    if (TEMPLATE_NAMES.every(n => got[n])) return got
  }
  return null
}

function randomKey() {
  const bytes = new Array(KEY_LENGTH)
  if (typeof crypto !== 'undefined' && crypto && typeof crypto.getRandomValues === 'function') {
    const buf = new Uint8Array(KEY_LENGTH)
    crypto.getRandomValues(buf)
    for (let i = 0; i < KEY_LENGTH; i++) bytes[i] = buf[i]
  } else {
    for (let i = 0; i < KEY_LENGTH; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  return keyFromBytes(bytes)
}

async function openBrowser($, url) {
  try {
    const r = await $.process.run(['open', url])
    return !r || r.exitCode === 0
  } catch {
    return false
  }
}

async function startRelay($, opt) {
  const loaded = await loadTemplates($)
  if (!loaded) return { text: MSG.noTemplate }
  tpl = loaded
  root = await $.session.root()
  if (!key) key = randomKey()
  stopRelay()
  const gen = relayGen
  const argv = ['node', `${$.plugin.root}/relay/relay.mjs`, '--key', key]
  if (opt.target) argv.push('--target', String(opt.target))
  else argv.push('--root', opt.root)
  let settle = () => {}
  const ready = new Promise(resolve => { settle = resolve })
  let stream
  try {
    stream = $.process.spawn({ argv, cwd: root })
  } catch (err) {
    return { text: noStartText(err) }
  }
  starting = { stream }
  void readRelay($, stream, gen, settle)
  $.clock.after(READY_MS, () => settle({ type: 'timeout' }))
  const msg = await ready
  if (gen !== relayGen) return { text: failedText('別の /yubi で付け替えました') }
  if (msg.type !== 'ready') {
    stopRelay()
    if (msg.type === 'nostart' || msg.type === 'ended') return { text: noStartText(msg.message) }
    if (msg.type === 'error' && msg.where === 'loop') return { text: MSG.loop }
    if (msg.type === 'timeout') return { text: failedText('5秒以内に応答がありませんでした') }
    return { text: failedText(String(msg.message ?? '理由不明')) }
  }
  starting = null
  const r = {
    port: msg.port, socket: msg.socket, mode: msg.mode, target: msg.target, root: msg.root, stream,
    label: msg.mode === 'proxy' ? String(msg.target) : relPath(msg.root, root, home),
  }
  relay = r
  stats = { pages: 0, sent: 0 }
  startStall($)
  // 同じ場所なら開き直さない（前のタブが自分でつなぎ直す）
  const page = opt.open ?? '/'
  let opened = true
  const place = { port: msg.port, path: page, mode: msg.mode, target: msg.target, root: msg.root }
  if (!lastOpened || Object.keys(place).some(k => lastOpened[k] !== place[k])) {
    opened = await openBrowser($, `http://localhost:${msg.port}${page}`)
    if (opened) lastOpened = place
  }
  if (gen !== relayGen) return { text: failedText('別の /yubi か止める操作で付け替えました') }
  later($, () => push($, { state: 'idle' }))
  await rememberPage($, opt)
  return { text: startedText(r, opened) }
}

// 落ちた理由の1行。Node の最後の行（Node.js v…）は飛ばし、Error を含む最初の行を選ぶ
function crashReason(text) {
  const lines = String(text).split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('Node.js v'))
  // 行頭が Error の行（Error: …・TypeError [CODE]: …）を先に探す。コードの抜粋（throw new Error(…)）は後回し
  return lines.find(l => /^[\w.]*Error\b/.test(l)) ?? lines.find(l => /Error\b/.test(l)) ?? lines[lines.length - 1] ?? '理由不明'
}

// 中継役の標準出力を読む。ready（か起動前の error）は settle へ、それ以外は onRelayMessage へ
async function readRelay($, stream, gen, settle) {
  let rest = ''
  let tail = ''
  let pulled = false
  try {
    outer: for await (const chunk of stream) {
      pulled = true
      if (gen !== relayGen) break
      if (chunk.stream === 'stderr') { tail = (tail + chunk.text).slice(-2000); continue }
      const out = splitLines(rest, chunk.text)
      rest = out.rest
      for (const msg of out.items) {
        if (gen !== relayGen) break outer
        if (msg.type === 'ready' || (msg.type === 'error' && !relay)) { settle(msg); continue }
        // 1件の失敗で読む流れを終えない（終えると中継役が止まる）
        try {
          await onRelayMessage($, msg)
        } catch (err) {
          await onMessageFailed($, msg, err)
        }
      }
    }
  } catch (err) {
    if (!pulled) { settle({ type: 'nostart', message: reasonOf(err) }); return }
    tail = tail || reasonOf(err)
  }
  const why = crashReason(tail)
  settle({ type: 'ended', message: why })
  // 自分で止めたのではないのに流れが終わった＝中継役が落ちた
  if (gen === relayGen && relay) {
    relay = null
    queue = []
    resetWatch()
    stopStall()
    try { $.ui.toast(relayDownText(why)) } catch { /* 知らせられなくても止めない */ }
  }
}

async function onMessageFailed($, msg, err) {
  const reason = reasonOf(err)
  if (msg.type === 'pick' || msg.type === 'reply') {
    const kind = msg.type === 'reply' ? 'reply' : (msg.kind === 'draft' ? 'draft' : 'send')
    await sendRelay($, '/ack', { v: 1, type: 'ack', kind, ok: false, reason })
  }
  // 質問が出ている間は質問の表示を残す（送ったものの失敗は ack の理由でブラウザに出る）
  if (questionOpen) return
  try {
    await push($, { state: 'stopped', text: `Mod の中でエラー（${reason}）` })
  } catch {
    // 知らせられなくても読む流れは続ける
  }
}

function stopRelay() {
  relayGen += 1
  stopStall()
  for (const s of [relay && relay.stream, starting && starting.stream]) {
    if (!s || typeof s.return !== 'function') continue
    try {
      void Promise.resolve(s.return(undefined)).catch(() => {})
    } catch {
      // 止められなくても進める（流れを終えると子のプログラムも止まる）
    }
  }
  relay = null
  starting = null
  queue = []
  resetWatch()
}

async function showStatus($) {
  const report = statusReport(relay, { ...stats, waiting: waitingCount() }, targetName(title, root))
  let choice = null
  try {
    choice = await $.ui.ask(`${report}\n\nどうしますか？`, { header: '指差し', options: [CHOICE_OPEN, CHOICE_STOP, CHOICE_KEEP] })
  } catch {
    choice = null
  }
  if (choice === CHOICE_STOP) { stopRelay(); return { text: MSG.stopped } }
  if (choice === CHOICE_OPEN && relay) {
    const opened = await openBrowser($, `http://localhost:${relay.port}/`)
    return { text: opened ? report : `${report}\nブラウザで http://localhost:${relay.port}/ を開いてください。` }
  }
  return { text: report }
}

// ---- 中継役からの知らせ ----

async function onRelayMessage($, msg) {
  if (!relay) return
  if (msg.type === 'pick') return onPick($, msg)
  if (msg.type === 'reply') return onReply($, msg)
  if (msg.type === 'page') { stats.pages += 1; return }
  if (msg.type === 'error') {
    try { $.ui.toast(`指差し：${String(msg.message ?? '').slice(0, 120)}`) } catch { /* 知らせられなくても止めない */ }
  }
}

async function onPick($, msg) {
  const ctx = { root, home }
  const mark = newMark(Math.random, marks)
  const head = headOf(msg.words)
  if (msg.kind === 'draft') {
    let box = ''
    try { box = (await $.prompt.read()).text ?? '' } catch { box = '' }
    const text = draftSeparator(box) + buildDraft(msg, ctx, tpl, mark, nextDraftNumber(box))
    let ok = false
    let reason = '入力欄に入れられませんでした'
    try {
      const r = await $.prompt.fill({ text, mode: 'append' })
      ok = Boolean(r && r.isFilled)
      if (!ok && r && r.refusal === 'dialog') reason = '選ぶ画面が開いています'
    } catch (err) {
      reason = reasonOf(err)
    }
    if (ok) marks.set(mark, { head })
    return sendRelay($, '/ack', ok ? { v: 1, type: 'ack', kind: 'draft', ok } : { v: 1, type: 'ack', kind: 'draft', ok, reason })
  }
  marks.set(mark, { head })
  queue.push({ mark, head, text: buildRequest(msg, ctx, tpl, mark) })
  await sendRelay($, '/ack', { v: 1, type: 'ack', kind: 'send', ok: true })
  await refreshWaiting($)
  later($, () => sendNext($))
}

async function onReply($, msg) {
  // 質問が閉じた後の返事（ターミナルで答えた後の古いタブ・2回目の返事）は受け付けない
  if (!questionOpen) return sendRelay($, '/ack', { v: 1, type: 'ack', kind: 'reply', ok: false, reason: MSG.closed })
  const mark = newMark(Math.random, marks)
  const chosen = lastChoices.find(c => c.n === msg.choice)
  const head = headOf(msg.words ?? '') || (chosen ? headOf(chosen.label) : '確認への返事')
  marks.set(mark, { head })
  // 質問への返事は、質問の間に並んだ依頼より先に送る
  queue.unshift({ mark, head, text: buildReply(msg, lastChoices, mark) })
  questionOpen = false
  await sendRelay($, '/ack', { v: 1, type: 'ack', kind: 'reply', ok: true })
  await refreshWaiting($)
  later($, () => sendNext($))
}

// ---- 送る・見張る ----

// Claude が空いていて、送ったばかりの依頼も無ければ、列の先頭を本人の依頼として送る
async function sendNext($) {
  if (!relay || busy || inFlight || questionOpen || queue.length === 0) return
  const item = queue.shift()
  inFlight = item.mark
  inFlightAt = 0
  stats.sent += 1
  await refreshWaiting($)
  let why = null
  try {
    inFlightAt = await $.clock.now()
    const r = await $.prompt.submit({ text: item.text, asUser: true })
    if (r && r.drop) why = String(r.drop)
  } catch (err) {
    why = reasonOf(err)
  }
  if (why !== null) {
    if (inFlight === item.mark) { inFlight = null; inFlightAt = 0 }
    await push($, { state: 'stopped', text: `送れませんでした：${why}`, head: item.head })
    later($, () => sendNext($))
  }
}

function startStall($) {
  stopStall()
  stallTimer = $.clock.every(STALL_CHECK_MS, () => { void checkStall($).catch(() => {}) })
}

// 動いている中継役がある間、30秒ごとに確かめる。
// 見張っている作業：道具が動いている間・許可の画面が出ている間は止まりにしない。
//   それ以外で5分、道具の呼び出しも許可の画面も無ければ見張りを外して次へ進める
// 送ったのに始まらない依頼：5分たっても見張りが始まらなければ外して次へ進める
async function checkStall($) {
  if (!relay) { stopStall(); return }
  const now = await $.clock.now()
  if (watching) {
    if (watching.running > 0 || isLooking()) return
    if (now - watching.seenAt < STALL_MS) return
    const head = marks.get(watching.mark)?.head
    resetWatch()
    await push($, { state: 'stopped', text: MSG.lost, head })
    later($, () => sendNext($))
    return
  }
  if (inFlight && inFlightAt && now - inFlightAt >= STALL_MS) {
    const head = marks.get(inFlight)?.head
    inFlight = null
    inFlightAt = 0
    await push($, { state: 'stopped', text: MSG.lost, head })
    later($, () => sendNext($))
  }
}

async function onTurnStart($, e) {
  busy = true
  // 質問の後に次の作業が始まった（ターミナルで答えた・ほかの依頼）。ブラウザの質問を閉じる。
  // 文字の無い作業（続き・知らせ）は本人の答えではないので閉じない
  const closed = questionOpen && String(e.text ?? '').trim() !== ''
  if (closed) { questionOpen = false; lastChoices = [] }
  // 前の作業の終わりを受け取れなかった
  const lost = watching && watching.turnId !== e.turnId ? watching : null
  if (lost) {
    watching = null
    pending = []
    askOpen = false
  }
  // await より前に見張りを立てる（知らせ・時刻を待つ間に turn.complete が来ても結果を逃さない）。
  // 時刻が分かるまでは seenAt を Infinity にして、止まりと数えない
  const mine = findMarks(e.text, marks)
  let w = null
  if (mine.length > 0) {
    if (inFlight && mine.includes(inFlight)) { inFlight = null; inFlightAt = 0 }
    queue = queue.filter(q => !mine.includes(q.mark))
    w = { turnId: e.turnId, mark: mine[mine.length - 1], edited: false, seenAt: Infinity, running: 0 }
    watching = w
    pending = []
    askOpen = false
  }
  if (lost) await push($, { state: 'stopped', text: MSG.lost, head: marks.get(lost.mark)?.head })
  if (!w) {
    if (closed) { lastView = { state: 'idle' }; await refreshWaiting($) }
    return
  }
  const now = await $.clock.now()
  // 待つ間に turn.complete が来た（結果はそちらで出した）か、次の作業に移った
  if (watching !== w) return
  w.seenAt = now
  // 待つ間に許可の画面が出ていれば、そちらの表示のままにする
  await push($, { state: isLooking() ? 'look' : 'working', head: marks.get(w.mark)?.head })
}

async function touch($) {
  if (watching) watching.seenAt = await $.clock.now()
}

async function onLook($) {
  if (!watching) return
  watching.seenAt = await $.clock.now()
  await push($, { state: 'look', head: marks.get(watching.mark)?.head })
}

// 道具の呼び出しが終わった。許可の画面・質問の画面が全部片づいたとき（resume）だけ作業中に戻す
async function onToolDone($, e, result, resume) {
  if (!watching) return
  watching.seenAt = await $.clock.now()
  if (WRITE_TOOLS.includes(e.tool) && result && result.deny === undefined && result.isError !== true) watching.edited = true
  if (resume) await push($, { state: 'working', head: marks.get(watching.mark)?.head })
}

async function onTurnComplete($, e) {
  busy = false
  if (watching && e.turnId === watching.turnId) {
    const w = watching
    watching = null
    pending = []
    askOpen = false
    const view = judgeAnswer(e, w.edited)
    if (view.state === 'ask') { lastChoices = view.choices; questionOpen = true }
    await push($, { ...view, head: marks.get(w.mark)?.head })
    // 読み直すかどうかはブラウザ側（picker）が決める
    if (view.state === 'done') await sendRelay($, '/reload', { v: 1, type: 'reload' })
  }
  later($, () => sendNext($))
}

// ---- 丸の状態 ----

function waitingCount() {
  return queue.length + (inFlight ? 1 : 0)
}

async function push($, view) {
  lastView = view
  await sendRelay($, '/status', statusBody(view, targetName(title, root), waitingCount()))
}

async function refreshWaiting($) {
  // 質問が出ている間は質問のまま（待ちの数は status の waiting で出る）
  if (!watching && !questionOpen && waitingCount() > 0) {
    const head = queue.length ? queue[0].head : marks.get(inFlight)?.head
    return push($, { state: 'waiting', head })
  }
  return push($, lastView)
}

async function sendRelay($, path, body) {
  const r = relay
  if (!r || !r.socket) return
  try {
    await $.http.fetch(`http://yubi${path}`, {
      method: 'POST',
      socketPath: r.socket,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    // 中継役に届かなくても会話は止めない
  }
}
