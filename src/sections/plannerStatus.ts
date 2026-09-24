import type { Plan, ValidationResult, Violation } from '../engine/types'
import type { TrustLevel } from '../data-trust'

/** Pure verdict logic for the Planner, kept out of the component so it can be tested without a DOM. */

// an engine that predates `blocking` reports every split as fatal, so a missing flag counts as blocking
export const isBlocking = (v: Violation) => v.blocking !== false

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** Required requirements finished at the university after transfer, from the plan and the completed courses. */
export const deferredOf = (current: ValidationResult, plan: Plan) =>
  [...new Set([...(plan.result.deferred ?? []), ...(current.deferred ?? [])])]

/** `ok`: green, every requirement covered. `problem`: red, grounded in ASSIST rows that exist. `unconfirmed`: would be
 *  green, but the data cannot be trusted (DATA_CONTRACT.md), so it is never shown as covered. */
export type Tone = 'ok' | 'problem' | 'unconfirmed'
/** `caveat`: a line about the data behind the verdict, shown under the title. */
export interface Status { ok: boolean; tone: Tone; title: string; details: string[]; caveat?: string }

export const UNCONFIRMED_TITLE = "Can't confirm — data needs refresh"
export const CAVEAT = {
  unconfirmed: 'The ASSIST data behind this check is out of date or unchecked, so it cannot say you are done. Confirm with a counselor.',
  problem: 'The ASSIST data behind this check needs a refresh. Confirm with a counselor.',
  aging: 'The ASSIST data behind this check is more than a week old. Confirm with a counselor before enrolling.',
} as const

/** One status drives the badge's color, icon and title, so a red badge never claims coverage and a green one
 *  never hides a blocking problem. Deferred requirements and non-blocking splits never turn it red. Untrusted data
 *  never turns it green: a would-be green becomes `unconfirmed`; red stays red with a caveat. `trust` defaults to
 *  'trusted' for callers that predate the data-trust check. */
export function badgeStatus(current: ValidationResult, plan: Plan, uc: string, trust: TrustLevel = 'trusted'): Status {
  const blocking = current.splitSeriesViolations.filter(isBlocking)
  const planSplits = plan.result.splitSeriesViolations.filter(isBlocking).map((v) => v.requirementId)
  const problem = blocking.length ? `${plural(blocking.length, 'split-series violation')} in your completed courses`
    : plan.unsolvable.length ? 'Some requirements cannot be met at the selected colleges'
    : planSplits.length ? `The planned schedule still splits ${planSplits.join(', ')} across colleges`
    : !plan.result.isValid ? 'The plan does not complete every requirement'
    : null
  const deferred = deferredOf(current, plan).length
  const warnings = current.splitSeriesViolations.length - blocking.length
  const details = [
    ...(deferred ? [`${deferred} to complete at ${uc} after transfer`] : []),
    ...(warnings ? [plural(warnings, 'warning')] : []),
  ]
  if (problem !== null) return trust === 'untrusted'
    ? { ok: false, tone: 'problem', title: problem, details, caveat: CAVEAT.problem }
    : { ok: false, tone: 'problem', title: problem, details }
  if (trust === 'untrusted') return { ok: false, tone: 'unconfirmed', title: UNCONFIRMED_TITLE, details, caveat: CAVEAT.unconfirmed }
  if (trust === 'aging') return { ok: true, tone: 'ok', title: 'Every requirement covered', details, caveat: CAVEAT.aging }
  return { ok: true, tone: 'ok', title: 'Every requirement covered', details }
}

/** Text when nothing is left to schedule: never claims completion on untrusted data. */
export const nothingLeftNote = (trust: TrustLevel = 'trusted') => trust === 'untrusted'
  ? 'Nothing left to schedule under the current data, but the data needs a refresh. Confirm with a counselor before you stop taking courses.'
  : 'Everything required is already complete. Nothing left to schedule.'

/** Note under "units to go": only claims minimality when the engine proved it. */
export const optimalNote = (plan: Plan) => (plan.optimal === true ? 'minimum units' : plan.optimal === false ? 'near-minimum' : null)

/** "PHYSICS 7B — offered at Foothill" -> { what: "PHYSICS 7B", offeredAt: "Foothill" } */
export function splitUnsolvable(entry: string): { what: string; offeredAt?: string } {
  const i = entry.indexOf(' — offered at ')
  return i < 0 ? { what: entry } : { what: entry.slice(0, i), offeredAt: entry.slice(i + ' — offered at '.length) }
}
