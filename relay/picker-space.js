// 間隔・位置の欄（設計書 §23-4・§23-5。0.4.0）。picker.js が createSpacePanel(ctx) で作り、入力欄の「間隔・位置」で開く
import { NUMS, labelOf, trimText, ledgerApply, ledgerRestore } from './picker-core.js'
import {
  SPACE_LABELS, SPACE_NOTES, OPPOSITE, sideOf, gapOf, cssGap, clampGap, clampMove, parentGapOf, marginPlan, madeOf,
  dragGap, dragMove, stepMove, translateValue, spaceButtons, gapTook, bandRect, buildSpace,
} from './space-core.js'

export function createSpacePanel(ctx) {
  const ui = ctx.ui()
  let what = null   // 'prev'・'next'・'move'
  let drag = null   // 帯か ⊕ を引いている間：{ kind: 'gap' | 'move', … }
  let warn = ''

  // 枠ごとの値。この入れ物が台帳の印になる（§23-7）
  const st = slot => (slot.space ??= { info: null, to: {} })

  const add = (parent, tag, text, cls) => {
    const x = document.createElement(tag)
    if (text) x.textContent = text
    if (cls) x.className = cls
    parent.appendChild(x)
    return x
  }

  // 並んでいる部品：画面に出ていて、absolute・fixed でない（§23-4）
  function inFlow(n) {
    if (n === ui.host) return false
    const cs = getComputedStyle(n)
    if (cs.display === 'none' || cs.display === 'contents' || cs.position === 'absolute' || cs.position === 'fixed') return false
    const r = n.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }

  function neighborOf(el, rel) {
    const step = n => (rel === 'prev' ? n.previousElementSibling : n.nextElementSibling)
    for (let n = step(el); n; n = step(n)) if (inFlow(n)) return n
    return null
  }

  // 隣の部品と向きと間（CSS の px）。隣が無い・重なっているなら null
  function gapInfo(el, rel) {
    const n = neighborOf(el, rel)
    if (!n) return null
    const r = el.getBoundingClientRect()
    const q = n.getBoundingClientRect()
    const side = sideOf(r, q, rel)
    return side ? { rel, side, n, gap: cssGap(gapOf(r, q, side), ctx.scaleNear(el)) } : null
  }

  function neighborLabel(n) {
    const out = { label: labelOf(n.tagName.toLowerCase(), ctx.classList(n)) }
    const t = n.childElementCount > 20 ? '' : trimText(n.innerText || '', 10)
    if (t) out.text = t
    return out
  }

  // 欄を最初に開いたときに、変える前の値を測る
  function measure(el) {
    const cs = getComputedStyle(el)
    const pcs = el.parentElement ? getComputedStyle(el.parentElement) : null
    const gaps = ['prev', 'next'].map(rel => gapInfo(el, rel)).filter(Boolean)
    const replaced = ['img', 'svg', 'video', 'canvas', 'iframe', 'embed', 'object'].includes(el.tagName.toLowerCase())
    const { buttons, notes } = spaceButtons({ gaps, display: cs.display, translate: cs.getPropertyValue('translate'), replaced })
    const from = {}
    for (const g of gaps) {
      from[g.rel] = {
        side: g.side,
        gap: g.gap,
        neighbor: neighborLabel(g.n),
        made: madeOf({
          self: cs.getPropertyValue(`margin-${g.side}`),
          other: getComputedStyle(g.n).getPropertyValue(`margin-${OPPOSITE[g.side]}`),
          display: pcs ? pcs.display : '',
          rowGap: pcs ? pcs.rowGap : '',
          columnGap: pcs ? pcs.columnGap : '',
          side: g.side,
        }),
      }
    }
    return { buttons, notes, from }
  }

  function open() {
    const c = ctx.cur()
    if (!c || !c.el.isConnected) return ctx.say('bubble', ctx.GONE)
    const s = st(c.slot)
    if (!s.info) s.info = measure(c.el)
    if (!what || !s.info.buttons.includes(what)) what = s.info.buttons[0] ?? null
    const changed = Object.keys(s.to).length > 0
    if (!changed) warn = ''   // 前の部品の「効いていない」の文を持ち越さない
    render()
    if (changed) apply(c.slot)   // 「効いていない」の文を測り直す
    else ctx.drawMarks()
  }

  function render() {
    const c = ctx.cur()
    if (!c) return
    const s = st(c.slot)
    const box = ui.space
    box.textContent = ''
    box.hidden = false
    add(box, 'div', c.many ? `${NUMS[c.i]} の間隔・位置` : '間隔・位置', 'dim')
    const row = add(box, 'div', '', 'row')
    for (const w of s.info.buttons) {
      const b = add(row, 'button', w === 'move' ? 'ずらす' : `${SPACE_LABELS[s.info.from[w].side]}の部品との間`, w === what ? 'on' : '')
      b.dataset.sp = 'what'
      b.dataset.what = w
    }
    for (const n of s.info.notes) add(box, 'div', n, 'note')
    ctx.scopeRow(box, c.slot)
    const ctl = add(box, 'div', '', 'ctl')
    const input = (key, value) => {
      const x = add(ctl, 'input')
      x.type = 'number'
      x.step = '1'
      x.value = String(value)
      x.dataset.key = key
    }
    if (what === 'prev' || what === 'next') {
      const f = s.info.from[what]
      add(ctl, 'span', `${SPACE_LABELS[f.side]}の部品（${f.neighbor.label}${f.neighbor.text ? `「${f.neighbor.text}」` : ''}）との間`)
      input('gap', s.to[what] ?? f.gap)
      add(ctl, 'span', 'px')
      add(box, 'div', '帯を引っ張る（隣の部品の方へ引くと広がる）', 'dim')
    }
    if (what === 'move') {
      const m = s.to.move ?? { dx: 0, dy: 0 }
      add(ctl, 'span', '右へ')
      input('dx', m.dx)
      add(ctl, 'span', 'px・下へ')
      input('dy', m.dy)
      add(ctl, 'span', 'px（左・上はマイナス）')
      add(box, 'div', '⊕ を引っ張るか、←↑→↓（Shift で 10px）', 'dim')
    }
    add(box, 'div', warn, 'warn')
    const foot = add(box, 'div', '', 'row')
    add(foot, 'button', '元に戻す').dataset.sp = 'reset'
    if (!drag) ctx.placeBubble()   // 欄の中身で入力欄の高さが変わるので置き直す（引いている間は置き直さない。§23-5）
  }

  // その枠の間隔・位置の仮の見た目を、いったん戻してから当て直す（前の間 → 次の間 → ずらす。§23-7）
  function apply(slot) {
    const s = st(slot)
    ledgerRestore(ctx.ledger, s)
    const el = ctx.elOf(slot)
    if (!el || !el.isConnected || !s.info) return
    const targets = ctx.targetsOf(slot, el)
    const checks = []
    for (const rel of ['prev', 'next']) {
      const f = s.info.from[rel]
      const want = s.to[rel]
      if (!f || want === undefined || want === f.gap) continue
      const n = neighborOf(el, rel)
      if (n) checks.push({ side: f.side, n, want, before: [ctx.cssSize(el), ctx.cssSize(n)] })
      for (const t of targets) {
        const g = t === el ? (n ? { side: f.side, n } : null) : gapInfo(t, rel)
        if (!g || g.side !== f.side || !t.parentElement) continue
        const pcs = getComputedStyle(t.parentElement)
        const plan = marginPlan(f.side, want, parentGapOf(pcs.display, pcs.rowGap, pcs.columnGap, f.side))
        ledgerApply(ctx.ledger, s, t, t.style, plan.self[0], plan.self[1])
        ledgerApply(ctx.ledger, s, g.n, g.n.style, plan.other[0], plan.other[1])
      }
    }
    // 効いたか（間と、部品・隣の大きさ）。ずらす前に測る（translate で四角が動くため）
    const ok = checks.every(ch => {
      const got = cssGap(gapOf(el.getBoundingClientRect(), ch.n.getBoundingClientRect(), ch.side), ctx.scaleNear(el))
      return gapTook(ch.want, got, ch.before, [ctx.cssSize(el), ctx.cssSize(ch.n)])
    })
    const m = s.to.move
    if (m && (m.dx || m.dy)) for (const t of targets) ledgerApply(ctx.ledger, s, t, t.style, 'translate', translateValue(m))
    const c = ctx.cur()
    if (c && c.slot === slot) {
      warn = ok ? '' : SPACE_NOTES.noEffect
      const w = ui.space.querySelector('.warn')
      if (w) w.textContent = warn
    }
    ctx.drawMarks()
  }

  // その枠の間隔・位置の仮の見た目と変更を捨てる（範囲は戻さない。§23-3a）
  function reset(slot) {
    const s = st(slot)
    ledgerRestore(ctx.ledger, s)
    s.to = {}
    warn = ''
  }

  function hide() {
    drag = null   // 引いている途中で閉じたら、引くのもやめる（§20-14 の直し 3）
    ui.space.hidden = true
    ctx.drawMarks()
  }

  function onClick(e) {
    const t = e.target
    if (!t || !t.dataset || !t.dataset.sp) return
    const c = ctx.cur()
    if (!c || !c.el.isConnected) return ctx.say('bubble', ctx.GONE)
    if (t.dataset.sp === 'what') what = t.dataset.what
    if (t.dataset.sp === 'reset') reset(c.slot)
    render()
    ctx.drawMarks()
    // 「ずらす」を押したら、そのボタンにフォーカスを移す（頼みごとの欄にフォーカスが残ると、矢印キーが文字のカーソルに行く。§23-5）
    if (what === 'move') {
      const b = ui.space.querySelector('button[data-what="move"]')
      if (b) b.focus()
    }
  }

  function onInput(e) {
    const x = e.target
    if (!x || !x.dataset || !x.dataset.key) return
    const n = Number(x.value)
    if (x.value === '' || !Number.isFinite(n)) return
    const c = ctx.cur()
    if (!c || !c.el.isConnected) return ctx.say('bubble', ctx.GONE)
    const s = st(c.slot)
    if (x.dataset.key === 'gap') s.to[what] = clampGap(n)
    else s.to.move = { ...(s.to.move ?? { dx: 0, dy: 0 }), [x.dataset.key]: clampMove(n) }
    apply(c.slot)
  }

  // 数字の欄：Enter は当てるだけ（送らない）・Shift＋↑↓ は 10px。キーはページに渡さない（大きさの欄と同じ。§23-3）
  function onFieldKey(e) {
    e.stopPropagation()
    const x = e.target
    if (!x || x.tagName !== 'INPUT') return
    if (e.key === 'Enter') {
      // 欄を作り直すので、同じ数字の欄にフォーカスを戻す（§20-14 の直し 2）
      e.preventDefault()
      const key = x.dataset.key
      render()
      const again = ui.space.querySelector(`input[data-key="${key}"]`)
      if (again) { again.focus(); again.select() }
      return
    }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.shiftKey) {
      e.preventDefault()
      x.value = String((Number(x.value) || 0) + (e.key === 'ArrowUp' ? 10 : -10))
      x.dispatchEvent(new Event('input', { bubbles: true }))
    }
  }

  function onBandDown(e) {
    const c = ctx.cur()
    if (!c || (what !== 'prev' && what !== 'next')) return
    e.preventDefault()
    e.stopPropagation()
    ui.band.setPointerCapture(e.pointerId)
    const s = st(c.slot)
    const f = s.info.from[what]
    drag = { kind: 'gap', rel: what, side: f.side, x: e.clientX, y: e.clientY, start: s.to[what] ?? f.gap, scale: ctx.scaleNear(c.el) }
  }

  function onBandMove(e) {
    if (!drag || drag.kind !== 'gap') return
    e.preventDefault()
    e.stopPropagation()
    const c = ctx.cur()
    if (!c || !c.el.isConnected) { drag = null; return ctx.say('bubble', ctx.GONE) }
    const v = dragGap(drag.start, drag.side, e.clientX - drag.x, e.clientY - drag.y, drag.scale)
    st(c.slot).to[drag.rel] = v
    apply(c.slot)
    const x = ui.space.querySelector('input[data-key="gap"]')
    if (x) x.value = String(v)
  }

  function onMoverDown(e) {
    const c = ctx.cur()
    if (!c || what !== 'move') return
    e.preventDefault()
    e.stopPropagation()
    ui.mover.setPointerCapture(e.pointerId)
    drag = { kind: 'move', x: e.clientX, y: e.clientY, start: { ...(st(c.slot).to.move ?? { dx: 0, dy: 0 }) }, scale: ctx.scaleNear(c.el) }
  }

  function onMoverMove(e) {
    if (!drag || drag.kind !== 'move') return
    e.preventDefault()
    e.stopPropagation()
    const c = ctx.cur()
    if (!c || !c.el.isConnected) { drag = null; return ctx.say('bubble', ctx.GONE) }
    const m = dragMove(drag.start, e.clientX - drag.x, e.clientY - drag.y, drag.scale)
    st(c.slot).to.move = m
    ui.mover.style.left = `${e.clientX - 9}px`
    ui.mover.style.top = `${e.clientY - 9}px`
    apply(c.slot)
    for (const k of ['dx', 'dy']) {
      const x = ui.space.querySelector(`input[data-key="${k}"]`)
      if (x) x.value = String(m[k])
    }
  }

  function onUp(e) {
    if (!drag) return
    e.stopPropagation()
    drag = null
    ctx.drawMarks()   // 引いている間は止めていた入力欄の置き直しも、ここで1回
  }

  // 「ずらす」を選んでいるときの矢印キー。文字・数字の欄にいるとき・Alt を押しているときは動かさない（§23-5）
  function key(e) {
    if (what !== 'move' || e.altKey || ctx.focusInField()) return false
    const c = ctx.cur()
    if (!c || !c.el.isConnected) return false
    const s = st(c.slot)
    if (!s.info || !s.info.buttons.includes('move')) return false
    const m = stepMove(s.to.move ?? { dx: 0, dy: 0 }, e.key, e.shiftKey)
    if (!m) return false
    e.preventDefault()
    e.stopPropagation()
    s.to.move = m
    apply(c.slot)
    render()
    return true
  }

  // 帯・⊕・範囲「すべて」の緑の枠（drawMarks から毎回）
  function draw() {
    ui.smarks.textContent = ''
    const c = ctx.cur()
    const s = c && c.slot.space
    if (!ctx.isOpen('space') || !c || !c.el.isConnected || !s || !s.info) {
      ui.band.hidden = true
      ui.mover.hidden = true
      return
    }
    for (const t of ctx.targetsOf(c.slot, c.el).slice(1)) {
      const r = t.getBoundingClientRect()
      const m = add(ui.smarks, 'div', '', 'what')
      Object.assign(m.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` })
    }
    let bandOn = false
    if (what === 'prev' || what === 'next') {
      const f = s.info.from[what]
      const n = neighborOf(c.el, what)
      if (f && n) {
        const b = bandRect(c.el.getBoundingClientRect(), n.getBoundingClientRect(), f.side)
        Object.assign(ui.band.style, { left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` })
        ui.band.dataset.side = f.side
        ui.bandLabel.textContent = `${s.to[what] ?? f.gap}px`
        bandOn = true
      }
    }
    ui.band.hidden = !bandOn
    if (drag && drag.kind === 'move') return   // ⊕ はカーソルに付いて動いている
    const moveOn = what === 'move' && s.info.buttons.includes('move')
    if (moveOn) {
      const r = c.el.getBoundingClientRect()
      ui.mover.style.left = `${r.left + r.width / 2 - 9}px`
      ui.mover.style.top = `${r.top + r.height / 2 - 9}px`
    }
    ui.mover.hidden = !moveOn
  }

  function collect(slot) {
    const s = slot.space
    if (!s || !s.info) return null
    return buildSpace({ scope: slot.scope, same: slot.same, from: s.info.from, to: s.to })
  }

  function clear() {
    what = null
    drag = null
    warn = ''
  }

  ui.space.addEventListener('click', onClick)
  ui.space.addEventListener('input', onInput)
  ui.space.addEventListener('keydown', onFieldKey)
  for (const t of ['keyup', 'keypress']) ui.space.addEventListener(t, e => e.stopPropagation())
  for (const [el, down, move] of [[ui.band, onBandDown, onBandMove], [ui.mover, onMoverDown, onMoverMove]]) {
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
  }

  return { open, render, hide, reset, apply, draw, key, collect, clear, holdBubble: () => Boolean(drag) }
}
