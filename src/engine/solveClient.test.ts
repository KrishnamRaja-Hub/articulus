import { describe, expect, it, vi } from 'vitest'
import me from '../../data/agreements/79-mechanical-engineering-b-s.json'
import { solve } from './solve'
import { SolveClient, WORKER_TIME_LIMIT_MS, type SolveMessage, type WorkerLike } from './solveClient'
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
  answer(m = this.inbox[0], plan = { tag: m.id } as unknown as Plan) {
    if (!this.terminated) this.onmessage?.({ data: { id: m.id, plan } } as MessageEvent)
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
    FakeWorker.all[0].onerror?.({ preventDefault() {} } as ErrorEvent)
    await vi.waitFor(() => expect(plans).toHaveLength(1), { timeout: 10_000 })
    const exact = solve(new Set(), ME, { allowed: [113], home: 113 })
    expect(plans[0].terms).toEqual(exact.terms)

    const main: number[] = []
    const m = new SolveClient(null, (id) => main.push(id))
    m.request(req())
    const last = m.request(req())
    await vi.waitFor(() => expect(main).toEqual([last]), { timeout: 10_000 }) // the superseded one is never solved
  })
})
