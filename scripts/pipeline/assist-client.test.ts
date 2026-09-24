import { afterEach, describe, expect, it } from 'vitest'
import { assistClient } from './assist-client.ts'
import { httpConfig } from './config.ts'
import { startMockAssist, type MockAssist, type MockOptions } from './mock-assist.ts'
import { fastEnv } from './test-helpers.ts'

let mock: MockAssist | undefined
afterEach(async () => { await mock?.close(); mock = undefined })
const client = async (o: MockOptions = {}, env: Record<string, string> = {}) => {
  mock = await startMockAssist(o)
  return assistClient(httpConfig(fastEnv(mock.url, env)))
}

describe('ASSIST client', () => {
  it('the mock enforces the antiforgery handshake like ASSIST (400 without it)', async () => {
    mock = await startMockAssist()
    expect((await fetch(mock.url + '/api/institutions')).status).toBe(400)
  })
  it('performs the handshake and parses JSON', async () => {
    const c = await client()
    const inst = await c.get<{ id: number }[]>('/api/institutions')
    expect(inst.some((i) => i.id === 79)).toBe(true)
    expect(mock!.log[0]).toBe('/')
  })
  it('starts a new session on 429 (rate limits are per session)', async () => {
    const c = await client({ rateLimitPerSession: 2 })
    for (let i = 0; i < 5; i++) await c.get('/api/institutions')
    expect(c.stats.renewals).toBeGreaterThanOrEqual(2)
    expect(mock!.log.filter((p) => p === '/').length).toBeGreaterThanOrEqual(3)
  })
  it('retries transient 5xx with backoff', async () => {
    const c = await client({ faults: [{ match: '/api/institutions', status: 503, times: 2 }] })
    await expect(c.get('/api/institutions')).resolves.toBeInstanceOf(Array)
    expect(c.stats.retries).toBe(2)
  })
  it('gives up after bounded retries on persistent 5xx', async () => {
    const c = await client({ faults: [{ match: '/api/institutions', status: 500 }] })
    await expect(c.get('/api/institutions')).rejects.toThrow(/failed after 3 attempts: HTTP 500/)
  })
  it('times out a hung request and retries it', async () => {
    const c = await client({ faults: [{ match: '/api/institutions', hangMs: 5_000, times: 1 }] }, { ASSIST_TIMEOUT_MS: '150' })
    await expect(c.get('/api/institutions')).resolves.toBeInstanceOf(Array)
    expect(c.stats.retries).toBe(1)
  })
  it('fails on a request that always hangs', async () => {
    const c = await client({ faults: [{ match: '/api/institutions', hangMs: 5_000 }] }, { ASSIST_TIMEOUT_MS: '100', ASSIST_RETRIES: '2' })
    await expect(c.get('/api/institutions')).rejects.toThrow(/timeout after 100 ms/)
  })
  it('does not retry a 404, and names the path', async () => {
    const c = await client()
    await expect(c.get('/api/nope')).rejects.toThrow(/\/api\/nope: HTTP 404/)
    expect(c.stats.retries).toBe(0)
  })
  it('enforces the whole-fetch deadline', async () => {
    const c = await client({ faults: [{ match: '/api/institutions', hangMs: 5_000 }] }, { ASSIST_TIMEOUT_MS: '100', ASSIST_RETRIES: '10', ASSIST_DEADLINE_MS: '250' })
    await expect(c.get('/api/institutions')).rejects.toThrow(/budget/)
  })
})
