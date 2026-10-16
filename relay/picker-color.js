// 色の欄（設計書 §23-6。0.5.0）。picker.js が createColorPanel(ctx) で作り、入力欄の「色」で開く
import { NUMS, labelOf, buildSelector, ledgerApply, ledgerRestore } from './picker-core.js'
import {
  COLOR_LABELS, SHAPE_TAGS, paintedShape, parseRgb, parseColorText, colorText, lighten, whereOf, rankColors, paintOf, colorButtons, buildColor,
} from './color-core.js'

const COLOR_ORDER = ['text', 'bg', 'img', 'border']
const SIDES = ['top', 'right', 'bottom', 'left']
const SCAN_MAX = 3000

export function createColorPanel(ctx) {
  const ui = ctx.ui()
  let what = null      // 'text'・'bg'・'img'・'border'
  let palette = null   // このページの色（入力欄を閉じるまで覚える）
  let probe = null     // 色を読む 1×1 の canvas
  let live = null      // 「ほかの色…」を選んでいる間に直す所（見本と文字）

  // 枠ごとの値。この入れ物が台帳の印になる（§23-7）
  const st = slot => (slot.color ??= { info: null, to: {}, base: {}, steps: {} })

  const add = (parent, tag, text, cls) => {
    const x = document.createElement(tag)
    if (text) x.textContent = text
    if (cls) x.className = cls
    parent.appendChild(x)
    return x
  }

  const shown = c => (c === 'transparent' ? '透明' : c)

  // 計算された色を、#RRGGBB・rgba・transparent にする。none は 'none'、url() など色でない物は 'other'。
  // rgb()・rgba() 以外（oklch など）は 1×1 の canvas に塗って sRGB の値を読む（§23-6）
  function readColor(value) {
    const v = String(value ?? '').trim()
    if (!v || v === 'none') return 'none'
    if (v.startsWith('url(')) return 'other'
    const quick = parseRgb(v)
    if (quick) return colorText(quick)
    try {
      if (!probe) {
        const cv = document.createElement('canvas')
        cv.width = 1
        cv.height = 1
        probe = cv.getContext('2d', { willReadFrequently: true })
      }
      probe.fillStyle = '#010203'
      probe.fillStyle = v
      if (probe.fillStyle === '#010203') return 'other'   // 読めない色（前の値のまま）
      probe.clearRect(0, 0, 1, 1)
      probe.fillRect(0, 0, 1, 1)
      const d = probe.getImageData(0, 0, 1, 1).data
      return colorText([d[0], d[1], d[2], d[3] / 255])
    } catch {
      return 'other'
    }
  }

  // 形の親から svg の手前までのタグ名（defs・clipPath などの中かを見る）
  const tagsUpTo = (sh, top) => {
    const out = []
    for (let n = sh.parentElement; n && n !== top; n = n.parentElement) out.push(n.tagName)
    return out
  }
  // 絵の中で、画面に塗られる形だけ（defs・clipPath・mask などの中は外す。§23-6）
  const shapesOf = svg => Array.from(svg.querySelectorAll(SHAPE_TAGS.join(','))).filter(sh => paintedShape(tagsUpTo(sh, svg)))
  const isImgTag = n => ['svg', 'img'].includes(n.tagName.toLowerCase())

  function imgNodeOf(el) {
    if (isImgTag(el)) return el
    const list = ctx.imgsIn(el)
    return list.length === 1 ? list[0] : null
  }

  function bordered(cs) {
    return SIDES.filter(s => parseFloat(cs.getPropertyValue(`border-${s}-width`)) > 0 && cs.getPropertyValue(`border-${s}-style`) !== 'none')
  }

  // 欄を最初に開いたときに、変える前の値を測る
  function measure(el) {
    const cs = getComputedStyle(el)
    const textColors = ctx.textHolders(el).map(h => readColor(getComputedStyle(h).color))
    const node = imgNodeOf(el)
    let img = null
    if (node) {
      img = node.tagName.toLowerCase() === 'img'
        ? { raster: true }
        : { raster: false, ...paintOf(shapesOf(node).map(sh => { const c = getComputedStyle(sh); return { stroke: readColor(c.stroke), strokeWidth: c.strokeWidth, fill: readColor(c.fill) } })) }
    }
    const sides = bordered(cs)
    const borderColors = sides.map(s => readColor(cs.getPropertyValue(`border-${s}-color`)))
    const bg = readColor(cs.backgroundColor)
    const { buttons, notes } = colorButtons({ textColors, img, borderColors, bg, bgImage: cs.backgroundImage !== 'none' })
    const from = {}
    if (buttons.includes('text')) from.text = textColors[0]
    if (buttons.includes('bg')) from.bg = bg
    if (buttons.includes('img')) from.img = img.colors[0]
    if (buttons.includes('border')) from.border = borderColors[0]
    // 絵の住所が 300字を超えたら付けない（大きさと同じ）
    const sel = node && node !== el ? buildSelector(ctx.toNode(node), ctx.countOf) : null
    return { buttons, notes, from, sides, node, paint: img && !img.raster ? img.paint : null, imgSelector: sel && [...sel].length <= 300 ? sel : null }
  }

  // このページの色（§23-6）。仮の見た目をすべて戻して数える
  function scan() {
    return ctx.withoutPreviews(() => {
      const uses = []
      let seen = 0
      for (const el of document.body ? document.body.getElementsByTagName('*') : []) {
        if (seen >= SCAN_MAX) break
        const r = el.getBoundingClientRect()
        if (r.width <= 0 || r.height <= 0) continue
        seen++
        const cs = getComputedStyle(el)
        const tag = el.tagName.toLowerCase()
        if (SHAPE_TAGS.includes(tag)) {
          const svg = el.closest('svg')
          if (svg && !paintedShape(tagsUpTo(el, svg))) continue
          const label = svg ? labelOf('svg', ctx.classList(svg)) : 'svg'
          if (cs.stroke !== 'none' && parseFloat(cs.strokeWidth) > 0) uses.push({ color: readColor(cs.stroke), where: whereOf(label, 'stroke') })
          if (cs.fill !== 'none') uses.push({ color: readColor(cs.fill), where: whereOf(label, 'fill') })
          continue
        }
        const label = labelOf(tag, ctx.classList(el))
        if (Array.from(el.childNodes).some(n => n.nodeType === 3 && n.textContent.trim())) uses.push({ color: readColor(cs.color), where: whereOf(label, 'text') })
        uses.push({ color: readColor(cs.backgroundColor), where: whereOf(label, 'bg') })
        const side = bordered(cs)[0]
        if (side) uses.push({ color: readColor(cs.getPropertyValue(`border-${side}-color`)), where: whereOf(label, 'border') })
      }
      return rankColors(uses)
    })
  }

  function open() {
    const c = ctx.cur()
    if (!c || !c.el.isConnected) return ctx.say('bubble', ctx.GONE)
    const s = st(c.slot)
    if (!s.info) s.info = measure(c.el)
    if (!palette) palette = scan()
    if (!what || !s.info.buttons.includes(what)) what = s.info.buttons[0] ?? null
    render()
    ctx.drawMarks()
  }

  function swatch(parent, color, tag = 'span') {
    const x = add(parent, tag, '', color === 'transparent' ? 'sw none' : 'sw')
    if (color !== 'transparent') x.style.background = color
    return x
  }

  function render() {
    const c = ctx.cur()
    if (!c) return
    const s = st(c.slot)
    const box = ui.color
    box.textContent = ''
    box.hidden = false
    live = null
    add(box, 'div', c.many ? `${NUMS[c.i]} の色` : '色', 'dim')
    const row = add(box, 'div', '', 'row')
    for (const w of s.info.buttons) {
      const b = add(row, 'button', COLOR_LABELS[w], w === what ? 'on' : '')
      b.dataset.co = 'what'
      b.dataset.what = w
    }
    for (const n of s.info.notes) add(box, 'div', n, 'note')
    ctx.scopeRow(box, c.slot)
    if (what) {
      const from = s.info.from[what]
      const cur = s.to[what] ?? from
      const line = add(box, 'div', '', 'ctl')
      add(line, 'span', `${COLOR_LABELS[what]}の色`)
      swatch(line, from)
      add(line, 'span', `${shown(from)} →`)
      const sw = swatch(line, cur)
      const text = add(line, 'span', shown(cur))
      add(box, 'div', 'このページの色（多い順）', 'dim')
      const pal = add(box, 'div', '', 'pal')
      for (const p of palette ?? []) {
        const b = swatch(pal, p.color, 'button')
        b.title = `${p.color}・${p.where}`
        b.dataset.co = 'pick'
        b.dataset.color = p.color
      }
      const ctl = add(box, 'div', '', 'ctl')
      const dark = add(ctl, 'button', '濃く')
      dark.dataset.co = 'step'
      dark.dataset.d = '-1'
      const light = add(ctl, 'button', '薄く')
      light.dataset.co = 'step'
      light.dataset.d = '1'
      dark.disabled = light.disabled = cur === 'transparent'
      add(ctl, 'span', 'ほかの色…')
      const other = add(ctl, 'input')
      other.type = 'color'
      other.value = colorText([...(parseColorText(cur) ?? [255, 255, 255, 1]).slice(0, 3), 1]).toLowerCase()
      other.dataset.co = 'other'
      live = { sw, text, dark, light }
    }
    const foot = add(box, 'div', '', 'row')
    add(foot, 'button', '元に戻す').dataset.co = 'reset'
    ctx.placeBubble()
  }

  // 見本・ほかの色：その色を基の色にする（濃く・薄くの段は 0 から）
  function setColor(slot, color) {
    const s = st(slot)
    s.to[what] = color
    s.base[what] = color
    s.steps[what] = 0
    apply(slot)
  }

  // 濃く・薄く：基の色と段の数から作る（§23-6）。0 と 100 で止まったら段を増やさない
  function step(slot, d) {
    const s = st(slot)
    const base = s.base[what] ?? s.info.from[what]
    if (base === 'transparent') return
    const n = s.steps[what] ?? 0
    const next = lighten(base, n + d)
    if (next === lighten(base, n)) return
    s.base[what] = base
    s.steps[what] = n + d
    s.to[what] = next
    apply(slot)
  }

  // その枠の色の仮の見た目を、いったん戻してから当て直す（文字 → 背景 → 絵 → 枠線。§23-7）
  function apply(slot) {
    const s = st(slot)
    ledgerRestore(ctx.ledger, s)
    const el = ctx.elOf(slot)
    if (!el || !el.isConnected || !s.info) return
    for (const t of ctx.targetsOf(slot, el)) {
      for (const w of COLOR_ORDER) {
        const v = s.to[w]
        if (v === undefined || v === s.info.from[w]) continue
        if (w === 'text') for (const h of ctx.textHolders(t)) ledgerApply(ctx.ledger, s, h, h.style, 'color', v)
        if (w === 'bg') ledgerApply(ctx.ledger, s, t, t.style, 'background-color', v)
        if (w === 'border') for (const side of s.info.sides) ledgerApply(ctx.ledger, s, t, t.style, `border-${side}-color`, v)
        if (w === 'img') {
          const node = t === el ? s.info.node : imgNodeOf(t)
          if (!node || node.tagName.toLowerCase() !== 'svg') continue
          for (const sh of shapesOf(node)) {
            const cs = getComputedStyle(sh)
            if (cs.stroke !== 'none' && parseFloat(cs.strokeWidth) > 0) ledgerApply(ctx.ledger, s, sh, sh.style, 'stroke', v)
            if (cs.fill !== 'none') ledgerApply(ctx.ledger, s, sh, sh.style, 'fill', v)
          }
        }
      }
    }
    ctx.drawMarks()
  }

  // その枠の色の仮の見た目と変更を捨てる（範囲は戻さない。§23-3a）
  function reset(slot) {
    const s = st(slot)
    ledgerRestore(ctx.ledger, s)
    s.to = {}
    s.base = {}
    s.steps = {}
  }

  function hide() {
    ui.color.hidden = true
    live = null
    ctx.drawMarks()
  }

  function onClick(e) {
    const t = e.target
    if (!t || !t.dataset || !t.dataset.co || t.dataset.co === 'other') return
    const c = ctx.cur()
    if (!c || !c.el.isConnected) return ctx.say('bubble', ctx.GONE)
    if (t.dataset.co === 'what') what = t.dataset.what
    if (t.dataset.co === 'pick') setColor(c.slot, t.dataset.color)
    if (t.dataset.co === 'step') step(c.slot, Number(t.dataset.d))
    if (t.dataset.co === 'reset') reset(c.slot)
    render()
    ctx.drawMarks()
  }

  // 「ほかの色…」：選ぶ画面を開いている間は欄を作り直さない（作り直すと画面が閉じる）。見本と文字だけ直し、閉じたら（change）作り直す
  function onInput(e) {
    const x = e.target
    if (!x || !x.dataset || x.dataset.co !== 'other') return
    const c = ctx.cur()
    if (!c || !c.el.isConnected) return ctx.say('bubble', ctx.GONE)
    const rgba = parseColorText(x.value)
    if (!rgba) return
    const color = colorText([rgba[0], rgba[1], rgba[2], 1])
    setColor(c.slot, color)
    if (live) {
      live.sw.className = 'sw'
      live.sw.style.background = color
      live.text.textContent = color
      live.dark.disabled = live.light.disabled = false
    }
  }

  function onChange(e) {
    if (e.target && e.target.dataset && e.target.dataset.co === 'other') render()
  }

  // 範囲「すべて」のほかの部品に緑の枠（drawMarks から毎回）
  function draw() {
    ui.cmarks.textContent = ''
    const c = ctx.cur()
    if (!ctx.isOpen('color') || !c || !c.el.isConnected) return
    for (const t of ctx.targetsOf(c.slot, c.el).slice(1)) {
      const r = t.getBoundingClientRect()
      const m = add(ui.cmarks, 'div', '', 'what')
      Object.assign(m.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` })
    }
  }

  function collect(slot) {
    const s = slot.color
    if (!s || !s.info) return null
    return buildColor({ scope: slot.scope, same: slot.same, from: s.info.from, to: s.to, paint: s.info.paint, imgSelector: s.info.imgSelector, palette })
  }

  function clear() {
    what = null
    palette = null
    live = null
  }

  ui.color.addEventListener('click', onClick)
  ui.color.addEventListener('input', onInput)
  ui.color.addEventListener('change', onChange)
  for (const t of ['keydown', 'keyup', 'keypress']) ui.color.addEventListener(t, e => e.stopPropagation())

  return { open, render, hide, reset, apply, draw, collect, clear }
}
