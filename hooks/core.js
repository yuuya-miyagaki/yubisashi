// 判断だけの関数。Claude Code にも Node にも頼らないので、そのままテストできる

export const READY_MS = 5_000
export const STALL_MS = 5 * 60_000
export const STALL_CHECK_MS = 30_000
export const TEXT_MAX = 40
export const CLASS_MAX = 200
export const HEAD_MAX = 30
export const DONE_LINES = 3
export const LINE_MAX = 120
export const ASK_MAX = 400
export const CHOICE_LABEL_MAX = 60
export const KEY_LENGTH = 32
export const GUIDE_HEAD = '■ 進め方'
export const WRITE_TOOLS = ['Write', 'Edit', 'NotebookEdit']
export const CHOICE_OPEN = 'ブラウザで開く'
export const CHOICE_STOP = '止める'
export const CHOICE_KEEP = 'そのまま'
export const NUMS = ['①', '②', '③', '④', '⑤']
export const LAST_MAX = 20
export const SURVEY_MS = 3_000
export const CHOICE_CANCEL = 'やめる'
export const START_QUESTION = 'どのページを開きますか？（「その他」にパスや番号も書けます）'
export const CUT_NOTE = '（全部は探していません）'

export const USAGE = [
  '使い方:',
  '  /yubi             前回のページ・最近直した HTML・動いている開発サーバーから選んで開く（動いているときは状態を表示する）',
  '  /yubi 3000        3000 番の開発サーバーを中継して、ブラウザで開く',
  '  /yubi ./site      フォルダの HTML を配って、ブラウザで開く（file:/// の URL も可）',
  '  /yubi 止める      中継を止める',
  'ブラウザでは: 右下の丸を押すか Alt＋クリックで部品を選び、一言書いて「送る」',
].join('\n')

export const MSG = {
  https: 'HTTPS の開発サーバーにはまだ対応していません。http で起動してください。',
  remote: '手元の開発サーバーかフォルダを指定してください。',
  loop: 'その番号は指差しの中継役です。開発サーバーの番号を指定してください。',
  noIndexPick: 'index.html がありません。このフォルダの HTML から選んでください。',
  noHtmlIn: 'このフォルダに HTML がありません：',
  cancelled: 'やめました。',
  notFound: 'ページかフォルダが見つかりません：',
  stopped: '指差しを止めました。',
  notRunning: '動いていません。',
  headless: 'この実行（claude -p など）では指差しを動かしていません。',
  noNode: '始められませんでした。Node が見つかりません（https://nodejs.org から入れてください）。',
  noTemplate: 'テンプレート（request.md・draft.md・guide.md）が読めませんでした。~/claude-mods/yubisashi/template/ を確かめてください。',
  lost: '結果を受け取れませんでした',
  closed: '確認はもう閉じています',
  aborted: '中断しました',
  refused: 'Claude が断りました',
  error: 'エラーで止まりました',
}

const EDGE_SPACES = /^[\s　]+|[\s　]+$/g
const LOCAL = '(?:localhost|127\\.0\\.0\\.1|\\[::1\\])'
const PORT_ONLY = /^(\d{1,5})$/
const LOCAL_URL = new RegExp(`^(?:http://)?${LOCAL}:(\\d{1,5})/?$`, 'i')
const HTTPS_LOCAL = new RegExp(`^https://${LOCAL}(?:[:/]|$)`, 'i')
const ANY_URL = /^[a-z][a-z0-9+.-]*:\/\//i

// ファイルをターミナルに落とすと '…' か "…" で囲まれたり（VS Code は名前の ' を '\'' にする）、
// 空白や ( ) の前に \ が付いたりする（macOS のターミナル）。それを外す
function unquote(s) {
  const m = s.match(/^'((?:[^']|'\\'')*)'$|^"([^"]*)"$/)
  if (m) return (m[1]?.replace(/'\\''/g, "'") ?? m[2]).replace(EDGE_SPACES, '')
  return s.replace(/\\(.)/g, '$1')
}

// file:/// の URL をパスに戻す（? と # から後を外し、%xx を元の文字に）。file:// でなければ null。戻せない形なら、そのままの文字
export function fileUrlPath(s) {
  const m = String(s ?? '').match(/^file:\/\/(?:localhost)?(\/[^?#]*)/i)
  if (!m) return null
  try {
    return decodeURIComponent(m[1])
  } catch {
    return m[1]
  }
}

// /yubi の引数を読む。パスかどうかは register.js がファイルを見て決める
// 全角の数字などは番号・URL・止めるの見分けにだけ読み替え、パスは元の文字のまま返す。
// 読み替えると違う文字になるパスは alt にも入れる（元の文字で見つからないとき、全角で打った ～／・．／ を読むため）
export function parseArgs(raw) {
  const orig = unquote(String(raw ?? '').replace(EDGE_SPACES, ''))
  const s = orig.normalize('NFKC').replace(EDGE_SPACES, '')
  if (s === '') return { kind: 'status' }
  if (s === '止める' || s.toLowerCase() === 'stop') return { kind: 'stop' }
  // ブラウザのアドレス欄から貼った file:/// の URL（§22-4）。戻したままの文字で探し、NFC が違えばそれも探す
  const fp = fileUrlPath(orig)
  if (fp !== null) {
    const nfc = fp.normalize('NFC')
    return nfc === fp ? { kind: 'path', path: fp } : { kind: 'path', path: fp, alt: nfc }
  }
  const m = s.match(PORT_ONLY) ?? s.match(LOCAL_URL)
  if (m) {
    const port = Number(m[1])
    return port >= 1 && port <= 65535 ? { kind: 'port', port } : { kind: 'usage' }
  }
  if (HTTPS_LOCAL.test(s)) return { kind: 'https' }
  if (ANY_URL.test(s)) return { kind: 'remote' }
  return s === orig ? { kind: 'path', path: orig } : { kind: 'path', path: orig, alt: s }
}

export function expandPath(p, root, home) {
  if (p === '~') return home
  if (p.startsWith('~/')) return home + p.slice(1)
  if (p.startsWith('/')) return p.replace(/\/+$/, '') || '/'
  const rel = p.replace(/^\.\/+/, '').replace(/\/+$/, '')
  return rel === '' || rel === '.' ? root : `${root}/${rel}`
}

const MARK_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz'

// 依頼の印（#k3x9 の形）。この会話で使った印は避ける
export function newMark(rand, used) {
  let mark = ''
  for (let tries = 0; tries < 50; tries++) {
    mark = '#'
    for (let i = 0; i < 4; i++) mark += MARK_CHARS[Math.floor(rand() * MARK_CHARS.length) % MARK_CHARS.length]
    if (!used || !used.has(mark)) return mark
  }
  return mark
}

const KEY_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

export function keyFromBytes(bytes) {
  return Array.from(bytes, b => KEY_CHARS[b % KEY_CHARS.length]).join('')
}

const MARK_RE = /#[0-9a-z]{4}(?![0-9a-z])/g

// 文の中の印のうち、この会話で出したものだけを返す
export function findMarks(text, known) {
  return (String(text ?? '').match(MARK_RE) ?? []).filter(m => known.has(m))
}

export function nextDraftNumber(box) {
  let max = 0
  for (const m of String(box ?? '').matchAll(/■ 指差し (\d+)（/g)) max = Math.max(max, Number(m[1]))
  return max + 1
}

// 入力欄に書いてある文と、足す下書きの間に入れる改行
export function draftSeparator(box) {
  const t = String(box ?? '')
  if (t.trim() === '') return ''
  if (t.endsWith('\n\n')) return ''
  return t.endsWith('\n') ? '\n' : '\n\n'
}

// 字（コードポイント）で数えて切る。改行は残す
export function clip(s, max) {
  const chars = [...String(s ?? '')]
  return chars.length > max ? chars.slice(0, max).join('') + '…' : chars.join('')
}

// 空白と改行を1つの空白に詰めてから切る
export function trimText(s, max) {
  return clip(String(s ?? '').replace(/\s+/g, ' ').trim(), max)
}

export function headOf(words) {
  const line = String(words ?? '').split('\n').map(l => l.trim()).find(Boolean) ?? ''
  return trimText(line, HEAD_MAX)
}

// 作業フォルダの中なら相対パス、家の中なら ~/ から。macOS の NFD と NFC の違いは揃えて比べる
export function relPath(file, root, home) {
  const f = String(file ?? '').normalize('NFC')
  if (!f.startsWith('/')) return f
  const r = String(root ?? '').normalize('NFC').replace(/\/+$/, '')
  const h = String(home ?? '').normalize('NFC').replace(/\/+$/, '')
  if (r && f.startsWith(r + '/')) return f.slice(r.length + 1)
  if (h && f.startsWith(h + '/')) return '~/' + f.slice(h.length + 1)
  return f
}

export function fillTemplate(tpl, vars) {
  return String(tpl)
    .replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ''))
    .replace(/\n{3,}/g, '\n\n')
    .trim() + '\n'
}

// 打った・Remote Control・本人の言葉として送った Mod の依頼か
export function isPersonOrigin(origin) {
  if (!origin || typeof origin !== 'object') return false
  if (origin.kind === 'composer' || origin.kind === 'bridge') return true
  return origin.kind === 'plugin' && origin.asUser === true
}

// 届け先の表示。会話の名前が無ければ作業フォルダの名前
export function targetName(title, root) {
  const t = String(title ?? '').trim()
  if (t) return t
  const parts = String(root ?? '').split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : String(root ?? '')
}

export function directionText(r) {
  return `${r.label} → ${r.port}`
}

export function startedText(r, opened) {
  const head = `指差しを始めました（${directionText(r)}）。ブラウザで部品を選んで一言書いてください。`
  return opened ? head : `${head}\nブラウザで http://localhost:${r.port}/ を開いてください。`
}

export function failedText(why) {
  return `始められませんでした（${why}）。`
}

export function relayDownText(why) {
  return `指差しの中継役が止まりました（${why}）。/yubi でもう一度始められます。`
}

export function statusReport(r, stats, target) {
  const lines = [
    `指差し：中継中（${directionText(r)}）`,
    `届け先: ${target}`,
    `差し込めたページ: ${stats.pages}`,
    `送った数: ${stats.sent}／待ち: ${stats.waiting}`,
  ]
  if (stats.pages === 0) lines.push(`丸が出ないときは、ブラウザの URL が ${r.port} 番か確かめてください。`)
  return lines.join('\n')
}

function styleText(styles) {
  return Object.entries(styles ?? {}).map(([k, v]) => `${k} ${v}`).join(' / ')
}

function parentsText(parents) {
  return (parents ?? []).map(p => {
    const kv = Object.entries(p.styles ?? {}).map(([k, v]) => `${k} ${v}`).join(', ')
    return kv ? `${p.label}（${kv}）` : p.label
  }).join('› ')
}

function sourceText(src, ctx) {
  const line = src.line ? `:${src.line}` : ''
  return `${relPath(src.file, ctx.root, ctx.home)}${line}${src.approx ? '（行は目安）' : ''}`
}

const round = n => Math.round(Number(n) || 0)

const SIZE_HEAD = '- 大きさを変える（使う人がブラウザで見て決めた値）:'
const okNum = v => typeof v === 'number' && Number.isFinite(v)
const okWH = v => Boolean(v) && typeof v === 'object' && okNum(v.w) && okNum(v.h)
const half = n => String(Math.round(n * 2) / 2)
const whText = v => `幅${round(v.w)}×高さ${round(v.h)}`

function changeLine(c) {
  if (!c || typeof c !== 'object') return null
  if (c.what === 'box' && okWH(c.from) && okWH(c.to)) return `全体（見えている大きさ。枠線・内側の余白を含む）: ${whText(c.from)} → ${whText(c.to)}px`
  if (c.what === 'img' && okWH(c.from) && okWH(c.to)) {
    const at = typeof c.selector === 'string' && c.selector ? `（${clip(c.selector, 300)}）` : ''
    return `絵${at}: ${whText(c.from)} → ${whText(c.to)}px`
  }
  if (c.what === 'text' && okNum(c.from) && okNum(c.to)) return `文字: ${half(c.from)}px → ${half(c.to)}px`
  if (c.what === 'padding' && typeof c.from === 'string' && typeof c.to === 'string') return `内側の余白: ${clip(c.from, 40)} → ${clip(c.to, 40)}`
  return null
}

// 部品の size（設計書 §20-8）の行。知らない項目と壊れた値は出さない
export function sizeLines(size) {
  if (!size || typeof size !== 'object' || !Array.isArray(size.changes)) return []
  const rows = []
  for (const what of ['box', 'img', 'text', 'padding']) {
    const line = changeLine(size.changes.find(c => c && c.what === what))
    if (line) rows.push(`  - ${line}`)
  }
  return withScope(SIZE_HEAD, size, rows)
}

// 塊の頭と範囲の行（同じ作りの部品が2つ以上あるときだけ）。size・space・color で同じ（設計書 §20-8・§23-8）
function withScope(head, block, rows) {
  if (!rows.length) return []
  const same = block.same
  if (same && typeof same.label === 'string' && Number.isInteger(same.count) && same.count >= 2) {
    rows.unshift(block.scope === 'all'
      ? `  - 範囲: 同じ作りの部品すべて（${clip(same.label, 100)}・${same.count}個）`
      : `  - 範囲: この1つだけ（同じ作りの部品 ${clip(same.label, 100)} がほかに${same.count - 1}個）`)
  }
  return [head, ...rows]
}

const SPACE_HEAD = '- 間隔・位置を変える（使う人がブラウザで見て決めた値）:'
const SIDE_WORDS = { top: '上', bottom: '下', left: '左', right: '右' }
const SIDE_OPP = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }

function moveWords(dx, dy) {
  const out = []
  if (dx) out.push(`${dx > 0 ? '右へ' : '左へ'} ${Math.abs(dx)}px`)
  if (dy) out.push(`${dy > 0 ? '下へ' : '上へ'} ${Math.abs(dy)}px`)
  return out.join('・')
}

function gapLines(c) {
  if (!c || typeof c !== 'object' || !SIDE_WORDS[c.side] || !Number.isInteger(c.from) || !Number.isInteger(c.to)) return []
  const nb = c.neighbor
  if (!nb || typeof nb.label !== 'string' || !nb.label) return []
  const word = SIDE_WORDS[c.side]
  const text = typeof nb.text === 'string' && nb.text ? `「${clip(nb.text, 20)}」` : ''
  const out = [`  - ${word}の部品（${clip(nb.label, 100)}${text}）との間（見えている間）: ${c.from}px → ${c.to}px`]
  const m = c.made
  if (m && typeof m.self === 'string' && typeof m.other === 'string') {
    const gapName = c.side === 'top' || c.side === 'bottom' ? 'row-gap' : 'column-gap'
    const gap = typeof m.gap === 'string' ? `・親の ${gapName} ${clip(m.gap, 40)}` : ''
    out.push(`    いまの作り: この部品の margin-${c.side} ${clip(m.self, 40)}・${word}の部品の margin-${SIDE_OPP[c.side]} ${clip(m.other, 40)}${gap}`)
  }
  return out
}

// 部品の space（設計書 §23-8）の行。前の間 → 次の間 → 位置。知らない項目と壊れた値は出さない
export function spaceLines(space) {
  if (!space || typeof space !== 'object' || !Array.isArray(space.changes)) return []
  const rows = []
  for (const what of ['prev', 'next']) rows.push(...gapLines(space.changes.find(c => c && c.what === what)))
  const mv = space.changes.find(c => c && c.what === 'move')
  if (mv && Number.isInteger(mv.dx) && Number.isInteger(mv.dy) && (mv.dx || mv.dy)) {
    rows.push(`  - 位置（見た目で動かした量。周りの部品は動かしていない）: ${moveWords(mv.dx, mv.dy)}`)
  }
  return withScope(SPACE_HEAD, space, rows)
}

const COLOR_HEAD = '- 色を変える（使う人がブラウザで見て決めた値）:'
const COLOR_WORDS = { text: '文字', bg: '背景', img: '絵', border: '枠線' }
const PAINT_WORDS = { stroke: '線', fill: '塗り', both: '線と塗り' }
const COLOR_RE = /^(#[0-9A-F]{6}|rgba\(\d{1,3}, \d{1,3}, \d{1,3}, (0|1|0?\.\d+)\)|transparent)$/
const colorWord = s => (s === 'transparent' ? '透明' : s)

function colorLine(c) {
  if (!c || typeof c !== 'object' || !COLOR_WORDS[c.what] || !COLOR_RE.test(String(c.from)) || !COLOR_RE.test(String(c.to))) return null
  let name = COLOR_WORDS[c.what]
  if (c.what === 'img') {
    if (!PAINT_WORDS[c.paint]) return null
    const at = typeof c.selector === 'string' && c.selector ? `${clip(c.selector, 300)}・` : ''
    name += `（${at}${PAINT_WORDS[c.paint]}）`
  }
  const page = typeof c.page === 'string' && c.page ? `（このページの色：${clip(c.page, 100)}）` : ''
  return `${name}: ${colorWord(c.from)} → ${colorWord(c.to)}${page}`
}

// 部品の color（設計書 §23-8）の行。文字 → 背景 → 絵 → 枠線。知らない項目と壊れた値は出さない
export function colorLines(color) {
  if (!color || typeof color !== 'object' || !Array.isArray(color.changes)) return []
  const rows = []
  for (const what of ['text', 'bg', 'img', 'border']) {
    const line = colorLine(color.changes.find(c => c && c.what === what))
    if (line) rows.push(`  - ${line}`)
  }
  return withScope(COLOR_HEAD, color, rows)
}

// 部品1つ分の「- 住所: …」などの行。取れない項目の行は出さない
export function elLines(el, ctx) {
  const out = []
  if (el.selector) out.push(`- 住所: ${el.selector}`)
  if (el.classes) out.push(`- クラス名: ${trimText(el.classes, CLASS_MAX)}`)
  if (el.text) out.push(`- 中の文字: 「${trimText(el.text, TEXT_MAX)}」`)
  if (el.rect) out.push(`- 大きさ・位置: 幅${round(el.rect.w)}×高さ${round(el.rect.h)}、左から${round(el.rect.x)}・上から${round(el.rect.y)}`)
  out.push(...sizeLines(el.size), ...spaceLines(el.space), ...colorLines(el.color))
  const st = styleText(el.styles)
  if (st) out.push(`- 見た目の値: ${st}`)
  const pt = parentsText(el.parents)
  if (pt) out.push(`- 外側の並び: ${pt}`)
  if (el.components && el.components.length) out.push(`- 部品の名前: ${el.components.slice(0, 3).join(' ‹ ')}`)
  if (el.source && el.source.file) out.push(`- ファイル候補: ${sourceText(el.source, ctx)}`)
  return out
}

function readableUrl(u) {
  try { return decodeURI(u) } catch { return u }
}

export function pageText(page, ctx) {
  const w = round(page.width)
  if (page.servedFile) return `${relPath(page.servedFile, ctx.root, ctx.home)}（画面の幅 ${w}px・見る URL ${readableUrl(String(page.url))}）`
  return `${page.url}（画面の幅 ${w}px）`
}

// 部品の塊。送る文は「■ 指した部品（①）」、下書きは「指した部品（①）:」
export function elementsBlock(els, ctx, style) {
  const blocks = els.map((el, i) => {
    const lines = elLines(el, ctx)
    if (!(el.source && el.source.file) && ctx.servedFile) lines.push(`- ファイル候補: ${relPath(ctx.servedFile, ctx.root, ctx.home)}`)
    const n = els.length > 1 ? ` ${NUMS[i]}` : ''
    return style === 'send' ? `■ 指した部品${n}\n${lines.join('\n')}` : `指した部品${n}:\n${lines.join('\n')}`
  })
  return blocks.join(style === 'send' ? '\n\n' : '\n')
}

export function buildRequest(pick, ctx, tpl, mark) {
  const c = { ...ctx, servedFile: pick.page && pick.page.servedFile }
  return fillTemplate(tpl.request, {
    words: String(pick.words).trim(),
    page: pageText(pick.page, c),
    elements: elementsBlock(pick.els, c, 'send'),
    guide: String(tpl.guide).trim(),
    mark,
  })
}

export function buildDraft(pick, ctx, tpl, mark, n) {
  const c = { ...ctx, servedFile: pick.page && pick.page.servedFile }
  const words = String(pick.words).trim().split('\n').map(l => l.trim()).filter(Boolean).join(' / ')
  return fillTemplate(tpl.draft, { n, mark, words, page: pageText(pick.page, c), elements: elementsBlock(pick.els, c, 'draft') })
}

export function buildReply(reply, choices, mark) {
  const c = (choices ?? []).find(x => x.n === reply.choice)
  const words = String(reply.words ?? '').trim()
  const body = [c ? `${c.n}. ${c.label}` : '', words].filter(Boolean).join(' ')
  return `（指差しの確認への返事 ${mark}）\n${body}`
}

// 行の頭の Markdown の飾り（見出し・引用・太字）を外す
export function stripDecor(line) {
  return String(line).trim().replace(/^(?:#{1,6}\s+|>\s*)+/, '').replace(/^(?:\*\*|__)/, '').trim()
}

const CIRCLED = '①②③④⑤⑥⑦⑧⑨'
// 「1.5倍」のように「.」の後ろに数字が続くものは選択肢にしない（「1）2列」は選択肢）
const CHOICE = /^(?:(\d{1,2})(?:[.．](?!\d)|[)）])|([①-⑨]))\s*(.+)$/

// 選択肢にする行の番号（rows の添え字）。1 から1つずつ増える番号の行の並びのうち、2つ以上続く最後の並び
// （無ければ最後の並び）。それ以外の番号の行（「①は見出し、②は…」のような説明）は文に戻す
function choiceRun(rows) {
  const runs = []
  let cur = null
  rows.forEach((r, i) => {
    if (r.n === undefined) return
    if (cur && r.n === cur.next) { cur.idx.push(i); cur.next += 1; return }
    cur = r.n === 1 ? { idx: [i], next: 2 } : null
    if (cur) runs.push(cur)
  })
  const long = runs.filter(x => x.idx.length >= 2)
  const run = (long.length ? long : runs).pop()
  return new Set(run ? run.idx : [])
}

// 作業の終わりの答えから、丸の状態を決める
export function judgeAnswer(e, edited) {
  if (e.isAborted || e.reason === 'aborted') return { state: 'stopped', text: MSG.aborted }
  if (e.reason === 'refusal') return { state: 'stopped', text: MSG.refused }
  if (e.reason === 'error') return { state: 'stopped', text: MSG.error }
  const lines = String(e.answer ?? '').split('\n').map(stripDecor)
  const first = lines.findIndex(l => l !== '')
  if (first >= 0 && lines[first].startsWith('【確認】')) {
    // 1行目は質問の文。「①も②も…」で始まっても選択肢にしない
    const question = lines[first].slice('【確認】'.length).replace(/^[\s*_:：]+/, '').replace(/\*\*|__/g, '').trim()
    const rows = []
    for (const raw of lines.slice(first + 1)) {
      const l = raw.replace(/\*\*|__/g, '').trim()
      if (!l) continue
      const m = l.match(CHOICE)
      rows.push(m ? { l, n: m[1] ? Number(m[1]) : CIRCLED.indexOf(m[2]) + 1, label: m[3].trim() } : { l })
    }
    const picked = choiceRun(rows)
    const choices = []
    const text = question ? [question] : []
    rows.forEach((r, i) => {
      if (picked.has(i)) choices.push({ n: r.n, label: clip(r.label, CHOICE_LABEL_MAX) })
      else text.push(r.l)
    })
    return { state: 'ask', text: clip(text.join('\n'), ASK_MAX), choices }
  }
  const shown = lines.filter(Boolean).slice(0, DONE_LINES).map(l => clip(l, LINE_MAX)).join('\n')
  return edited ? { state: 'done', text: shown } : { state: 'done', text: shown, noEdit: true }
}

// 設計書 §9-5 の status の形
export function statusBody(view, target, waiting) {
  const body = { v: 1, ...view, target }
  if (waiting > 0) body.waiting = waiting
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k]
  return body
}

// 中継役の標準出力を1行1件の JSON に分ける。版 1 で type のあるものだけ通す
export function splitLines(rest, chunk) {
  const parts = (String(rest) + String(chunk)).split('\n')
  const tail = parts.pop() ?? ''
  const items = []
  for (const p of parts) {
    const t = p.trim()
    if (!t) continue
    try {
      const o = JSON.parse(t)
      if (o && typeof o === 'object' && o.v === 1 && typeof o.type === 'string') items.push(o)
    } catch {
      // 壊れた行は捨てる
    }
  }
  return { items, rest: tail.length > 1_000_000 ? '' : tail }
}

// ---- 始め方（0.3.0・設計書 §22） ----

const nfc = s => String(s ?? '').normalize('NFC')
const baseOf = p => nfc(p).replace(/\/+$/, '').split('/').pop() ?? ''
const parentOf = p => { const parts = nfc(p).replace(/\/+$/, '').split('/'); return parts.length > 2 ? parts[parts.length - 2] : '' }
const two = n => String(n).padStart(2, '0')

// 長いファイル名は真ん中を … にして、終わり（日付と .html）を残す
export function clipMiddle(s, max) {
  const c = [...String(s ?? '')]
  if (c.length <= max) return c.join('')
  const tail = Math.min(16, max - 4)
  const head = max - 1 - tail
  return c.slice(0, head).join('') + '…' + c.slice(c.length - tail).join('')
}

// 直した時刻（この機械の時刻で M/D H:MM）
export function whenText(ms) {
  const d = new Date(ms)
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${two(d.getMinutes())}`
}

// フォルダの相対パス。作業フォルダそのものなら '.'
export function relDir(dir, root, home) {
  const d = nfc(dir).replace(/\/+$/, '')
  return d === nfc(root).replace(/\/+$/, '') ? '.' : relPath(d, root, home)
}

export function notHtmlText(name) {
  return `HTML ではありません（${name}）。同じフォルダの HTML から選んでください。`
}

export function noPageText(folder) {
  return `この作業フォルダ（${folder}）に、開けるページが見つかりませんでした。`
}

export function surveyFailedText(why) {
  return `ページを探せませんでした（${why}）。`
}

// 選ぶ画面の問いと選択肢（§22-3）。前回 → 開発サーバー（2つまで）→ HTML の順に4つまで詰める。
// last は確かめ済みの前回（ファイルはあるときだけ渡す。番号は servers に無ければ並べない）。候補が無ければ null
export function startChoices({ head = '', last = null, servers = [], files = [], cut = false, root = '', home = '' }) {
  const items = []
  if (last && last.kind === 'file') items.push({ kind: 'file', path: last.path, last: true })
  if (last && last.kind === 'port') {
    const sv = servers.find(x => x.port === last.port)
    if (sv) items.push({ kind: 'port', port: sv.port, title: sv.title, last: true })
  }
  let shown = 0
  for (const sv of servers) {
    if (items.length >= 4 || shown >= 2) break
    if (items.some(i => i.kind === 'port' && i.port === sv.port)) continue
    items.push({ kind: 'port', port: sv.port, title: sv.title })
    shown++
  }
  for (const f of files) {
    if (items.length >= 4) break
    if (items.some(i => i.kind === 'file' && nfc(i.path) === nfc(f.path))) continue
    items.push({ kind: 'file', path: f.path, mtimeMs: f.mtimeMs })
  }
  if (!items.length) return null
  // 同じファイル名が2つ以上なら、親フォルダの名前を前に付ける
  const names = items.filter(i => i.kind === 'file').map(i => baseOf(i.path))
  const nameOf = i => {
    const b = baseOf(i.path)
    return names.filter(n => n === b).length > 1 && parentOf(i.path) ? `${parentOf(i.path)}/${b}` : b
  }
  const options = []
  const lines = []
  for (const i of items) {
    let label
    if (i.kind === 'port') {
      label = `${i.last ? '前回：' : ''}${i.port} 番${i.title ? `：${clip(i.title, i.last ? 10 : 12)}` : ''}`
      lines.push(`・${i.last ? '前回：' : ''}${i.port} 番：${i.title || '題名なし'}（開発サーバー）`)
    } else {
      label = i.last ? `前回：${clipMiddle(nameOf(i), 20)}` : clipMiddle(nameOf(i), 24)
      const when = !i.last && Number.isFinite(i.mtimeMs) ? `（${whenText(i.mtimeMs)} に直した）` : ''
      lines.push(`・${i.last ? '前回：' : ''}${relPath(i.path, root, home)}${when}`)
    }
    const base = label
    for (let n = 2; options.includes(label); n++) label = `${base} (${n})`
    options.push(label)
  }
  const picks = items.map(i => (i.kind === 'port' ? { kind: 'port', port: i.port } : { kind: 'file', path: i.path }))
  // 選択肢は2つ以上要る
  if (options.length === 1) { options.push(CHOICE_CANCEL); picks.push(null) }
  // 頭の一言があるときは、それを1行目、問い（「その他」の案内）を2行目に置く。打ち切りの一言は問いの後
  const ask = START_QUESTION + (cut ? CUT_NOTE : '')
  return { question: [...(head ? [head] : []), ask, ...lines].join('\n'), options, picks }
}

// 選ぶ画面の答えを読む。選択肢の文なら、その物。やめる・空・閉じた → cancel。それ以外は「その他」に書いた文
export function choiceOf(answer, choices) {
  const a = nfc(answer).trim()
  if (!a || a === CHOICE_CANCEL) return { kind: 'cancel' }
  const i = choices.options.findIndex(o => nfc(o) === a)
  if (i >= 0) return choices.picks[i] ?? { kind: 'cancel' }
  return { kind: 'other', text: a }
}

// 前回のページを書く（作業フォルダごとに1つ・新しい物から 20 個まで）。壊れた中身は作り直す
export function rememberLast(map, root, entry, now) {
  const m = map && typeof map === 'object' && !Array.isArray(map) ? { ...map } : {}
  m[nfc(root)] = { ...entry, at: now }
  const keys = Object.keys(m).sort((a, b) => (Number(m[b]?.at) || 0) - (Number(m[a]?.at) || 0))
  return Object.fromEntries(keys.slice(0, LAST_MAX).map(k => [k, m[k]]))
}

// 前回のページを読む。形が違えば null（覚えていないのと同じ）
export function lastOf(map, root) {
  const v = map && typeof map === 'object' && !Array.isArray(map) ? map[nfc(root)] : null
  if (!v || typeof v !== 'object') return null
  if (v.kind === 'file' && typeof v.path === 'string' && v.path.startsWith('/')) return { kind: 'file', path: v.path }
  if (v.kind === 'port' && Number.isInteger(v.port) && v.port >= 1 && v.port <= 65535) return { kind: 'port', port: v.port }
  return null
}

// survey.mjs の答え（最後の行の JSON）を読む。読めなければ null
export function parseSurvey(text) {
  let o
  try {
    o = JSON.parse(String(text ?? '').trim().split('\n').pop())
  } catch {
    return null
  }
  if (!o || typeof o !== 'object' || o.v !== 1) return null
  if (o.error) return { error: String(o.error) }
  const files = Array.isArray(o.files)
    ? o.files.filter(f => f && typeof f.path === 'string' && Number.isFinite(f.mtimeMs)).map(f => ({ path: f.path, mtimeMs: f.mtimeMs }))
    : []
  const servers = Array.isArray(o.servers)
    ? o.servers.filter(s => s && Number.isInteger(s.port)).map(s => ({ port: s.port, title: typeof s.title === 'string' ? s.title : '' }))
    : []
  return { files, servers, cut: o.cut === true }
}
