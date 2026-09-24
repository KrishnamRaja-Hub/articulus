/**
 * The app's verifySchedule against the oracle on synthetic trees (nested AND / OR / N_OF, optional subtrees, UC-only
 * rows, unrecorded rows, honors twins, shared courses, repeated ids), hand-built edge trees, and a self-test that
 * the harness catches plausible regressions.
 */
import { afterAll, describe, expect, it } from 'vitest'
import type { Agreement, CourseId, ReqNode, Requirement } from '../../src/engine/types'
import { verifySchedule } from '../../src/engine/verify.ts'
import { BUDGET, SEED, SLOW } from './budget.ts'
import { check, describeFailures, Metrics, type Verifier } from './compare.ts'
import { CCS, INDEX, loadAgreement } from './fixtures.ts'
import { writeMetrics } from './metrics.ts'
import { oracle } from './oracle.ts'
import { exhaustive } from './realcases.ts'
import { NO_RECORD, randomAgreement, rng } from './synth.ts'

const RANDOM_FLAGS = new Metrics('synthetic (random optional flags)'), INHERITED = new Metrics('synthetic (inherited optional flags)')
const HAND = new Metrics('hand trees')
const t0 = performance.now()

function fuzz(M: Metrics, inherit: boolean, seed: number) {
  const r = rng(seed)
  for (let i = 0; i < BUDGET.synthTrees; i++) {
    const a = randomAgreement(r, { inherit })
    const pool = Object.keys(a.catalog), repro = `synthetic seed=${seed} inherit=${inherit} #${i} root=${JSON.stringify(a.root)}`
    for (const p of [0.15, 0.4, 0.7, 0.9]) check(M, repro, a, new Set(pool.filter(() => r.next() < p)))
  }
}

describe('verifySchedule vs oracle: synthetic trees', () => {
  it(`${BUDGET.synthTrees} trees x 4 transcripts, optional flags at random (includes LOW-2 shapes)`, () => {
    fuzz(RANDOM_FLAGS, false, SEED + 2)
    expect(RANDOM_FLAGS.failureCount, describeFailures(RANDOM_FLAGS)).toBe(0)
  }, SLOW)
  it(`${BUDGET.synthTrees} trees x 4 transcripts, optional flags inherited as normalize produces them`, () => {
    fuzz(INHERITED, true, SEED + 3)
    expect(INHERITED.failureCount, describeFailures(INHERITED)).toBe(0)
  }, SLOW)
})

/* ---- hand-built edge trees ---- */
const uc = (id: string): Requirement => ({ kind: 'req', id, label: id, units: 4, groups: [], noArticulation: { 1: 'This course must be taken at the university after transfer' } })
const none = (id: string): Requirement => ({ kind: 'req', id, label: id, units: 4, groups: [], noArticulation: { 1: NO_RECORD } })
const cc = (id: string, ...groups: CourseId[][]): Requirement =>
  ({ kind: 'req', id, label: id, units: 4, groups: groups.map((courses) => ({ institutionId: Number(courses[0].split(':')[0]), courses })) })
const node = (type: ReqNode['type'], children: (ReqNode | Requirement)[], n?: number, required = true): ReqNode => ({ kind: 'node', type, n, required, children })
const tree = (children: (ReqNode | Requirement)[], ids: CourseId[] = [], rootRequired = true): Agreement => ({
  receivingId: 1, major: 'hand', year: 'x', sendingIds: [1, 2],
  root: node('AND', children, undefined, rootRequired),
  catalog: Object.fromEntries(ids.map((id) => [id, { id, institutionId: Number(id.split(':')[0]), prefix: 'C', number: id.split(' ')[1], title: id, units: 4 }])),
})
const C1 = '1:C 1', C2 = '1:C 2'

const HAND_TREES: { name: string; a: Agreement; taken: CourseId[]; valid: boolean; deferred?: string[] }[] = [
  { name: 'OR(UC, UC): passes, one UC-only row fills the slot', a: tree([node('OR', [uc('U1'), uc('U2')])]), taken: [], valid: true, deferred: ['U1'] },
  { name: 'N_OF(2)(CC, UC, UC), nothing taken: the CC row is owed first', a: tree([node('N_OF', [cc('R1', [C1]), uc('U1'), uc('U2')], 2)], [C1]), taken: [], valid: false },
  { name: 'N_OF(2)(CC, UC, UC), CC done: one UC-only row fills the other slot', a: tree([node('N_OF', [cc('R1', [C1]), uc('U1'), uc('U2')], 2)], [C1]), taken: [C1], valid: true, deferred: ['U1'] },
  { name: 'N_OF(3)(CC, UC, UC), nothing taken', a: tree([node('N_OF', [cc('R1', [C1]), uc('U1'), uc('U2')], 3)], [C1]), taken: [], valid: false },
  { name: 'N_OF(2)(CC, no record), CC done: cannot be met', a: tree([node('N_OF', [cc('R1', [C1]), none('P1')], 2)], [C1]), taken: [C1], valid: false },
  { name: 'OR(no record, UC): the UC-only row fills the slot', a: tree([node('OR', [none('P1'), uc('U1')])]), taken: [], valid: true, deferred: ['U1'] },
  { name: 'OR(AND(CC, no record), UC), CC done', a: tree([node('OR', [node('AND', [cc('R1', [C1]), none('P1')]), uc('U1')])], [C1]), taken: [C1], valid: true, deferred: ['U1'] },
  { name: 'N_OF(5) with 2 children: cannot be met', a: tree([node('N_OF', [cc('R1', [C1]), cc('R2', [C2])], 5)], [C1, C2]), taken: [C1, C2], valid: false },
  { name: 'N_OF(0): nothing needed', a: tree([node('N_OF', [cc('R1', [C1])], 0)], [C1]), taken: [], valid: true },
  { name: 'empty AND', a: tree([node('AND', [])]), taken: [], valid: true },
  { name: 'an optional subtree never fails', a: tree([node('AND', [cc('R1', [C1])], undefined, false)], [C1]), taken: [], valid: true },
  { name: 'OR whose only child is optional (LOW-2 shape)', a: tree([node('OR', [node('AND', [cc('R1', [C1])], undefined, false)])], [C1]), taken: [], valid: false },
  { name: 'root not required', a: tree([cc('R1', [C1])], [C1], false), taken: [], valid: false },
  { name: 'honors twin only at the listing college', a: tree([cc('R1', ['1:C 1', '1:C 2'], ['1:C 1H', '1:C 2H'], ['2:C 1', '2:C 2'])], ['1:C 1', '1:C 2', '1:C 1H', '1:C 2H', '2:C 1', '2:C 2', '2:C 1H']), taken: ['2:C 1H', '2:C 2'], valid: false },
  { name: 'split: different courses at two colleges', a: tree([cc('R1', ['1:C 1', '1:C 2'], ['2:C 1', '2:C 2'])], []), taken: ['1:C 1', '2:C 2'], valid: false },
  { name: 'honors id without a listed twin is not progress', a: tree([cc('R1', ['1:C 1', '1:C 2'], ['2:C 1', '2:C 2'])], []), taken: ['1:C 1', '2:C 2H'], valid: false },
  { name: 'duplicate across colleges is not a split', a: tree([cc('R1', ['1:C 1', '1:C 2'], ['2:C 1', '2:C 2'])], []), taken: ['1:C 1', '2:C 1'], valid: false },
]

describe('verifySchedule vs oracle: hand-built edge trees', () => {
  for (const h of HAND_TREES) it(h.name, () => {
    const o = oracle(h.a, new Set(h.taken))
    expect(o.isValid, 'oracle verdict').toBe(h.valid)
    if (h.deferred) expect([...o.deferred], 'oracle deferred').toEqual(h.deferred)
    const M = new Metrics(h.name)
    check(M, `hand: ${h.name}`, h.a, new Set(h.taken))
    HAND.merge(M)
    expect(M.failureCount, describeFailures(M)).toBe(0)
  })
})

/* ---- the harness has teeth: plausible regressions must be caught ---- */
const mapTree = (n: ReqNode | Requirement, f: (r: Requirement) => Requirement, g: (x: ReqNode) => ReqNode = (x) => x): ReqNode | Requirement =>
  n.kind === 'req' ? f(n) : g({ ...n, children: n.children.map((c) => mapTree(c, f, g)) })
const onTree = (f: (r: Requirement) => Requirement, g?: (x: ReqNode) => ReqNode): Verifier => {
  const memo = new WeakMap<Agreement, Agreement>()
  return (t, a) => {
    let m = memo.get(a)
    if (!m) memo.set(a, (m = { ...a, root: mapTree(a.root, f, g) as ReqNode }))
    return verifySchedule(t, m)
  }
}
const MUTANTS: [string, Verifier][] = [
  ['a row with no ASSIST record treated as UC-only', onTree((r) => (r.groups.length ? r : { ...r, noArticulation: { 1: 'No Course Articulated' } }))],
  ['honors twins dropped', onTree((r) => ({ ...r, groups: r.groups.filter((g) => !g.courses.some((c) => c.endsWith('H'))) }))],
  ['optional subtrees treated as required', onTree((r) => r, (x) => ({ ...x, required: true }))],
  ['every split reported as blocking', (t, a) => { const v = verifySchedule(t, a); return { ...v, splitSeriesViolations: v.splitSeriesViolations.map((x) => ({ ...x, blocking: true })) } }],
  ['UC-only rows not deferred', (t, a) => ({ ...verifySchedule(t, a), deferred: [] })],
  ['the first group of a row only', onTree((r) => ({ ...r, groups: r.groups.slice(0, 1) }))],
]

describe('harness self-test: plausible regressions fail the suite', () => {
  const corpus: [string, Agreement, Set<CourseId>][] = []
  const r = rng(SEED + 4)
  for (const e of INDEX.filter((_, i) => i % 2 === 0)) {
    const a = loadAgreement(e.file)
    let k = 0
    for (const t of exhaustive(a, r, { subsetCap: 4, pairs: 1, triples: 0, pairCap: 4 })) if (k++ % 4 === 0) corpus.push([e.file, a, t])
    corpus.push([e.file, a, new Set(Object.keys(a.catalog).filter((c) => CCS.includes(Number(c.split(':')[0]))))])
  }
  for (let i = 0; i < 200; i++) {
    const a = randomAgreement(r, { inherit: i % 2 === 0 })
    corpus.push([`synthetic #${i}`, a, new Set(Object.keys(a.catalog).filter(() => r.next() < 0.6))])
  }
  for (const [name, mutant] of MUTANTS) it(`catches: ${name}`, () => {
    const M = new Metrics(name)
    let seen = 0
    for (const [file, a, t] of corpus) {
      seen++
      if (check(M, file, a, t, mutant) && M.failureCount) break
    }
    expect(M.failureCount, `not caught in ${seen} transcripts`).toBeGreaterThan(0)
  }, SLOW)
})

afterAll(() => writeMetrics('verify-synthetic', {
  seconds: Number(((performance.now() - t0) / 1000).toFixed(1)),
  randomFlags: RANDOM_FLAGS.summary(), inheritedFlags: INHERITED.summary(), handTrees: HAND.summary(),
}))
