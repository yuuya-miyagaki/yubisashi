// 選ぶ仕掛けの計算だけ。ページの部品に直接さわらないので、Node でもテストできる

export const MAX_ELS = 5
export const NUMS = ['①', '②', '③', '④', '⑤']

export const STYLE_PROPS = [
  'display', 'position', 'top', 'right', 'bottom', 'left', 'z-index', 'margin', 'padding', 'gap',
  'flex-direction', 'justify-content', 'align-items', 'grid-template-columns', 'font-family', 'font-size',
  'font-weight', 'line-height', 'letter-spacing', 'color', 'background-color', 'border', 'border-radius',
  'box-shadow', 'text-align',
]

const OMIT = new Set(['0px', 'none', 'normal', 'auto', 'static', 'rgba(0, 0, 0, 0)', 'transparent'])
const DEFAULTS = {
  'flex-direction': ['row'],
  'text-align': ['start', 'left'],
  'font-weight': ['400'],
  'justify-content': ['normal', 'flex-start', 'start'],
  'align-items': ['normal', 'stretch'],
}
const ALWAYS = new Set(['display', 'color', 'font-size'])
const OFFSETS = new Set(['top', 'right', 'bottom', 'left', 'z-index'])
const FLEXGRID_ONLY = new Set(['gap', 'justify-content', 'align-items'])
const SIMPLE = /^[A-Za-z_-][A-Za-z0-9_-]*$/
const TEST_ATTRS = ['data-testid', 'data-test', 'data-cy']

export function isGeneratedClass(c) {
  return /^css-[0-9a-z]+$/i.test(c)
    || /^sc-[0-9a-z]+$/i.test(c)
    || /^jsx-\d+$/.test(c)
    || /^svelte-[0-9a-z]+$/i.test(c)
    // CSS Modules の「名前__ハッシュ」。BEM の card__title（小文字だけ・数字なし）は残す
    || /__(?=[0-9A-Za-z_-]*\d)[0-9A-Za-z_-]{5,}$/.test(c)
    || /__(?=[0-9A-Za-z_-]*[A-Z])(?=[0-9A-Za-z_-]*[a-z])[0-9A-Za-z_-]{5,}$/.test(c)
    // 英字と数字が混ざった6字以上の塊（ハッシュ）
    || /^(?=[0-9a-z]*\d)(?=[0-9a-z]*[a-z])[0-9a-z]{6,}$/i.test(c)
}

export function isGeneratedId(id) {
  if (!id) return true
  if (/^\d+$/.test(id)) return true
  if (id.includes(':')) return true
  if (/^(radix|headlessui|mui|react-aria)[-_]/i.test(id)) return true
  return id.length >= 8 && /\d/.test(id) && /[a-z]/i.test(id) && !/[-_]/.test(id)
}

export function selectorClasses(classes) {
  return (classes ?? []).filter(c => SIMPLE.test(c) && !isGeneratedClass(c)).slice(0, 2)
}

export function labelOf(tag, classes) {
  return tag + selectorClasses(classes).map(c => `.${c}`).join('')
}

// 住所の1段分
export function segmentOf(n) {
  if (n.id && SIMPLE.test(n.id) && !isGeneratedId(n.id)) return `#${n.id}`
  for (const a of TEST_ATTRS) {
    const v = n.attrs && n.attrs[a]
    if (v) return `[${a}="${String(v).replace(/["\\]/g, '\\$&')}"]`
  }
  let sel = n.tag + selectorClasses(n.classes).map(c => `.${c}`).join('')
  if (n.likeMe > 0 && n.tag !== 'html' && n.tag !== 'body') sel += `:nth-child(${n.index})`
  return sel
}

// 1つに決まるまで親へたどって住所をつなぐ。count は「その住所でページの中に何個あるか」
export function buildSelector(n, count, maxDepth = 6) {
  const parts = []
  let cur = n
  while (cur && parts.length < maxDepth) {
    parts.unshift(segmentOf(cur))
    const sel = parts.join(' > ')
    if (count(sel) === 1) return sel
    cur = cur.parent
  }
  return parts.join(' > ')
}

export function compactBox(t, r, b, l) {
  if (t === b && r === l) return t === r ? t : `${t} ${r}`
  if (r === l) return `${t} ${r} ${b}`
  return `${t} ${r} ${b} ${l}`
}

// ブラウザが計算した値のうち、配置と雰囲気に関わるものだけ。get(prop) は getComputedStyle の値
export function pickStyles(get) {
  const out = {}
  const display = get('display') || ''
  const position = get('position') || 'static'
  const isFlex = display.includes('flex')
  const isGrid = display.includes('grid')
  for (const prop of STYLE_PROPS) {
    let v
    if (prop === 'margin' || prop === 'padding') {
      const sides = ['top', 'right', 'bottom', 'left'].map(s => get(`${prop}-${s}`) || '0px')
      if (sides.every(x => x === '0px')) continue
      v = compactBox(...sides)
    } else {
      v = get(prop)
    }
    if (!v) continue
    if (OFFSETS.has(prop) && position === 'static') continue
    if (FLEXGRID_ONLY.has(prop) && !isFlex && !isGrid) continue
    if (prop === 'flex-direction' && !isFlex) continue
    if (prop === 'grid-template-columns' && !isGrid) continue
    if (!ALWAYS.has(prop)) {
      if (OMIT.has(v) || (DEFAULTS[prop] ?? []).includes(v)) continue
      if (prop === 'border' && (/^0px\b/.test(v) || /\bnone\b/.test(v))) continue
    }
    if (prop === 'font-family') v = v.split(',').slice(0, 2).map(s => s.trim()).join(', ')
    out[prop] = v
  }
  return out
}

// 親の並べ方（display・flex/grid の向き・揃え・gap）
export function parentStyles(get) {
  const display = get('display') || ''
  const out = { display }
  if (display.includes('flex')) {
    const fd = get('flex-direction')
    if (fd && fd !== 'row') out['flex-direction'] = fd
  }
  if (display.includes('flex') || display.includes('grid')) {
    for (const p of ['justify-content', 'align-items', 'gap']) {
      const v = get(p)
      if (v && !OMIT.has(v) && !(DEFAULTS[p] ?? []).includes(v)) out[p] = v
    }
  }
  if (display.includes('grid')) {
    const v = get('grid-template-columns')
    if (v && v !== 'none') out['grid-template-columns'] = v
  }
  return out
}

export function trimText(s, max) {
  const chars = [...String(s ?? '').replace(/\s+/g, ' ').trim()]
  return chars.length > max ? chars.slice(0, max).join('') + '…' : chars.join('')
}

// React の部品の名前（関数・forwardRef・memo）
export function componentName(type) {
  if (!type) return null
  if (typeof type === 'function') return type.displayName || type.name || null
  if (typeof type === 'object') {
    if (type.displayName) return type.displayName
    if (type.render) return componentName(type.render)
    if (type.type) return componentName(type.type)
  }
  return null
}

const FRAME = /(https?:\/\/[^\s)]+?):(\d+):(\d+)/

// React 19 の _debugStack から、部品が書かれたファイルの場所（Vite の URL のときだけ）
export function stackToSource(stack) {
  const BUNDLE_PATHS = /^\/(?:assets|static|build|dist|_next)\//
  const BUNDLE_FILE = /[.-][A-Za-z0-9_]{8,}\.m?js$|\/bundle\.js$/
  for (const line of String(stack ?? '').split('\n').slice(1)) {
    const m = FRAME.exec(line)
    if (!m) continue
    let u
    try { u = new URL(m[1]) } catch { continue }
    let p
    try { p = decodeURIComponent(u.pathname) } catch { continue }
    if (/\/node_modules\/|\/\.vite\/|^\/@/.test(p)) continue
    if (/\/chunks\/|webpack-internal/.test(p)) return null
    if (BUNDLE_PATHS.test(p) || BUNDLE_FILE.test(p)) return null
    if (!/\.(jsx?|tsx?|vue|mjs)$/.test(p)) return null
    return { file: p.replace(/^\//, ''), line: Number(m[2]), approx: true }
  }
  return null
}

// React 18 までの _debugSource
export function debugSourceToSource(ds) {
  if (!ds || typeof ds !== 'object' || !ds.fileName) return null
  return { file: ds.fileName, line: ds.lineNumber ?? null, approx: false }
}

const HMR = /@vite\/client|\/_next\/|webpack-hmr|hot-update|livereload|browser-sync/

export function shouldReload(mode, scriptSrcs) {
  if (mode === 'static') return true
  return !(scriptSrcs ?? []).some(s => HMR.test(String(s)))
}

// 完了の読み直しをどうするか（§21）。'now'＝すぐ読み直す・'later'＝作業が終わるまで待つ・'none'＝何もしない（開発サーバーが読み直す）
export function reloadAction(mode, scriptSrcs, busy) {
  if (!shouldReload(mode, scriptSrcs)) return 'none'
  return busy ? 'later' : 'now'
}

// ---- 選び方（0.2.0） ----

// svg の中の部品（path・g など）なら、いちばん近い svg まで何段上がるか。tags は自分から外側への tagName
export function svgLift(tags) {
  for (let i = 0; i < tags.length; i++) {
    const t = String(tags[i] ?? '').toLowerCase()
    if (t === 'svg') return i
    if (t === 'foreignobject') return 0
  }
  return 0
}

export function uniqueInOrder(list) {
  const seen = new Set()
  return list.filter(x => (seen.has(x) ? false : (seen.add(x), true)))
}

// ↑↓ で動かした後の位置（端で止まる）
export function stepIndex(i, delta, len) {
  if (len <= 0) return 0
  return Math.min(len - 1, Math.max(0, i + delta))
}

// カーソルを動かした後の ↑↓ の位置。重なりの並びが前と同じ（同じ部品が同じ順）なら保ち、変わったら一番上
export function hoverIndexAfter(prev, next, idx) {
  const same = prev.length === next.length && next.every((x, i) => x === prev[i])
  return same && idx >= 0 && idx < next.length ? idx : 0
}

// chain は元の部品から外側への並び（[元, 親, 祖父…]）。いまの部品の1つ内側。元の部品か、並びに無ければ null
export function innerStep(chain, current) {
  const k = chain.indexOf(current)
  return k > 0 ? chain[k - 1] : null
}

export function stableClasses(classes) {
  return (classes ?? []).filter(c => SIMPLE.test(c) && !isGeneratedClass(c))
}

// 同じ作り＝同じタグで同じクラス（自動のクラスを除き、順は問わない）。CSS の住所としてそのまま使える形
export function sameShapeKey(tag, classes) {
  const cs = [...new Set(stableClasses(classes))].sort()
  return cs.length ? `${String(tag).toLowerCase()}.${cs.join('.')}` : null
}

// ---- 大きさ（0.2.0） ----

export const SIZE_LABELS = { box: '全体', text: '文字', img: '絵', padding: '内側の余白' }
export const SIZE_NOTES = {
  textMany: '中の文字の大きさが2種類以上あります。文字を変えるときは、文字の部品を選んでください',
  imgMany: '絵を変えるときは、絵を選んでください',
  noEffect: 'このページの作りでは、ここだけでは大きさが変わりません。数字はそのまま Claude に届きます',
}
export const SIZE_WORDS = '大きさを下の値に変えて'
export const SAME_MAX = 100
const SIZE_LIMITS = { box: [1, 4000], img: [1, 4000], text: [1, 400], padding: [0, 1000] }

export const roundHalf = n => Math.round(Number(n) * 2) / 2

export function uniqueSizes(list) {
  return uniqueInOrder((list ?? []).map(roundHalf).filter(n => Number.isFinite(n) && n > 0))
}

// 欄に出すボタン（全体・文字・絵・内側の余白の順）と、出せない理由の文
export function sizeButtons({ display, isImg, imgCount, textSizes }) {
  const buttons = []
  const notes = []
  if (!isImg && !['inline', 'contents', 'none'].includes(display)) buttons.push('box')
  const sizes = uniqueSizes(textSizes)
  if (sizes.length === 1) buttons.push('text')
  else if (sizes.length > 1) notes.push(SIZE_NOTES.textMany)
  if (isImg || imgCount === 1) buttons.push('img')
  else if (imgCount > 1) notes.push(SIZE_NOTES.imgMany)
  buttons.push('padding')
  return { buttons, notes }
}

export function clampSize(what, n) {
  const [lo, hi] = SIZE_LIMITS[what] ?? [0, 10000]
  const v = what === 'text' ? roundHalf(n) : Math.round(Number(n))
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo
}

// 見えている大きさ（枠線・内側の余白を含む）にするために当てる width・height
export function cssSizeFor(target, b) {
  if (b.sizing !== 'content-box') return { w: target.w, h: target.h }
  return {
    w: Math.max(0, target.w - b.padL - b.padR - b.bordL - b.bordR),
    h: Math.max(0, target.h - b.padT - b.padB - b.bordT - b.bordB),
  }
}

// 数字の欄で片方を打ったとき。keep なら base（変える前）の縦横の割合でもう片方も変える
export function fitRatio(base, cur, which, value, keep) {
  const v = clampSize('box', value)
  if (!keep || !base.w || !base.h) return which === 'w' ? { w: v, h: cur.h } : { w: cur.w, h: v }
  return which === 'w'
    ? { w: v, h: clampSize('box', v * base.h / base.w) }
    : { w: clampSize('box', v * base.w / base.h), h: v }
}

// つまみを引いたとき。引いた分だけ増える。keep なら大きく動いた方の割合で縦横とも変える
export function dragSize(start, dx, dy, keep) {
  if (!keep || !start.w || !start.h) return { w: clampSize('box', start.w + dx), h: clampSize('box', start.h + dy) }
  const k = Math.abs(dx / start.w) >= Math.abs(dy / start.h) ? (start.w + dx) / start.w : (start.h + dy) / start.h
  return { w: clampSize('box', start.w * k), h: clampSize('box', start.h * k) }
}

// 先祖の縮み（transform: scale など）＝画面の上の幅 ÷ CSS の幅。測れないとき（0・NaN・無限・負）は 1
export function scaleOf(rectW, offsetW) {
  const s = Number(rectW) / Number(offsetW)
  return Number.isFinite(s) && s > 0 ? s : 1
}

// 画面の上の大きさを縮みで割って、整数の CSS の px にする
export function unscale(size, s) {
  const k = Number.isFinite(s) && s > 0 ? s : 1
  return { w: Math.round(size.w / k), h: Math.round(size.h / k) }
}

export function sizeTook(want, got) {
  return Math.abs(want.w - got.w) <= 1 && Math.abs(want.h - got.h) <= 1
}

export function paddingText(sides) {
  return compactBox(...sides.map(n => `${clampSize('padding', n)}px`))
}

// 「すべて」で仮の見た目を当てる部品。選んだ部品を必ず先頭に含める
export function limitTargets(list, el, max) {
  return [el, ...list.filter(x => x !== el)].slice(0, max)
}

// 台帳：部品 → 値の名前 → { 控え（最初に書き換える直前の値）, style, 枠ごとに当てた値（当てた順） }
export function createLedger() {
  return new Map()
}

export function ledgerApply(ledger, slot, el, style, prop, value) {
  let props = ledger.get(el)
  if (!props) ledger.set(el, (props = new Map()))
  let rec = props.get(prop)
  if (!rec) {
    rec = { orig: { value: style.getPropertyValue(prop), priority: style.getPropertyPriority(prop) }, style, bySlot: new Map() }
    props.set(prop, rec)
  }
  rec.bySlot.delete(slot)
  rec.bySlot.set(slot, value)
  style.setProperty(prop, value, 'important')
}

function putBack(prop, rec) {
  if (rec.orig.value) rec.style.setProperty(prop, rec.orig.value, rec.orig.priority)
  else rec.style.removeProperty(prop)
}

// その枠が当てた分を戻す。ほかの枠がまだ当てていれば、その最後の値に戻す
export function ledgerRestore(ledger, slot) {
  for (const [el, props] of ledger) {
    for (const [prop, rec] of props) {
      if (!rec.bySlot.has(slot)) continue
      rec.bySlot.delete(slot)
      const rest = [...rec.bySlot.values()]
      if (rest.length) rec.style.setProperty(prop, rest[rest.length - 1], 'important')
      else { putBack(prop, rec); props.delete(prop) }
    }
    if (!props.size) ledger.delete(el)
  }
}

export function ledgerRestoreAll(ledger) {
  for (const props of ledger.values()) for (const [prop, rec] of props) putBack(prop, rec)
  ledger.clear()
}

const sameSize = (a, b) => (a && typeof a === 'object' ? Boolean(b) && a.w === b.w && a.h === b.h : a === b)

// 設計書 §20-8 の size。変えた物が無ければ null
export function buildSize({ scope, same, from, to, imgSelector }) {
  const changes = []
  for (const what of ['box', 'img', 'text', 'padding']) {
    if (to[what] === undefined || from[what] === undefined || sameSize(from[what], to[what])) continue
    const c = { what, from: from[what], to: to[what] }
    if (what === 'img' && imgSelector) c.selector = imgSelector
    changes.push(c)
  }
  if (!changes.length) return null
  const out = { scope: same && scope === 'all' ? 'all' : 'one', changes }
  if (same) out.same = { label: same.label, count: same.count }
  return out
}

// 入力欄の置き場所。下 → 上 → 右横 → 左横の順に、画面（8px の余白）に収まる所。どこにも入らなければ上端
export function bubblePos(rect, w, h, vw, vh) {
  const clamp = (n, lo, hi) => Math.min(Math.max(lo, n), hi)
  const left = clamp(rect.left, 8, vw - w - 8)
  if (rect.bottom + 8 + h <= vh - 8) return { top: rect.bottom + 8, left }
  if (rect.top - h - 8 >= 8) return { top: rect.top - h - 8, left }
  const top = clamp(rect.top, 8, Math.max(8, vh - h - 8))
  if (rect.right + 8 + w <= vw - 8) return { top, left: rect.right + 8 }
  if (rect.left - 8 - w >= 8) return { top, left: rect.left - 8 - w }
  return { top: Math.max(8, rect.top - h - 8), left }
}

// ---- 欄の共通（0.4.0。設計書 §23-8） ----

export const LOOK_WORDS = '見た目を下の値に変えて'

// 頼みごとの欄が空のときの文。間隔・位置か色があれば LOOK_WORDS、大きさだけなら SIZE_WORDS、どれも無ければ空
export function emptyWords(els) {
  if (els.some(x => x.space || x.color)) return LOOK_WORDS
  return els.some(x => x.size) ? SIZE_WORDS : ''
}
