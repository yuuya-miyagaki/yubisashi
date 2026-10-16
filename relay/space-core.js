// 間隔・位置（0.4.0。設計書 §23-4・§23-5）の計算だけ。ページの部品に触らない（作り物の四角と値で node --test できる）

export const SPACE_LABELS = { top: '上', bottom: '下', left: '左', right: '右' }
export const OPPOSITE = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }
export const SPACE_NOTES = {
  none: '隣の部品がありません（親の中でこの部品だけです）。外側の部品との間を変えるときは「ひとつ外側へ」を押してください',
  inline: 'この部品は文の中の部品なので、ずらせません。外側の部品を選んでください',
  moved: 'この部品は元から動かしてあるので、ここではずらせません',
  noEffect: 'このページの作りでは、ここだけでは間隔が変わりません。数字はそのまま Claude に届きます',
}
export const GAP_MAX = 1000
export const MOVE_MAX = 2000
export const BAND_MIN = 4
const SLACK = 0.5
const MADE_MAX = 40

const okScale = s => (Number.isFinite(s) && s > 0 ? s : 1)
const vertical = side => side === 'top' || side === 'bottom'

export function clampGap(n) {
  const v = Math.round(Number(n))
  return Number.isFinite(v) ? Math.min(GAP_MAX, Math.max(0, v)) + 0 : 0
}

export function clampMove(n) {
  const v = Math.round(Number(n))
  return Number.isFinite(v) ? Math.min(MOVE_MAX, Math.max(-MOVE_MAX, v)) + 0 : 0
}

// 隣の四角 n が、部品の四角 r のどちら側か（rel は 'prev'・'next'）。0.5px の遊びを持つ。重なっていれば null
export function sideOf(r, n, rel) {
  const hits = {
    bottom: n.top >= r.bottom - SLACK,
    right: n.left >= r.right - SLACK,
    left: n.right <= r.left + SLACK,
    top: n.bottom <= r.top + SLACK,
  }
  const order = rel === 'prev' ? ['top', 'left', 'right', 'bottom'] : ['bottom', 'right', 'left', 'top']
  return order.find(side => hits[side]) ?? null
}

// 向きに沿った2つの四角の隙間（画面の px。重なれば負）
export function gapOf(r, n, side) {
  if (side === 'bottom') return n.top - r.bottom
  if (side === 'top') return r.top - n.bottom
  if (side === 'right') return n.left - r.right
  return r.left - n.right
}

// 画面の px を先祖の縮みで割り、0〜1,000 の整数にする
export function cssGap(px, scale) {
  return clampGap(Number(px) / okScale(scale))
}

// 親の間（CSS の px）。親が flex・grid のときだけ。上下の間は row-gap、左右の間は column-gap。normal・読めない値は 0
export function parentGapOf(display, rowGap, columnGap, side) {
  if (!/flex|grid/.test(String(display ?? ''))) return 0
  const v = parseFloat(vertical(side) ? rowGap : columnGap)
  return Number.isFinite(v) ? v : 0
}

// 間を target にするために当てる margin：部品の隣に向いた側を「target − 親の間」、隣の向かい側を 0（§23-4）
export function marginPlan(side, target, parentGap) {
  const g = Number.isFinite(parentGap) ? parentGap : 0
  return { self: [`margin-${side}`, `${target - g}px`], other: [`margin-${OPPOSITE[side]}`, '0px'] }
}

// 届く「いまの作り」（計算された値のまま。40字まで）。親が flex・grid のときだけ親の間
export function madeOf({ self, other, display, rowGap, columnGap, side }) {
  const cut = s => [...String(s ?? '')].slice(0, MADE_MAX).join('')
  const out = { self: cut(self), other: cut(other) }
  if (/flex|grid/.test(String(display ?? ''))) out.gap = cut(vertical(side) ? rowGap : columnGap)
  return out
}

// 帯を引いた量（画面の px）→ 新しい間。隣の部品の方へ引くと広がる
export function dragGap(start, side, dx, dy, scale) {
  const d = side === 'bottom' ? dy : side === 'top' ? -dy : side === 'right' ? dx : -dx
  return clampGap(start + d / okScale(scale))
}

// ⊕ を引いた量（画面の px）→ 動かした量（CSS の px）
export function dragMove(start, dx, dy, scale) {
  const k = okScale(scale)
  return { dx: clampMove(start.dx + dx / k), dy: clampMove(start.dy + dy / k) }
}

// 矢印キー1回分（Shift で 10px）。矢印でなければ null
export function stepMove(cur, key, shift) {
  const d = shift ? 10 : 1
  const v = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, -d], ArrowDown: [0, d] }[key]
  return v ? { dx: clampMove(cur.dx + v[0]), dy: clampMove(cur.dy + v[1]) } : null
}

export function translateValue(m) {
  return `${m.dx}px ${m.dy}px`
}

// 欄の頭のボタン（前の間・次の間・ずらす）と、出せない理由の文。gaps は見つかった隣（[{ rel, side }]）。
// replaced は置き換え要素（img・svg など）。行の中にあっても translate が効くので、ずらせる
export function spaceButtons({ gaps, display, translate, replaced = false }) {
  const buttons = gaps.map(g => g.rel)
  const notes = []
  if (!gaps.length) notes.push(SPACE_NOTES.none)
  if (display === 'inline' && !replaced) notes.push(SPACE_NOTES.inline)
  else if (display === 'contents' || display === 'none') { /* ずらせない（選ばれることはまれ） */ }
  else if (translate && translate !== 'none') notes.push(SPACE_NOTES.moved)
  else buttons.push('move')
  return { buttons, notes }
}

// 効いたか：間が 1px より多くずれた、または部品・隣の大きさが 1px より多く変わったら効いていない（§23-4）
export function gapTook(want, got, before, after) {
  if (Math.abs(want - got) > 1) return false
  return before.every((b, i) => Math.abs(b.w - after[i].w) <= 1 && Math.abs(b.h - after[i].h) <= 1)
}

// 帯の四角（画面の px）。部品と隣の間で、太さは部品の幅（高さ）。4px より狭いときは真ん中に 4px で出す
export function bandRect(r, n, side) {
  if (vertical(side)) {
    const a = side === 'bottom' ? r.bottom : n.bottom
    const b = side === 'bottom' ? n.top : r.top
    let top = Math.min(a, b)
    let height = Math.abs(b - a)
    if (height < BAND_MIN) { top = (a + b) / 2 - BAND_MIN / 2; height = BAND_MIN }
    return { left: r.left, top, width: r.right - r.left, height }
  }
  const a = side === 'right' ? r.right : n.right
  const b = side === 'right' ? n.left : r.left
  let left = Math.min(a, b)
  let width = Math.abs(b - a)
  if (width < BAND_MIN) { left = (a + b) / 2 - BAND_MIN / 2; width = BAND_MIN }
  return { left, top: r.top, width, height: r.bottom - r.top }
}

// 設計書 §23-8 の space。from は欄を開いたときの値（{ prev?, next? }）、to は変えた値（{ prev?, next?, move? }）。変えた物が無ければ null
export function buildSpace({ scope, same, from, to }) {
  const changes = []
  for (const what of ['prev', 'next']) {
    const f = from[what]
    const t = to[what]
    if (!f || t === undefined || t === f.gap) continue
    changes.push({ what, side: f.side, from: f.gap, to: t, neighbor: f.neighbor, made: f.made })
  }
  const m = to.move
  if (m && (m.dx || m.dy)) changes.push({ what: 'move', dx: m.dx, dy: m.dy })
  if (!changes.length) return null
  const out = { scope: same && scope === 'all' ? 'all' : 'one', changes }
  if (same) out.same = { label: same.label, count: same.count }
  return out
}
