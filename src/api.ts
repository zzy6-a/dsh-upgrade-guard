import { appendLine, asRecord, asString, errorText, short } from './util.js'
import type { ScanReport } from './scan.js'
import type { GuardPaths } from './paths.js'

const API_PREFIX = '/dsh-upgrade-guard/api'

export interface GuardApi {
  getState(): Record<string, unknown> | Promise<Record<string, unknown>>
  check(): Promise<ScanReport>
  ack(id: string): boolean
  ackAll(): number
  repair(name?: string, dryRun?: boolean): Promise<Record<string, unknown>>
  enable(name: string): Promise<Record<string, unknown>>
  toggle(name: string, enabled: boolean): Promise<Record<string, unknown>>
  updateSoftConfig(patch: { enabled?: boolean; autoScan?: boolean }): Promise<Record<string, unknown>>
  uninstall(name: string, allowSelf?: boolean): Promise<Record<string, unknown>>
  restart(): Promise<Record<string, unknown>>
  openLog(): string
}

interface RequestLike {
  method?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
  socket?: { remoteAddress?: string | undefined }
}

interface ResponseLike {
  writeHead(status: number, headers?: Record<string, string>): void
  end(body?: string): void
}

function sendJson(res: ResponseLike, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function readBody(req: RequestLike): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    const stream = req as unknown as NodeJS.ReadableStream
    stream.on('data', (chunk: Buffer | string) => { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)) })
    stream.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        const value = text === '' ? {} : JSON.parse(text)
        resolve(asRecord(value) ?? {})
      } catch {
        resolve({})
      }
    })
    stream.on('error', () => resolve({}))
  })
}

function trusted(request: RequestLike): boolean {
  const address = request.socket?.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  if (request.headers.forwarded !== undefined
    || request.headers['x-forwarded-for'] !== undefined
    || request.headers['x-real-ip'] !== undefined) return false
  const origin = request.headers.origin
  const host = request.headers.host
  if (origin === undefined || host === undefined) return false
  const originText = Array.isArray(origin) ? origin[0] : origin
  try {
    const parsed = new URL(originText)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host
  } catch {
    return false
  }
}

/** 注册 /dsh-upgrade-guard/api 前缀路由，返回 disposer。 */
export function registerRoutes(hostCtx: any, paths: GuardPaths, api: GuardApi): () => void {
  const handler = async (request: RequestLike, response: ResponseLike): Promise<void> => {
    try {
      const rawUrl = typeof request.url === 'string' ? request.url : API_PREFIX
      const path = rawUrl.split('?')[0].replace(/\/+$/, '')
      const method = (request.method ?? 'GET').toUpperCase()
      const sub = path.startsWith(API_PREFIX) ? path.slice(API_PREFIX.length) : path

      if (method === 'GET' && (sub === '' || sub === '/state')) {
        const state = await api.getState()
        sendJson(response, 200, { ok: true, api: API_PREFIX, ...state })
        return
      }
      if (method === 'GET' && sub === '/log') {
        sendJson(response, 200, { ok: true, log: api.openLog() })
        return
      }
      // 以下为变更类操作：同源 + 回环校验
      if (!trusted(request)) {
        sendJson(response, 403, { ok: false, error: '仅允许本机同源请求' })
        return
      }
      if (method === 'POST' && sub === '/check') {
        const report = await api.check()
        sendJson(response, 200, { ok: true, report })
        return
      }
      if (method === 'POST' && sub === '/alert/ack') {
        const body = await readBody(request)
        const id = asString(body.id)
        sendJson(response, id !== null && api.ack(id) ? 200 : 404, { ok: id !== null && api.ack(id) })
        return
      }
      if (method === 'POST' && sub === '/alert/ack-all') {
        sendJson(response, 200, { ok: true, acked: api.ackAll() })
        return
      }
      if (method === 'POST' && sub === '/repair') {
        const body = await readBody(request)
        const result = await api.repair(asString(body.name) ?? undefined, body.dryRun === true)
        sendJson(response, result.ok === true ? 200 : 500, result)
        return
      }
      if (method === 'POST' && sub === '/enable') {
        const body = await readBody(request)
        const name = asString(body.name)
        if (name === null) {
          sendJson(response, 400, { ok: false, detail: '缺少 name' })
          return
        }
        const result = await api.enable(name)
        sendJson(response, result.ok === true ? 200 : 500, result)
        return
      }
      if (method === 'POST' && sub === '/toggle') {
        const body = await readBody(request)
        const name = asString(body.name)
        if (name === null) {
          sendJson(response, 400, { ok: false, detail: '缺少 name' })
          return
        }
        const result = await api.toggle(name, body.enabled !== false)
        sendJson(response, result.ok === true ? 200 : 500, result)
        return
      }
      if (method === 'POST' && sub === '/config') {
        const body = await readBody(request)
        const result = await api.updateSoftConfig({
          ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
          ...(typeof body.autoScan === 'boolean' ? { autoScan: body.autoScan } : {}),
        })
        sendJson(response, 200, result)
        return
      }
      if (method === 'POST' && sub === '/uninstall') {
        const body = await readBody(request)
        const name = asString(body.name)
        if (name === null) {
          sendJson(response, 400, { ok: false, detail: '缺少 name' })
          return
        }
        const result = await api.uninstall(name, body.allowSelf === true)
        sendJson(response, result.ok === true ? 200 : 500, result)
        return
      }
      if (method === 'POST' && sub === '/restart') {
        const result = await api.restart()
        sendJson(response, result.ok ? 200 : 500, result)
        return
      }
      sendJson(response, 404, { ok: false, error: `unknown route ${method} ${sub}` })
    } catch (error) {
      appendLine(paths.logFile, `[${new Date().toISOString()}] api error: ${errorText(error)}`)
      try {
        sendJson(response, 500, { ok: false, error: short(errorText(error), 300) })
      } catch { /* response may be closed */ }
    }
  }
  return hostCtx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler,
  }) as () => void
}

export { API_PREFIX }
