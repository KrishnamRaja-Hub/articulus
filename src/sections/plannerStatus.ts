import type { CourseId, Plan, ValidationResult, Violation } from '../engine/types'
import type { DataTrust, TrustLevel } from '../data-trust'

/** Pure verdict logic for the Planner, kept out of the component so it can be tested without a DOM. */

// an engine that predates `blocking` reports every split as fatal, so a missing flag counts as blocking
export const isBlocking = (v: Violation) => v.blocking !== false

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** Only exactly 'trusted' or 'aging' may be trusted; anything else ('Untrusted', '', undefined, null) is untrusted. */
const trustLevel = (t: unknown): TrustLevel => (t === 'trusted' || t === 'aging' ? t : 'untrusted')

/** Required requirements finished at the university after transfer, from the plan and the completed courses. */
export const deferredOf = (current: ValidationResult, plan: Plan) =>
  [...new Set([...(plan.result.deferred ?? []), ...(current.deferred ?? [])])]

/** Whether a plan was solved and finishes every requirement: only then may it relax a completed-course verdict. */
const planFinishes = (plan: Plan) => plan.result.isValid && plan.unsolvable.length === 0

/**
 * The split series in the completed courses, each marked blocking the way the plan sees it (H-1). Checked on the
 * completed courses alone, a split in a "choose one" option is blocking until another option is done; the plan's own
 * check covers the courses it schedules, so a split its scheduled courses make unnecessary is only a warning there.
 * The plan's flag is used only when the plan finishes every requirement (a plan still being solved, EMPTY or
 * incomplete never relaxes anything). A split the plan does not mention stays as the completed courses show it unless
 * the plan reports that requirement satisfied.
 */
export function completedSplits(current: ValidationResult, plan: Plan): Violation[] {
  if (!planFinishes(plan)) return current.splitSeriesViolations
  const inPlan = new Map(plan.result.splitSeriesViolations.map((v) => [v.requirementId, v]))
  return current.splitSeriesViolations.map((v) => {
    if (!isBlocking(v)) return v
    const p = inPlan.get(v.requirementId)
    // relaxed only on the plan's word: it reports the split as not blocking, or the requirement as satisfied
    const relaxed = p ? !isBlocking(p) : !!plan.result.satisfied[v.requirementId]
    return relaxed ? { ...v, blocking: false } : v
  })
}

/** `ok`: green, every requirement covered. `problem`: red, grounded in ASSIST rows that exist. `unconfirmed`: would be
 *  green, but the data cannot be trusted (DATA_CONTRACT.md), so it is never shown as covered. `caution`: amber, would be
 *  green, but on the prior academic year's agreements (carried over, TESTER L-1), so it is never shown as certain. */
export type Tone = 'ok' | 'problem' | 'unconfirmed' | 'caution' | 'pending'
/** `caveat`: a line about the data behind the verdict, shown under the title. */
export interface Status { ok: boolean; tone: Tone; title: string; details: string[]; caveat?: string }

/** While a newer plan is being computed: no verdict at all, so the badge is never green on the previous plan. */
export const PLANNING: Status = { ok: false, tone: 'pending', title: 'Planning…', details: [] }

export const UNCONFIRMED_TITLE = "Can't confirm — data needs refresh"
export const CAUTION_TITLE = "Covered under last year's agreement — confirm with a counselor"
export const REVIEW_TITLE = 'Looks covered — confirm the "choose several" requirement with a counselor'
export const PLAN_FAILED_TITLE = "Couldn't build a plan"
export const CAVEAT = {
  planFailed: 'Something went wrong while planning. Change an input to try again, or confirm your plan with a counselor.',
  unconfirmed: 'The ASSIST data behind this check is out of date or unchecked, so it cannot say you are done. Confirm with a counselor.',
  problem: 'The ASSIST data behind this check needs a refresh. Confirm with a counselor.',
  aging: 'The ASSIST data behind this check is more than a week old. Confirm with a counselor before enrolling.',
  review: 'This major has a "choose several of these" requirement, and this check cannot yet guarantee one course is not counted twice in it. Confirm with a counselor before enrolling.',
  priorYear: "This check uses the prior academic year's agreements, and articulation can change between years. Confirm with a counselor before enrolling.",
  // both caveats at once (round 7 L-5): the review sentence, then the prior-year one, with a single "confirm" ending
  reviewPriorYear: 'This major has a "choose several of these" requirement, and this check cannot yet guarantee one course is not counted twice in it. It also uses the prior academic year\'s agreements, and articulation can change between years. Confirm with a counselor before enrolling.',
} as const

/** One status drives the badge's color, icon and title, so a red badge never claims coverage and a green one
 *  never hides a blocking problem. Deferred requirements and non-blocking splits never turn it red. Untrusted data
 *  never turns it green: a would-be green becomes `unconfirmed`; red stays red with a caveat. Prior-year data (a
 *  DataTrust with a yearNote) turns a would-be green amber (`caution`, L-1). Completed-course splits are judged with
 *  the plan (completedSplits, H-1). `trust` defaults to 'trusted' for callers that predate the data-trust check. */
export function badgeStatus(current: ValidationResult, plan: Plan, uc: string,
  trustIn: TrustLevel | Pick<DataTrust, 'level' | 'yearNote'> = 'trusted'): Status {
  // the planner threw or timed out (solveClient errorPlan): say so, never a coverage verdict (round 7 N-2)
  const failed = (plan as Plan & { error?: string }).error
  if (failed) return { ok: false, tone: 'problem', title: PLAN_FAILED_TITLE, details: [failed], caveat: CAVEAT.planFailed }
  // the default covers callers that omit trust; an invalid value, null or an object without a valid level is untrusted
  const obj = typeof trustIn === 'object' && trustIn !== null ? trustIn : null
  const trust = trustLevel(obj ? obj.level : trustIn)
  // prior-year data (DataTrust.yearNote, set only when not untrusted): would-be green is amber, never green (L-1)
  const priorYear = !!obj?.yearNote
  const splits = completedSplits(current, plan)
  const blocking = splits.filter(isBlocking)
  const planSplits = plan.result.splitSeriesViolations.filter(isBlocking).map((v) => v.requirementId)
  const problem = blocking.length ? `${plural(blocking.length, 'split-series violation')} in your completed courses`
    : plan.unsolvable.length ? 'Some requirements cannot be met at the selected colleges'
    : planSplits.length ? `The planned schedule still splits ${planSplits.join(', ')} across colleges`
    : !plan.result.isValid ? 'The plan does not complete every requirement'
    : null
  const deferred = deferredOf(current, plan).length
  const warnings = splits.length - blocking.length
  const details = [
    ...(deferred ? [`${deferred} to complete at ${uc} after transfer`] : []),
    ...(warnings ? [plural(warnings, 'warning')] : []),
  ]
  if (problem !== null) return trust === 'untrusted'
    ? { ok: false, tone: 'problem', title: problem, details, caveat: CAVEAT.problem }
    : { ok: false, tone: 'problem', title: problem, details }
  if (trust === 'untrusted') return { ok: false, tone: 'unconfirmed', title: UNCONFIRMED_TITLE, details, caveat: CAVEAT.unconfirmed }
  // a "choose 2+ of" group: one course may still fill two slots (M-4), so a would-be green is amber, never green
  const review = [...new Set([...(current.review ?? []), ...(plan.result.review ?? [])])]
  // with prior-year data too, the caveat says both, never only the review one (round 7 L-5)
  if (review.length) return { ok: false, tone: 'caution', title: REVIEW_TITLE, details: [...details, `Check: ${review.join(', ')}`],
    caveat: priorYear ? CAVEAT.reviewPriorYear : CAVEAT.review }
  if (priorYear) return { ok: false, tone: 'caution', title: CAUTION_TITLE, details, caveat: CAVEAT.priorYear }
  if (trust === 'aging') return { ok: true, tone: 'ok', title: 'Every requirement covered', details, caveat: CAVEAT.aging }
  return { ok: true, tone: 'ok', title: 'Every requirement covered', details }
}

/** Everything the plan needs is done or scheduled: the only state in which "complete" wording may appear. */
const planComplete = (status: Status, plan: Plan) => status.tone === 'ok' && plan.unsolvable.length === 0 && plan.result.isValid

/** How many requirements the plan still leaves unmet: the unschedulable ones, else the plan's missing ones. */
export const unmetCount = (plan: Plan) => plan.unsolvable.length || plan.result.missing.length

/** The unmet requirements by name, with where each is offered when known (at most 3, then "and N more"). */
export function unmetNames(plan: Plan, max = 3): string {
  const all = plan.unsolvable.length
    ? plan.unsolvable.map((e) => { const { what, offeredAt } = splitUnsolvable(e); return offeredAt ? `${what} (offered at ${offeredAt})` : what })
    : plan.result.missing
  if (!all.length) return ''
  const shown = all.slice(0, max).join('; ')
  return all.length > max ? `${shown}; and ${all.length - max} more` : shown
}

export type NoteTone = 'ok' | 'warn' | 'alert'
export interface ScheduleNote { tone: NoteTone; text: string }

export const COMPLETE_NOTE = 'Everything required is already complete. Nothing left to schedule.'

/**
 * The line in the schedule section that says what the schedule does and does not finish. Derived from the verdict
 * (`status`, `plan.unsolvable`, `plan.result`), never from "no terms" alone (TESTER1_REPORT C-1): COMPLETE_NOTE
 * appears only when the verdict is complete on data that may be trusted.
 * null: terms are scheduled and they finish the plan, or the data caveat above the terms already says enough.
 */
export function scheduleNote(status: Status, plan: Plan, trustIn: TrustLevel = 'trusted'): ScheduleNote | null {
  const trust = trustLevel(trustIn)
  const empty = plan.terms.length === 0
  const complete = planComplete(status, plan)
  if (complete && trust !== 'untrusted') return empty ? { tone: 'ok', text: COMPLETE_NOTE } : null
  // would be complete on prior-year agreements (badgeStatus gives this the 'caution' tone, L-1)
  if (status.tone === 'caution' && plan.unsolvable.length === 0 && plan.result.isValid) return empty
    ? { tone: 'warn', text: status.title === REVIEW_TITLE
      ? 'Nothing more to schedule, but a "choose several" requirement may be counting one course twice, so we can\'t confirm you are done. Confirm with a counselor before you stop taking courses.'
      : "Nothing more to schedule under the prior year's agreements, but articulation can change between years, so we can't confirm you are done. Confirm with a counselor before you stop taking courses." }
    : null
  // would be complete, but the data cannot be trusted (badgeStatus gives this the 'unconfirmed' tone)
  if (complete || (status.tone === 'unconfirmed' && plan.unsolvable.length === 0 && plan.result.isValid)) return empty
    ? { tone: 'warn', text: "Nothing more to schedule, but the data needs a refresh, so we can't confirm you are done. Confirm with a counselor before you stop taking courses." }
    : null
  const n = unmetCount(plan)
  const unmet = n ? `${plural(n, 'requirement is', 'requirements are')} still unmet` : 'Some requirements are still unmet'
  const refresh = trust === 'untrusted' ? ' The data also needs a refresh, so confirm with a counselor.' : ''
  const names = unmetNames(plan)
  const which = names ? `: ${names}.` : ' — see above.'
  if (empty) return { tone: 'alert', text: `Nothing more can be scheduled at the selected colleges. ${unmet}${which}${refresh}` }
  const why = plan.unsolvable.length ? ' and cannot be scheduled at the selected colleges' : ''
  return { tone: 'alert', text: `This schedule does not finish your plan. ${unmet}${why}${which}${refresh}` }
}

/** Caveat on the schedule itself (TESTER1_REPORT M-3); null when the data is trusted or nothing is scheduled. */
export function scheduleCaveat(plan: Plan, trustIn: TrustLevel, dataDate?: string | null): ScheduleNote | null {
  const trust = trustLevel(trustIn)
  if (plan.terms.length === 0 || trust === 'trusted') return null
  if (trust === 'untrusted') return { tone: 'alert', text: 'This schedule is built from ASSIST data that needs a refresh, so courses may be missing or wrong. Check every course with a counselor before you enroll.' }
  return { tone: 'warn', text: `This schedule is built from ASSIST data downloaded ${dataDate ?? 'more than a week ago'}. Check it with a counselor before you enroll.` }
}

/** Short label under "units to go" (TESTER1_REPORT M-1). The planner minimizes units plus a penalty for each extra
 *  college and each subject split across colleges, so it never claims "minimum units". */
export const optimalNote = (plan: Plan) => (plan.optimal === true ? 'lowest cost under our rules' : plan.optimal === false ? 'near-lowest cost' : null)

/** Tag on a scheduled course that is planned only because a later course requires it to enroll. */
export const PREREQ_TAG = 'prerequisite'
/** Course ids the planner added only as enrollment prerequisites; empty when the engine does not report them. */
export const prereqOnlySet = (plan: Plan): ReadonlySet<CourseId> => new Set(Array.isArray(plan.prereqOnly) ? plan.prereqOnly : [])

/** The trade-off behind the label, for a tooltip and the schedule header. */
export const optimalExplain = (plan: Plan) => {
  const how = 'Lowest cost under our rules: units, counting each extra college and each subject (math, physics…) split across colleges as a few extra units. Spreading courses over more colleges can sometimes save units.'
  return plan.optimal === false ? `${how} The search stopped early, so a slightly better plan may exist.` : how
}

/** A course as the search sees it (agreement.catalog entries). */
export interface SearchCourse { id: CourseId; institutionId: number; prefix: string; number: string }

const squash = (s: string) => s.replace(/\s+/g, '').toUpperCase()
const listOr = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`)

/**
 * What to say when a completed-course search finds nothing (TESTER1_REPORT L-7). Courses that do not articulate for
 * the major stay out of the transcript (they would never count), but the student is told why: a known honors or
 * regular twin, or a course code at a college that articulates other courses in that subject, is "not articulated for
 * this major — it will not count" rather than "no course matches".
 */
export function noMatchNote(query: string, catalog: Record<CourseId, SearchCourse>, allowed: number[], taken: ReadonlySet<CourseId>,
  shortOf: (inst: number) => string): string {
  const q = query.trim()
  const at = listOr(allowed.map(shortOf))
  const generic = `No course at ${at} that counts for this major matches "${q}". Courses not listed here are not articulated for this major and will not count.`
  const m = /^([A-Z&]+)(\d[0-9A-Z.]*)$/.exec(squash(q))
  if (!m) return generic
  const [, prefix, number] = m
  const inAllowed = Object.values(catalog).filter((c) => allowed.includes(c.institutionId) && squash(c.prefix) === prefix)
  if (!inAllowed.length) return generic
  const label = `${inAllowed[0].prefix} ${number}`
  const same = inAllowed.find((c) => squash(c.number) === number && taken.has(c.id))
  if (same) return `${same.prefix} ${same.number} at ${shortOf(same.institutionId)} is already in your completed courses.`
  const twinNumber = number.endsWith('H') ? number.slice(0, -1) : `${number}H`
  const twins = inAllowed.filter((c) => squash(c.number) === twinNumber)
  if (twins.length) {
    const colleges = [...new Set(twins.map((c) => c.institutionId))]
    return `${label} is not articulated for this major at ${listOr(colleges.map(shortOf))} — it will not count. ASSIST lists ${twins[0].prefix} ${twins[0].number} instead; ask a counselor before you retake anything.`
  }
  const colleges = [...new Set(inAllowed.map((c) => c.institutionId))]
  return `${label} is not articulated for this major at ${listOr(colleges.map(shortOf))} — it will not count.`
}

/** "PHYSICS 7B — offered at Foothill" -> { what: "PHYSICS 7B", offeredAt: "Foothill" } */
export function splitUnsolvable(entry: string): { what: string; offeredAt?: string } {
  const i = entry.indexOf(' — offered at ')
  return i < 0 ? { what: entry } : { what: entry.slice(0, i), offeredAt: entry.slice(i + ' — offered at '.length) }
}
