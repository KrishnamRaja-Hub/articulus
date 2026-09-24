/* ASSIST HTTP client: antiforgery session, 429 session renewal, timeouts, bounded retries with backoff. */
import type { HttpConfig } from './config.ts'

export class FetchError extends Error {
  readonly path: string
  readonly status?: number
  /** Not worth retrying (e.g. the whole-fetch budget is spent). */
  readonly fatal: boolean
  constructor(message: string, path: string, status?: number, fatal = false) { super(message); this.path = path; this.status = status; this.fatal = fatal }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const retriable = (status: number) => status >= 500 || status === 408

export interface AssistClient {
  get: <T>(path: string) => Promise<T>
  /** identityMismatches: payloads rejected by fetchRaw because they were not for the request (C-2). */
  stats: { requests: number; retries: number; renewals: number; identityMismatches?: number }
}

/** Read a body, refusing more than `max` bytes (L-8: a huge response must not be parsed fully in memory). */
async function boundedText(r: Response, max: number, path: string): Promise<string> {
  const declared = Number(r.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > max) {
    await r.body?.cancel()
    throw new FetchError(`${path}: response of ${declared} bytes exceeds ASSIST_MAX_RESPONSE_BYTES (${max})`, path, r.status, true)
  }
  if (!r.body) return ''
  const reader = r.body.getReader(), chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel()
      throw new FetchError(`${path}: response exceeds ASSIST_MAX_RESPONSE_BYTES (${max})`, path, r.status, true)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function assistClient(cfg: HttpConfig, log: (m: string) => void = () => {}): AssistClient {
  const deadline = Date.now() + cfg.deadlineMs
  const stats: AssistClient['stats'] = { requests: 0, retries: 0, renewals: 0, identityMismatches: 0 }
  const timed = async (url: string, init: RequestInit = {}) => {
    if (Date.now() > deadline) throw new FetchError(`fetch budget of ${cfg.deadlineMs} ms (ASSIST_DEADLINE_MS) exhausted`, url, undefined, true)
    stats.requests++
    return fetch(url, { ...init, signal: AbortSignal.timeout(cfg.timeoutMs), redirect: 'follow' })
  }

  /** Retry `fn` on network errors, timeouts and 5xx; anything else is final. */
  const withRetry = async (what: string, fn: () => Promise<Response>): Promise<Response> => {
    let last: unknown
    for (let i = 0; i < cfg.attempts; i++) {
      if (i) {
        stats.retries++
        const wait = cfg.backoffMs * 2 ** (i - 1) * (1 + Math.random() / 2)
        log(`retry ${i}/${cfg.attempts - 1} ${what} in ${Math.round(wait)} ms (${last instanceof Error ? last.message : String(last)})`)
        await sleep(wait)
      }
      try {
        const r = await fn()
        if (!retriable(r.status)) return r
        last = new FetchError(`HTTP ${r.status}`, what, r.status)
        await r.body?.cancel()
      } catch (e) {
        if (e instanceof FetchError && e.fatal) throw e
        last = e instanceof Error && e.name === 'TimeoutError' ? new FetchError(`timeout after ${cfg.timeoutMs} ms`, what) : e
      }
    }
    throw new FetchError(`${what}: failed after ${cfg.attempts} attempts: ${last instanceof Error ? last.message : String(last)}`, what,
      last instanceof FetchError ? last.status : undefined)
  }

  // ASSIST returns 400 without the antiforgery cookie pair + X-XSRF-TOKEN header taken from the home page.
  const session = async (): Promise<Record<string, string>> => {
    const home = await withRetry('/ (antiforgery handshake)', () => timed(cfg.base + '/'))
    const cookies = home.headers.getSetCookie().map((c) => c.split(';')[0])
    await home.body?.cancel()
    if (!home.ok) throw new FetchError(`antiforgery handshake: HTTP ${home.status}`, '/', home.status)
    const xsrf = cookies.find((c) => c.startsWith('X-XSRF-TOKEN='))?.slice('X-XSRF-TOKEN='.length)
    if (!xsrf) throw new FetchError('antiforgery handshake: no X-XSRF-TOKEN cookie (ASSIST changed its handshake?)', '/')
    return { Cookie: cookies.join('; '), 'X-XSRF-TOKEN': decodeURIComponent(xsrf), Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (articulus data refresh)' }
  }
  let headers: Promise<Record<string, string>> | undefined

  const get = async <T>(path: string): Promise<T> => {
    let renewals = 0, badRequestRenewed = false
    for (;;) {
      headers ??= session()
      const h = await headers
      const r = await withRetry(path, () => timed(cfg.base + path, { headers: h }))
      // Rate limits are per session: start a new one. A 400 can be an expired antiforgery token: renew once.
      if ((r.status === 429 && renewals < cfg.renewals) || (r.status === 400 && !badRequestRenewed)) {
        await r.body?.cancel()
        if (r.status === 400) badRequestRenewed = true
        else { renewals++; await sleep(Math.max(cfg.delayMs, Math.min(1500, cfg.backoffMs))) }
        stats.renewals++
        log(`HTTP ${r.status} on ${path}: new session`)
        headers = undefined
        continue
      }
      if (!r.ok) { await r.body?.cancel(); throw new FetchError(`${path}: HTTP ${r.status}`, path, r.status) }
      const text = await boundedText(r, cfg.maxResponseBytes, path)
      if (cfg.delayMs) await sleep(cfg.delayMs)
      try { return JSON.parse(text) as T }
      catch { throw new FetchError(`${path}: response is not JSON (${text.slice(0, 80)})`, path, r.status) }
    }
  }
  return { get, stats }
}
