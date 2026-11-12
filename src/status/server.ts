import { createServer } from 'node:http'
import { StatusChecker, loadStatusConfig } from './checker.js'
import { statusPage } from './page.js'

/*
 * The status page service: runs every probe against the API on an interval and serves the page and its JSON.
 * Listens on 127.0.0.1 only; nginx puts it behind the test site's password at /status.
 *
 *   STATUS_PORT (3101), STATUS_BASE_PATH (/status), STATUS_API_URL (http://127.0.0.1:3100),
 *   STATUS_PUBLIC_URL (optional), STATUS_INTERVAL_SECONDS (60), STATUS_HISTORY_FILE, STATUS_TOKEN_FILE,
 *   STATUS_ADMIN_ID (optional). DB_* come from .env, like the API.
 */

const config = loadStatusConfig()
const port = Number(process.env['STATUS_PORT'] ?? '3101')
const basePath = (process.env['STATUS_BASE_PATH'] ?? '/status').replace(/\/$/, '')
const checker = new StatusChecker(config)
const page = statusPage(basePath)
/** "Run checks now" starts a run at most this often. A press sooner than that gets the current summary. */
const MANUAL_RUN_GAP_MS = 5000
let lastManualRun = 0

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost')
  const send = (status: number, type: string, body: string) => {
    response.writeHead(status, {
      'content-type': type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    })
    response.end(body)
  }
  if (request.method === 'GET' && (url.pathname === basePath || url.pathname === `${basePath}/`)) {
    send(200, 'text/html; charset=utf-8', page)
    return
  }
  if (request.method === 'GET' && url.pathname === `${basePath}/api/summary`) {
    send(200, 'application/json', JSON.stringify(checker.summary()))
    return
  }
  if (request.method === 'POST' && url.pathname === `${basePath}/api/run`) {
    const now = Date.now()
    let run: Promise<void> = Promise.resolve()
    // Only a press that starts a run moves the clock. Counting ignored presses too meant that pressing every
    // few seconds never ran the checks at all.
    if (now - lastManualRun >= MANUAL_RUN_GAP_MS) {
      lastManualRun = now
      run = checker.run()
    }
    run
      .then(() => send(200, 'application/json', JSON.stringify(checker.summary())))
      .catch((error: unknown) => send(500, 'application/json', JSON.stringify({ error: String(error) })))
    return
  }
  send(404, 'text/plain; charset=utf-8', 'Not found')
})

let timer: NodeJS.Timeout | undefined
async function loop(): Promise<void> {
  try {
    await checker.run()
  } catch (error) {
    console.error('status run failed', error)
  }
  const next = new Date(Date.now() + config.intervalSeconds * 1000)
  checker.scheduleNext(next)
  timer = setTimeout(() => void loop(), config.intervalSeconds * 1000)
}

server.listen(port, '127.0.0.1', () => {
  console.log(`status page on http://127.0.0.1:${port}${basePath}, checking ${config.apiUrl} every ${config.intervalSeconds} s`)
  void loop()
})

function shutdown(): void {
  clearTimeout(timer)
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 5000).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
