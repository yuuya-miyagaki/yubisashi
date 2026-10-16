// 色（0.5.0。設計書 §23-6）の計算だけ。ページの部品に触らない（作り物の値で node --test できる）
import { uniqueInOrder } from './picker-core.js'

export const COLOR_LABELS = { text: '文字', bg: '背景', img: '絵', border: '枠線' }
export const COLOR_NOTES = {
  textMany: '中の文字の色が2種類以上あります。文字の色を変えるときは、文字の部品を選んでください',
  imgMany: '絵の中の色が2種類以上あります。ここでは変えられません',
  imgRaster: '画像（img）の色は、ここでは変えられません',
  bgImage: '背景に画像かグラデーションがあります。色を変えても見えないことがあります',
}
export const SHAPE_TAGS = ['path', 'circle', 'rect', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'use']
export const PALETTE_MAX = 12
export const LIGHT_STEP = 5
const WHERE_WORDS = { text: '文字', bg: '背景', border: '枠線', stroke: '線', fill: '塗り' }
const HEX = /^#[0-9A-F]{6}$/
const RGBA = /^rgba\((\d{1,3}), (\d{1,3}), (\d{1,3}), (0|1|0?\.\d+)\)$/

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

const UNPAINTED = new Set(['defs', 'clippath', 'mask', 'symbol', 'marker', 'pattern'])

// 絵の色に数える形か。tags は形の親から svg の手前までのタグ名。defs・clipPath・mask などの中の形は、画面にそのまま塗られないので数えない（Figma の書き出しによくある）
export function paintedShape(tags) {
  return !tags.some(t => UNPAINTED.has(String(t).toLowerCase()))
}

// 計算された色の文字（rgb()・rgba()・rgb(r g b / a%)・transparent）を [r, g, b, a] に。読めなければ null（oklch など。canvas で読む）
export function parseRgb(s) {
  const t = String(s ?? '').trim().toLowerCase()
  if (t === 'transparent') return [0, 0, 0, 0]
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+)(%)?\s*)?\)$/.exec(t)
  if (!m) return null
  const a = m[4] === undefined ? 1 : m[5] ? Number(m[4]) / 100 : Number(m[4])
  return [m[1], m[2], m[3]].map(v => clamp(Math.round(Number(v)), 0, 255)).concat(clamp(a, 0, 1))
}

// 届ける形（#RRGGBB・rgba・transparent）を [r, g, b, a] に戻す。形が違えば null
export function parseColorText(s) {
  const t = String(s ?? '')
  if (/^#[0-9a-f]{6}$/i.test(t)) {
    const n = parseInt(t.slice(1), 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1]
  }
  return parseRgb(t)
}

// 出し方：透け具合を先に小数2桁へ丸め、1 なら #RRGGBB（大文字）・0 なら transparent・その間は rgba（§23-6）
export function colorText([r, g, b, a]) {
  const al = Math.round(a * 100) / 100
  if (al <= 0) return 'transparent'
  if (al >= 1) return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase()
  return `rgba(${r}, ${g}, ${b}, ${al})`
}

export function isColorText(s) {
  if (s === 'transparent') return true
  if (typeof s !== 'string') return false
  if (HEX.test(s)) return true
  const m = RGBA.exec(s)
  return Boolean(m) && [m[1], m[2], m[3]].every(v => Number(v) <= 255) && Number(m[4]) <= 1
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l * 100]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h * 60, s * 100, l * 100]
}

function hslToRgb(h, s, l) {
  s /= 100; l /= 100
  const k = n => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))
  return [f(0), f(8), f(4)].map(v => clamp(Math.round(v * 255), 0, 255))
}

// 基の色から明るさ（HSL の L）を steps 段（1段で 5）変えた色。濃く＝マイナス。0〜100 で止まる。透け具合はそのまま。透明は変えない
export function lighten(base, steps) {
  const c = parseColorText(base)
  if (!c || c[3] === 0) return base
  if (!steps) return colorText(c)
  const [h, s, l] = rgbToHsl(c[0], c[1], c[2])
  return colorText([...hslToRgb(h, s, clamp(l + steps * LIGHT_STEP, 0, 100)), c[3]])
}

// 「どこの色か」の文：部品の名前＋項目（button.primary の背景・svg の線 など）
export function whereOf(label, prop) {
  return `${label} の${WHERE_WORDS[prop] ?? prop}`
}

// このページの色：多い順に 12 色（透明と色でない物を除く。同じ数なら先に見つけた方）。それぞれ、いちばん多い「どこの色か」を付ける
export function rankColors(uses) {
  const by = new Map()
  uses.forEach((u, i) => {
    if (!u || !isColorText(u.color) || u.color === 'transparent') return
    let rec = by.get(u.color)
    if (!rec) by.set(u.color, (rec = { color: u.color, count: 0, first: i, wheres: new Map() }))
    rec.count++
    rec.wheres.set(u.where, (rec.wheres.get(u.where) ?? 0) + 1)
  })
  return [...by.values()]
    .sort((a, b) => b.count - a.count || a.first - b.first)
    .slice(0, PALETTE_MAX)
    .map(rec => ({ color: rec.color, where: [...rec.wheres].sort((a, b) => b[1] - a[1])[0][0] }))
}

// 絵の中の部品（[{ stroke, strokeWidth, fill }]。色は届ける形か 'none'・'other'）→ 使っている物（stroke・fill・both）と色
export function paintOf(shapes) {
  let stroke = false
  let fill = false
  let other = false
  const colors = []
  for (const s of shapes) {
    if (s.stroke !== 'none' && parseFloat(s.strokeWidth) > 0) {
      stroke = true
      if (isColorText(s.stroke) && s.stroke !== 'transparent') colors.push(s.stroke)
      else other = true
    }
    if (s.fill !== 'none') {
      fill = true
      if (isColorText(s.fill) && s.fill !== 'transparent') colors.push(s.fill)
      else other = true
    }
  }
  return { paint: stroke && fill ? 'both' : stroke ? 'stroke' : fill ? 'fill' : null, colors: uniqueInOrder(colors), other }
}

// 欄の頭のボタン（文字・背景・絵・枠線の順）と、出せない理由の文。img は null・{ raster: true }・paintOf の答え
export function colorButtons({ textColors, img, borderColors, bg, bgImage }) {
  const buttons = []
  const notes = []
  const tc = uniqueInOrder(textColors ?? [])
  if (tc.length === 1 && isColorText(tc[0])) buttons.push('text')
  else if (tc.length > 1) notes.push(COLOR_NOTES.textMany)
  if (isColorText(bg)) buttons.push('bg')
  if (bgImage) notes.push(COLOR_NOTES.bgImage)
  if (img && img.raster) notes.push(COLOR_NOTES.imgRaster)
  else if (img && img.paint) {
    if (!img.other && img.colors.length === 1) buttons.push('img')
    else notes.push(COLOR_NOTES.imgMany)
  }
  const bc = uniqueInOrder(borderColors ?? [])
  if (bc.length === 1 && isColorText(bc[0])) buttons.push('border')
  return { buttons, notes }
}

// 設計書 §23-8 の color。palette は「このページの色」（[{ color, where }]）。変えた物が無ければ null
export function buildColor({ scope, same, from, to, paint, imgSelector, palette }) {
  const changes = []
  for (const what of ['text', 'bg', 'img', 'border']) {
    if (to[what] === undefined || from[what] === undefined || to[what] === from[what]) continue
    const c = { what, from: from[what], to: to[what] }
    if (what === 'img') {
      c.paint = paint
      if (imgSelector) c.selector = imgSelector
    }
    const p = (palette ?? []).find(x => x.color === to[what])
    if (p) c.page = p.where
    changes.push(c)
  }
  if (!changes.length) return null
  const out = { scope: same && scope === 'all' ? 'all' : 'one', changes }
  if (same) out.same = { label: same.label, count: same.count }
  return out
}
