import type { PlanResult } from '../engine/solveClient'
import type { Agreement, CourseId, Term, ValidationResult } from '../engine/types'
import { nthTerm, startSlot } from '../engine/calendar'
import type { StartTerm, TermSystem } from '../terms'

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

/**
 * The longest plan that fits in two academic years: 4 semesters or 6 quarters (summer not counted). The solver packs
 * every course regardless (solve.ts ignores maxTerms); the Planner flags a plan past this limit as too long.
 */
export const maxTermsFor = (system: 'semester' | 'quarter'): number => (system === 'semester' ? 4 : 6)

/** The last quarter-period slot (engine/calendar.ts timeline) of the allowed window: maxTermsFor(home) consecutive
 *  home-calendar terms starting at `start` (the same terms termsFrom(start, home, max) lists). null for a start term
 *  the calendar cannot read. */
export function windowEnd(start: StartTerm, home: TermSystem): number | null {
  try {
    return nthTerm(home, startSlot(start, home), maxTermsFor(home) - 1).end
  } catch {
    return null
  }
}

/** A planned term's [first, last] slot on the shared timeline: its solver span, else derived from system/season/year. */
function spanOf(t: Term): [number, number] | null {
  if (t.span) return t.span
  if (!t.system || !t.season || t.year === undefined) return null
  try {
    const c = nthTerm(t.system, startSlot({ season: t.season, year: t.year }, t.system), 0)
    return [c.start, c.end]
  } catch {
    return null
  }
}

/**
 * Indices of the planned terms that fall outside two academic years of the home calendar, measured in TIME rather than
 * by counting cards: a plan can mix quarter and semester colleges, so 8 mixed cards may fit in 4 semesters while 6 may
 * run into a 7th quarter.
 *
 * Rule: a term is beyond the window when it ENDS after the window's last home term ends (span[1] > windowEnd), i.e. the
 * student would still be in class after two academic years. With a semester home the window always ends at a slot
 * where every quarter term ends too, so this equals "starts after the window". With a quarter home whose window ends
 * on a Winter quarter, a Spring semester (Jan-May) that starts inside the window but runs past it is flagged: it cannot
 * finish in time.
 *
 * A term without any calendar information falls back to its position (index >= maxTermsFor(home)).
 */
export function beyondWindow(terms: readonly Term[], start: StartTerm, home: TermSystem): number[] {
  const end = windowEnd(start, home), max = maxTermsFor(home)
  const out: number[] = []
  terms.forEach((t, i) => {
    const span = end === null ? null : spanOf(t)
    if (span ? span[1] > end! : i >= max) out.push(i)
  })
  return out
}

/** The "too long" warning under the schedule (when any planned term is beyond the window, see beyondWindow), or null
 *  when the plan fits in two academic years of the home calendar. */
export function tooLongNote(beyond: boolean, system: TermSystem): string | null {
  const max = maxTermsFor(system)
  return beyond
    ? `More than ${max} ${system}s (two academic years) needed at this unit cap. Talk to a counselor about your timeline before you enroll.`
    : null
}

/** Whether to render the schedule section: not for a failed plan, nor while the first plan is built (nothing to show).
 *  A settled plan with no terms keeps it, since its note says why nothing is scheduled. */
export const showSchedule = (v: PlanView) => v.plan.terms.length > 0 || (!v.planning && !v.failed)
