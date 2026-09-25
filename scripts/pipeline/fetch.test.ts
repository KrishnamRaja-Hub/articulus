/* fetchRaw: listing hygiene (L2: a report listed twice). */
import { afterEach, describe, expect, it } from 'vitest'
import { assistClient, type AssistClient } from './assist-client.ts'
import { PIPELINE, httpConfig } from './config.ts'
import { fetchRaw } from './fetch.ts'
import { defaultDataset, startMockAssist, type MockAssist } from './mock-assist.ts'
import { NOW, fastEnv } from './test-helpers.ts'

let mock: MockAssist | undefined
afterEach(async () => { await mock?.close(); mock = undefined })
const go = (c: AssistClient) => fetchRaw(c, PIPELINE, { base: mock!.url, now: NOW, log: () => {} })

describe('fetchRaw: duplicate listing entries (L2)', () => {
  it('the same report listed twice (same label and key) is fetched and stored once', async () => {
    const ds = defaultDataset(); ds.majors.push({ ...ds.majors[0] })
    mock = await startMockAssist({ dataset: ds })
    const b = await go(assistClient(httpConfig(fastEnv(mock.url))))
    const a = b.agreements.find((x) => x.major === ds.majors[0].label && x.receivingId === ds.majors[0].receivingId)!
    const ids = a.sources.map((s) => s.sendingId)
    expect(ids).toEqual([...new Set(ids)])
    expect(a.payloads.length).toBe(a.sources.length)
  })
  it('the same label under two different keys fails the fetch', async () => {
    mock = await startMockAssist()
    const real = assistClient(httpConfig(fastEnv(mock.url)))
    const c: AssistClient = {
      stats: real.stats,
      get: async <T>(path: string) => {
        const r = await real.get<any>(path)
        if (path.startsWith('/api/agreements?') && r?.reports?.length) r.reports.push({ ...r.reports[0], key: r.reports[0].key + 'x' })
        return r as T
      },
    }
    await expect(go(c)).rejects.toThrow(/listed twice with different keys/)
  })
})
