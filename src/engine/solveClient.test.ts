import { describe, expect, it, vi } from 'vitest'
import me from '../../data/agreements/79-mechanical-engineering-b-s.json'
import { solve } from './solve'
import { SolveClient, WORKER_TIME_LIMIT_MS, WORKER_WATCHDOG_MS, type PlanResult, type SolveMessage, type WorkerLike } from './solveClient'
import type { Agreement, Plan } from './types'

const ME = me as unknown as Agreement
const req = (taken: string[] = []) => ({ taken: new Set(taken), agreement: ME, opts: { allowed: [113], home: 113 } })

/** A fake worker that holds each message until the test answers it. */
class FakeWorker implements WorkerLike {
  static all: FakeWorker[] = []
  inbox: SolveMessage[] = []
  terminated = false
  onmessage: WorkerLike['onmessage'] = null
  onerror: WorkerLike['onerror'] = null
  constructor() { FakeWorker.all.push(this) }
  postMessage(m: SolveMessage) { this.inbox.push(m) }
  terminate() { this.terminated = true }
  answer(m = this.inbox[this.inbox.length - 1], plan = { tag: m.id } as unknown as Plan) {
    if (!this.terminated) this.onmessage?.({ data: { id: m.id, plan } } as MessageEvent)
  }
  fail(m = this.inbox[this.inbox.length - 1], error = 'boom') {
    if (!this.terminated) this.onmessage?.({ data: { id: m.id, error } } as MessageEvent)
  }
}

describe('SolveClient (M-4): off-thread solving, only the newest request wins', () => {
  it('sends a time limit to the worker and delivers the answer', () => {
    FakeWorker.all = []
    const got: number[] = []
    const c = new SolveClient(() => new FakeWorker(), (id) => got.push(id))
    const id = c.request(req())
    const w = FakeWorker.all[0]
    expect(w.inbox[0].opts.timeLimitMs).toBe(WORKER_TIME_LIMIT_MS)
    w.answer()
    expect(got).toEqual([id])
  })
  it('a new request while busy terminates the old worker; a late stale answer is dropped', () => {
    FakeWorker.all = []
    const got: number[] = []
    const c = new SolveClient(() => new FakeWorker(), (id) => got.push(id))
    const first = c.request(req())
    const second = c.request(req(['113:MATH 1A']))
    const [w1, w2] = FakeWorker.all
    expect(w1.terminated).toBe(true)
    w1.onmessage?.({ data: { id: first, plan: {} } } as MessageEvent) // even if it slipped through
    expect(got).toEqual([])
    w2.answer()
    expect(got).toEqual([second])
  })
  it('falls back to the main thread when the worker fails, and without Worker support', async () => {
    FakeWorker.all = []
    const plans: Plan[] = []
    const c = new SolveClient(() => new FakeWorker(), (_, p) => plans.push(p))
    c.request(req())
    FakeWorker.all[0].onerror?.({ preventDefault() {} } as ErrorEvent) // one crash: an error plan, not the main thread
    expect((plans[0] as PlanResult).error).toMatch(/stopped unexpectedly/)
    c.request(req())
    FakeWorker.all[1].onerror?.({ preventDefault() {} } as ErrorEvent) // a second, and no worker ever answered
    expect(FakeWorker.all[1].terminated).toBe(true)
    await vi.waitFor(() => expect(plans).toHaveLength(2), { timeout: 10_000 })
    const exact = solve(new Set(), ME, { allowed: [113], home: 113 })
    expect(plans[1].terms).toEqual(exact.terms)
    c.request(req())
    expect(FakeWorker.all).toHaveLength(2) // for good

    const main: number[] = []
    const m = new SolveClient(null, (id) => main.push(id))
    m.request(req())
    const last = m.request(req())
    await vi.waitFor(() => expect(main).toEqual([last]), { timeout: 10_000 }) // the superseded one is never solved
  })
})

describe('SolveClient (N-2): every request is answered; one failure never disables the worker', () => {
  const setup = () => {
    FakeWorker.all = []
    const got: [number, PlanResult][] = []
    const c = new SolveClient(() => new FakeWorker(), (id, p) => got.push([id, p]))
    return { c, got }
  }
  it('a solve error in the worker is delivered as an error plan; the same worker serves the next request', () => {
    const { c, got } = setup()
    const id = c.request(req())
    FakeWorker.all[0].fail(undefined, 'Unknown start term season "Summer"')
    expect(got).toHaveLength(1)
    expect(got[0][0]).toBe(id)
    expect(got[0][1].error).toMatch(/Summer/)
    expect(got[0][1].terms).toEqual([])
    expect(got[0][1].result.isValid).toBe(false)
    expect(got[0][1].unsolvable).toEqual(['Planning failed: Unknown start term season "Summer"'])
    const id2 = c.request(req())
    expect(FakeWorker.all).toHaveLength(1)
    FakeWorker.all[0].answer()
    expect(got.map(([i, p]) => [i, p.error])).toEqual([[id, got[0][1].error], [id2, undefined]])
  })
  it('a worker crash after it has worked: an error plan, and the next request gets a new worker (not the main thread)', () => {
    const { c, got } = setup()
    c.request(req()); FakeWorker.all[0].answer()
    const id = c.request(req())
    FakeWorker.all[0].onerror?.({ preventDefault() {}, message: 'oops' } as ErrorEvent)
    expect(FakeWorker.all[0].terminated).toBe(true)
    expect(got[1][0]).toBe(id)
    expect(got[1][1].error).toMatch(/stopped unexpectedly \(oops\)/)
    const id3 = c.request(req())
    expect(FakeWorker.all).toHaveLength(2)
    FakeWorker.all[1].answer()
    expect(got[2][0]).toBe(id3)
    expect(got[2][1].error).toBeUndefined()
  })
  it('watchdog: a silent worker is terminated after WORKER_WATCHDOG_MS with an error; its late answer is ignored', () => {
    vi.useFakeTimers()
    try {
      const { c, got } = setup()
      const id = c.request(req())
      const w1 = FakeWorker.all[0]
      vi.advanceTimersByTime(WORKER_WATCHDOG_MS - 1)
      expect(got).toEqual([])
      vi.advanceTimersByTime(1)
      expect(w1.terminated).toBe(true)
      expect(got).toHaveLength(1)
      expect(got[0][0]).toBe(id)
      expect(got[0][1].error).toMatch(/did not answer/)
      w1.terminated = false; w1.answer() // a reply that slipped through anyway
      expect(got).toHaveLength(1)
      const id2 = c.request(req())
      expect(FakeWorker.all).toHaveLength(2)
      FakeWorker.all[1].answer()
      expect(got[1]).toEqual([id2, { tag: id2 }])
      vi.advanceTimersByTime(2 * WORKER_WATCHDOG_MS) // an answered request's watchdog is cleared
      expect(got).toHaveLength(2)
    } finally { vi.useRealTimers() }
  })
  it('a superseded request never gets an error: only the newest one is answered', () => {
    vi.useFakeTimers()
    try {
      const { c, got } = setup()
      c.request(req())
      const id2 = c.request(req())
      FakeWorker.all[0].fail(FakeWorker.all[0].inbox[0]) // the old worker was dropped
      vi.advanceTimersByTime(WORKER_WATCHDOG_MS)
      expect(got.map(([i]) => i)).toEqual([id2])
      expect(FakeWorker.all[0].terminated && FakeWorker.all[1].terminated).toBe(true)
    } finally { vi.useRealTimers() }
  })
  it('main thread: a throwing solve is delivered as an error plan; a worker that cannot be built means the main thread', async () => {
    const got: PlanResult[] = []
    const m = new SolveClient(null, (_, p) => got.push(p))
    m.request({ ...req(), opts: { allowed: [113], home: 113, startTerm: { season: 'Summer' as never, year: 2026 } } })
    await vi.waitFor(() => expect(got).toHaveLength(1))
    expect(got[0].error).toMatch(/season/)
    const b: PlanResult[] = []
    const n = new SolveClient(() => { throw new Error('no workers') }, (_, p) => b.push(p))
    n.request(req())
    await vi.waitFor(() => expect(b).toHaveLength(1), { timeout: 10_000 })
    expect(b[0].error).toBeUndefined()
    expect(b[0].terms.length).toBeGreaterThan(0)
  })
})

describe('solve.worker (N-2)', () => {
  it('answers a throwing solve with its message instead of crashing', async () => {
    const posted: unknown[] = []
    const self = { onmessage: null as ((e: MessageEvent) => void) | null, postMessage: (m: unknown) => posted.push(m) }
    vi.stubGlobal('self', self)
    try {
      await import('./solve.worker')
      self.onmessage!({ data: { ...req(), id: 7, opts: { allowed: [113], home: 113, startTerm: { season: 'Fall', year: NaN } } } } as MessageEvent)
      expect(posted).toEqual([{ id: 7, error: expect.stringMatching(/whole number/) }])
      self.onmessage!({ data: { ...req(), id: 8 } } as MessageEvent)
      expect((posted[1] as { id: number; plan: Plan }).plan.terms.length).toBeGreaterThan(0)
    } finally { vi.unstubAllGlobals() }
  })
})
