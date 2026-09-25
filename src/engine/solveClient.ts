import { solve, type SolveOptions } from './solve'
import type { Agreement, CourseId, Plan } from './types'

/** Wall-clock search limits (TESTER2_REPORT M-4). Past them the solver returns its best plan, marked not optimal.
 *  Off the UI thread a long search only delays the answer; on it, it freezes the page, so the limit is tighter. */
export const WORKER_TIME_LIMIT_MS = 3000
export const MAIN_TIME_LIMIT_MS = 500
/** N-2: a worker that has not answered this long after a request is presumed hung: it is terminated and the request
 *  gets an error plan. Well above WORKER_TIME_LIMIT_MS, since the search limit is checked between nodes. */
export const WORKER_WATCHDOG_MS = 10_000

export interface SolveRequest { taken: Set<CourseId>; agreement: Agreement; opts: SolveOptions }
export interface SolveMessage extends SolveRequest { id: number }
/** A worker's answer: the plan, or the message of the error `solve` threw. */
export type SolveReply = { id: number; plan: Plan; error?: undefined } | { id: number; error: string; plan?: undefined }

/**
 * What the callback receives. When planning failed (solve threw, the worker crashed or hung) `error` holds a message
 * and the plan is empty and incomplete: no terms, not valid, and `unsolvable` holds one line "Planning failed: …", so
 * a UI that knows nothing of `error` still leaves "Planning…" and shows a red, incomplete plan.
 */
export type PlanResult = Plan & { error?: string }

export const errorPlan = (message: string): PlanResult => ({
  terms: [], chosen: {}, totalUnits: 0, unsolvable: [`Planning failed: ${message}`], error: message,
  result: { isValid: false, satisfied: {}, missing: [], incomplete: {}, splitSeriesViolations: [], deferred: [] },
})
const messageOf = (e: unknown) => (e instanceof Error ? e.message : typeof e === 'string' ? e : 'unknown error') || 'unknown error'

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
 *
 * Every request is answered (N-2): an error `solve` throws, a crashed worker (`onerror`) and a worker silent for
 * WORKER_WATCHDOG_MS each deliver an error plan (see PlanResult). A crashed or hung worker is terminated and the next
 * request gets a new one. Only a worker that cannot be constructed, or a second worker crash before any worker has ever
 * answered (workers cannot run here), sends the client to the main thread for good (that request is solved again there).
 */
export class SolveClient {
  private last = 0
  private worker: WorkerLike | null = null
  private busy = false
  private pending: SolveMessage | null = null
  private watchdog: ReturnType<typeof setTimeout> | null = null
  private answered = false // some worker has replied: workers run here
  private deadWorkers = 0   // workers that crashed before any worker replied
  constructor(private makeWorker: (() => WorkerLike) | null, private onPlan: (id: number, plan: PlanResult) => void) {}

  request(req: SolveRequest): number {
    const msg: SolveMessage = { ...req, id: ++this.last }
    this.pending = msg
    if (!this.makeWorker) this.onMain(msg)
    else this.onWorker(msg)
    return msg.id
  }

  /** Stops any running solve; the client stays usable (a later request starts a new worker). */
  dispose() {
    this.dropWorker()
    this.pending = null
  }

  private dropWorker() {
    if (this.watchdog !== null) clearTimeout(this.watchdog)
    this.watchdog = null
    const w = this.worker
    this.worker = null
    this.busy = false
    if (w) { w.onmessage = null; w.onerror = null; w.terminate() }
  }

  private deliver(id: number, plan: PlanResult) {
    if (id !== this.last) return // stale: a newer request exists
    this.pending = null
    this.onPlan(id, plan)
  }

  private onMain(msg: SolveMessage) {
    // a macrotask, so a "Planning…" state can paint before the solve blocks the thread
    setTimeout(() => {
      if (msg.id !== this.last) return
      const opts = { ...msg.opts, timeLimitMs: Math.min(msg.opts.timeLimitMs ?? Infinity, MAIN_TIME_LIMIT_MS) }
      let plan: PlanResult
      try { plan = solve(msg.taken, msg.agreement, opts) } catch (e) { plan = errorPlan(messageOf(e)) }
      this.deliver(msg.id, plan)
    }, 0)
  }

  private onWorker(msg: SolveMessage) {
    if (this.busy) this.dropWorker()
    this.pending = msg
    if (!this.worker) {
      let w: WorkerLike
      try { w = this.makeWorker!() } catch { this.makeWorker = null; return this.onMain(msg) }
      w.onmessage = (e) => {
        if (this.worker !== w) return // a reply from a worker already dropped
        if (this.watchdog !== null) clearTimeout(this.watchdog)
        this.watchdog = null
        this.busy = false
        this.answered = true
        const r = e.data
        this.deliver(r.id, r.error !== undefined || !r.plan ? errorPlan(r.error ?? 'the planner returned no plan') : r.plan)
      }
      w.onerror = (e) => {
        e.preventDefault?.()
        if (this.worker !== w) return
        // A crash: this request fails and the next gets a new worker. A second crash before any worker has ever
        // answered means workers cannot run here (e.g. no module workers): the main thread, for good.
        if (!this.answered && ++this.deadWorkers >= 2) { const p = this.pending; this.dropWorker(); this.makeWorker = null; if (p) this.onMain(p); return }
        this.fail(`the planner stopped unexpectedly${e.message ? ` (${e.message})` : ''}`)
      }
      this.worker = w
    }
    this.busy = true
    if (this.watchdog !== null) clearTimeout(this.watchdog)
    this.watchdog = setTimeout(() => { this.watchdog = null; this.fail(`the planner did not answer within ${WORKER_WATCHDOG_MS / 1000} s`) }, WORKER_WATCHDOG_MS)
    try {
      this.worker.postMessage({ ...msg, opts: { ...msg.opts, timeLimitMs: msg.opts.timeLimitMs ?? WORKER_TIME_LIMIT_MS } })
    } catch (e) { this.fail(messageOf(e)) } // e.g. a request that cannot be cloned
  }

  /** The current worker failed: drop it and answer the pending request with an error plan. */
  private fail(message: string) {
    const p = this.pending
    this.dropWorker()
    if (p) this.deliver(p.id, errorPlan(message))
  }
}
