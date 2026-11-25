// taskmarket-live — a live market dashboard for taskmarket.dev
// Zero-dependency Node server: polls the public Taskmarket API on the server,
// caches the result, and serves a static dashboard that never calls the API
// from the browser. Node >= 18.
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, extname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const PUBLIC = join(ROOT, 'public')
const PORT = Number(process.env.PORT || 8080)
const API = 'https://api.taskmarket.dev/api'
const CHAINS = [4217, 8453] // Tempo, Base
const REFRESH_MS = Number(process.env.REFRESH_MS || 60 * 60 * 1000) // hourly
const UA = 'taskmarket-live/1.0 (+https://github.com/AlbertPa00/taskmarket-live)'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
}

async function api(path) {
  const r = await fetch(`${API}${path}`, { headers: { 'user-agent': UA, accept: 'application/json' } })
  if (!r.ok) throw new Error(`${path} -> ${r.status}`)
  return r.json()
}

async function fetchAllTasks(chainId) {
  // Keep only the fields the dashboard derives from — memory stays small.
  const out = []
  let cursor
  for (let page = 0; page < 60; page++) {
    const q = `/tasks?chainId=${chainId}&sort=newest&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
    const j = await api(q)
    for (const t of j.tasks || []) {
      out.push({
        requester: t.requester,
        createdAt: t.createdAt,
        status: t.status,
        mode: t.mode,
        reward: t.reward,
        awardCount: t.awardCount ?? 0,
        submissionCount: t.submissionCount ?? 0,
      })
    }
    if (!j.hasMore || !j.nextCursor) break
    cursor = j.nextCursor
  }
  return out
}

function isoWeek(d) {
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const day = (dt.getUTCDay() + 6) % 7 // Mon=0
  dt.setUTCDate(dt.getUTCDate() - day + 3) // Thursday
  const firstThu = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4))
  const fday = (firstThu.getUTCDay() + 6) % 7
  firstThu.setUTCDate(firstThu.getUTCDate() - fday + 3)
  const week = 1 + Math.round((dt - firstThu) / (7 * 864e5))
  return `${dt.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

function derive(tasks) {
  const postersPerWeek = {}
  const posterCount = {}
  const funnel = { posted: 0, open: 0, claimed: 0, inReview: 0, completed: 0, expired: 0, cancelled: 0 }
  let totalReward = 0n
  let subsTotal = 0, subsTasks = 0
  for (const t of tasks) {
    if (!t.requester || !t.createdAt) continue
    const wk = isoWeek(new Date(t.createdAt))
    ;(postersPerWeek[wk] ||= new Set()).add(t.requester.toLowerCase())
    posterCount[t.requester.toLowerCase()] = (posterCount[t.requester.toLowerCase()] || 0) + 1
    funnel.posted++
    if (t.status === 'open') funnel.open++
    else if (t.status === 'claimed') funnel.claimed++
    else if (t.status === 'pending_approval' || t.status === 'worker_selected') funnel.inReview++
    else if (t.status === 'completed') funnel.completed++
    else if (t.status === 'expired') funnel.expired++
    else if (t.status === 'cancelled') funnel.cancelled++
    try { totalReward += BigInt(t.reward || 0) } catch {}
    if (t.submissionCount > 0) { subsTotal += t.submissionCount; subsTasks++ }
  }
  const weekly = Object.entries(postersPerWeek)
    .map(([week, set]) => ({ week, posters: set.size }))
    .sort((a, b) => a.week.localeCompare(b.week))
  const top = Object.entries(posterCount).sort((a, b) => b[1] - a[1])
  const top5 = top.slice(0, 5).reduce((s, [, n]) => s + n, 0)
  return {
    postersPerWeek: weekly,
    distinctPosters: top.length,
    topPosters: top.slice(0, 10).map(([addr, n]) => ({ addr: addr.slice(0, 10) + '…', tasks: n })),
    top5Share: tasks.length ? top5 / tasks.length : 0,
    funnel,
    totalRewardBaseUnits: totalReward.toString(),
    avgSubmissionsPerTask: subsTasks ? subsTotal / subsTasks : 0,
    taskCount: tasks.length,
  }
}

let snapshot = { asOf: null, ok: false, chains: {} }
let refreshing = null

async function refresh() {
  if (refreshing) return refreshing
  refreshing = (async () => {
    const chains = {}
    for (const chainId of CHAINS) {
      const [stats, breakdowns, tsAll, heatWeek, heatMode, feed, tasks] = await Promise.all([
        api(`/market/stats?chainId=${chainId}`),
        api(`/stats/breakdowns?chainId=${chainId}`),
        api(`/stats/platform-time-series?chainId=${chainId}&range=all&bucket=day`),
        api(`/stats/activity-heatmap?chainId=${chainId}&range=30d&dimension=hourOfWeek`),
        api(`/stats/activity-heatmap?chainId=${chainId}&range=30d&dimension=mode`),
        api(`/stats/activity-feed?chainId=${chainId}&limit=40`),
        fetchAllTasks(chainId),
      ])
      chains[chainId] = { stats, breakdowns, timeSeries: tsAll, heatWeek, heatMode, feed: feed.items || [], tasks, derived: derive(tasks) }
    }
    // A requester active on both chains is still one poster — derive over the merged list.
    const allTasks = [...(chains[4217]?.tasks || []), ...(chains[8453]?.tasks || [])]
    const both = { derived: derive(allTasks), taskCount: allTasks.length }
    snapshot = { asOf: new Date().toISOString(), ok: true, chains, both }
    console.log(`[${snapshot.asOf}] snapshot refreshed: tempo ${chains[4217].tasks.length} tasks, base ${chains[8453].tasks.length} tasks`)
  })()
  try { await refreshing } catch (e) {
    console.error('refresh failed:', e.message)
    snapshot.ok = false
  } finally { refreshing = null }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/api/snapshot') {
    const body = JSON.stringify(snapshot)
    res.writeHead(200, { 'content-type': MIME['.json'], 'cache-control': 'public, max-age=60', 'access-control-allow-origin': '*' })
    return res.end(body)
  }
  if (url.pathname === '/healthz') {
    res.writeHead(snapshot.asOf ? 200 : 503, { 'content-type': 'text/plain' })
    return res.end(snapshot.asOf ? 'ok ' + snapshot.asOf : 'warming')
  }
  let p = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\]*\.\.[/\\]*)+/, '')
  if (p === '/' || p === '\\') p = '/index.html'
  const file = join(PUBLIC, p)
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end() }
  try {
    const st = await stat(file)
    const data = await readFile(file)
    const immutable = /\.(woff2|ttf|otf|png|jpg)$/.test(file) ? 'public, max-age=86400' : 'public, max-age=60'
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'content-length': st.size, 'cache-control': immutable })
    res.end(data)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  }
})

await refresh()
setInterval(refresh, REFRESH_MS).unref()
server.listen(PORT, () => console.log(`taskmarket-live on :${PORT} (snapshot as of ${snapshot.asOf})`))
