// 中継役の判断だけの関数。待ち受けや通信をしないので、そのままテストできる
import path from 'node:path'

export const PORT_MIN = 4000
export const PORT_MAX = 4099
export const MAX_BODY = 64 * 1024
export const WORDS_MAX = 1000
export const ELS_MAX = 5
export const INJECT_WAIT = 64 * 1024
export const PARENT_CHECK_MS = 5000

export function parseCli(argv) {
  const out = { key: '', target: null, root: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const v = argv[i + 1]
    if (a === '--key') { out.key = v ?? ''; i++ }
    else if (a === '--target') { out.target = Number(v); i++ }
    else if (a === '--root') { out.root = v ?? null; i++ }
  }
  if (!/^[A-Za-z0-9]{16,}$/.test(out.key)) throw new Error('--key が正しくありません')
  if (out.target !== null && !(Number.isInteger(out.target) && out.target >= 1 && out.target <= 65535)) {
    throw new Error('--target が正しくありません')
  }
  if ((out.target === null) === (out.root === null)) throw new Error('--target か --root のどちらか1つを指定してください')
  return out
}

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]']

// DNS リバインディング（悪意あるサイトが自分のドメインを 127.0.0.1 に向け直す攻撃）を防ぐ
export function isAllowedHost(host, port) {
  if (typeof host !== 'string') return false
  const h = host.toLowerCase()
  return LOCAL_HOSTS.some(x => h === `${x}:${port}`)
}

export function isAllowedOrigin(origin, port) {
  if (typeof origin !== 'string') return false
  const o = origin.toLowerCase()
  return LOCAL_HOSTS.some(x => o === `http://${x}:${port}`)
}

export function injectTag(key, mode) {
  return `<script type="module" src="/__yubi/picker.js?k=${key}&m=${mode}"></script>`
}

// 仕掛けを差し込む位置。<head> が見つかるまで（頭の 64KB まで）は待つ（-1）
export function findInjectAt(html, final) {
  // コメントを削除してから検索（インデックスは変わらないよう空白で埋める）
  const cleanHtml = html.replace(/<!--(?:[^]*?-->|[^]*$)/g, (match) => ' '.repeat(match.length))

  const head = /<head(?=[\s>/])[^>]*>/i.exec(cleanHtml)
  if (head) {
    const injectPos = head.index + head[0].length
    // DOCTYPE より前にはならないようにする
    const doctype = /<!doctype[^>]*>/i.exec(html)
    if (!doctype || injectPos >= doctype.index + doctype[0].length) {
      return injectPos
    }
    // 見つかった <head> が DOCTYPE の前にあれば、フォールバック
  }
  if (!final && html.length < INJECT_WAIT) return -1
  for (const re of [/<html(?=[\s>/])[^>]*>/i, /<body(?=[\s>/])[^>]*>/i]) {
    const m = re.exec(cleanHtml)
    if (m) return m.index + m[0].length
  }
  const doctype = /<!doctype[^>]*>/i.exec(html)
  if (doctype) return doctype.index + doctype[0].length
  return final ? html.length : 0
}

// http://(localhost|127.0.0.1|[::1]):from を http://localhost:to に変える（番号がちょうど合うときだけ）
export function swapPort(url, from, to) {
  const re = new RegExp(`^(https?://)(?:localhost|127\\.0\\.0\\.1|\\[::1\\]):${from}(?=[/?#]|$)`, 'i')
  return String(url).replace(re, `$1localhost:${to}`)
}

export function rewriteRequestHeaders(headers, relayPort, targetPort) {
  const out = {}
  for (const [k, v] of Object.entries(headers)) if (v !== undefined) out[k] = v
  out.host = `localhost:${targetPort}`
  for (const k of ['origin', 'referer']) {
    if (typeof out[k] === 'string') out[k] = swapPort(out[k], relayPort, targetPort)
  }
  out['accept-encoding'] = 'identity'
  delete out['x-yubi-key']
  // HTML を求める通信は、毎回作り直した HTML を受け取る（古い合言葉入りの HTML を 304 で使い回させない）
  if (/\btext\/html\b/i.test(String(out.accept ?? ''))) {
    delete out['if-none-match']
    delete out['if-modified-since']
  }
  return out
}

export function rewriteResponseHeaders(headers, relayPort, targetPort, html) {
  const out = {}
  for (const [k, v] of Object.entries(headers)) if (v !== undefined) out[k] = v
  if (typeof out.location === 'string') out.location = swapPort(out.location, targetPort, relayPort)
  delete out['transfer-encoding']
  if (html) {
    delete out['content-security-policy']
    delete out['content-security-policy-report-only']
    delete out['content-length']
    // 差し込む合言葉は起こすたびに変わる。ブラウザに HTML をキャッシュ・再利用させない
    delete out.etag
    delete out['last-modified']
    out['cache-control'] = 'no-store'
  }
  out['x-yubi-relay'] = '1'
  return out
}

export function isHtml(headers) {
  return /\btext\/html\b/i.test(String(headers['content-type'] ?? ''))
}

// フォルダ配りのパス。フォルダの外へ出る・読めないパスは null
export function safeJoin(root, urlPath) {
  let p
  try {
    p = decodeURIComponent(String(urlPath).split('?')[0].split('#')[0])
  } catch {
    return null
  }
  if (p.includes('\0')) return null
  if (p.split('/').includes('..')) return null
  const base = path.resolve(root)
  const full = path.resolve(base, '.' + path.posix.normalize('/' + p))
  if (full !== base && !full.startsWith(base + path.sep)) return null
  return full
}

const MIME = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8', txt: 'text/plain; charset=utf-8', xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  mp4: 'video/mp4', webm: 'video/webm', pdf: 'application/pdf',
}

export function mimeOf(file) {
  return MIME[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream'
}

const charLength = s => [...s].length

const SIZE_WHATS = ['box', 'img', 'text', 'padding']
const SIZE_STR_MAX = 300
const okNum = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 10_000
const okWH = v => Boolean(v) && typeof v === 'object' && okNum(v.w) && okNum(v.h)
const okStr = s => typeof s === 'string' && s.length > 0 && charLength(s) <= SIZE_STR_MAX

function okChange(c) {
  if (!c || typeof c !== 'object' || !SIZE_WHATS.includes(c.what)) return false
  if (c.selector !== undefined && !okStr(c.selector)) return false
  if (c.what === 'box' || c.what === 'img') return okWH(c.from) && okWH(c.to)
  if (c.what === 'text') return okNum(c.from) && okNum(c.to)
  return okStr(c.from) && okStr(c.to)
}

// 範囲（scope・same）と changes の個数・what の重なり。size・space・color で同じ確かめ（設計書 §20-8・§23-8）
function okBlock(s, max) {
  if (!s || typeof s !== 'object' || (s.scope !== 'one' && s.scope !== 'all')) return false
  if (s.same !== undefined) {
    const ok = s.same && okStr(s.same.label) && Number.isInteger(s.same.count) && s.same.count >= 2 && s.same.count <= 100_000
    if (!ok) return false
  }
  if (s.scope === 'all' && s.same === undefined) return false
  if (!Array.isArray(s.changes) || s.changes.length < 1 || s.changes.length > max) return false
  return new Set(s.changes.map(c => c && c.what)).size === s.changes.length
}

// 部品ごとの size（設計書 §20-8）。無ければ通す（0.1.x のブラウザの仕掛け）
export function validateSize(s) {
  if (s === undefined) return true
  return okBlock(s, 4) && s.changes.every(okChange)
}

const SPACE_SIDES = ['top', 'bottom', 'left', 'right']
const MADE_MAX = 40
const okInt = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi
const okShort = s => typeof s === 'string' && s.length > 0 && charLength(s) <= MADE_MAX

function okSpaceChange(c) {
  if (!c || typeof c !== 'object') return false
  if (c.what === 'move') return okInt(c.dx, -10_000, 10_000) && okInt(c.dy, -10_000, 10_000) && (c.dx !== 0 || c.dy !== 0)
  if (c.what !== 'prev' && c.what !== 'next') return false
  if (!SPACE_SIDES.includes(c.side) || !okInt(c.from, 0, 10_000) || !okInt(c.to, 0, 10_000)) return false
  const nb = c.neighbor
  if (!nb || typeof nb !== 'object' || !okStr(nb.label) || (nb.text !== undefined && !okStr(nb.text))) return false
  const m = c.made
  return Boolean(m) && typeof m === 'object' && okShort(m.self) && okShort(m.other) && (m.gap === undefined || okShort(m.gap))
}

// 部品ごとの space（設計書 §23-8）。無ければ通す（0.3.0 までのブラウザの仕掛け）
export function validateSpace(s) {
  if (s === undefined) return true
  return okBlock(s, 3) && s.changes.every(okSpaceChange)
}

const COLOR_WHATS = ['text', 'bg', 'img', 'border']
const RGBA = /^rgba\((\d{1,3}), (\d{1,3}), (\d{1,3}), (0|1|0?\.\d+)\)$/

// 色の値：#RRGGBB（大文字）・rgba(r, g, b, a)・transparent（設計書 §23-6）
function okColor(s) {
  if (s === 'transparent') return true
  if (typeof s !== 'string') return false
  if (/^#[0-9A-F]{6}$/.test(s)) return true
  const m = RGBA.exec(s)
  return Boolean(m) && [m[1], m[2], m[3]].every(v => Number(v) <= 255) && Number(m[4]) <= 1
}

function okColorChange(c) {
  if (!c || typeof c !== 'object' || !COLOR_WHATS.includes(c.what)) return false
  if (!okColor(c.from) || !okColor(c.to)) return false
  if (c.page !== undefined && !okStr(c.page)) return false
  if (c.what !== 'img') return c.paint === undefined && c.selector === undefined
  return ['stroke', 'fill', 'both'].includes(c.paint) && (c.selector === undefined || okStr(c.selector))
}

// 部品ごとの color（設計書 §23-8）。無ければ通す（0.4.0 までのブラウザの仕掛け）
export function validateColor(s) {
  if (s === undefined) return true
  return okBlock(s, 4) && s.changes.every(okColorChange)
}

export function validatePick(o) {
  if (!o || typeof o !== 'object' || o.v !== 1 || o.type !== 'pick') return false
  if (o.kind !== 'send' && o.kind !== 'draft') return false
  if (typeof o.words !== 'string' || o.words.trim() === '' || charLength(o.words) > WORDS_MAX) return false
  if (!o.page || typeof o.page.url !== 'string' || typeof o.page.width !== 'number') return false
  if (!Array.isArray(o.els) || o.els.length < 1 || o.els.length > ELS_MAX) return false
  return o.els.every(el => el && typeof el.selector === 'string' && el.rect && typeof el.rect.w === 'number'
    && validateSize(el.size) && validateSpace(el.space) && validateColor(el.color))
}

export function validateReply(o) {
  if (!o || typeof o !== 'object' || o.v !== 1 || o.type !== 'reply') return false
  const words = typeof o.words === 'string' ? o.words : ''
  if (charLength(words) > WORDS_MAX) return false
  const hasChoice = Number.isInteger(o.choice) && o.choice >= 1 && o.choice <= 20
  return hasChoice || words.trim() !== ''
}

export function ssePacket(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

function page(title, body) {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>`
    + `<body style="font-family:sans-serif;padding:32px;line-height:1.7">${body}</body></html>`
}

export function upstreamDownPage(port) {
  return page('指差し', `<h1>${port} 番の開発サーバーが応答していません</h1><p>開発サーバーを起動してから、このページを読み直してください。</p>`)
}

export function notFoundPage(p) {
  return page('見つかりません', `<h1>見つかりません</h1><p>${escapeHtml(p)}</p>`)
}

// ---- 始め方（0.3.0・設計書 §22-6）。survey.mjs が使う ----

export const DEV_COMMANDS = ['node', 'bun', 'deno', 'python', 'ruby', 'php']
const SKIP_DIRS = ['node_modules', 'dist', 'build', 'out', 'coverage', 'vendor']
const HOME_SKIP_DIRS = ['Library', 'Applications', 'Pictures', 'Music', 'Movies']
const TITLE_MAX = 40

// lsof -F pcnt の答え（p＝命令の番号・c＝命令の名前・f＝ファイル・t＝IPv4/IPv6・n＝待ち受けの所）から、待ち受けている番号を読む。
// 同じ番号（IPv4 と IPv6 の2行など）は最初の1つにまとめ、番号の小さい順に返す。host は問い合わせ先
export function parseLsof(text) {
  const out = new Map()
  let command = ''
  let type = ''
  for (const line of String(text ?? '').split('\n')) {
    const tag = line[0]
    const val = line.slice(1).trim()
    if (tag === 'p') { command = ''; type = '' }
    else if (tag === 'c') command = val
    else if (tag === 'f') type = ''
    else if (tag === 't') type = val
    else if (tag === 'n') {
      const m = val.match(/^(.*):(\d{1,5})$/)
      if (!m) continue
      const port = Number(m[2])
      if (port < 1 || port > 65535 || out.has(port)) continue
      const addr = m[1]
      const host = addr === '[::1]' || (addr === '*' && type === 'IPv6') ? '::1' : addr === 'localhost' ? 'localhost' : '127.0.0.1'
      out.set(port, { port, command, host })
    }
  }
  return [...out.values()].sort((a, b) => a.port - b.port)
}

// 開発サーバーらしい命令か（node・bun・deno・python・ruby・php で始まる。データベースやほかのアプリには GET を送らないため）
export function isDevCommand(name) {
  const n = String(name ?? '').toLowerCase()
  return n !== '' && DEV_COMMANDS.some(d => n.startsWith(d))
}

// HTML の <title> の中身（空白を詰めて 40字まで）。無ければ ''
export function htmlTitle(html) {
  const m = String(html ?? '').match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)
  if (!m) return ''
  const t = m[1]
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim()
  const chars = [...t]
  return chars.length > TITLE_MAX ? chars.slice(0, TITLE_MAX).join('') + '…' : t
}

// そのまま開くと白い画面になる HTML か（Vite などの元の index.html・Create React App の public/index.html）。head は頭の 16KB
export function needsServer(head) {
  const h = String(head ?? '')
  if (h.includes('%PUBLIC_URL%')) return true
  for (const m of h.matchAll(/<script\b[^>]*>/gi)) {
    const tag = m[0]
    if (/\btype\s*=\s*["']?module\b/i.test(tag) && /\bsrc\s*=\s*["']?\/(?!\/)/i.test(tag)) return true
  }
  return false
}

// 中身が手元に無いファイルか（iCloud の「ストレージ最適化」で外に置かれた物。読むとダウンロードが始まって待たされる）
export function isDataless(st) {
  return Boolean(st) && st.size > 0 && st.blocks === 0
}

// 新しい順に並べ、上から look 個のうち、サーバーが要る物（server: true）を除いて keep 個まで
export function newestHtml(files, keep = 8, look = 12) {
  return [...files].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, look).filter(f => !f.server).slice(0, keep)
}

// 探さないフォルダか。atHomeTop はホームの直下を見ているとき
export function skipDir(name, atHomeTop) {
  const n = String(name ?? '')
  if (n.startsWith('.') || SKIP_DIRS.includes(n)) return true
  return Boolean(atHomeTop) && HOME_SKIP_DIRS.includes(n)
}
