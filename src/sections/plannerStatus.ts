import type { Plan, ValidationResult, Violation } from '../engine/types'

/** Pure verdict logic for the Planner, kept out of the component so it can be tested without a DOM. */

// an engine that predates `blocking` reports every split as fatal, so a missing flag counts as blocking
export const isBlocking = (v: Violation) => v.blocking !== false

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** Required requirements finished at the university after transfer, from the plan and the completed courses. */
export const deferredOf = (current: ValidationResult, plan: Plan) =>
  [...new Set([...(plan.result.deferred ?? []), ...(current.deferred ?? [])])]

export interface Status { ok: boolean; title: string; details: string[] }

/** One status drives the badge's color, icon and title, so a red badge never claims coverage and a green one
 *  never hides a blocking problem. Deferred requirements and non-blocking splits never turn it red. */
export function badgeStatus(current: ValidationResult, plan: Plan, uc: string): Status {
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
  return { ok: problem === null, title: problem ?? 'Every requirement covered', details }
}

/** Note under "units to go": only claims minimality when the engine proved it. */
export const optimalNote = (plan: Plan) => (plan.optimal === true ? 'minimum units' : plan.optimal === false ? 'near-minimum' : null)

/** "PHYSICS 7B — offered at Foothill" -> { what: "PHYSICS 7B", offeredAt: "Foothill" } */
export function splitUnsolvable(entry: string): { what: string; offeredAt?: string } {
  const i = entry.indexOf(' — offered at ')
  return i < 0 ? { what: entry } : { what: entry.slice(0, i), offeredAt: entry.slice(i + ' — offered at '.length) }
}
