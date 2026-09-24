/**
 * Named counselor scenarios: app == oracle == counselor expectation, on the real fixtures.
 * Refetch-dependent scenarios run in their own describes, keyed to data/meta.json normalizeVersion.
 */
import { afterAll, describe, expect, it } from 'vitest'
import type { CourseId, Plan, ValidationResult } from '../../src/engine/types'
import { check, describeFailures, Metrics, type Confusion } from './compare.ts'
import { SLOW } from './budget.ts'
import { DATA_REFRESHED, loadAgreement, META, SYS } from './fixtures.ts'
import { writeMetrics } from './metrics.ts'
import type { OracleResult } from './oracle.ts'
import { PlannerStats, runPlanner } from './planner-harness.ts'
import { SCENARIOS, type Expect, type PlanExpect, type Scenario } from './scenarios.ts'

interface View { valid: boolean; sat: Set<string>; splits: Map<string, boolean>; deferred: Set<string>; mentions: (id: string) => boolean }
const appView = (v: ValidationResult): View => ({
  valid: v.isValid, sat: new Set(Object.keys(v.satisfied)), deferred: new Set(v.deferred),
  splits: new Map(v.splitSeriesViolations.map((x) => [x.requirementId, x.blocking])),
  mentions: (id) => v.missing.some((m) => m.includes(id)),
})
const oracleView = (o: OracleResult): View => ({
  valid: o.isValid, sat: o.satisfied, deferred: o.deferred,
  splits: new Map([...o.splits].map((id) => [id, o.blocking.has(id)])),
  mentions: (id) => o.missing.has(id),
})

/** What in `e` the result does not meet (empty = meets it). */
function unmet(e: Expect, v: View): string[] {
  const out: string[] = []
  if (v.valid !== e.valid) out.push(`isValid ${v.valid}, expected ${e.valid}`)
  for (const id of e.sat ?? []) if (!v.sat.has(id)) out.push(`${id} should be satisfied`)
  for (const id of e.unsat ?? []) if (v.sat.has(id)) out.push(`${id} should not be satisfied`)
  for (const id of e.split ?? []) if (!v.splits.has(id)) out.push(`${id} should be a split`)
  if (e.split && !e.split.length && !e.warn && v.splits.size) out.push(`no split expected, got ${[...v.splits.keys()]}`)
  for (const id of e.blocking ?? []) if (v.splits.get(id) !== true) out.push(`${id} should be a blocking split (got ${v.splits.has(id) ? 'warning' : 'none'})`)
  for (const id of e.warn ?? []) if (v.splits.get(id) !== false) out.push(`${id} should be a warning split (got ${v.splits.has(id) ? 'blocking' : 'none'})`)
  for (const id of e.notSplit ?? []) if (v.splits.has(id)) out.push(`${id} should not be a split`)
  if (e.deferred && (e.deferred.length !== v.deferred.size || e.deferred.some((x) => !v.deferred.has(x)))) out.push(`deferred ${[...v.deferred]}, expected ${e.deferred}`)
  for (const id of e.missingIncludes ?? []) if (!v.mentions(id)) out.push(`missing should name ${id}`)
  return out
}

function unmetPlan(P: PlanExpect, p: Plan): string[] {
  const out: string[] = []
  const planned = p.terms.flatMap((t) => t.courses)
  if (P.validPlan !== undefined && (p.unsolvable.length === 0) !== P.validPlan) out.push(`unsolvable ${JSON.stringify(p.unsolvable)}, expected a ${P.validPlan ? 'complete' : 'incomplete'} plan`)
  for (const c of P.notPlanned ?? []) if (planned.includes(c)) out.push(`re-planned ${c}`)
  for (const c of P.mustPlan ?? []) if (!planned.includes(c)) out.push(`should plan ${c}; planned ${planned}`)
  if (P.onlyAt) for (const c of planned) if (!P.onlyAt.includes(Number(c.split(':')[0]))) out.push(`planned outside ${P.onlyAt}: ${c}`)
  for (const s of P.unsolvableMentions ?? []) if (!p.unsolvable.some((u) => u.includes(s))) out.push(`unsolvable should mention ${s}: ${JSON.stringify(p.unsolvable)}`)
  for (const s of P.unsolvableExcludes ?? []) if (p.unsolvable.some((u) => u.includes(s))) out.push(`unsolvable should not mention ${s}: ${JSON.stringify(p.unsolvable)}`)
  for (const s of P.offeredAtIncludes ?? []) if (!p.unsolvable.some((u) => u.includes(s))) out.push(`unsolvable should name ${s}: ${JSON.stringify(p.unsolvable)}`)
  if (P.counselor && !p.unsolvable.some((u) => /counselor/.test(u))) out.push('should send the student to a counselor')
  return out
}

const M = new Metrics('named-scenarios')
const planner = new PlannerStats('named-scenarios')
const rules: Confusion = { TP: 0, TN: 0, FP: 0, FN: 0 }
const deviations: string[] = []
let enforced = 0

/** One scenario against one expectation: app == oracle, oracle meets it, app meets it, planner rules hold. */
function run(s: Scenario, e: Expect, P?: PlanExpect) {
  enforced++
  const a = loadAgreement(s.file), taken = new Set<CourseId>(s.taken)
  const local = new Metrics(s.id)
  const { o, v } = check(local, s.file, a, taken)
  rules[e.valid ? (v.isValid ? 'TP' : 'FN') : v.isValid ? 'FP' : 'TN']++
  const problems: string[] = []
  const dev = s.knownAppDeviation
  if (dev) {
    // hostile input only: the verdict must still match; row-level differences are allowed on the named rows
    const other = local.failures.filter((f) => !['ROW_FP', 'ROW_FN', 'MISSING_DIFF'].includes(f.kind) || !dev.rows.some((id) => JSON.stringify(f).includes(id)))
    if (other.length) problems.push(`app vs oracle:\n${other.map((f) => JSON.stringify(f)).join('\n')}`)
    const appDiffers = unmet(e, appView(v)).filter((x) => !dev.rows.some((id) => x.startsWith(id)))
    if (appDiffers.length) problems.push(`app vs expected: ${appDiffers.join('; ')}`)
    if (local.failureCount) deviations.push(`${s.id}: ${dev.finding} still present`)
    else deviations.push(`${s.id}: ${dev.finding} no longer reproduces; drop knownAppDeviation`)
  } else {
    M.merge(local)
    if (local.failureCount) problems.push(`app vs oracle:\n${describeFailures(local)}`)
    const appDiffers = unmet(e, appView(v))
    if (appDiffers.length) problems.push(`app vs expected: ${appDiffers.join('; ')}`)
  }
  const oracleDiffers = unmet(e, oracleView(o))
  if (oracleDiffers.length) problems.push(`oracle vs expected: ${oracleDiffers.join('; ')}`)

  if (dev) return void expect(problems, `${s.id} ${s.name}`).toEqual([]) // the planner inherits the deviation; nothing more to learn
  const before = planner.violationCount
  const p = runPlanner(planner, { a, file: s.file, taken: s.taken, allowed: s.allowed, home: s.home, systems: SYS })
  if (planner.violationCount > before) problems.push(`planner rules: ${JSON.stringify(planner.examples.slice(-1))}`)
  if (P && p) {
    const planDiffers = unmetPlan(P, p)
    if (planDiffers.length) problems.push(`plan vs expected: ${planDiffers.join('; ')}`)
  }
  expect(problems, `${s.id} ${s.name}\n  why: ${s.why}\n  taken: ${JSON.stringify(s.taken.slice(0, 40))}`).toEqual([])
}

const fixed = SCENARIOS.filter((s) => !s.dataDependent)
const refetch = SCENARIOS.filter((s) => s.dataDependent === 'refetch')
const WAIT = `skipped until data/ is refreshed (meta.json normalizeVersion ${META.normalizeVersion} < 2; run npm run fetch)`

describe('named counselor scenarios: app == oracle == counselor', () => {
  it('the catalog has at least 150 scenarios, unique ids, a rationale each, and the three Plan.md stories', () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(150)
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length)
    for (const s of SCENARIOS) expect(s.why.length, s.id).toBeGreaterThan(3)
    for (const story of ['Plan.md Scenario 1', 'Plan.md Scenario 2', 'Plan.md Scenario 3']) expect(SCENARIOS.some((s) => s.story === story), story).toBe(true)
    for (const s of refetch) if (s.realWorld) expect(s.realWorld.finding, s.id).toMatch(/^(CRITICAL|HIGH)-\d$/)
  })
  for (const s of fixed) it(`${s.id}: ${s.name}`, () => run(s, s.expect, s.plan), SLOW)
})

describe('refetch-dependent scenarios: legacy fixture answer (until data/ is refreshed)', () => {
  for (const s of refetch) it.skipIf(DATA_REFRESHED)(`${s.id}: ${s.name}`, () => run(s, s.expect, s.plan), SLOW)
})

describe(`refetch-dependent scenarios: real-world answer${DATA_REFRESHED ? '' : ` (${WAIT})`}`, () => {
  for (const s of refetch) {
    if (!s.realWorld) it.todo(`${s.id}: re-derive the expectation after npm run fetch (${s.name})`)
    else it.skipIf(!DATA_REFRESHED)(`${s.id} [${s.realWorld.finding}]: ${s.realWorld.why}`, () => run(s, s.realWorld!.expect, s.realWorld!.plan), SLOW)
  }
})

afterAll(() => {
  const real: Confusion = { TP: 0, TN: 0, FP: 0, FN: 0 }
  // the real-world verdict where it is known, else the rules' answer on these fixtures
  for (const s of SCENARIOS) {
    const truth = s.realWorld?.expect.valid ?? s.expect.valid
    const appValid = check(new Metrics('rw'), s.file, loadAgreement(s.file), new Set(s.taken)).v.isValid
    real[truth ? (appValid ? 'TP' : 'FN') : appValid ? 'FP' : 'TN']++
  }
  writeMetrics('scenarios', {
    scenarios: SCENARIOS.length, enforced, refetchDependent: refetch.length, dataRefreshed: DATA_REFRESHED,
    appVsExpected: rules, appVsRealWorld: real, appVsOracle: M.summary(), planner: planner.summary(), knownAppDeviations: deviations,
  })
})
