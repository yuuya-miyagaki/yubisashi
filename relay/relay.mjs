#!/usr/bin/env node
// 指差しの中継役。Claude Code の Mod（yubisashi）が起こす。Node の標準機能だけで動き、ファイルは読むだけ
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PORT_MIN, PORT_MAX, MAX_BODY, PARENT_CHECK_MS, parseCli, isAllowedHost, isAllowedOrigin, injectTag,
  findInjectAt, swapPort, rewriteRequestHeaders, rewriteResponseHeaders, isHtml, safeJoin, mimeOf,
  validatePick, validateReply, ssePacket, upstreamDownPage, notFoundPage,
} from './lib.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// 標準出力に1行1件の JSON を書く（Mod が読む）
function out(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

let opts
try {
  opts = parseCli(process.argv.slice(2))
} catch (err) {
  out({ v: 1, type: 'error', where: 'args', message: err.message })
  process.exit(2)
}

const mode = opts.target ? 'proxy' : 'static'
let rootDir = null
if (opts.root) {
  try {
    rootDir = fs.realpathSync(path.resolve(opts.root))
    if (!fs.statSync(rootDir).isDirectory()) throw new Error('フォルダではありません')
  } catch (err) {
    out({ v: 1, type: 'error', where: 'args', message: `--root のフォルダを開けません（${opts.root}）：${err.code ?? err.message}` })
    process.exit(2)
  }
}
let port = 0
let lastStatus = { v: 1, state: 'idle' }
let upstreamWarned = false
const clients = new Set()
const servers = []
let control = null
let sockDir = null

function deny(res, code, text = '') {
  if (res.headersSent) return res.destroy()
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'x-yubi-relay': '1' })
  res.end(text)
}

function readBody(req, limit) {
  return new Promise(resolve => {
    let size = 0
    let over = false
    const chunks = []
    req.on('data', c => {
      size += c.length
      if (size > limit) { over = true; return }
      chunks.push(c)
    })
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(null))
  })
}

async function sendFile(res, file, type) {
  try {
    const body = await fs.promises.readFile(file)
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'x-yubi-relay': '1' })
    res.end(body)
  } catch {
    deny(res, 404)
  }
}

// 中継しているページ（ブラウザ）からの通信
async function handle(req, res) {
  if (!isAllowedHost(req.headers.host, port)) return deny(res, 403)
  // 自分が転送した通信がまた自分に戻ってきた（輪）
  if (req.headers['x-yubi-via']) return deny(res, 508)
  let url
  try { url = new URL(req.url, `http://localhost:${port}`) } catch { return deny(res, 400) }
  if (url.pathname.startsWith('/__yubi/')) return handleYubi(req, res, url)
  if (mode === 'proxy') return proxy(req, res)
  return serveStatic(req, res, url)
}

// 合言葉なしで配る仕掛けのファイル（picker.js が import する。設計書 §23-10）。picker.js はこの外で合言葉つき
const MODULES = new Set(['picker-core.js', 'picker-space.js', 'space-core.js', 'picker-color.js', 'color-core.js'])


async function handleYubi(req, res, url) {
  const p = url.pathname
  const k = url.searchParams.get('k')
  if (req.method === 'GET' && p === '/__yubi/picker.js') {
    if (k !== opts.key) return deny(res, 403)
    return sendFile(res, path.join(HERE, 'picker.js'), 'text/javascript; charset=utf-8')
  }
  const mod = /^\/__yubi\/([a-z-]+\.js)$/.exec(p)
  if (req.method === 'GET' && mod && MODULES.has(mod[1])) {
    return sendFile(res, path.join(HERE, mod[1]), 'text/javascript; charset=utf-8')
  }
  if (req.method === 'GET' && p === '/__yubi/hello') return deny(res, k === opts.key ? 200 : 403, k === opts.key ? 'ok' : '')
  if (req.method === 'GET' && p === '/__yubi/events') {
    if (k !== opts.key) return deny(res, 403)
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-yubi-relay': '1' })
    res.write(ssePacket('status', lastStatus))
    clients.add(res)
    req.on('close', () => clients.delete(res))
    return
  }
  if (req.method === 'POST' && (p === '/__yubi/pick' || p === '/__yubi/reply')) {
    if (req.headers['x-yubi-key'] !== opts.key || !isAllowedOrigin(req.headers.origin, port)) return deny(res, 403)
    const body = await readBody(req, MAX_BODY)
    if (body === null) return deny(res, 413)
    let o
    try { o = JSON.parse(body) } catch { return deny(res, 400) }
    if (p === '/__yubi/pick') {
      if (!validatePick(o)) return deny(res, 400)
      if (mode === 'proxy') {
        // servedFile は静的配りのときに中継役だけが入れる。ブラウザから来たものは捨てる
        delete o.page.servedFile
        o.page.url = swapPort(o.page.url, port, opts.target)
      } else {
        try { o.page.servedFile = staticFileFor(new URL(o.page.url, `http://localhost:${port}`).pathname) } catch { return deny(res, 400) }
      }
    } else if (!validateReply(o)) {
      return deny(res, 400)
    }
    out(o)
    res.writeHead(202, { 'content-type': 'application/json', 'x-yubi-relay': '1' })
    return res.end('{"ok":true}')
  }
  return deny(res, 404)
}

// 1つの通信の失敗で中継役全体が落ちないようにする
function safeHandle(req, res) {
  handle(req, res).catch(() => { try { deny(res, 400) } catch { res.destroy() } })
}

function broadcast(event, data) {
  const pkt = ssePacket(event, data)
  for (const c of clients) c.write(pkt)
}

// HTML の返事に仕掛けを差し込みながら流す。文字の途中で切れないよう、バイトのまま扱う（latin1 は1バイト＝1文字）
function streamInject(src, dst, tag, onInjected) {
  let held = Buffer.alloc(0)
  let done = false
  const inject = (buf, at) => {
    dst.write(Buffer.concat([buf.subarray(0, at), Buffer.from(tag), buf.subarray(at)]))
    done = true
    onInjected()
  }
  src.on('data', chunk => {
    if (done) return dst.write(chunk)
    held = Buffer.concat([held, chunk])
    const at = findInjectAt(held.toString('latin1'), false)
    if (at >= 0) { inject(held, at); held = Buffer.alloc(0) }
  })
  src.on('end', () => {
    if (!done) inject(held, findInjectAt(held.toString('latin1'), true))
    dst.end()
  })
  src.on('error', () => dst.destroy())
}

function proxy(req, res) {
  const headers = rewriteRequestHeaders(req.headers, port, opts.target)
  headers['x-yubi-via'] = '1'
  const up = http.request({ host: 'localhost', port: opts.target, method: req.method, path: req.url, headers, autoSelectFamily: true }, upRes => {
    // 差し込むのはページ本体（document）だけ。iframe や fetch の HTML には入れない
    const dest = req.headers['sec-fetch-dest']
    const topLevel = dest === undefined || dest === 'document'
    const html = topLevel && isHtml(upRes.headers) && !upRes.headers['content-encoding'] && req.method !== 'HEAD'
    res.writeHead(upRes.statusCode ?? 502, rewriteResponseHeaders(upRes.headers, port, opts.target, html))
    if (!html) {
      // 途中で切れたら、ブラウザの待ちも切る
      upRes.on('aborted', () => res.destroy())
      upRes.on('error', () => res.destroy())
      return upRes.pipe(res)
    }
    streamInject(upRes, res, injectTag(opts.key, 'proxy'), () => out({ v: 1, type: 'page', url: req.url }))
  })
  up.on('error', err => {
    if (!upstreamWarned) {
      upstreamWarned = true
      out({ v: 1, type: 'error', where: 'upstream', message: `${opts.target} 番の開発サーバーが応答していません（${err.code ?? err.message}）` })
    }
    if (res.headersSent) return res.destroy()
    res.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'x-yubi-relay': '1' })
    res.end(upstreamDownPage(opts.target))
  })
  req.pipe(up)
}

// フォルダ配りで、URL のパスに当たるファイル（フォルダなら index.html）。外を指すものは null
function staticFileFor(pathname) {
  let file = safeJoin(rootDir, pathname)
  if (!file) return null
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html')
    const real = fs.realpathSync(file)
    if (real !== rootDir && !real.startsWith(rootDir + path.sep)) return null
    return fs.statSync(real).isFile() ? real : null
  } catch {
    return null
  }
}

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return deny(res, 405)
  // URL に直すと %2e%2e が消えて見えなくなるので、安全確認には届いたままのパスを使う
  const rawPath = req.url.split('?')[0].split('#')[0]
  const joined = safeJoin(rootDir, rawPath)
  if (!joined) return deny(res, 403)
  const file = staticFileFor(rawPath)
  if (!file) {
    // ファイルはあるのに外を指している（symlink）なら 403、無ければ 404
    if (fs.existsSync(joined)) return deny(res, 403)
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'x-yubi-relay': '1' })
    return res.end(notFoundPage(url.pathname))
  }
  const type = mimeOf(file)
  const headers = { 'content-type': type, 'cache-control': 'no-store', 'x-yubi-relay': '1' }
  if (type.startsWith('text/html')) {
    let raw
    try { raw = await fs.promises.readFile(file) } catch { return deny(res, 403) }
    const at = findInjectAt(raw.toString('latin1'), true)
    const body = Buffer.concat([raw.subarray(0, at), Buffer.from(injectTag(opts.key, 'static')), raw.subarray(at)])
    res.writeHead(200, { ...headers, 'content-length': body.length })
    res.end(req.method === 'HEAD' ? undefined : body)
    out({ v: 1, type: 'page', url: url.pathname })
    return
  }
  let st
  try { st = await fs.promises.stat(file) } catch { return deny(res, 404) }
  const stream = fs.createReadStream(file)
  stream.on('error', () => { if (res.headersSent) res.destroy(); else deny(res, 403) })
  if (req.method === 'HEAD') { stream.destroy(); res.writeHead(200, { ...headers, 'content-length': st.size }); return res.end() }
  stream.on('open', () => {
    res.writeHead(200, { ...headers, 'content-length': st.size })
    stream.pipe(res)
  })
}

// 自動の読み直しの通信（WebSocket）は中身を見ずにそのまま流す。開発サーバーが 101 以外を返したら、そこで閉じる
function refuseUpgrade(socket, code, text) {
  socket.on('error', () => {})
  socket.write(`HTTP/1.1 ${code} ${text}\r\nX-Yubi-Relay: 1\r\nConnection: close\r\n\r\n`, () => socket.destroy())
}

function onUpgrade(req, socket, head) {
  const url = String(req.url ?? '')
  if (!isAllowedHost(req.headers.host, port) || mode !== 'proxy' || url.startsWith('/__yubi/')) return refuseUpgrade(socket, 403, 'Forbidden')
  if (req.headers['x-yubi-via']) return refuseUpgrade(socket, 508, 'Loop Detected')
  const headers = rewriteRequestHeaders(req.headers, port, opts.target)
  delete headers['accept-encoding']
  headers['x-yubi-via'] = '1'
  socket.on('error', () => {})
  let up
  try {
    up = http.request({ host: 'localhost', port: opts.target, method: req.method, path: url, headers, autoSelectFamily: true, agent: false })
  } catch {
    return refuseUpgrade(socket, 400, 'Bad Request')
  }
  const rawHead = (r, extra) => {
    const lines = []
    for (let n = 0; n < r.rawHeaders.length; n += 2) {
      if (extra && /^(connection|keep-alive)$/i.test(r.rawHeaders[n])) continue
      lines.push(`${r.rawHeaders[n]}: ${r.rawHeaders[n + 1]}`)
    }
    if (extra) lines.push('Connection: close')
    return `HTTP/1.1 ${r.statusCode} ${r.statusMessage}\r\n${lines.join('\r\n')}\r\n\r\n`
  }
  up.on('upgrade', (upRes, upSocket, upHead) => {
    upSocket.on('error', () => socket.destroy())
    socket.on('error', () => upSocket.destroy())
    socket.write(rawHead(upRes, false))
    if (upHead && upHead.length) socket.write(upHead)
    if (head && head.length) upSocket.write(head)
    upSocket.pipe(socket)
    socket.pipe(upSocket)
  })
  up.on('response', upRes => {
    // 101 以外：その返事を返して閉じる（あとの通信を開発サーバーへ素通しにしない）
    socket.write(rawHead(upRes, true))
    upRes.on('error', () => socket.destroy())
    upRes.on('end', () => socket.destroy())
    upRes.pipe(socket, { end: false })
  })
  up.on('error', () => socket.destroy())
  up.end()
}

function tryListen(server, p, host) {
  return new Promise(resolve => {
    const onError = err => { server.removeListener('listening', onOk); resolve(err.code === 'EADDRINUSE' ? 'inuse' : 'error') }
    const onOk = () => { server.removeListener('error', onError); resolve('ok') }
    server.once('error', onError)
    server.once('listening', onOk)
    server.listen(p, host)
  })
}

// その番号にすでに誰かが待ち受けていないか（127.0.0.1・::1 のどちらかにつながれば使用中）
function inUse(p) {
  const probe = host => new Promise(resolve => {
    const c = net.connect({ host, port: p })
    const done = v => { c.destroy(); resolve(v) }
    c.setTimeout(300, () => done(false))
    c.on('connect', () => done(true))
    c.on('error', () => done(false))
  })
  return Promise.all([probe('127.0.0.1'), probe('::1')]).then(([a, b]) => a || b)
}

// 4000 番から順に、127.0.0.1 と ::1 の両方で待ち受けられる番号を探す（::1 が無い Mac なら 127.0.0.1 だけ）
async function listenBoth() {
  for (let p = PORT_MIN; p <= PORT_MAX; p++) {
    if (p === opts.target) continue
    if (await inUse(p)) continue
    const s4 = http.createServer(safeHandle)
    if ((await tryListen(s4, p, '127.0.0.1')) !== 'ok') continue
    const s6 = http.createServer(safeHandle)
    const r6 = await tryListen(s6, p, '::1')
    if (r6 === 'inuse') { s4.close(); continue }
    return { port: p, list: r6 === 'ok' ? [s4, s6] : [s4] }
  }
  return null
}

// Mod から丸の状態・読み直し・受け取り確認を受ける手元の通り道（Unix ソケット）。ブラウザからは届かない
function listenControl() {
  sockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yubi-'))
  const sockPath = path.join(sockDir, 's.sock')
  control = http.createServer((req, res) => controlHandle(req, res).catch(() => { try { deny(res, 400) } catch { res.destroy() } }))
  const controlHandle = async (req, res) => {
    if (req.method !== 'POST') return deny(res, 405)
    const body = await readBody(req, MAX_BODY)
    let o
    try { o = JSON.parse(body ?? '') } catch { return deny(res, 400) }
    if (req.url === '/status') { lastStatus = o; broadcast('status', o) }
    else if (req.url === '/reload') broadcast('reload', o)
    else if (req.url === '/ack') broadcast('ack', o)
    else return deny(res, 404)
    res.writeHead(204)
    res.end()
  }
  return new Promise((resolve, reject) => {
    control.once('error', reject)
    control.listen(sockPath, () => resolve(sockPath))
  })
}

// 相手（開発サーバー）も中継役なら、中継が輪になるので止まる
function isRelay(targetPort) {
  return new Promise(resolve => {
    const r = http.request({ host: 'localhost', port: targetPort, method: 'GET', path: '/__yubi/hello', autoSelectFamily: true, timeout: 2000 }, res => {
      resolve(res.headers['x-yubi-relay'] === '1')
      res.resume()
    })
    r.on('error', () => resolve(false))
    r.on('timeout', () => { r.destroy(); resolve(false) })
    r.end()
  })
}

function cleanup() {
  if (sockDir) {
    try { fs.rmSync(sockDir, { recursive: true, force: true }) } catch { /* 消せなくても止まる */ }
    sockDir = null
  }
}

function shutdown(code = 0) {
  for (const s of servers) s.close()
  if (control) control.close()
  for (const c of clients) c.destroy()
  cleanup()
  process.exit(code)
}

async function main() {
  if (mode === 'proxy' && (await isRelay(opts.target))) {
    out({ v: 1, type: 'error', where: 'loop', message: `${opts.target} 番は指差しの中継役です` })
    process.exit(2)
  }
  const got = await listenBoth()
  if (!got) {
    out({ v: 1, type: 'error', where: 'listen', message: `空いている番号が見つかりませんでした（${PORT_MIN}〜${PORT_MAX}）` })
    process.exit(2)
  }
  port = got.port
  for (const s of got.list) { s.on('upgrade', onUpgrade); servers.push(s) }
  const socket = await listenControl()
  setInterval(() => { for (const c of clients) c.write(': ping\n\n') }, 25_000).unref()
  // 親（Claude Code）が居なくなったら自分で止まる
  setInterval(() => { if (process.ppid === 1) shutdown(0) }, PARENT_CHECK_MS).unref()
  out({ v: 1, type: 'ready', port, socket, mode, ...(mode === 'proxy' ? { target: opts.target } : { root: rootDir }) })
}

process.on('SIGTERM', () => shutdown(0))
process.on('SIGINT', () => shutdown(0))
process.on('SIGHUP', () => shutdown(0))
process.on('exit', cleanup)

main().catch(err => {
  out({ v: 1, type: 'error', where: 'listen', message: String(err && err.message || err) })
  cleanup()
  process.exit(2)
})
