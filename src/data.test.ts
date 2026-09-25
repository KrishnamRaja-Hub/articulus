import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadAgreement, memoizeLoader } from './data'

describe('memoizeLoader (retry after a failed load)', () => {
  it('a failed load is evicted: the retry calls the loader again and succeeds', async () => {
    const loader = vi.fn()
      .mockRejectedValueOnce(new Error('chunk failed'))
      .mockResolvedValueOnce('agreement')
    const load = memoizeLoader(loader)
    await expect(load('a.json')).rejects.toThrow('chunk failed')
    await expect(load('a.json')).resolves.toBe('agreement')
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('a success is cached and not re-fetched', async () => {
    const loader = vi.fn(async (k: string) => `v:${k}`)
    const load = memoizeLoader(loader)
    await expect(load('a')).resolves.toBe('v:a')
    await expect(load('a')).resolves.toBe('v:a')
    expect(loader).toHaveBeenCalledTimes(1)
    await load('b')
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('concurrent callers share one in-flight request', async () => {
    const loader = vi.fn(async () => 1)
    const load = memoizeLoader(loader)
    await Promise.all([load('x'), load('x')])
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('a loader that throws synchronously becomes a rejection and is not cached', async () => {
    const loader = vi.fn().mockImplementationOnce(() => { throw new Error('sync') }).mockResolvedValueOnce(2)
    const load = memoizeLoader(loader)
    await expect(load('k')).rejects.toThrow('sync')
    await expect(load('k')).resolves.toBe(2)
  })

  it('loadAgreement caches a bundled agreement and keeps rejecting a missing one', async () => {
    const a = await loadAgreement('79-mechanical-engineering-b-s.json')
    expect(await loadAgreement('79-mechanical-engineering-b-s.json')).toBe(a)
    await expect(loadAgreement('nope.json')).rejects.toThrow(/not bundled/)
    await expect(loadAgreement('nope.json')).rejects.toThrow(/not bundled/)
  })

  describe('loadAgreement fetches the JSON asset (a failed fetch is retried, unlike a failed dynamic import)', () => {
    afterEach(() => vi.unstubAllGlobals())
    const FILE = '79-computer-science-b-a.json'

    it('a network failure rejects, then "Try again" fetches again and caches the success', async () => {
      const body = { year: '2025-2026', marker: 'cs' }
      const fetchMock = vi.fn()
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => body })
      vi.stubGlobal('fetch', fetchMock)
      await expect(loadAgreement(FILE)).rejects.toThrow('Failed to fetch')
      const a = await loadAgreement(FILE)
      expect(a).toEqual(body)
      expect(await loadAgreement(FILE)).toBe(a)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(String(fetchMock.mock.calls[0][0])).toMatch(/79-computer-science-b-a.*\.json/)
      expect(fetchMock.mock.calls[1][0]).toBe(fetchMock.mock.calls[0][0])
    })

    it('an HTTP error status rejects and is not cached', async () => {
      const file = '7-mathematics-computer-science-b-s.json'
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ year: '2025-2026' }) })
      vi.stubGlobal('fetch', fetchMock)
      await expect(loadAgreement(file)).rejects.toThrow(/HTTP 503/)
      await expect(loadAgreement(file)).resolves.toEqual({ year: '2025-2026' })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('the bundled Berkeley ME agreement never touches the network', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      await loadAgreement('79-mechanical-engineering-b-s.json')
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })
})
