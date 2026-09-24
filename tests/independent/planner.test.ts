/**
 * The app's planner (solve) against the oracle and an independent brute force, on synthetic agreements and on the
 * real ones: allowed colleges only, no UC-only rows planned, no blocking split created, `unsolvable` iff infeasible,
 * a valid plan when solvable, deterministic under input order, and minimal under each objective in OBJECTIVES (the
 * product default 5,5, then pure units).
 */
import { afterAll, describe, expect, it } from 'vitest'
import type { Agreement, CourseId, Plan, ReqNode, Requirement } from '../../src/engine/types'
import { solve } from '../../src/engine/solve.ts'
import { BUDGET, FULL, SEED, SLOW } from './budget.ts'
import { bruteMin, feasible, planCost, subjectChains, type Weights } from './brute.ts'
import { CCS, FH, DA, INDEX, loadAgreement, SYS } from './fixtures.ts'
import { writeMetrics } from './metrics.ts'
import { instOf, oracle } from './oracle.ts'
import { describeWeights, OBJECTIVES, PlannerStats, runPlanner, solveOptions, type PlanRun } from './planner-harness.ts'
import { NO_RECORD, permuteAgreement, randomAgreement, rng, type Rng } from './synth.ts'

const LATENT = new PlannerStats('synthetic latent shapes')
const knownIssues: Record<string, string> = {}
const t0 = performance.now()
const report = (S: PlannerStats) => `${JSON.stringify(S.summary())}\n${S.examples.map((e) => JSON.stringify(e)).join('\n')}`

/** Everything a student reads off a plan: terms (courses in any order), chosen groups, unsolvable, totals, `optimal`. */
const sig = (p: Plan) => JSON.stringify({
  t: p.terms.map((t) => [t.name, [...t.courses].sort()]), u: p.unsolvable, tot: p.totalUnits, opt: p.optimal,
  c: Object.keys(p.chosen).sort().map((id) => [id, p.chosen[id].institutionId, [...p.chosen[id].courses].sort()]),
})

const results: Record<string, unknown> = {}
for (const W of OBJECTIVES) {
  const tag = describeWeights(W)
  const SYNTH = new PlannerStats(`synthetic realistic, ${tag}`, W), REAL = new PlannerStats(`real grid + random, ${tag}`, W)
  const determinism = { runs: 0, same: 0, diffs: [] as unknown[] }
  /** The same run again with every input order shuffled (tree, groups, courses, catalog, sendingIds, allowed, taken). */
  const again = (r: Rng, p: Plan | undefined, run: PlanRun) => {
    const q = solve(new Set(r.shuffle(run.taken)), permuteAgreement(run.a, r), solveOptions({ ...run, allowed: r.shuffle(run.allowed) }, W))
    determinism.runs++
    if (p && sig(p) === sig(q)) determinism.same++
    else if (determinism.diffs.length < 10) determinism.diffs.push({ file: run.file.slice(0, 200), home: run.home, allowed: run.allowed, taken: run.taken, p: p && sig(p), q: sig(q) })
  }
  results[tag] = { SYNTH, REAL, determinism }

  describe(`planner vs brute force (${tag}): synthetic agreements`, () => {
    it(`${BUDGET.plannerSynth} realistic agreements (inherited optional flags, choice shapes normalize produces)`, () => {
      const r = rng(SEED + 10), rp = rng(SEED + 13)
      for (let i = 0; i < BUDGET.plannerSynth; i++) {
        // odd cases name rows by UC subject, so the chain penalty is exercised
        const a = randomAgreement(r, { inherit: true, latentShapes: false, subjects: i % 2 === 1 })
        const taken = Object.keys(a.catalog).filter(() => r.next() < 0.2)
        const allowed = a.sendingIds.filter(() => r.next() < 0.7)
        if (!allowed.length) allowed.push(a.sendingIds[0])
        const run = { a, file: `synthetic seed=${SEED + 10} #${i} root=${JSON.stringify(a.root)}`, taken, allowed, home: allowed[0], brute: true, bruteBudget: 50_000 }
        again(rp, runPlanner(SYNTH, run), run)
      }
      expect(SYNTH.violationCount, report(SYNTH)).toBe(0)
      expect(SYNTH.minimality.checked).toBeGreaterThan(BUDGET.plannerSynth / 3)
    }, SLOW)
  })

  describe(`planner rules on the real agreements (${tag})`, () => {
    const homes = BUDGET.plannerHomes === 'all' ? CCS : BUDGET.plannerHomes
    for (const e of INDEX) it(`${e.file}: homes ${homes.length === CCS.length ? 'all 15' : homes.join(', ')} x {home, home + Foothill (De Anza for Foothill), all 15}`, () => {
      const a = loadAgreement(e.file), r = rng(SEED + e.file.length)
      const before = REAL.violationCount
      for (const home of homes) for (const allowed of [[home], home === FH ? [FH, DA] : [home, FH], [home, ...CCS.filter((x) => x !== home)]]) {
        const run = { a, file: e.file, taken: [], allowed, home, systems: SYS, brute: allowed.length <= 2, bruteBudget: BUDGET.bruteBudget / 4 }
        again(r, runPlanner(REAL, run), run)
      }
      expect(REAL.violationCount - before, report(REAL)).toBe(0)
    }, SLOW)

    it(`${BUDGET.plannerRealRandom} random transcripts at random college sets, input order shuffled`, () => {
      const r = rng(SEED + 11)
      const before = REAL.violationCount
      for (let i = 0; i < BUDGET.plannerRealRandom; i++) {
        const e = r.pick(INDEX), a = loadAgreement(e.file), home = r.pick(CCS)
        const allowed = [...new Set(r.pick([[home], [home, FH], [home, DA], [home, ...r.shuffle(CCS).slice(0, 3)], CCS]))]
        const cols = r.shuffle(CCS).slice(0, 1 + r.int(3))
        const taken = Object.keys(a.catalog).filter((c) => cols.includes(instOf(c)) && r.next() < 0.3)
        const run = { a, file: e.file, taken, allowed, home, systems: SYS, brute: allowed.length <= 2 && taken.length < 12, bruteBudget: BUDGET.bruteBudget / 4 }
        again(r, runPlanner(REAL, run), run)
      }
      expect(REAL.violationCount - before, report(REAL)).toBe(0)
    }, SLOW)

    it('is deterministic under input order', () => expect(determinism.same, JSON.stringify(determinism.diffs)).toBe(determinism.runs))
  })
}

/* ---- the brute force itself (no app involved) ---- */
const req = (id: string, ...groups: CourseId[][]): Requirement =>
  ({ kind: 'req', id, label: id, units: 4, groups: groups.map((courses) => ({ institutionId: instOf(courses[0]), courses })) })
const tiny = (children: (ReqNode | Requirement)[], units: Record<CourseId, number>): Agreement => ({
  receivingId: 1, major: 'tiny', year: 'x', sendingIds: [1, 2],
  root: { kind: 'node', type: 'AND', required: true, children },
  catalog: Object.fromEntries(Object.entries(units).map(([id, u]) => [id, { id, institutionId: instOf(id), prefix: id.split(':')[1].split(' ')[0], number: id.split(' ')[1], title: id, units: u }])),
})

describe('independent brute force', () => {
  const a = tiny([req('MATH 51', ['1:MATH 1'], ['2:MATH 1']), req('MATH 52', ['1:MATH 2'], ['2:MATH 2'])], { '1:MATH 1': 5, '2:MATH 1': 4, '1:MATH 2': 5, '2:MATH 2': 4 })
  const unitsOf = (c: CourseId) => a.catalog[c].units
  const chains = subjectChains(a, [])
  it('units mode takes the cheapest groups wherever they are', () => {
    expect(bruteMin(a, new Set(), { allowed: [1, 2], home: 1, unitsOf })).toEqual({ cost: 8, units: 8, set: ['2:MATH 1', '2:MATH 2'] })
  })
  it('weighted mode charges each extra college and each subject chain across colleges', () => {
    expect(planCost(['1:MATH 1', '2:MATH 2'], unitsOf, { college: 5, chain: 5 }, 1, chains)).toEqual({ cost: 19, units: 9 })
    expect(bruteMin(a, new Set(), { allowed: [1, 2], home: 1, unitsOf, weights: { college: 5, chain: 5 } })).toEqual({ cost: 10, units: 10, set: ['1:MATH 1', '1:MATH 2'] })
    expect(bruteMin(a, new Set(), { allowed: [1, 2], home: 1, unitsOf, weights: { college: 1, chain: 0 } })).toEqual({ cost: 9, units: 8, set: ['2:MATH 1', '2:MATH 2'] })
  })
  it("subject chains follow the planner's definition: UC subject of the row id, 2+ rows with CC groups", () => {
    const b = tiny([
      req('COM SCI 31', ['1:CS 1'], ['2:CIS 22A']), req('COM SCI 32', ['1:CS 2H'], ['2:CIS 22B']), // chain COM SCI (CC prefix irrelevant)
      req('CHEM 1A, CHEM 1AL', ['1:CHEM 1']), req('CHEM 1B', ['2:CHEM 2']),                      // chain CHEM (up to the comma)
      req('PHYSICS 7A', ['1:PHYS 1']), req('PHYSICS 7B'),                                  // one row with groups: no chain
      req('R1', ['1:X 1']), req('R2', ['2:X 2']),                                                // no subject: no chain
    ], { '1:CS 1': 4, '2:CIS 22A': 4, '1:CS 2': 4, '1:CS 2H': 4, '2:CIS 22B': 4, '1:CHEM 1': 5, '2:CHEM 2': 5, '1:PHYS 1': 5, '1:X 1': 1, '2:X 2': 1 })
    const ch = subjectChains(b, [])
    expect(ch.map((c) => c.subject).sort()).toEqual(['CHEM', 'COM SCI'])
    const cs = ch.find((c) => c.subject === 'COM SCI')!
    expect(['1:CS 1', '1:CS 1H', '1:CS 2', '1:CS 2H', '2:CIS 22B'].every((c) => cs.members.has(c))).toBe(true)
    const u = (c: CourseId) => b.catalog[c]?.units ?? 4, w = { college: 0, chain: 5 }
    expect(planCost(['1:CS 2', '2:CIS 22A'], u, w, 1, ch).cost).toBe(13)                 // honors twin counts: split
    expect(planCost(['1:X 1', '2:X 2'], u, w, 1, ch).cost).toBe(2)                        // no chain
    expect(planCost(['2:CIS 22B'], u, w, 1, subjectChains(b, ['1:CS 1'])).cost).toBe(9)   // taken at 1, planned at 2
    expect(planCost(['1:CHEM 1'], u, w, 1, subjectChains(b, ['1:CS 1', '2:CIS 22A'])).cost).toBe(5) // taken-only chain: 0
    expect(planCost(['2:CHEM 2'], u, { college: 5, chain: 0 }, 1, ch).cost).toBe(10)     // one college away from home
  })
  it('a chain across k colleges costs chain × (k − 1): 3 colleges cost twice 2 (TESTER1 M-4)', () => {
    const c = tiny([req('MATH 1', ['1:M 1'], ['2:M 1'], ['3:M 1']), req('MATH 2', ['1:M 2'], ['2:M 2'], ['3:M 2']), req('MATH 3', ['1:M 3'], ['2:M 3'], ['3:M 3'])],
      Object.fromEntries([1, 2, 3].flatMap((k) => [1, 2, 3].map((n) => [`${k}:M ${n}`, 4]))))
    const u = (x: CourseId) => c.catalog[x].units, w = { college: 0, chain: 5 }, ch = subjectChains(c, [])
    expect(planCost(['1:M 1', '1:M 2', '1:M 3'], u, w, 1, ch).cost).toBe(12)
    expect(planCost(['1:M 1', '2:M 2', '2:M 3'], u, w, 1, ch).cost).toBe(17)
    expect(planCost(['1:M 1', '2:M 2', '3:M 3'], u, w, 1, ch).cost).toBe(22)
    expect(planCost(['2:M 2', '3:M 3'], u, w, 1, subjectChains(c, ['1:M 1'])).cost).toBe(18) // taken at 1: 3 colleges
    expect(planCost(['1:M 2', '1:M 3'], u, w, 1, subjectChains(c, ['1:M 1'])).cost).toBe(8)
  })
  it('agrees with the oracle on feasibility', () => {
    expect(bruteMin(a, new Set(), { allowed: [3], unitsOf })).toBeNull()
    expect(feasible(a, new Set(), [3])).toBe(false)
    expect(feasible(a, new Set(), [2])).toBe(true)
  })
  it(`objectives under test: ${OBJECTIVES.map(describeWeights).join(', ')}`, () => {
    expect(OBJECTIVES.every((w: Weights) => w.college >= 0 && w.chain >= 0)).toBe(true)
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

afterAll(() => {
  const by = Object.fromEntries(Object.entries(results).map(([tag, x]) => {
    const { SYNTH, REAL, determinism } = x as { SYNTH: PlannerStats; REAL: PlannerStats; determinism: { runs: number; same: number } }
    return [tag, { synthetic: SYNTH.summary(), real: REAL.summary(), determinism: { runs: determinism.runs, same: determinism.same }, ruleViolations: SYNTH.violationCount + REAL.violationCount }]
  }))
  writeMetrics('planner', {
    seconds: Number(((performance.now() - t0) / 1000).toFixed(1)),
    objectives: OBJECTIVES, byObjective: by,
    latent: FULL ? LATENT.summary() : 'run with INDEPENDENT_BUDGET=full', knownIssues,
  })
})
