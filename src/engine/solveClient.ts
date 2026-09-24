import { solve, type SolveOptions } from './solve'
import type { Agreement, CourseId, Plan } from './types'

/** Wall-clock search limits (TESTER2_REPORT M-4). Past them the solver returns its best plan, marked not optimal.
 *  Off the UI thread a long search only delays the answer; on it, it freezes the page, so the limit is tighter. */
export const WORKER_TIME_LIMIT_MS = 3000
export const MAIN_TIME_LIMIT_MS = 500

export interface SolveRequest { taken: Set<CourseId>; agreement: Agreement; opts: SolveOptions }
export interface SolveMessage extends SolveRequest { id: number }
export interface SolveReply { id: number; plan: Plan }

/** The part of `Worker` the client uses, so tests can pass a fake. */
export interface WorkerLike {
  postMessage(m: SolveMessage): void
  terminate(): void
  onmessage: ((e: MessageEvent<SolveReply>) => void) | null
  onerror: ((e: ErrorEvent) => void) | null
}

/**
 * Solves requests in a worker when `makeWorker` is given, else on the main thread (tests, old browsers). Every
 * request gets a new id; only the newest request's plan reaches `onPlan`, so a slow older plan never overwrites a
 * newer one. A new request while the worker is busy terminates it (its answer is stale anyway) and starts a fresh one.
 * If the worker fails, the client falls back to the main thread for good.
 */
export class SolveClient {
  private last = 0
  private worker: WorkerLike | null = null
  private busy = false
  private pending: SolveMessage | null = null
  constructor(private makeWorker: (() => WorkerLike) | null, private onPlan: (id: number, plan: Plan) => void) {}

  request(req: SolveRequest): number {
    const msg: SolveMessage = { ...req, id: ++this.last }
    this.pending = msg
    if (!this.makeWorker) this.onMain(msg)
    else this.onWorker(msg)
    return msg.id
  }

  /** Stops any running solve; the client stays usable (a later request starts a new worker). */
  dispose() {
    this.worker?.terminate()
    this.worker = null
    this.busy = false
    this.pending = null
  }

  private deliver(id: number, plan: Plan) {
    if (id !== this.last) return // stale: a newer request exists
    this.pending = null
    this.onPlan(id, plan)
  }

  private onMain(msg: SolveMessage) {
    // a macrotask, so a "Planning…" state can paint before the solve blocks the thread
    setTimeout(() => {
      if (msg.id !== this.last) return
      const opts = { ...msg.opts, timeLimitMs: Math.min(msg.opts.timeLimitMs ?? Infinity, MAIN_TIME_LIMIT_MS) }
      this.deliver(msg.id, solve(msg.taken, msg.agreement, opts))
    }, 0)
  }

  private onWorker(msg: SolveMessage) {
    if (this.busy) this.dispose()
    this.pending = msg
    if (!this.worker) {
      let w: WorkerLike
      try { w = this.makeWorker!() } catch { this.makeWorker = null; return this.onMain(msg) }
      w.onmessage = (e) => { this.busy = false; this.deliver(e.data.id, e.data.plan) }
      w.onerror = (e) => {
        e.preventDefault?.()
        const p = this.pending
        this.worker?.terminate(); this.worker = null; this.busy = false; this.makeWorker = null
        if (p) this.onMain(p)
      }
      this.worker = w
    }
    this.busy = true
    this.worker.postMessage({ ...msg, opts: { ...msg.opts, timeLimitMs: msg.opts.timeLimitMs ?? WORKER_TIME_LIMIT_MS } })
  }
}
