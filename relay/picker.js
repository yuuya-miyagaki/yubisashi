// 指差しのブラウザの仕掛け。中継役がページに差し込む（丸・選ぶモード・入力欄・状態の表示）
import {
  MAX_ELS, NUMS, pickStyles, parentStyles, buildSelector, selectorClasses, labelOf, trimText,
  componentName, stackToSource, debugSourceToSource, shouldReload, reloadAction,
  svgLift, uniqueInOrder, stepIndex, innerStep, sameShapeKey, hoverIndexAfter, scaleOf, unscale, bubblePos,
  SIZE_LABELS, SIZE_NOTES, SAME_MAX, uniqueSizes, sizeButtons, clampSize, cssSizeFor, fitRatio,
  dragSize, sizeTook, paddingText, limitTargets, createLedger, ledgerApply, ledgerRestore, ledgerRestoreAll, buildSize,
  emptyWords,
} from './picker-core.js'
import { createSpacePanel } from './picker-space.js'
import { createColorPanel } from './picker-color.js'

const me = new URL(import.meta.url)
const KEY = me.searchParams.get('k') ?? ''
const MODE = me.searchParams.get('m') === 'static' ? 'static' : 'proxy'
const ACK_MS = 5000
const DONE_MS = 10_000
const TEXT_MAX = 40
const WORDS_MAX = 1000

// 自分の script タグを外す（ページのほかのスクリプトから合言葉を読まれにくくする）
for (const s of document.querySelectorAll('script[src*="/__yubi/picker.js"]')) s.remove()

let ui = null
let status = { state: 'idle' }
let conn = 'ok'
let picking = false
let reloadLater = false   // 完了の読み直しを、作業が終わるまで後に回している（§21）
let picked = []
let ackWait = null
let doneFresh = false
let doneTimer = null
let panelOpen = false
let panelKey = ''
let hoverStack = []   // カーソルの下に重なっている部品（上から順。svg の中は svg にまとめる）
let hoverIdx = 0
let altHover = false  // Alt を押したまま動かして、枠を出している
let slots = []        // 枠（①②…）ごと：{ origin, info, to, padSides, scope, same, space?, color? }。picked と同じ順
let lookOpen = null   // 開いている欄：'size'・'space'・'color'・null（設計書 §23-3）
let sizeWhat = null
let drag = null
const ledger = createLedger()
const SIZE_ORDER = ['padding', 'text', 'img', 'box']   // 全体は余白を当てた後の作りで width を決める
const GONE = '選んだ部品が画面から消えました。選び直してください'

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif; }
.ball, .bubble, .panel, .toast { pointer-events: auto; }
.ball { position: fixed; right: 16px; bottom: 16px; min-width: 44px; height: 44px; padding: 0 12px; border-radius: 22px; border: none;
  background: #1f2937; color: #fff; font-size: 18px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.3); }
.ball.picking { background: #2563eb; font-size: 14px; }
.ball.wait { background: #6b7280; font-size: 13px; }
.ball.work { background: #2563eb; animation: pulse 1s infinite alternate; }
.ball.done { background: #16a34a; }
.ball.ask { background: #ca8a04; }
.ball.stop { background: #dc2626; }
.ball.off { background: #9ca3af; }
@keyframes pulse { from { opacity: 1 } to { opacity: .55 } }
.box { position: fixed; border: 2px solid #2563eb; background: rgba(37,99,235,.08); pointer-events: none; }
.tag { position: absolute; left: -2px; top: -22px; background: #2563eb; color: #fff; font-size: 11px; padding: 2px 6px; border-radius: 3px; white-space: nowrap; }
.mark { position: fixed; border: 2px dashed #f97316; pointer-events: none; }
.mark span { position: absolute; left: -2px; top: -20px; background: #f97316; color: #fff; font-size: 12px; padding: 1px 6px; border-radius: 3px; white-space: nowrap; }
.bubble, .panel { position: fixed; width: 320px; max-width: calc(100vw - 32px); background: #fff; color: #111; border: 1px solid #d1d5db;
  border-radius: 10px; padding: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.2); font-size: 13px; }
.bubble { max-height: calc(100vh - 16px); overflow: auto; }
.panel { right: 16px; bottom: 70px; max-height: 60vh; overflow: auto; }
.nums, .dim { color: #6b7280; font-size: 12px; margin-bottom: 6px; }
textarea { width: 100%; font-size: 14px; padding: 6px; border: 1px solid #d1d5db; border-radius: 6px; resize: vertical; }
.row { display: flex; gap: 6px; justify-content: flex-end; margin-top: 6px; flex-wrap: wrap; }
button { font-size: 12px; padding: 5px 9px; border-radius: 6px; border: 1px solid #d1d5db; background: #f9fafb; color: #111; cursor: pointer; }
button.main { background: #2563eb; color: #fff; border-color: #2563eb; }
button:disabled { opacity: .5; cursor: default; }
.msg, .pmsg { color: #b45309; font-size: 12px; min-height: 1em; margin-top: 4px; }
.later { color: #15803d; font-size: 12px; margin-top: 4px; }
pre { white-space: pre-wrap; background: #f3f4f6; padding: 6px; border-radius: 6px; font-size: 12px; margin: 6px 0; }
.panel button { display: block; width: 100%; text-align: left; margin-top: 4px; }
.panel button.main { text-align: center; }
.toast { position: fixed; right: 16px; bottom: 70px; background: #111; color: #fff; padding: 6px 10px; border-radius: 6px; font-size: 12px; }
.look { border-top: 1px solid #e5e7eb; margin-top: 6px; padding-top: 6px; }
.look .row, .row.looks { justify-content: flex-start; }
.look button.on, .looks button.on { background: #16a34a; color: #fff; border-color: #16a34a; }
.look .ctl { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-top: 6px; font-size: 12px; }
.look input { width: 64px; font-size: 13px; padding: 3px 4px; border: 1px solid #d1d5db; border-radius: 4px; }
.look .note, .look .warn { color: #b45309; font-size: 12px; margin-top: 4px; }
.what { position: fixed; border: 2px solid #16a34a; pointer-events: none; }
.band { position: fixed; background: rgba(236,72,153,.28); border: 1px dashed #db2777; pointer-events: auto; touch-action: none; }
.band[data-side="top"], .band[data-side="bottom"] { cursor: ns-resize; }
.band[data-side="left"], .band[data-side="right"] { cursor: ew-resize; }
.band span { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); background: #db2777; color: #fff;
  font-size: 11px; padding: 1px 5px; border-radius: 3px; white-space: nowrap; pointer-events: none; }
.mover { position: fixed; width: 18px; height: 18px; line-height: 16px; text-align: center; font-size: 13px; color: #fff; background: #db2777;
  border: 1px solid #fff; border-radius: 9px; cursor: move; pointer-events: auto; touch-action: none; }
.pal { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.sw { display: inline-block; width: 16px; height: 16px; border: 1px solid #d1d5db; border-radius: 3px; padding: 0; vertical-align: middle; }
.sw.none { background: repeating-linear-gradient(45deg, #fff 0 3px, #e5e7eb 3px 6px); }
button.sw { width: 22px; height: 22px; cursor: pointer; }
.look input[type="color"] { width: 36px; height: 24px; padding: 0 2px; }
.grip { position: fixed; width: 12px; height: 12px; background: #16a34a; border: 2px solid #fff; border-radius: 2px;
  box-shadow: 0 0 0 1px #16a34a; cursor: nwse-resize; pointer-events: auto; touch-action: none; }
`

const start = () => setTimeout(build, 300)
if (document.readyState === 'complete') start()
else window.addEventListener('load', start, { once: true })

function build() {
  if (ui) return
  const host = document.createElement('yubi-sashi')
  host.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;'
  document.documentElement.appendChild(host)
  const root = host.attachShadow({ mode: 'closed' })
  root.innerHTML = `<style>${CSS}</style>
<div class="box" hidden><span class="tag"></span></div>
<div class="marks"></div>
<div class="whats"></div>
<div class="smarks"></div>
<div class="cmarks"></div>
<div class="band" hidden><span></span></div>
<div class="mover" hidden>⊕</div>
<div class="bubble" hidden>
  <div class="nums"></div>
  <textarea rows="3" placeholder="どう直したいかを書く（例：もう少し右へ）"></textarea>
  <div class="msg"></div>
  <div class="later" hidden>前の直しが終わりました。この欄を閉じると読み直します</div>
  <div class="row"><button data-act="up">ひとつ外側へ</button><button data-act="down">ひとつ内側へ</button><button data-act="more">もう1つ選ぶ</button></div>
  <div class="row looks"><button data-look="size">大きさ</button><button data-look="space">間隔・位置</button><button data-look="color">色</button></div>
  <div class="look size" hidden></div>
  <div class="look space" hidden></div>
  <div class="look color" hidden></div>
  <div class="row"><button data-act="cancel">やめる</button><button data-act="draft">下書きへ</button><button data-act="send" class="main">送る</button></div>
</div>
<div class="panel" hidden></div>
<div class="toast" hidden></div>
<div class="grip" hidden></div>
<button class="ball" title="指差し：部品を選ぶ">☝</button>`
  ui = {
    host,
    root,
    box: root.querySelector('.box'),
    tag: root.querySelector('.tag'),
    marks: root.querySelector('.marks'),
    whats: root.querySelector('.whats'),
    size: root.querySelector('.size'),
    grip: root.querySelector('.grip'),
    space: root.querySelector('.look.space'),
    color: root.querySelector('.look.color'),
    cmarks: root.querySelector('.cmarks'),
    smarks: root.querySelector('.smarks'),
    band: root.querySelector('.band'),
    bandLabel: root.querySelector('.band span'),
    mover: root.querySelector('.mover'),
    bubble: root.querySelector('.bubble'),
    nums: root.querySelector('.nums'),
    text: root.querySelector('textarea'),
    msg: root.querySelector('.msg'),
    later: root.querySelector('.later'),
    panel: root.querySelector('.panel'),
    toast: root.querySelector('.toast'),
    ball: root.querySelector('.ball'),
  }
  ui.ball.addEventListener('click', onBall)
  ui.bubble.addEventListener('click', onBubbleClick)
  ui.text.addEventListener('keydown', onTextKey)
  for (const t of ['keyup', 'keypress']) ui.text.addEventListener(t, e => e.stopPropagation())
  ui.panel.addEventListener('click', onPanelClick)
  ui.size.addEventListener('click', onSizeClick)
  ui.size.addEventListener('input', onSizeInput)
  ui.size.addEventListener('keydown', onSizeKey)
  for (const t of ['keyup', 'keypress']) ui.size.addEventListener(t, e => e.stopPropagation())
  ui.grip.addEventListener('pointerdown', onGripDown)
  ui.grip.addEventListener('pointermove', onGripMove)
  ui.grip.addEventListener('pointerup', onGripUp)
  ui.grip.addEventListener('pointercancel', onGripUp)
  document.addEventListener('keyup', onKeyUp, true)
  panels.space = createSpacePanel(ctx)
  panels.color = createColorPanel(ctx)
  document.addEventListener('mousemove', onMove, true)
  document.addEventListener('mousedown', onDown, true)
  for (const t of ['pointerdown', 'pointerup', 'mouseup']) document.addEventListener(t, onPointer, true)
  document.addEventListener('click', onClick, true)
  document.addEventListener('keydown', onKey, true)
  window.addEventListener('scroll', drawMarks, true)
  window.addEventListener('resize', drawMarks)
  connect()
  render()
}

// ---- 中継役とのやり取り ----

function connect() {
  const es = new EventSource(`/__yubi/events?k=${encodeURIComponent(KEY)}`)
  es.addEventListener('status', ev => {
    status = JSON.parse(ev.data)
    conn = 'ok'
    if (status.state === 'done') {
      doneFresh = true
      clearTimeout(doneTimer)
      doneTimer = setTimeout(() => { doneFresh = false; render() }, DONE_MS)
    }
    if (status.state === 'ask') panelOpen = true
    render()
  })
  es.addEventListener('reload', () => {
    const act = reloadAction(MODE, Array.from(document.scripts, s => s.src), picking || picked.length > 0)
    if (act === 'now') setTimeout(() => location.reload(), 300)
    if (act === 'later') { reloadLater = true; ui.later.hidden = false; if (!ui.bubble.hidden) placeBubble() }
  })
  es.addEventListener('ack', ev => onAck(JSON.parse(ev.data)))
  es.onerror = async () => {
    try {
      const r = await fetch(`/__yubi/hello?k=${encodeURIComponent(KEY)}`)
      conn = r.status === 403 ? 'stale' : 'ok'
    } catch {
      conn = 'down'
    }
    if (conn === 'stale') es.close()
    render()
  }
}

async function post(url, body) {
  let r
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-yubi-key': KEY },
      body: JSON.stringify(body),
    })
  } catch (err) {
    if (err instanceof TypeError) throw new Error('指差しの中継役に届きませんでした（Claude Code で /yubi を確かめてください）')
    throw err
  }
  if (r.ok) return
  if (r.status === 413) throw new Error('長すぎます（短くしてください）')
  if (r.status === 400) throw new Error('内容が正しくありません（頼みごとを書いてください）')
  if (r.status === 403) throw new Error('ページを読み直してください')
  throw new Error(`送れませんでした（${r.status}）`)
}

function sendWithAck(kind, url, body, where) {
  if (ackWait) return
  setBusy(true)
  say(where, kind === 'draft' ? '下書きに入れています…' : '送っています…')
  const timer = setTimeout(() => {
    ackWait = null
    setBusy(false)
    say(where, '応答がありません（Claude Code を確かめてください）')
  }, ACK_MS)
  ackWait = { kind, where, timer }
  post(url, body).catch(err => {
    clearTimeout(timer)
    ackWait = null
    setBusy(false)
    say(where, err.message)
  })
}

function onAck(a) {
  if (!ackWait || a.kind !== ackWait.kind) return
  const where = ackWait.where
  clearTimeout(ackWait.timer)
  ackWait = null
  setBusy(false)
  if (!a.ok) {
    say(where, `${a.kind === 'draft' ? '下書きに入れられませんでした' : '送れませんでした'}（${a.reason ?? '理由不明'}）`)
    return
  }
  if (a.kind === 'reply') {
    panelOpen = false
    render()
    return
  }
  closeBubble(true)
  if (a.kind === 'draft') flash('下書きに入れました')
}

// ---- 選ぶモード ----

function fromPage(e) {
  const path = e.composedPath ? e.composedPath() : []
  if (path.includes(ui.host)) return null
  const el = e.target
  return el && el.nodeType === 1 && el !== document.documentElement ? el : null
}

// svg の中の部品（path・g など）は、その svg にまとめる
function lift(el) {
  const tags = []
  for (let n = el; n && tags.length < 40; n = n.parentElement) tags.push(n.tagName)
  let out = el
  for (let up = svgLift(tags); up > 0 && out.parentElement; up--) out = out.parentElement
  return out
}

// カーソルの下の重なりが前と同じなら、↑↓ で移した位置（札の部品）を保つ。変わったら一番上に戻す
function hoverAt(x, y) {
  const raw = document.elementsFromPoint(x, y).filter(el => el !== ui.host && el !== document.documentElement)
  const next = uniqueInOrder(raw.map(lift))
  hoverIdx = hoverIndexAfter(hoverStack, next, hoverIdx)
  hoverStack = next
  drawBox(hoverStack[hoverIdx] ?? null)
}

function onMove(e) {
  if (!picking && !e.altKey) {
    if (altHover) { altHover = false; hoverStack = []; drawBox(null) }
    return
  }
  altHover = !picking
  if (fromPage(e)) hoverAt(e.clientX, e.clientY)
  else { hoverStack = []; drawBox(null) }
}

function onDown(e) {
  if ((picking || e.altKey) && fromPage(e)) { e.preventDefault(); e.stopPropagation() }
}

// pointerdown / pointerup / mouseup も止める（ポインターで動く部品（メニューなど）を動かさない）
function onPointer(e) {
  if ((picking || e.altKey) && fromPage(e)) { e.stopPropagation(); e.stopImmediatePropagation() }
}

function onClick(e) {
  if (!picking && !e.altKey) return
  const el = fromPage(e)
  if (!el) return
  e.preventDefault()
  e.stopPropagation()
  e.stopImmediatePropagation()
  const own = lift(el)
  choose(hoverStack.includes(own) ? hoverStack[hoverIdx] : own)
}

function inOurUi(e) {
  return e.composedPath ? e.composedPath().includes(ui.host) : false
}

function onKey(e) {
  const arrow = e.key === 'ArrowUp' || e.key === 'ArrowDown'
  if (arrow && hoverStack.length && (picking || (altHover && e.altKey && !inOurUi(e)))) {
    e.preventDefault()
    e.stopPropagation()
    hoverIdx = stepIndex(hoverIdx, e.key === 'ArrowDown' ? 1 : -1, hoverStack.length)
    drawBox(hoverStack[hoverIdx])
    return
  }
  // 開いている欄のキー（間隔・位置の矢印キー。§23-5）
  if (lookOpen && panels[lookOpen].key && panels[lookOpen].key(e)) return
  if (e.key !== 'Escape') return
  // 1回目は開いている欄だけ閉じ、その枠のその欄の変更を捨てる（書いた頼みごとと範囲は残す。§23-3）
  if (lookOpen) {
    e.preventDefault()
    e.stopPropagation()
    const i = curIdx()
    if (i >= 0) panels[lookOpen].reset(slots[i])
    closeLook()
    return
  }
  if (picking || !ui.bubble.hidden) { e.stopPropagation(); cancelAll() }
}

function onKeyUp(e) {
  if (e.key === 'Alt' && altHover && !picking) { altHover = false; hoverStack = []; drawBox(null) }
}

function newSlot(el) {
  return { origin: el, info: null, to: {}, padSides: null, scope: 'one', same: undefined }
}

function startPicking() {
  closeLook()
  if (conn !== 'ok') { panelOpen = true; render(); return }
  picking = true
  panelOpen = false
  ui.bubble.hidden = true
  render()
}

function choose(el) {
  if (picked.length >= MAX_ELS) return
  if (!picked.includes(el)) { picked.push(el); slots.push(newSlot(el)); closeLook() }
  picking = false
  altHover = false
  hoverStack = []
  drawBox(null)
  openBubble()
  drawMarks()
  render()
}

function cancelAll() {
  picking = false
  drawBox(null)
  closeBubble(true)
  render()
}

// ---- 入力欄 ----

function openBubble() {
  ui.bubble.hidden = false
  const first = picked[0]
  ui.nums.textContent = picked.length > 1
    ? `選んだ部品：${picked.map((_, i) => NUMS[i]).join('')}（文の中で ①② と書けます）`
    : `選んだ部品：${labelOf(first.tagName.toLowerCase(), Array.from(first.classList))}`
  say('bubble', '')
  placeBubble()
  updateButtons()
  ui.text.focus()
}

// 完了の読み直しを後に回していたら、作業が終わったところで読み直す（§21）。中継役が止まっていたら読み直さない（エラー画面になるため）
function reloadIfLater() {
  if (!reloadLater || picking || picked.length) return
  reloadLater = false
  if (conn === 'down') return
  setTimeout(() => {
    if (picking || picked.length) { reloadLater = true; ui.later.hidden = false; return }
    location.reload()
  }, 300)
}

function closeBubble(clear) {
  ui.bubble.hidden = true
  if (clear) {
    ledgerRestoreAll(ledger)
    ui.text.value = ''
    picked = []
    slots = []
    closeLook()
    sizeWhat = null
    drag = null
    for (const p of Object.values(panels)) if (p.clear) p.clear()
    reloadIfLater()
  }
  drawMarks()
}

function curIdx() {
  return picked.length - 1
}

// 元の部品から外側への並び
function chainOf(el) {
  const out = []
  for (let n = el; n && n !== document.documentElement; n = n.parentElement) out.push(n)
  return out
}

function placeBubble() {
  const last = picked[picked.length - 1]
  if (!last) return
  const w = Math.min(320, window.innerWidth - 32)
  const h = ui.bubble.offsetHeight || 190
  const { top, left } = bubblePos(last.getBoundingClientRect(), w, h, window.innerWidth, window.innerHeight)
  ui.bubble.style.top = `${top}px`
  ui.bubble.style.left = `${left}px`
}

function updateButtons() {
  ui.bubble.querySelector('[data-act="more"]').disabled = picked.length >= MAX_ELS
  const i = curIdx()
  ui.bubble.querySelector('[data-act="down"]').disabled = !(i >= 0 && innerStep(chainOf(slots[i].origin), picked[i]))
}

// 最後の枠の部品を入れ替える。その枠の3つの欄の仮の見た目と変更は捨てる（元の部品は覚えたまま。§23-3）
function replaceLast(el) {
  const i = curIdx()
  const reopen = lookOpen
  closeLook()
  resetAll(slots[i])
  picked[i] = el
  slots[i] = newSlot(slots[i].origin)
  openBubble()
  drawMarks()
  if (reopen) openLook(reopen)
}

function setBusy(on) {
  for (const b of ui.bubble.querySelectorAll('button')) b.disabled = on
  for (const b of ui.panel.querySelectorAll('button')) b.disabled = on
  if (!on) updateButtons()
}

function say(where, text) {
  const el = where === 'panel' ? ui.panel.querySelector('.pmsg') : ui.msg
  if (el) el.textContent = text
}

function onBubbleClick(e) {
  const look = e.target && e.target.dataset ? e.target.dataset.look : null
  if (look) { if (lookOpen === look) closeLook(); else openLook(look); return }
  const act = e.target && e.target.dataset ? e.target.dataset.act : null
  if (!act) return
  const i = curIdx()
  const last = picked[i]
  if (act === 'up' && last) {
    const parent = last.parentElement
    if (parent && parent !== document.documentElement) replaceLast(parent)
  }
  if (act === 'down' && last) {
    const inner = innerStep(chainOf(slots[i].origin), last)
    if (inner) replaceLast(inner)
  }
  if (act === 'more') startPicking()
  if (act === 'cancel') cancelAll()
  if (act === 'draft' || act === 'send') submit(act)
}

function onTextKey(e) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault()
    submit('send')
  }
  if (e.key === 'Escape') { e.preventDefault(); cancelAll() }
  // 打った文字をページ側のキー操作へ渡さない
  e.stopPropagation()
}

function slotSize(slot) {
  if (!slot || !slot.info) return null
  return buildSize({ scope: slot.scope, same: slot.same, from: slot.info.from, to: slot.to, imgSelector: slot.info.imgSelector })
}

function submit(kind) {
  if (picked.some(el => !el.isConnected)) return say('bubble', GONE)
  let els
  try {
    // 仮の見た目をすべて戻して元のページの値を集め、集めたら3つの欄とも当て直す（§23-7）
    els = withoutPreviews(() => picked.map((el, i) => {
      const info = collect(el)
      const size = slotSize(slots[i])
      if (size) info.size = size
      for (const [name, p] of Object.entries(panels)) {   // 間隔・位置（space）・色（color）。欄の名前が項目の名前
        if (!p.collect) continue
        const v = p.collect(slots[i])
        if (v) info[name] = v
      }
      return info
    }))
  } catch (err) {
    return say('bubble', `部品の情報を集められませんでした（${err.message}）`)
  }
  const words = ui.text.value.trim() || emptyWords(els)
  if (!words) return say('bubble', 'どう直したいかを書いてください')
  if ([...words].length > WORDS_MAX) return say('bubble', '頼みごとが長すぎます（1,000字まで）')
  const body = { v: 1, type: 'pick', kind, words, page: { url: location.href, width: window.innerWidth }, els }
  sendWithAck(kind, '/__yubi/pick', body, 'bubble')
}

// ---- 入力欄の中の欄（設計書 §23-3・§23-3a） ----

// 欄の名前 → { open, render, hide, reset(slot), apply(slot), draw, key?(e), collect?(slot), clear?, holdBubble? }
// 間隔・位置（space）は picker-space.js、色（color）は picker-color.js が作り、build() で足す
const panels = {
  size: {
    open: openSize,
    render: renderSize,
    hide: hideSize,
    reset: resetSizeOf,
    apply: slot => { if (slot.info && Object.keys(slot.to).length) applyPreview(slot) },
    draw: () => { drawWhats(); drawGrip() },
  },
}

// 新しい欄に渡す物（§23-10）。picker.js の変数は直に触らせない
const ctx = {
  cur: () => { const i = curIdx(); return i < 0 ? null : { i, el: picked[i], slot: slots[i], many: picked.length > 1 } },
  elOf: slot => picked[slots.indexOf(slot)],
  ui: () => ui,
  ledger,
  GONE,
  isOpen: name => lookOpen === name,
  targetsOf, scopeRow, say, placeBubble, drawMarks, focusInField, withoutPreviews,
  scaleNear, cssSize, textHolders, imgsIn, classList, toNode, countOf,
}

function openLook(name) {
  const c = ctx.cur()
  if (!c || !c.el.isConnected) return say('bubble', GONE)
  const was = lookOpen
  lookOpen = name
  if (was && was !== name) panels[was].hide()
  sameOf(c.slot, c.el)
  panels[name].open()
  markLooks()
}

function closeLook() {
  const was = lookOpen
  lookOpen = null
  if (was) panels[was].hide()
  markLooks()
}

function markLooks() {
  if (!ui) return
  for (const b of ui.bubble.querySelectorAll('[data-look]')) b.classList.toggle('on', b.dataset.look === lookOpen)
}

// 同じ作りの部品（範囲の行）。その枠で最初に欄を開いたときに1回だけ測る（§23-3a）
function sameOf(slot, el) {
  if (slot.same === undefined) slot.same = sameShape(el)
  return slot.same
}

// 範囲は3つの欄で共通。変えたら、その枠の3つの欄を当て直す（§23-3a）
function setScope(slot, scope) {
  slot.scope = scope
  reapplyAll(slot)
  if (lookOpen) panels[lookOpen].render()
  drawMarks()   // 変えた値が無くても、範囲の緑の枠を描き直す
}

function reapplyAll(slot) {
  for (const p of Object.values(panels)) p.apply(slot)
}

function resetAll(slot) {
  for (const p of Object.values(panels)) p.reset(slot)
}

// 範囲の行。同じ作りの部品が2つ以上あるときだけ
function scopeRow(parent, slot) {
  if (!slot.same) return
  const row = document.createElement('div')
  row.className = 'row'
  for (const [scope, text] of [['one', 'この1つだけ'], ['all', `同じ作りの部品すべて（${slot.same.count} 個）`]]) {
    const b = document.createElement('button')
    b.textContent = text
    if (slot.scope === scope) b.className = 'on'
    b.addEventListener('click', () => setScope(slot, scope))
    row.appendChild(b)
  }
  parent.appendChild(row)
}

// 指差しの入力欄の文字・数字の欄にフォーカスがあるか。閉じた Shadow DOM の中は ui.root でしか見えない（§23-5）
function focusInField() {
  const a = ui.root.activeElement
  return Boolean(a) && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT')
}

// 仮の見た目をすべて戻してから fn を呼び、終わったら3つの欄とも当て直す（送るとき・このページの色を集めるとき）
function withoutPreviews(fn) {
  ledgerRestoreAll(ledger)
  try { return fn() } finally { for (const s of slots) reapplyAll(s) }
}

// ---- 大きさ（0.2.0） ----

function imgsIn(el) {
  return Array.from(el.querySelectorAll('svg, img')).filter(x => !(x.parentElement && x.parentElement.closest('svg')))
}

// 文字を直に持ち、画面に出ている部品（自分と中の部品。200 まで）
function textHolders(el) {
  const out = []
  const walk = n => {
    if (out.length >= 200 || n.nodeType !== 1 || n === ui.host) return
    const own = Array.from(n.childNodes).some(c => c.nodeType === 3 && c.textContent.trim())
    if (own) {
      const r = n.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) out.push(n)
    }
    for (const c of n.children) walk(c)
  }
  walk(el)
  return out
}

function sameShapeEls(el) {
  const key = sameShapeKey(el.tagName, classList(el))
  if (!key) return [el]
  let list
  try { list = Array.from(document.querySelectorAll(key)) } catch { return [el] }
  return list.filter(x => sameShapeKey(x.tagName, classList(x)) === key)
}

function sameShape(el) {
  const list = sameShapeEls(el)
  return list.length >= 2 ? { label: labelOf(el.tagName.toLowerCase(), classList(el)), count: list.length } : null
}

function boxOf(el) {
  const cs = getComputedStyle(el)
  const n = p => parseFloat(cs.getPropertyValue(p)) || 0
  return {
    sizing: cs.boxSizing,
    padL: n('padding-left'), padR: n('padding-right'), padT: n('padding-top'), padB: n('padding-bottom'),
    bordL: n('border-left-width'), bordR: n('border-right-width'), bordT: n('border-top-width'), bordB: n('border-bottom-width'),
  }
}

// 先祖の縮み（transform: scale など）。近くの HTML の部品（自分は含めない）の 画面の上の幅 ÷ offsetWidth
function scaleNear(node) {
  for (let n = node.parentElement; n; n = n.parentElement) {
    if (n instanceof HTMLElement && n.offsetWidth > 0) return scaleOf(n.getBoundingClientRect().width, n.offsetWidth)
  }
  return 1
}

// 先祖の縮みを外した大きさ（CSS の px・枠線と内側の余白を含む・整数）。svg には offsetWidth が無いので、画面の上の大きさを縮みで割る
function cssSize(node) {
  if (node instanceof HTMLElement) return { w: node.offsetWidth, h: node.offsetHeight }
  const r = node.getBoundingClientRect()
  return unscale({ w: r.width, h: r.height }, scaleNear(node))
}

// 欄を最初に開いたときに、変える前の値を測る（その枠の仮の見た目がまだ無いうちに）
function measure(el) {
  const tag = el.tagName.toLowerCase()
  const isImg = tag === 'svg' || tag === 'img'
  const imgs = isImg ? [] : imgsIn(el)
  const sizes = uniqueSizes(textHolders(el).map(h => parseFloat(getComputedStyle(h).fontSize)))
  const cs = getComputedStyle(el)
  const { buttons, notes } = sizeButtons({ display: cs.display, isImg, imgCount: imgs.length, textSizes: sizes })
  const img = isImg ? el : imgs.length === 1 ? imgs[0] : null
  const pad = ['top', 'right', 'bottom', 'left'].map(s => clampSize('padding', parseFloat(cs.getPropertyValue(`padding-${s}`)) || 0))
  const from = { padding: paddingText(pad) }
  if (buttons.includes('box')) from.box = cssSize(el)
  if (img) from.img = cssSize(img)
  if (sizes.length === 1) from.text = sizes[0]
  // 絵の住所が 300字を超えたら付けない（長い住所1つで送り全体が 400 になるのを防ぐ）
  const imgSel = img && img !== el ? buildSelector(toNode(img), countOf) : null
  return {
    buttons, notes, img, pad, from,
    imgSelector: imgSel && [...imgSel].length <= 300 ? imgSel : null,
  }
}

function openSize() {
  const i = curIdx()
  const el = picked[i]
  if (!el || !el.isConnected) return say('bubble', GONE)
  const slot = slots[i]
  sameOf(slot, el)
  if (!slot.info) slot.info = measure(el)
  if (!sizeWhat || !slot.info.buttons.includes(sizeWhat)) sizeWhat = slot.info.buttons[0]
  renderSize()
  placeBubble()
  drawMarks()
}

function hideSize() {
  drag = null   // つまみを引いている途中で閉じたら（Esc など）、引くのもやめる。やめないと、閉じた欄の枠に値が戻る
  ui.size.hidden = true
  drawMarks()
}

// その枠の大きさの仮の見た目と変更を捨てる（範囲は戻さない。§23-3a）
function resetSizeOf(slot) {
  ledgerRestore(ledger, slot)
  slot.to = {}
  slot.padSides = null
}

// 大きさの欄の「元に戻す」
function resetSize() {
  const i = curIdx()
  if (i >= 0) resetSizeOf(slots[i])
  renderSize()
  drawMarks()
}

function valueOf(slot, what) {
  if (what === 'padding') return slot.padSides ?? slot.info.pad
  return slot.to[what] ?? slot.info.from[what]
}

function setValue(what, v) {
  const slot = slots[curIdx()]
  if (what === 'padding') { slot.padSides = v; slot.to.padding = paddingText(v) }
  else slot.to[what] = v
  applyPreview(slot)
}

function targetsOf(slot, el) {
  return slot.scope === 'all' && slot.same ? limitTargets(sameShapeEls(el), el, SAME_MAX) : [el]
}

function imgOfTarget(t, el, slot) {
  if (t === el) return slot.info.img
  const tag = t.tagName.toLowerCase()
  if (tag === 'svg' || tag === 'img') return t
  const list = imgsIn(t)
  return list.length === 1 ? list[0] : null
}

// その枠の仮の見た目をいったん戻し、いまの値をすべて当て直す
function applyPreview(slot) {
  ledgerRestore(ledger, slot)
  const el = picked[slots.indexOf(slot)]
  if (!el || !el.isConnected) return say('bubble', GONE)
  for (const t of targetsOf(slot, el)) {
    for (const what of SIZE_ORDER) {
      const v = slot.to[what]
      if (v === undefined) continue
      if (what === 'padding') ledgerApply(ledger, slot, t, t.style, 'padding', v)
      if (what === 'text') for (const h of textHolders(t)) ledgerApply(ledger, slot, h, h.style, 'font-size', `${v}px`)
      if (what === 'img' || what === 'box') {
        const node = what === 'img' ? imgOfTarget(t, el, slot) : t
        if (!node) continue
        const css = cssSizeFor(v, boxOf(node))
        ledgerApply(ledger, slot, node, node.style, 'width', `${css.w}px`)
        ledgerApply(ledger, slot, node, node.style, 'height', `${css.h}px`)
      }
    }
  }
  checkTook(slot, el)
  drawMarks()
}

function checkTook(slot, el) {
  const warn = ui.size.querySelector('.warn')
  if (!warn) return
  let ok = true
  for (const what of ['box', 'img']) {
    const v = slot.to[what]
    const node = what === 'img' ? slot.info.img : el
    if (!v || !node) continue
    if (!sizeTook(v, cssSize(node))) ok = false
  }
  warn.textContent = ok ? '' : SIZE_NOTES.noEffect
}

function renderSize() {
  const i = curIdx()
  const slot = slots[i]
  const info = slot.info
  const box = ui.size
  box.textContent = ''
  box.hidden = false
  const add = (parent, tag, text, cls) => {
    const x = document.createElement(tag)
    if (text) x.textContent = text
    if (cls) x.className = cls
    parent.appendChild(x)
    return x
  }
  add(box, 'div', picked.length > 1 ? `${NUMS[i]} の大きさ` : '大きさ', 'dim')
  const whats = add(box, 'div', '', 'row')
  for (const w of info.buttons) {
    const b = add(whats, 'button', SIZE_LABELS[w], w === sizeWhat ? 'on' : '')
    b.dataset.sz = 'what'
    b.dataset.what = w
  }
  for (const n of info.notes) add(box, 'div', n, 'note')
  scopeRow(box, slot)
  const ctl = add(box, 'div', '', 'ctl')
  const input = (key, label, value) => {
    if (label) add(ctl, 'span', label)
    const x = add(ctl, 'input')
    x.type = 'number'
    x.step = '1'
    x.value = String(value)
    x.dataset.key = key
    return x
  }
  const cur = valueOf(slot, sizeWhat)
  if (sizeWhat === 'box' || sizeWhat === 'img') {
    input('w', '幅', cur.w)
    input('h', '高さ', cur.h)
    add(ctl, 'span', 'px')
    add(box, 'div', sizeWhat === 'img' ? '右下のつまみを引っ張る（縦横の割合を保つ。Shift で別々に）' : '右下のつまみを引っ張る（Shift で縦横の割合を保つ）', 'dim')
  }
  if (sizeWhat === 'text') {
    const minus = add(ctl, 'button', 'A−')
    minus.dataset.sz = 'step'
    minus.dataset.d = '-1'
    input('px', '', cur)
    add(ctl, 'span', 'px')
    const plus = add(ctl, 'button', 'A＋')
    plus.dataset.sz = 'step'
    plus.dataset.d = '1'
  }
  if (sizeWhat === 'padding') {
    ;['上', '右', '下', '左'].forEach((label, k) => input(String(k), label, cur[k]))
    add(ctl, 'span', 'px')
  }
  add(box, 'div', '', 'warn')
  const row = add(box, 'div', '', 'row')
  const reset = add(row, 'button', '元に戻す')
  reset.dataset.sz = 'reset'
  checkTook(slot, picked[i])
  placeBubble()   // 欄の中身で入力欄の高さが変わるので置き直す
}

function onSizeClick(e) {
  const t = e.target
  if (!t || !t.dataset || !t.dataset.sz) return
  const slot = slots[curIdx()]
  if (!picked[curIdx()] || !picked[curIdx()].isConnected) return say('bubble', GONE)
  if (t.dataset.sz === 'what') { sizeWhat = t.dataset.what; renderSize(); drawMarks(); return }
  if (t.dataset.sz === 'step') { setValue('text', clampSize('text', valueOf(slot, 'text') + Number(t.dataset.d))); renderSize(); return }
  if (t.dataset.sz === 'reset') resetSize()
}

function onSizeInput(e) {
  const x = e.target
  if (!x || !x.dataset || x.dataset.key === undefined) return
  const n = Number(x.value)
  if (x.value === '' || !Number.isFinite(n)) return
  const slot = slots[curIdx()]
  if (sizeWhat === 'box' || sizeWhat === 'img') {
    const k = x.dataset.key
    const next = fitRatio(slot.info.from[sizeWhat], valueOf(slot, sizeWhat), k, n, sizeWhat === 'img')
    setValue(sizeWhat, next)
    const other = ui.size.querySelector(`input[data-key="${k === 'w' ? 'h' : 'w'}"]`)
    if (other) other.value = String(next[k === 'w' ? 'h' : 'w'])
  } else if (sizeWhat === 'text') {
    setValue('text', clampSize('text', n))
  } else if (sizeWhat === 'padding') {
    const sides = [...valueOf(slot, 'padding')]
    sides[Number(x.dataset.key)] = clampSize('padding', n)
    setValue('padding', sides)
  }
}

// 数字の欄：Enter は当てるだけ（送らない）・Shift＋↑↓ は 10px。キーはページに渡さない
function onSizeKey(e) {
  e.stopPropagation()
  const x = e.target
  if (!x || x.tagName !== 'INPUT') return
  if (e.key === 'Enter') {
    // 欄を作り直すので、同じ数字の欄にフォーカスを戻す（戻さないと、続けて押した ↑↓ でページが動く）
    e.preventDefault()
    const key = x.dataset.key
    renderSize()
    const again = ui.size.querySelector(`input[data-key="${key}"]`)
    if (again) { again.focus(); again.select() }
    return
  }
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.shiftKey) {
    e.preventDefault()
    x.value = String((Number(x.value) || 0) + (e.key === 'ArrowUp' ? 10 : -10))
    x.dispatchEvent(new Event('input', { bubbles: true }))
  }
}

function gripTarget() {
  const i = curIdx()
  if (lookOpen !== 'size' || i < 0 || !slots[i].info || (sizeWhat !== 'box' && sizeWhat !== 'img')) return null
  return sizeWhat === 'img' ? slots[i].info.img : picked[i]
}

function drawGrip() {
  if (drag) return
  const t = gripTarget()
  if (!t || !t.isConnected) { ui.grip.hidden = true; return }
  const r = t.getBoundingClientRect()
  const outside = r.width < 20 || r.height < 20
  ui.grip.style.left = `${outside ? r.right + 2 : r.right - 12}px`
  ui.grip.style.top = `${outside ? r.bottom + 2 : r.bottom - 12}px`
  ui.grip.hidden = false
}

function onGripDown(e) {
  if (!gripTarget()) return
  e.preventDefault()
  e.stopPropagation()
  ui.grip.setPointerCapture(e.pointerId)
  // 画面で引いた量は、先祖の縮みで割って CSS の px にする
  drag = { x: e.clientX, y: e.clientY, start: { ...valueOf(slots[curIdx()], sizeWhat) }, what: sizeWhat, scale: scaleNear(gripTarget()) }
}

function onGripMove(e) {
  if (!drag) return
  e.preventDefault()
  e.stopPropagation()
  const keep = drag.what === 'img' ? !e.shiftKey : e.shiftKey
  const next = dragSize(drag.start, (e.clientX - drag.x) / drag.scale, (e.clientY - drag.y) / drag.scale, keep)
  ui.grip.style.left = `${e.clientX - 6}px`
  ui.grip.style.top = `${e.clientY - 6}px`
  setValue(drag.what, next)
  for (const k of ['w', 'h']) {
    const x = ui.size.querySelector(`input[data-key="${k}"]`)
    if (x) x.value = String(next[k])
  }
}

function onGripUp(e) {
  if (!drag) return
  e.stopPropagation()
  drag = null
  drawMarks()
}

// 変える物に緑の枠
function drawWhats() {
  ui.whats.textContent = ''
  const i = curIdx()
  if (lookOpen !== 'size' || i < 0 || !slots[i].info || !picked[i].isConnected) return
  const el = picked[i]
  const slot = slots[i]
  const nodes = []
  for (const t of targetsOf(slot, el)) {
    if (sizeWhat === 'img') { const n = imgOfTarget(t, el, slot); if (n) nodes.push(n) }
    else if (sizeWhat === 'text') nodes.push(...textHolders(t))
    else nodes.push(t)
  }
  for (const n of nodes.slice(0, SAME_MAX)) {
    const r = n.getBoundingClientRect()
    const m = document.createElement('div')
    m.className = 'what'
    Object.assign(m.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` })
    ui.whats.appendChild(m)
  }
}

// ---- 部品の情報 ----

function classList(el) {
  return Array.from(el.classList ?? [])
}

function toNode(el) {
  if (!el || el.nodeType !== 1) return null
  const parent = el.parentElement
  const tag = el.tagName.toLowerCase()
  const shape = e => e.tagName.toLowerCase() + '.' + selectorClasses(classList(e)).join('.')
  let index = 1
  let likeMe = 0
  if (parent) {
    const sibs = Array.from(parent.children)
    index = sibs.indexOf(el) + 1
    const mine = shape(el)
    likeMe = sibs.filter(s => s !== el && shape(s) === mine).length
  }
  const attrs = {}
  for (const a of ['data-testid', 'data-test', 'data-cy']) {
    const v = el.getAttribute(a)
    if (v) attrs[a] = v
  }
  return { tag, id: el.id || '', classes: classList(el), attrs, index, likeMe, get parent() { return toNode(parent) } }
}

function countOf(sel) {
  try { return document.querySelectorAll(sel).length } catch { return 0 }
}

function textOf(el) {
  const t = (el.innerText || el.getAttribute('alt') || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim()
  return trimText(t, TEXT_MAX)
}

function frameworkInfo(el) {
  const out = { components: [], source: null }
  const fk = Object.keys(el).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'))
  if (fk) {
    const fiber = el[fk]
    out.source = debugSourceToSource(fiber._debugSource)
      ?? (fiber._debugStack ? stackToSource(fiber._debugStack.stack ?? String(fiber._debugStack)) : null)
    for (let f = fiber.return; f && out.components.length < 3; f = f.return) {
      const name = componentName(f.type)
      if (name && /^[A-Z]/.test(name) && !out.components.includes(name)) out.components.push(name)
    }
    return out
  }
  let inst = el.__vueParentComponent
  if (inst) {
    if (inst.type && inst.type.__file) out.source = { file: inst.type.__file, line: null, approx: false }
    for (; inst && out.components.length < 3; inst = inst.parent) {
      const name = inst.type && (inst.type.name || inst.type.__name)
      if (name && !out.components.includes(name)) out.components.push(name)
    }
  }
  return out
}

function collect(el) {
  const cs = getComputedStyle(el)
  const rect = el.getBoundingClientRect()
  const parents = []
  let p = el.parentElement
  for (let i = 0; i < 2 && p && p !== document.documentElement; i++, p = p.parentElement) {
    const pcs = getComputedStyle(p)
    parents.push({ label: labelOf(p.tagName.toLowerCase(), classList(p)), styles: parentStyles(prop => pcs.getPropertyValue(prop)) })
  }
  const info = {
    selector: buildSelector(toNode(el), countOf),
    classes: (el.getAttribute('class') || '').trim(),
    text: textOf(el),
    rect: { x: Math.round(rect.left + window.scrollX), y: Math.round(rect.top + window.scrollY), w: Math.round(rect.width), h: Math.round(rect.height) },
    styles: pickStyles(prop => cs.getPropertyValue(prop)),
    parents,
  }
  const fw = frameworkInfo(el)
  if (fw.components.length) info.components = fw.components
  if (fw.source) info.source = fw.source
  return info
}

// ---- 描く ----

function drawBox(el) {
  if (!el) { ui.box.hidden = true; return }
  const r = el.getBoundingClientRect()
  Object.assign(ui.box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` })
  const t = el.childElementCount > 20 ? '' : trimText(el.innerText || '', 10)
  ui.tag.textContent = `${labelOf(el.tagName.toLowerCase(), classList(el))}  ${Math.round(r.width)}×${Math.round(r.height)}${t ? `「${t}」` : ''}`
  ui.box.hidden = false
}

function drawMarks() {
  if (!ui) return
  ui.marks.textContent = ''
  picked.forEach((el, i) => {
    const r = el.getBoundingClientRect()
    const m = document.createElement('div')
    m.className = 'mark'
    Object.assign(m.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` })
    const label = document.createElement('span')
    label.textContent = picked.length > 1 ? NUMS[i] : '選択中'
    m.appendChild(label)
    ui.marks.appendChild(m)
  })
  // 帯・⊕ を引いている間は入力欄を置き直さない（§23-5）
  if (!ui.bubble.hidden && !Object.values(panels).some(p => p.holdBubble && p.holdBubble())) placeBubble()
  for (const p of Object.values(panels)) p.draw()
}

function flash(text) {
  ui.toast.textContent = text
  ui.toast.hidden = false
  setTimeout(() => { ui.toast.hidden = true }, 1500)
}

const LOOKS = {
  idle: () => ['☝', ''],
  waiting: () => [`待ち ${status.waiting ?? 1}`, 'wait'],
  working: () => ['…', 'work'],
  done: () => (doneFresh ? ['✓', 'done'] : ['☝', '']),
  ask: () => ['？', 'ask'],
  look: () => ['！', 'ask'],
  stopped: () => ['×', 'stop'],
  down: () => ['☝', 'off'],
  stale: () => ['☝', 'off'],
}

function shownState() {
  if (conn === 'down') return 'down'
  if (conn === 'stale') return 'stale'
  return status.state in LOOKS ? status.state : 'idle'
}

function render() {
  if (!ui) return
  const st = shownState()
  const [label, cls] = LOOKS[st]()
  ui.ball.textContent = picking ? '選ぶ…' : label
  ui.ball.className = `ball ${picking ? 'picking' : cls}`
  ui.panel.hidden = !panelOpen
  if (panelOpen) {
    // 返事を書いている途中で中身を作り直さないよう、状態が変わったときだけ描く
    const key = JSON.stringify([st, status])
    if (key !== panelKey) { panelKey = key; renderPanel(st) }
  } else {
    panelKey = ''
  }
}

function renderPanel(st) {
  const p = ui.panel
  p.textContent = ''
  const add = (tag, text, cls) => {
    const el = document.createElement(tag)
    if (text) el.textContent = text
    if (cls) el.className = cls
    p.appendChild(el)
    return el
  }
  if (st === 'down') { add('p', '指差しが止まっています。Claude Code で /yubi を打ってください。'); return }
  if (st === 'stale') { add('p', '指差しが新しく始まりました。ページを読み直してください。'); return }
  add('div', `届け先：${status.target ?? ''}`, 'dim')
  if (status.head) add('div', `頼みごと：${status.head}`, 'dim')
  if (st === 'idle') add('p', '「部品を選ぶ」か、Alt＋クリックで部品を選べます。')
  if (st === 'waiting') add('p', `${status.waiting ?? 1} 番目に送ります。`)
  if (st === 'working') add('p', `Claude が作業中です${status.waiting ? `（待ち ${status.waiting}）` : ''}。`)
  if (st === 'done') {
    add('p', status.noEdit ? '完了（書き換えなし）' : '完了')
    if (status.text) add('pre', status.text)
  }
  if (st === 'look') add('p', 'Claude Code（ターミナル）に許可か質問の画面が出ています。そちらで答えてください（ブラウザからは答えられません）。')
  if (st === 'stopped') add('p', `止まりました（${status.text ?? '理由不明'}）`)
  if (st === 'ask') {
    add('p', '確認があります')
    if (status.text) add('pre', status.text)
    if (status.waiting) add('div', `待ち ${status.waiting}：返事のあとに送ります。`, 'dim')
    for (const c of status.choices ?? []) {
      const b = add('button', `${c.n}. ${c.label}`)
      b.dataset.choice = String(c.n)
    }
    const ta = add('textarea')
    ta.rows = 2
    ta.placeholder = '返事を書く（選んだ番号に足す文も書けます）'
    ta.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && ev.keyCode !== 229) { ev.preventDefault(); sendReply(null) }
      ev.stopPropagation()
    })
    for (const t of ['keyup', 'keypress']) ta.addEventListener(t, ev => ev.stopPropagation())
    const send = add('button', '返事を送る', 'main')
    send.dataset.act = 'reply'
  }
  add('div', '', 'pmsg')
  if (st !== 'ask') {
    const b = add('button', '部品を選ぶ', 'main')
    b.dataset.act = 'pick'
  }
  if (st === 'idle' || st === 'done' || st === 'stopped') add('div', '丸が消えたときは、URL が中継の番号（4000 番など）か確かめてください。', 'dim')
}

function sendReply(choice) {
  const ta = ui.panel.querySelector('textarea')
  const words = ta ? ta.value.trim() : ''
  if (!choice && !words) return say('panel', '番号を選ぶか、返事を書いてください')
  if ([...words].length > WORDS_MAX) return say('panel', '頼みごとが長すぎます（1,000字まで）')
  const body = { v: 1, type: 'reply' }
  if (choice) body.choice = choice
  if (words) body.words = words
  sendWithAck('reply', '/__yubi/reply', body, 'panel')
}

function onPanelClick(e) {
  const t = e.target
  if (!t || !t.dataset) return
  if (t.dataset.choice) sendReply(Number(t.dataset.choice))
  if (t.dataset.act === 'reply') sendReply(null)
  if (t.dataset.act === 'pick') { panelOpen = false; startPicking() }
}

function onBall() {
  if (picking) { picking = false; drawBox(null); if (picked.length) openBubble(); else reloadIfLater(); render(); return }
  if (shownState() === 'idle' && !panelOpen) { startPicking(); return }
  panelOpen = !panelOpen
  render()
}
