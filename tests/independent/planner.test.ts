/**
 * The app's planner (solve) against the oracle and an independent brute force, on synthetic agreements and on the
 * real ones: allowed colleges only, no UC-only rows planned, no blocking split created, `unsolvable` iff infeasible,
 * a valid plan when solvable, deterministic under input order, and minimal under the objective in OBJECTIVE.
 */
import { afterAll, describe, expect, it } from 'vitest'
import type { Agreement, CourseId, Plan, ReqNode, Requirement } from '../../src/engine/types'
import { solve } from '../../src/engine/solve.ts'
import { BUDGET, FULL, SEED, SLOW } from './budget.ts'
import { bruteMin, feasible, planCost, PURE_UNITS } from './brute.ts'
import { CCS, FH, DA, INDEX, loadAgreement, SYS } from './fixtures.ts'
import { writeMetrics } from './metrics.ts'
import { instOf, oracle } from './oracle.ts'
import { OBJECTIVE, PlannerStats, runPlanner } from './planner-harness.ts'
import { NO_RECORD, randomAgreement, rng } from './synth.ts'

const SYNTH = new PlannerStats('synthetic realistic'), REAL = new PlannerStats('real grid + random'), LATENT = new PlannerStats('synthetic latent shapes')
const determinism = { runs: 0, same: 0, diffs: [] as unknown[] }
const knownIssues: Record<string, string> = {}
const t0 = performance.now()
const report = (S: PlannerStats) => `${JSON.stringify(S.summary())}\n${S.examples.map((e) => JSON.stringify(e)).join('\n')}`

describe('planner vs brute force: synthetic agreements', () => {
  it(`${BUDGET.plannerSynth} realistic agreements (inherited optional flags, choice shapes normalize produces)`, () => {
    const r = rng(SEED + 10)
    for (let i = 0; i < BUDGET.plannerSynth; i++) {
      const a = randomAgreement(r, { inherit: true, latentShapes: false })
      const taken = Object.keys(a.catalog).filter(() => r.next() < 0.2)
      const allowed = a.sendingIds.filter(() => r.next() < 0.7)
      if (!allowed.length) allowed.push(a.sendingIds[0])
      runPlanner(SYNTH, { a, file: `synthetic seed=${SEED + 10} #${i} root=${JSON.stringify(a.root)}`, taken, allowed, home: allowed[0], brute: true, bruteBudget: 50_000 })
    }
    expect(SYNTH.violationCount, report(SYNTH)).toBe(0)
    expect(SYNTH.minimality.checked).toBeGreaterThan(BUDGET.plannerSynth / 3)
  }, SLOW)
})

const sig = (p: Plan) => JSON.stringify({ t: p.terms.map((t) => [t.name, [...t.courses].sort()]), u: [...p.unsolvable].sort(), tot: p.totalUnits })

describe('planner rules on the real agreements', () => {
  const homes = BUDGET.plannerHomes === 'all' ? CCS : BUDGET.plannerHomes
  for (const e of INDEX) it(`${e.file}: homes ${homes.length === CCS.length ? 'all 15' : homes.join(', ')} x {home, home + Foothill (De Anza for Foothill), all 15}`, () => {
    const a = loadAgreement(e.file), r = rng(SEED + e.file.length)
    const before = REAL.violationCount
    for (const home of homes) for (const allowed of [[home], home === FH ? [FH, DA] : [home, FH], [home, ...CCS.filter((x) => x !== home)]]) {
      const p = runPlanner(REAL, { a, file: e.file, taken: [], allowed, home, systems: SYS, brute: allowed.length <= 2, bruteBudget: BUDGET.bruteBudget / 4 })
      // same plan whatever the order of allowed colleges (home first stays home)
      const again = solve(new Set(), a, { allowed: [home, ...r.shuffle(allowed.filter((x) => x !== home))], home, termSystem: SYS[home], unitSystems: SYS, unitCap: SYS[home] === 'semester' ? 12 : 16, maxTerms: 6 })
      determinism.runs++
      if (p && sig(p) === sig(again)) determinism.same++
      else if (determinism.diffs.length < 10) determinism.diffs.push({ file: e.file, home, allowed })
    }
    expect(REAL.violationCount - before, report(REAL)).toBe(0)
  }, SLOW)

  it(`${BUDGET.plannerRealRandom} random transcripts at random college sets, taken order shuffled`, () => {
    const r = rng(SEED + 11)
    const before = REAL.violationCount
    for (let i = 0; i < BUDGET.plannerRealRandom; i++) {
      const e = r.pick(INDEX), a = loadAgreement(e.file), home = r.pick(CCS)
      const allowed = [...new Set(r.pick([[home], [home, FH], [home, DA], [home, ...r.shuffle(CCS).slice(0, 3)], CCS]))]
      const cols = r.shuffle(CCS).slice(0, 1 + r.int(3))
      const taken = Object.keys(a.catalog).filter((c) => cols.includes(instOf(c)) && r.next() < 0.3)
      const p = runPlanner(REAL, { a, file: e.file, taken, allowed, home, systems: SYS, brute: allowed.length <= 2 && taken.length < 12, bruteBudget: BUDGET.bruteBudget / 4 })
      const again = solve(new Set(r.shuffle(taken)), a, { allowed, home, termSystem: SYS[home], unitSystems: SYS, unitCap: SYS[home] === 'semester' ? 12 : 16, maxTerms: 6 })
      determinism.runs++
      if (p && sig(p) === sig(again)) determinism.same++
      else if (determinism.diffs.length < 10) determinism.diffs.push({ file: e.file, home, allowed, taken })
    }
    expect(REAL.violationCount - before, report(REAL)).toBe(0)
  }, SLOW)

  it('is deterministic under input order', () => expect(determinism.same, JSON.stringify(determinism.diffs)).toBe(determinism.runs))
})

/* ---- the brute force itself (no app involved) ---- */
const req = (id: string, ...groups: CourseId[][]): Requirement =>
  ({ kind: 'req', id, label: id, units: 4, groups: groups.map((courses) => ({ institutionId: instOf(courses[0]), courses })) })
const tiny = (children: (ReqNode | Requirement)[], units: Record<CourseId, number>): Agreement => ({
  receivingId: 1, major: 'tiny', year: 'x', sendingIds: [1, 2],
  root: { kind: 'node', type: 'AND', required: true, children },
  catalog: Object.fromEntries(Object.entries(units).map(([id, u]) => [id, { id, institutionId: instOf(id), prefix: id.split(':')[1].split(' ')[0], number: id.split(' ')[1], title: id, units: u }])),
})

describe('independent brute force', () => {
  const a = tiny([req('R1', ['1:MATH 1'], ['2:MATH 1']), req('R2', ['1:MATH 2'], ['2:MATH 2'])], { '1:MATH 1': 5, '2:MATH 1': 4, '1:MATH 2': 5, '2:MATH 2': 4 })
  const unitsOf = (c: CourseId) => a.catalog[c].units
  it('units mode takes the cheapest groups wherever they are', () => {
    expect(bruteMin(a, new Set(), { allowed: [1, 2], home: 1, unitsOf })).toEqual({ cost: 8, units: 8, set: ['2:MATH 1', '2:MATH 2'] })
  })
  it('weighted mode charges each extra college and each subject chain across colleges', () => {
    expect(planCost(['1:MATH 1', '2:MATH 2'], unitsOf, { college: 5, chain: 5 }, 1)).toEqual({ cost: 19, units: 9 })
    expect(bruteMin(a, new Set(), { allowed: [1, 2], home: 1, unitsOf, weights: { college: 5, chain: 5 } })).toEqual({ cost: 10, units: 10, set: ['1:MATH 1', '1:MATH 2'] })
    expect(bruteMin(a, new Set(), { allowed: [1, 2], home: 1, unitsOf, weights: { college: 1, chain: 0 } })).toEqual({ cost: 9, units: 8, set: ['2:MATH 1', '2:MATH 2'] })
  })
  it('agrees with the oracle on feasibility', () => {
    expect(bruteMin(a, new Set(), { allowed: [3], unitsOf })).toBeNull()
    expect(feasible(a, new Set(), [3])).toBe(false)
    expect(feasible(a, new Set(), [2])).toBe(true)
  })
  it(`objective under test: ${OBJECTIVE === PURE_UNITS ? 'pure units (weights 0)' : `weighted ${JSON.stringify(OBJECTIVE)}`}`, () => {
    expect(OBJECTIVE.college >= 0 && OBJECTIVE.chain >= 0).toBe(true)
  })
})

/* ---- latent planner findings (COUNSELOR_REPORT MED-1, MED-2, LOW-2): reported, enforced with INDEPENDENT_STRICT_LATENT=1 ---- */
const STRICT = process.env.INDEPENDENT_STRICT_LATENT === '1'
const uc = (id: string): Requirement => ({ kind: 'req', id, label: id, units: 4, groups: [], noArticulation: { 1: 'This course must be taken at the university after transfer' } })
const none = (id: string): Requirement => ({ kind: 'req', id, label: id, units: 4, groups: [], noArticulation: { 1: NO_RECORD } })
const choice = (type: 'OR' | 'N_OF', children: (ReqNode | Requirement)[], n?: number): ReqNode => ({ kind: 'node', type, n, required: true, children })
const problemsOf = (a: Agreement, allowed: number[]) => {
  const S = new PlannerStats('latent')
  runPlanner(S, { a, file: 'hand', taken: [], allowed, home: allowed[0], brute: true })
  return S.examples.map((e) => `${e.kind}: ${JSON.stringify(e.detail)}`)
}
function knownIssue(id: string, problems: string[]) {
  knownIssues[id] = problems.length ? 'present' : 'no longer reproduces'
  if (STRICT) expect(problems, id).toEqual([])
  else if (!problems.length) console.warn(`[independent] ${id} no longer reproduces: move it to an enforced test`)
}

describe(`latent planner findings (${STRICT ? 'enforced' : 'reported only; INDEPENDENT_STRICT_LATENT=1 enforces'})`, () => {
  it('MED-1: OR(no record, UC-only) next to a CC row is solvable (the UC-only row fills the slot)', () => {
    const a = tiny([choice('OR', [none('P1'), uc('U1')]), req('R1', ['1:C 1'])], { '1:C 1': 4 })
    expect(feasible(a, new Set(), [1])).toBe(true)
    knownIssue('MED-1', problemsOf(a, [1]))
  })
  it('MED-2: an alternative that passes only by deferral does not satisfy a choice with an open CC alternative', () => {
    const a = tiny([choice('OR', [choice('N_OF', [uc('U6'), req('R7', ['1:C 7'])], 2), req('R8', ['1:C 8'])])], { '1:C 7': 2, '1:C 8': 5 })
    expect(oracle(a, new Set(['1:C 7'])).isValid, 'the CC alternative R8 is owed').toBe(false)
    knownIssue('MED-2', problemsOf(a, [1]))
  })
  it('LOW-2: an optional subtree inside a choice never satisfies it', () => {
    const opt: ReqNode = { kind: 'node', type: 'AND', required: false, children: [req('R1', ['1:C 1'])] }
    const a = tiny([choice('OR', [opt, req('R2', ['1:C 2'])])], { '1:C 1': 1, '1:C 2': 5 })
    expect(oracle(a, new Set(['1:C 1'])).isValid).toBe(false)
    knownIssue('LOW-2', problemsOf(a, [1]))
  })
  it.runIf(FULL)(`${BUDGET.plannerSynth} synthetic agreements with latent shapes: hard rules hold, the rest is reported`, () => {
    const r = rng(SEED + 12)
    for (let i = 0; i < BUDGET.plannerSynth; i++) {
      const a = randomAgreement(r, { inherit: i % 2 === 0, latentShapes: true })
      const taken = Object.keys(a.catalog).filter(() => r.next() < 0.2)
      const allowed = a.sendingIds.filter(() => r.next() < 0.7)
      if (!allowed.length) allowed.push(a.sendingIds[0])
      runPlanner(LATENT, { a, file: `latent seed=${SEED + 12} #${i} root=${JSON.stringify(a.root)}`, taken, allowed, home: allowed[0], brute: true, bruteBudget: 50_000 })
    }
    const hard = ['THROW', 'PLANNED_OUTSIDE_ALLOWED', 'RE_PLANNED_TAKEN', 'PLANNED_UC_ONLY_ROW', 'BEATS_BRUTE_FORCE']
    expect(hard.filter((k) => LATENT.violations[k]), report(LATENT)).toEqual([])
    if (STRICT) expect(LATENT.violationCount, report(LATENT)).toBe(0)
  }, SLOW)
})

afterAll(() => writeMetrics('planner', {
  seconds: Number(((performance.now() - t0) / 1000).toFixed(1)),
  objective: OBJECTIVE, synthetic: SYNTH.summary(), real: REAL.summary(), determinism: { runs: determinism.runs, same: determinism.same },
  latent: FULL ? LATENT.summary() : 'run with INDEPENDENT_BUDGET=full', knownIssues,
  ruleViolations: SYNTH.violationCount + REAL.violationCount,
}))
