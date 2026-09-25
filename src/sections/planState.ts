import type { PlanResult } from '../engine/solveClient'
import type { Agreement, CourseId, ValidationResult } from '../engine/types'

/** Pure planning-state derivation for the Planner (TESTER r7 M-1/M-2/M-3), kept out of the component so it can be tested. */

const EMPTY_RESULT: ValidationResult = { isValid: false, satisfied: {}, missing: [], incomplete: {}, splitSeriesViolations: [], deferred: [] }
export const EMPTY_PLAN: PlanResult = { terms: [], chosen: {}, result: EMPTY_RESULT, totalUnits: 0, unsolvable: [] }

/** Every solver input other than the agreement, as one string: two requests with the same key and agreement are the same request. */
export interface PlanInputs {
  taken: ReadonlySet<CourseId>
  allowed: readonly number[]
  home: number
  unitCap: number
  maxTerms: number
  start: string
}
export const inputsKey = (i: PlanInputs) =>
  JSON.stringify([[...i.taken].sort(), [...i.allowed], i.home, i.unitCap, i.maxTerms, i.start])

/** A plan as delivered by the solver, with the exact inputs it was solved for. */
export interface Solved { agreement: Agreement; key: string; plan: PlanResult }

export interface PlanView {
  /** The plan to render. While planning it is the previous plan for this agreement (render it dimmed, never as a verdict) or EMPTY_PLAN. */
  plan: PlanResult
  /** No plan for the current inputs yet: show "Planning…", never a verdict. */
  planning: boolean
  /** `plan` was solved for different inputs (only while planning). */
  stale: boolean
  /** The plan for the current inputs failed (solveClient errorPlan): no stats, no schedule claims. */
  failed: boolean
}

/**
 * Derived synchronously on every render from the current inputs, so no frame ever pairs the current selection with a
 * verdict from a plan solved for other inputs (no effect has to run first). A plan for another agreement is never shown.
 */
export function planView(solved: Solved | null, agreement: Agreement | null, key: string): PlanView {
  if (!agreement) return { plan: EMPTY_PLAN, planning: false, stale: false, failed: false }
  if (!solved || solved.agreement !== agreement) return { plan: EMPTY_PLAN, planning: true, stale: false, failed: false }
  if (solved.key !== key) return { plan: solved.plan, planning: true, stale: true, failed: false }
  return { plan: solved.plan, planning: false, stale: false, failed: !!solved.plan.error }
}

/** A plan that says something about the current inputs: solved for them and not an error plan. */
export const authoritative = (v: PlanView) => !v.planning && !v.failed
