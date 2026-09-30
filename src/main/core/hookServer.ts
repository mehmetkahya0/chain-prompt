import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'

export const TOKEN_HEADER = 'x-chain-prompt-token'

/** A hook call received from a Claude Code session we launched. */
export interface HookEvent {
  /** Identifies which claude launch the hook came from (see ClaudeLauncher). */
  launchId: string
  /** Hook event name, e.g. Stop, Notification, SessionStart. */
  event: string
  /** The hook input JSON Claude Code sent (session_id, cwd, ...). */
  payload: Record<string, unknown>
  receivedAt: number
}

const MAX_BODY = 4 * 1024 * 1024

/**
 * Loopback-only HTTP server that Claude Code hooks call into.
 *
 * URL shape: POST http://127.0.0.1:<port>/hook/<launchId>/<EventName>
 * Every request must carry the random per-app-run token in the
 * `x-chain-prompt-token` header; anything else gets a 403.
 */
export class HookServer extends EventEmitter {
  readonly token = randomBytes(24).toString('hex')
  private server: Server | null = null
  private _port = 0

  get port(): number {
    return this._port
  }

  async start(): Promise<number> {
    if (this.server) return this._port
    this.server = createServer((req, res) => this.handle(req, res))
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      // Port 0 = pick a random free port.
      this.server!.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = this.server.address()
    this._port = typeof addr === 'object' && addr ? addr.port : 0
    return this._port
  }

  async stop(): Promise<void> {
    const s = this.server
    this.server = null
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()))
  }

  baseUrl(): string {
    return `http://127.0.0.1:${this._port}`
  }

  private checkToken(req: IncomingMessage): boolean {
    const got = req.headers[TOKEN_HEADER]
    if (typeof got !== 'string') return false
    const a = Buffer.from(got)
    const b = Buffer.from(this.token)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const reply = (code: number, body = '') => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(body)
    }
    const m = /^\/hook\/([A-Za-z0-9-]+)\/([A-Za-z]+)$/.exec(req.url ?? '')
    if (req.method !== 'POST' || !m) return reply(404)
    if (!this.checkToken(req)) return reply(403)

    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) req.destroy()
      else chunks.push(c)
    })
    req.on('end', () => {
      let payload: Record<string, unknown> = {}
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw) {
        try {
          const parsed = JSON.parse(raw)
          if (parsed && typeof parsed === 'object') payload = parsed
        } catch {
          payload = { raw }
        }
      }
      // Empty 2xx body = "success, no decision" for Claude Code; we never
      // influence Claude's behaviour, we only observe.
      reply(200)
      const ev: HookEvent = { launchId: m[1], event: m[2], payload, receivedAt: Date.now() }
      this.emit('hook', ev)
    })
  }
}
