// 指差しの「始め方」の下調べ（設計書 §22-6）。作業フォルダの中の新しい HTML と、動いている開発サーバーを探して、JSON 1行で答える。
// Mod（hooks/register.js）が `node survey.mjs --root <フォルダ> --servers|--no-servers` で呼ぶ。2秒で、そこまでの結果を出して自分で終わる。
// 中継役と同じく Node の標準の機能だけで作る。ブラウザには配らない
import fs from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { parseLsof, isDevCommand, htmlTitle, needsServer, isDataless, newestHtml, skipDir } from './lib.mjs'

export const LIMITS = { ms: 2000, depth: 4, entries: 5000, head: 16 * 1024, look: 12, keep: 8, lsofMs: 1000, probeMs: 500, servers: 8 }

// 浅い順（幅優先）に HTML を集め、state.files に足していく（打ち切られても、そこまでの物が残る）
async function walk(root, home, state, lim, deadline) {
  let level = [root]
  let seen = 0
  for (let depth = 0; level.length; depth++) {
    const next = []
    for (const dir of level) {
      if (Date.now() > deadline) { state.cut = true; return }
      let ents
      try { ents = await fs.readdir(dir, { withFileTypes: true }) } catch { continue }
      for (const e of ents) {
        if (++seen > lim.entries) { state.cut = true; return }
        const full = path.join(dir, e.name)
        if (e.isDirectory()) {
          if (depth < lim.depth && !skipDir(e.name, dir === home)) next.push(full)
        } else if (e.isFile() && /\.html?$/i.test(e.name)) {
          try {
            const st = await fs.stat(full)
            state.files.push({ path: full, rel: path.relative(root, full), mtimeMs: st.mtimeMs, dataless: isDataless(st) })
          } catch { /* 消えた・読めない物は飛ばす */ }
        }
      }
    }
    level = next
  }
}

// 新しい順の上から頭を読み、サーバーが要る HTML に印を付ける。中身が手元に無いファイルは読まない（同期で読まない）
async function markServerPages(files, lim, deadline) {
  const top = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, lim.look)
  for (const f of top) {
    if (Date.now() > deadline) break
    if (f.dataless) continue
    let fh = null
    try {
      fh = await fs.open(f.path, 'r')
      const buf = Buffer.alloc(lim.head)
      const { bytesRead } = await fh.read(buf, 0, lim.head, 0)
      f.server = needsServer(buf.subarray(0, bytesRead).toString('utf8'))
    } catch { /* 読めなければ普通の HTML として扱う */ } finally {
      if (fh) await fh.close().catch(() => {})
    }
  }
}

function lsof(ms) {
  return new Promise(resolve => {
    execFile('lsof', ['+c', '0', '-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcnt'], { timeout: ms }, (err, stdout) => resolve(String(stdout ?? '')))
  })
}

// 開発サーバーらしい待ち受けに GET / を1回送る。2xx の HTML で、中継役でない物だけ { port, title }
function probe({ port, host }, ms, headMax) {
  return new Promise(resolve => {
    let done = false
    const finish = v => { if (!done) { done = true; resolve(v) } }
    const req = http.get({ host, port, path: '/', timeout: ms, headers: { accept: 'text/html' } }, res => {
      const type = String(res.headers['content-type'] ?? '')
      if (res.statusCode < 200 || res.statusCode >= 300 || !/text\/html/i.test(type) || res.headers['x-yubi-relay'] === '1') {
        res.resume()
        return finish(null)
      }
      let body = ''
      res.setEncoding('utf8')
      res.on('data', c => { body += c; if (body.length >= headMax) res.destroy() })
      res.on('close', () => finish({ port, title: htmlTitle(body) }))
      res.on('error', () => finish({ port, title: htmlTitle(body) }))
    })
    req.on('timeout', () => { req.destroy(); finish(null) })
    req.on('error', () => finish(null))
  })
}

export function result(state, lim = LIMITS) {
  return {
    files: newestHtml(state.files, lim.keep, lim.look).map(f => ({ path: f.path, rel: f.rel, mtimeMs: f.mtimeMs })),
    servers: state.servers,
    cut: state.cut,
  }
}

export async function survey({ root, servers = false, home = os.homedir(), limits = {} }, state = { files: [], servers: [], cut: false }) {
  const lim = { ...LIMITS, ...limits }
  const deadline = Date.now() + lim.ms - 200
  const st = await fs.stat(root).catch(() => null)
  if (!st || !st.isDirectory()) return { error: 'フォルダがありません' }
  const findFiles = (async () => {
    await walk(root, home, state, lim, deadline)
    await markServerPages(state.files, lim, deadline)
  })()
  const findServers = servers
    ? (async () => {
      const list = parseLsof(await lsof(lim.lsofMs)).filter(x => isDevCommand(x.command))
      const found = (await Promise.all(list.map(x => probe(x, lim.probeMs, lim.head)))).filter(Boolean)
      state.servers = found.slice(0, lim.servers)
    })()
    : Promise.resolve()
  await Promise.all([findFiles, findServers])
  return result(state, lim)
}

async function main() {
  const argv = process.argv.slice(2)
  const i = argv.indexOf('--root')
  const root = i >= 0 ? argv[i + 1] : null
  const state = { files: [], servers: [], cut: false }
  let done = false
  // 書き終えてから終わる（macOS のパイプは書くのが後になることがある）
  const finish = o => {
    if (done) return
    done = true
    process.stdout.write(JSON.stringify({ v: 1, ...o }) + '\n', () => process.exit(0))
  }
  setTimeout(() => finish({ ...result(state), cut: true }), LIMITS.ms)
  if (!root) return finish({ error: '--root がありません' })
  try {
    finish(await survey({ root: path.resolve(root), servers: argv.includes('--servers') }, state))
  } catch (err) {
    finish({ error: String((err && err.message) || err).slice(0, 120) })
  }
}

// 命令として呼ばれたときだけ動く（テストから import したときは動かない）
const self = (() => { try { return pathToFileURL(realpathSync(process.argv[1] ?? '')).href } catch { return '' } })()
if (self === import.meta.url) main()
