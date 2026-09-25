import { describe, expect, it } from 'vitest'
import me from '../../data/agreements/79-mechanical-engineering-b-s.json'
import mae from '../../data/agreements/7-mae-mechanical-engineering-b-s.json'
import mcs from '../../data/agreements/7-mathematics-computer-science-b-s.json'
import cse from '../../data/agreements/89-computer-science-engineering-b-s.json'
import cs from '../../data/agreements/117-computer-science-b-s.json'
import ime from '../../data/agreements/120-mechanical-engineering-b-s.json'
import ece from '../../data/agreements/7-ece-electrical-engineering-b-s.json'
import dme from '../../data/agreements/89-mechanical-engineering-b-s.json'
import index from '../../data/index.json'
import type { Agreement, ReqNode, Requirement, ValidationResult } from './types'
import { blockingSplits, has, honorsColleges, honorsMix, isDeferrable, malformed, reqStatus, ucOnly, verifySchedule } from './verify'

const ME = me as unknown as Agreement, MAE = mae as unknown as Agreement, MCS = mcs as unknown as Agreement, CSE = cse as unknown as Agreement
const DA = 113, FH = 51
const reqs = (n: ReqNode | Requirement): Requirement[] => (n.kind === 'req' ? [n] : n.children.flatMap(reqs))
const req = (a: Agreement, id: string) => reqs(a.root).find((r) => r.id === id)!

describe('honors mix is per college (F-04)', () => {
  it('De Anza MATH 1CH + 1D does not satisfy UCSD MATH 20E: De Anza lists no honors twin there', () => {
    const r = verifySchedule(new Set([`${DA}:MATH 1CH`, `${DA}:MATH 1D`]), MAE)
    expect(r.satisfied['MATH 20E']).toBeUndefined()
  })
  it('Foothill MATH 1B + 1CH does not satisfy Berkeley MATH 52: only De Anza has the honors twin', () => {
    const r = verifySchedule(new Set([`${FH}:MATH 1B`, `${FH}:MATH 1CH`]), ME)
    expect(r.satisfied['MATH 52']).toBeUndefined()
  })
  it('De Anza, which has the twin, still mixes regular and honors', () => {
    expect(reqStatus(req(ME, 'MATH 52'), new Set([`${DA}:MATH 1BH`, `${DA}:MATH 1C`])).satisfied?.institutionId).toBe(DA)
  })
  it('honorsColleges names the colleges with a twin; has honours a set, and a boolean as before', () => {
    const m = req(ME, 'MATH 52')
    expect(honorsColleges(m).has(DA)).toBe(true)
    expect(honorsColleges(m).has(FH)).toBe(false)
    expect(honorsMix(m)).toBe(true)
    const t = new Set([`${DA}:MATH 1CH`, `${FH}:MATH 1CH`])
    expect(has(t, `${DA}:MATH 1C`, honorsColleges(m))).toBe(true)
    expect(has(t, `${FH}:MATH 1C`, honorsColleges(m))).toBe(false)
    expect(has(t, `${FH}:MATH 1C`, true)).toBe(true)
    expect(has(t, `${FH}:MATH 1C`, false)).toBe(false)
  })
})

describe('split detection (F-09)', () => {
  it('MATH 1BH at De Anza + MATH 1B at Foothill is a duplicate, not a split', () => {
    const r = verifySchedule(new Set([`${DA}:MATH 1BH`, `${FH}:MATH 1B`]), ME)
    expect(r.splitSeriesViolations.map((v) => v.requirementId)).not.toContain('MATH 52')
  })
  it('MATH 1BH at De Anza + MATH 1C at Foothill is still a split', () => {
    const r = verifySchedule(new Set([`${DA}:MATH 1BH`, `${FH}:MATH 1C`]), ME)
    expect(r.splitSeriesViolations.map((v) => v.requirementId)).toContain('MATH 52')
  })
})

describe('missing (F-12)', () => {
  it('an OR with one completable route names that route, not the ones through an unrecorded row', () => {
    // UC Davis CSE: two of the three ECS 32/36 routes include ECS 032C, which no college articulates and for which
    // ASSIST gives no reason (placeholder only). We cannot tell the student to take it at Davis, so the only route we
    // can vouch for is ECS 036A + 036B + 036C; it is owed row by row.
    const r = verifySchedule(new Set(), CSE)
    expect(r.missing).toEqual(expect.arrayContaining(['ECS 036A', 'ECS 036B', 'ECS 036C']))
    expect(r.missing.join()).not.toContain('ECS 032C')
    expect(r.missing.join()).not.toContain('(group)')
    expect(r.missing).toContain('MAT 021A')
  })
  it('an OR of rows with no articulation and no ASSIST reason stays missing: only a counselor can confirm UC-only', () => {
    // UCSD Math/CS: CSE 15L and CSE 29 have no CC groups, but the only "reason" is our placeholder for a row absent from
    // every payload. Telling the student "take it at UCSD" could be wrong (F-01 dropped rows), so it is not deferred.
    const r = verifySchedule(new Set(), MCS)
    expect(r.missing).toContain('One of: CSE 15L, CSE 29')
    expect(r.deferred).toEqual([])
    expect(r.missing).toContain('MATH 20A')
  })
  it('names an alternative by what it still lacks, and drops a satisfied OR', () => {
    const r = (id: string): Requirement => ({ kind: 'req', id, label: id, units: 4, groups: [{ institutionId: DA, courses: [`${DA}:${id}`] }] })
    const or: ReqNode = { kind: 'node', type: 'OR', required: true, children: [
      { kind: 'node', type: 'AND', required: true, children: [r('A'), r('B'), r('C')] }, r('D')] }
    const a = { ...ME, root: { kind: 'node', type: 'AND', required: true, children: [or] } } as Agreement
    expect(verifySchedule(new Set([`${DA}:A`]), a).missing).toEqual(['One of: (B + C), D'])
    expect(verifySchedule(new Set([`${DA}:D`]), a).missing).toEqual([])
  })
})

/*
 * Post-transfer rows and blocking splits. Synthetic trees: `C(x)` is articulated at college 1 (course `1:x`),
 * `UC(x)` has no articulation at any college (ASSIST "no course articulated": completed at the UC after transfer),
 * `SER(x)` is a two-course series offered at colleges 1 and 2; `SPLIT(x)` takes its first half at 1, second at 2.
 */
const C = (id: string): Requirement => ({ kind: 'req', id, label: id, units: 4, groups: [{ institutionId: 1, courses: [`1:${id}`] }] })
const UC = (id: string): Requirement =>
  ({ kind: 'req', id, label: id, units: 4, groups: [], noArticulation: { 1: 'This course must be taken at the university after transfer' } })
const SER = (id = 'S'): Requirement => ({ kind: 'req', id, label: id, units: 8,
  groups: [1, 2].map((i) => ({ institutionId: i, courses: [`${i}:${id} 1`, `${i}:${id} 2`] })) })
const SPLIT = (id = 'S') => [`1:${id} 1`, `2:${id} 2`]
type Kid = ReqNode | Requirement
const nd = (type: ReqNode['type'], children: Kid[], n?: number): ReqNode => ({ kind: 'node', type, n, required: true, children })
const AND = (...c: Kid[]) => nd('AND', c), OR = (...c: Kid[]) => nd('OR', c), NOF = (n: number, ...c: Kid[]) => nd('N_OF', c, n)
const opt = (n: ReqNode): ReqNode => ({ ...n, required: false })
const ag = (...c: Kid[]) => ({ ...ME, root: AND(...c) }) as Agreement
const v = (a: Agreement, ...ids: (string | string[])[]) => verifySchedule(new Set(ids.flat().map((x) => (x.includes(':') ? x : `1:${x}`))), a)
const splits = (r: ValidationResult) => r.splitSeriesViolations.map((x) => [x.requirementId, x.blocking])

describe('leaf states: satisfied, deferred (no CC articulates it), open', () => {
  const a = ag(C('A'), UC('U'))
  it('a UC-only row does not hold the plan back; it is reported as deferred, never missing', () => {
    // Counselor: no sending college offers U, so every transfer student takes it at the UC. A is done: plan complete.
    expect(v(a, 'A')).toMatchObject({ isValid: true, missing: [], deferred: ['U'] })
  })
  it('with nothing taken the articulated row is missing, the UC-only row still only deferred', () => {
    // A can be taken at a CC and is owed before transfer; U is owed at the UC whatever the student does.
    expect(v(a)).toMatchObject({ isValid: false, missing: ['A'], deferred: ['U'] })
  })
  it('an agreement whose required rows are all UC-only is complete with nothing taken', () => {
    // Nothing can be done at a CC for this major's prep, so nothing is missing.
    expect(v(ag(UC('U1'), UC('U2')))).toMatchObject({ isValid: true, missing: [], deferred: ['U1', 'U2'] })
  })
})

describe('AND', () => {
  it('passes when every child is satisfied or deferred, at any depth', () => {
    // Counselor: A and B done at a CC, U cannot be; the nested AND is met the moment A is.
    const a = ag(AND(C('A'), UC('U')), C('B'))
    expect(v(a, 'A', 'B')).toMatchObject({ isValid: true, missing: [], deferred: ['U'] })
    expect(v(a, 'B')).toMatchObject({ isValid: false, missing: ['A'], deferred: ['U'] })
  })
  it('an AND of UC-only rows (nested) is deferred as a whole', () => {
    expect(v(ag(AND(UC('U1'), AND(UC('U2'))), C('A')), 'A')).toMatchObject({ isValid: true, missing: [], deferred: ['U1', 'U2'] })
  })
})

describe('OR', () => {
  it('a UC-only alternative never satisfies an OR while a CC alternative exists', () => {
    // Counselor: the student can and must take A before transfer; "I will take U at the UC" is not a CC plan.
    const a = ag(OR(C('A'), UC('U')))
    expect(v(a)).toMatchObject({ isValid: false, missing: ['A'], deferred: [] })
    expect(v(a, 'A')).toMatchObject({ isValid: true, missing: [], deferred: [] })
  })
  it('an OR with no articulable alternative passes as deferred', () => {
    // Neither choice exists at any CC: the student picks one at the UC. Both are listed as "complete at UC".
    expect(v(ag(OR(UC('U1'), UC('U2'))))).toMatchObject({ isValid: true, missing: [], deferred: ['U1', 'U2'] })
    expect(v(ag(OR(AND(UC('U1'), UC('U2')), UC('U3'))))).toMatchObject({ isValid: true, deferred: ['U1', 'U2', 'U3'] })
  })
  it('a CC + UC-only alternative is articulable; its UC-only part is deferred only if that route is the one used', () => {
    const a = ag(OR(AND(C('A'), UC('U')), C('B')))
    // Nothing done: two CC routes; U is not named (it belongs to the first route only).
    expect(v(a)).toMatchObject({ isValid: false, missing: ['One of: A, B'], deferred: [] })
    // A done: the first route is complete apart from U, which the student takes at the UC.
    expect(v(a, 'A')).toMatchObject({ isValid: true, deferred: ['U'] })
    // B done: nothing is left for the UC, even if A is done too (the route that leaves least is used).
    expect(v(a, 'B').deferred).toEqual([])
    expect(v(a, 'A', 'B').deferred).toEqual([])
  })
  it('lists only CC alternatives as missing', () => {
    expect(v(ag(OR(C('A'), C('B'), UC('U')))).missing).toEqual(['One of: A, B'])
  })
})

describe('N_OF: s satisfied, a open articulable, d UC-only', () => {
  const two = ag(NOF(2, C('A'), C('B'), UC('U1'), UC('U2')))
  it('s >= n: satisfied', () => {
    expect(v(two, 'A', 'B')).toMatchObject({ isValid: true, missing: [], deferred: [] })
  })
  it('s < n <= s + a: open, the remainder must come from CC courses', () => {
    // Counselor: B exists at a CC, so the second pick is B, not a UC-only course.
    expect(v(two, 'A')).toMatchObject({ isValid: false, missing: ['B'], deferred: [] })
    expect(v(two).missing).toEqual(['A', 'B'])
    const three = ag(NOF(3, C('A'), C('B'), C('C'), UC('U')))
    expect(v(three).missing).toEqual(['A', 'B', 'C']) // s + a = 3 = n: every CC choice is needed
    expect(v(three, 'A').missing).toEqual(['B', 'C'])
    expect(v(three, 'A', 'B').missing).toEqual(['C'])
    expect(v(three, 'A', 'B', 'C')).toMatchObject({ isValid: true, deferred: [] })
    expect(v(ag(NOF(2, C('A'), C('B'), C('C'))), 'A').missing).toEqual(['1 of: B, C'])
  })
  it('s + a < n <= s + a + d: the CC picks are owed first; UC-only rows fill only the slots left', () => {
    // Counselor: only two of the three picks exist at any CC, so A and B must be taken before transfer; the third is
    // completed at the UC. Nothing taken is not "done" (the brute-force planner oracle agrees).
    const a = ag(NOF(3, C('A'), C('B'), UC('U1'), UC('U2')))
    expect(v(a)).toMatchObject({ isValid: false, missing: ['A', 'B'], deferred: [] })
    expect(v(a, 'A')).toMatchObject({ isValid: false, missing: ['B'] })
    expect(v(a, 'A', 'B')).toMatchObject({ isValid: true, deferred: ['U1', 'U2'] })
    expect(v(ag(NOF(3, C('A'), UC('U1'), UC('U2'))), 'A')).toMatchObject({ isValid: true, deferred: ['U1', 'U2'] })
  })
  it('s + a + d < n: open, it cannot be met', () => {
    const a = ag(NOF(4, C('A'), UC('U1'), UC('U2')))
    expect(v(a)).toMatchObject({ isValid: false, missing: ['4 of: A, U1, U2'], deferred: [] })
    expect(v(a, 'A')).toMatchObject({ isValid: false, missing: ['3 of: U1, U2'] })
  })
  it('a satisfied N_OF relies on the n satisfied children that leave least for the UC', () => {
    expect(v(ag(NOF(1, AND(C('A'), UC('U1')), C('B'))), 'A').deferred).toEqual(['U1'])
    expect(v(ag(NOF(1, AND(C('A'), UC('U1')), C('B'))), 'A', 'B').deferred).toEqual([])
    expect(v(ag(NOF(2, AND(C('A'), UC('U1')), C('B'), AND(C('C'), UC('U2')))), 'A', 'B', 'C').deferred).toEqual(['U1'])
  })
})

describe('optional (recommended) subtrees', () => {
  it('never fail their parent and never add to missing or deferred', () => {
    // Counselor: recommended courses help but are not conditions of admission.
    const a = ag(C('A'), opt(AND(C('B'), UC('U'))))
    expect(v(a, 'A')).toMatchObject({ isValid: true, missing: [], deferred: [] })
    expect(v(a)).toMatchObject({ isValid: false, missing: ['A'], deferred: [] })
  })
  it('a satisfied optional alternative does not satisfy a required OR either', () => {
    // Choice made here: optional children are left out of the fold entirely (only AND parents have them in the data).
    expect(v(ag(OR(opt(AND(C('A'))), C('B'))), 'A')).toMatchObject({ isValid: false, missing: ['B'] })
  })
})

describe('split series: blocking iff the plan still needs that requirement', () => {
  it('a split in a required row with no alternative is blocking', () => {
    // Counselor: the pieces earn no credit and nothing else can stand in for S: the plan fails the audit.
    const r = v(ag(SER()), SPLIT())
    expect(splits(r)).toEqual([['S', true]])
    expect(r).toMatchObject({ isValid: false, missing: ['S'] })
    expect(blockingSplits(r).map((x) => x.requirementId)).toEqual(['S'])
  })
  it('a split in a recommended course is a warning, whether or not the rest is done', () => {
    // The courses count for nothing toward S, but the UC does not require S.
    const a = ag(C('A'), opt(AND(SER())))
    expect(v(a, 'A', SPLIT())).toMatchObject({ isValid: true })
    expect(splits(v(a, 'A', SPLIT()))).toEqual([['S', false]])
    expect(blockingSplits(v(a, 'A', SPLIT()))).toEqual([])
    const r = v(a, SPLIT())
    expect(r).toMatchObject({ isValid: false, missing: ['A'] })
    expect(splits(r)).toEqual([['S', false]])
  })
  it('OR: a split alternative is a warning once another is done, blocking while a CC route is still owed', () => {
    const a = ag(OR(SER(), C('B')))
    expect(v(a, 'B', SPLIT())).toMatchObject({ isValid: true })
    expect(splits(v(a, 'B', SPLIT()))).toEqual([['S', false]])
    // Nothing done: finishing S properly is one way to satisfy the OR, so the split is what the student must fix.
    const r = v(a, SPLIT())
    expect(r).toMatchObject({ isValid: false, missing: ['One of: S, B'] })
    expect(splits(r)).toEqual([['S', true]])
    // The UC-only alternative cannot rescue it: S is the only CC route.
    expect(splits(v(ag(OR(SER(), UC('U'))), SPLIT()))).toEqual([['S', true]])
    expect(v(ag(OR(SER(), UC('U'))), SPLIT())).toMatchObject({ isValid: false, missing: ['S'] })
  })
  it('OR -> AND: a split inside an open articulable route is blocking', () => {
    const a = ag(OR(AND(SER(), C('A')), C('B')))
    expect(splits(v(a, SPLIT()))).toEqual([['S', true]])
    expect(splits(v(a, 'A', SPLIT()))).toEqual([['S', true]])
    expect(splits(v(a, 'B', SPLIT()))).toEqual([['S', false]])
  })
  it('N_OF: a split in an unused alternative is a warning once n are done', () => {
    expect(splits(v(ag(NOF(1, SER(), C('B'))), 'B', SPLIT()))).toEqual([['S', false]])
    expect(splits(v(ag(NOF(1, SER(), C('B'))), SPLIT()))).toEqual([['S', true]])
    const a = ag(NOF(2, SER(), C('B'), C('C')))
    expect(v(a, 'B', 'C', SPLIT()).isValid).toBe(true)
    expect(splits(v(a, 'B', 'C', SPLIT()))).toEqual([['S', false]])
    expect(splits(v(a, 'B', SPLIT()))).toEqual([['S', true]])
    expect(v(a, 'B', SPLIT()).missing).toEqual(['1 of: S, C'])
  })
  it('an N_OF whose only CC alternative is split still needs it: the split blocks', () => {
    // n = 2 with one CC alternative (S) and two UC-only ones: S must be taken at a CC, so its split costs the plan.
    const r = v(ag(NOF(2, SER(), UC('U1'), UC('U2'))), SPLIT())
    expect(r).toMatchObject({ isValid: false, missing: ['S'], deferred: [] })
    expect(splits(r)).toEqual([['S', true]])
  })
  it('the root may pass through deferral with a split elsewhere', () => {
    const r = v(ag(OR(UC('U1'), UC('U2')), C('A'), opt(AND(SER()))), 'A', SPLIT())
    expect(r).toMatchObject({ isValid: true, missing: [], deferred: ['U1', 'U2'] })
    expect(splits(r)).toEqual([['S', false]])
  })
  it('a split inside a passing node stays a warning while the plan fails elsewhere', () => {
    // A is still owed, but the OR is met by B: completing S would change nothing, so only A is reported.
    const r = v(ag(C('A'), OR(C('B'), SER())), 'B', SPLIT())
    expect(r).toMatchObject({ isValid: false, missing: ['A'] })
    expect(splits(r)).toEqual([['S', false]])
  })
  it('a split next to a UC-only row in an AND is blocking, and the UC-only row stays deferred', () => {
    const r = v(ag(AND(SER(), UC('U'))), SPLIT())
    expect(r).toMatchObject({ isValid: false, missing: ['S'], deferred: ['U'] })
    expect(splits(r)).toEqual([['S', true]])
  })
  it('a requirement in two places is blocking if needed at either, and reported once', () => {
    // Recommended here, an OR alternative there: once B is done nobody needs S; without B the OR needs it.
    const a = ag(C('A'), opt(AND(SER())), OR(SER(), C('B')))
    expect(splits(v(a, 'A', 'B', SPLIT()))).toEqual([['S', false]])
    expect(v(a, 'A', 'B', SPLIT()).isValid).toBe(true)
    expect(splits(v(a, 'A', SPLIT()))).toEqual([['S', true]])
    const b = ag(OR(SER(), C('B')), OR(SER(), C('D')))
    expect(splits(v(b, 'B', SPLIT()))).toEqual([['S', true]]) // the second OR still needs it
    expect(splits(v(b, 'B', 'D', SPLIT()))).toEqual([['S', false]])
  })
  it('each split is judged on its own', () => {
    const r = v(ag(SER('S'), opt(AND(SER('T')))), SPLIT('S'), SPLIT('T'))
    expect(splits(r)).toEqual([['S', true], ['T', false]])
    expect(blockingSplits(r).map((x) => x.requirementId)).toEqual(['S'])
  })
  it('the same course at two colleges is still a duplicate, not a split', () => {
    expect(v(ag(SER()), '1:S 1', '2:S 1').splitSeriesViolations).toEqual([])
  })
})

describe('isDeferrable: no CC route exists, whatever is taken', () => {
  it('follows the fold with nothing taken', () => {
    expect(isDeferrable(UC('U'))).toBe(true)
    expect(isDeferrable(C('A'))).toBe(false)
    expect(isDeferrable(AND(UC('U1'), UC('U2')))).toBe(true)
    expect(isDeferrable(AND(UC('U'), C('A')))).toBe(false)
    expect(isDeferrable(AND(UC('U'), opt(AND(C('A')))))).toBe(true) // optional children do not count
    expect(isDeferrable(OR(UC('U1'), UC('U2')))).toBe(true)
    expect(isDeferrable(OR(UC('U'), C('A')))).toBe(false)
    expect(isDeferrable(OR(AND(UC('U'), C('A')), UC('V')))).toBe(false)
    expect(isDeferrable(NOF(1, UC('U'), C('A')))).toBe(false)
    expect(isDeferrable(NOF(2, UC('U1'), UC('U2'), C('A')))).toBe(false) // A exists at a CC, so it is owed
    expect(isDeferrable(NOF(2, UC('U1'), UC('U2')))).toBe(true)
    expect(isDeferrable(NOF(3, UC('U'), C('A')))).toBe(false) // cannot be met at all
    expect(isDeferrable(opt(AND(UC('U'))))).toBe(true) // the node's own flag is not consulted
  })
})

describe('deferral and blocking on real agreements', () => {
  const regular = (a: Agreement, ...rs: string[]) =>
    rs.flatMap((id) => req(a, id).groups.find((g) => g.institutionId === DA && !g.courses.some((c) => c.endsWith('H')))!.courses)
  // Every required Berkeley ME row at De Anza; the chemistry series also meets the "one science course" N_OF.
  const full = regular(ME, 'MATH 51', 'MATH 52', 'MATH 53', 'MATH 54', 'PHYSICS 7A', 'PHYSICS 7B', 'CHEM 1A, CHEM 1AL, CHEM 1B')
  it('the full De Anza plan is valid with nothing deferred', () => {
    // The science N_OF is met by the CHEM 1A series, so the UC-only ASTRON 7B and STAT 20 are not needed.
    expect(verifySchedule(new Set(full), ME)).toMatchObject({ isValid: true, missing: [], deferred: [], splitSeriesViolations: [] })
  })
  it('a split in the recommended MEC ENG C85 no longer fails a complete plan', () => {
    // Pasadena ENGR 011 + Irvine Valley ENGR 30: no credit toward C85, but Berkeley only recommends C85.
    const r = verifySchedule(new Set([...full, '49:ENGR 011', '124:ENGR 30']), ME)
    expect(splits(r)).toEqual([['MEC ENG C85', false]])
    expect(r.isValid).toBe(true)
  })
  it('a split in CHEM 3A, an unused alternative of the science N_OF, no longer fails a complete plan', () => {
    // De Anza CHEM 12A + Foothill CHEM 12B: the science choice is already met by the chemistry series.
    const r = verifySchedule(new Set([...full, `${DA}:CHEM 12A`, `${FH}:CHEM 12B`]), ME)
    expect(splits(r)).toEqual([['CHEM 3A, CHEM 3AL', false]])
    expect(r.isValid).toBe(true)
  })
  it('the same CHEM 3A split is blocking while the science choice is still open', () => {
    // With nothing else done, completing CHEM 3A properly is one of the ways to meet the science requirement.
    expect(splits(verifySchedule(new Set([`${DA}:CHEM 12A`, `${FH}:CHEM 12B`]), ME))).toEqual([['CHEM 3A, CHEM 3AL', true]])
  })
  it('a split in PHYSICS 7B with nothing else taken is still blocking', () => {
    // Scenario 2: PHYSICS 7B is required and has no alternative; the plan fails the July audit.
    const r = verifySchedule(new Set([`${DA}:PHYS 4B`, `${FH}:PHYS 4C`]), ME)
    expect(splits(r)).toEqual([['PHYSICS 7B', true]])
    expect(r.isValid).toBe(false)
  })
  it('a PHYSICS 7B split blocks even when everything else is done', () => {
    const r = verifySchedule(new Set([...full.filter((c) => c !== `${DA}:PHYS 4C`), `${FH}:PHYS 4C`]), ME)
    expect(splits(r)).toEqual([['PHYSICS 7B', true]])
    expect(r).toMatchObject({ isValid: false, missing: ['PHYSICS 7B'] })
  })
  it('a C85 split stays a warning while the plan is incomplete elsewhere', () => {
    const r = verifySchedule(new Set([...full.filter((c) => c !== `${DA}:MATH 1A`), '49:ENGR 011', '124:ENGR 30']), ME)
    expect(r.missing).toEqual(['MATH 51'])
    expect(splits(r)).toEqual([['MEC ENG C85', false]])
  })
  it('UCI ME: the UC-only ECON 23 does not stand in for the articulated ECON 20A', () => {
    const r = verifySchedule(new Set(), ime as unknown as Agreement)
    expect(r.missing).toContain('ECON 20A')
    expect(r.deferred).not.toContain('ECON 23')
  })
  it('UC Davis ME: honors chemistry has no CC articulation, so the regular CC series is owed', () => {
    const r = verifySchedule(new Set(), dme as unknown as Agreement)
    expect(r.missing).toContain('CHE 002A, CHE 002B')
    expect(r.deferred).toEqual(['EME 050'])
  })
  it('UCLA CS: COM SCI 35L has no articulation and no ASSIST reason, so it is not deferred', () => {
    // Placeholder only: the plan cannot be called complete until a counselor confirms 35L is taken at UCLA.
    const a = cs as unknown as Agreement
    expect(verifySchedule(new Set(Object.keys(a.catalog)), a)).toMatchObject({ isValid: false, missing: ['COM SCI 35L'], deferred: [] })
  })
  it('UCSD ECE: the lower-division ECE core that must be taken at UCSD is deferred', () => {
    const a = ece as unknown as Agreement
    expect(verifySchedule(new Set(Object.keys(a.catalog)), a).deferred.sort()).toEqual(['ECE 15', 'ECE 25', 'ECE 35', 'ECE 45', 'ECE 5', 'ECE 65'])
  })
  it('every fixture: taking every articulated course leaves only unrecorded rows; deferred rows are UC-only and never missing', async () => {
    for (const { file } of index as { file: string }[]) {
      const a = (await import(`../../data/agreements/${file.replace(/\.json$/, '')}.json`)).default as Agreement
      const all = verifySchedule(new Set(Object.keys(a.catalog)), a)
      // Anything still missing must involve a row with no CC group and no ASSIST reason (a counselor question).
      const unrecorded = new Set(reqs(a.root).filter((x) => !x.groups.length && !ucOnly(x)).map((x) => x.id))
      expect(all.isValid || all.missing.every((m) => [...unrecorded].some((id) => m.includes(id))), `${file} ${all.missing}`).toBe(true)
      if (!all.missing.length) expect(all.isValid, file).toBe(true)
      expect(all.splitSeriesViolations, file).toEqual([])
      for (const r of [all, verifySchedule(new Set(), a)]) for (const id of r.deferred) {
        expect(reqs(a.root).filter((x) => x.id === id).every(ucOnly), `${file} ${id}`).toBe(true)
        const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        expect(r.missing.join('|'), `${file} ${id}`).not.toMatch(new RegExp(`(^|[|(]|: |, | \\+ )${esc}($|[|)]|, | \\+ )`))
      }
    }
  })
})

describe('reqStatus reports the group the student actually took (TESTER1 M-2)', () => {
  const m52 = () => req(ME, 'MATH 52')
  it('regular MATH 1B + 1C: the regular group, not the honors twin ASSIST lists first', () => {
    const s = reqStatus(m52(), new Set([`${DA}:MATH 1B`, `${DA}:MATH 1C`]))
    expect(s.satisfied?.courses.slice().sort()).toEqual([`${DA}:MATH 1B`, `${DA}:MATH 1C`])
  })
  it('honors MATH 1BH + 1CH: the honors group', () => {
    const s = reqStatus(m52(), new Set([`${DA}:MATH 1BH`, `${DA}:MATH 1CH`]))
    expect(s.satisfied?.courses.slice().sort()).toEqual([`${DA}:MATH 1BH`, `${DA}:MATH 1CH`])
  })
  it("the satisfied group is always one of the row's own groups", () => {
    const s = reqStatus(m52(), new Set([`${DA}:MATH 1BH`, `${DA}:MATH 1C`]))
    expect(m52().groups).toContain(s.satisfied)
  })
  it('synthetic: fewest swaps wins over ASSIST order', () => {
    const r: Requirement = { kind: 'req', id: 'X', label: 'X', units: 4, groups: [
      { institutionId: 1, courses: ['1:A 1H', '1:A 2H'] }, { institutionId: 1, courses: ['1:A 1', '1:A 2'] }] }
    expect(reqStatus(r, new Set(['1:A 1', '1:A 2'])).satisfied).toBe(r.groups[1])
    expect(reqStatus(r, new Set(['1:A 1H', '1:A 2H'])).satisfied).toBe(r.groups[0])
  })
})

describe('degenerate trees fail closed (TESTER2 M-3)', () => {
  const row: Requirement = { kind: 'req', id: 'R1', label: 'R1', units: 4, groups: [{ institutionId: 1, courses: ['1:C 1'] }] }
  const tree = (children: (ReqNode | Requirement)[]): Agreement =>
    ({ receivingId: 1, major: 'x', year: 'x', sendingIds: [1], catalog: {}, root: { kind: 'node', type: 'AND', required: true, children } })
  const cases: [string, Agreement][] = [
    ['empty root', tree([])],
    ['choose 0', tree([{ kind: 'node', type: 'N_OF', n: 0, required: true, children: [row] }])],
    ['only optional rows', tree([{ kind: 'node', type: 'AND', required: false, children: [row] }])],
    ['an OR alternative that is an empty AND', tree([row, { kind: 'node', type: 'OR', required: true, children: [{ kind: 'node', type: 'AND', required: true, children: [] }, { ...row, id: 'R2' }] }])],
  ]
  for (const [name, a] of cases) it(`${name}: never valid, and says why`, () => {
    expect(malformed(a.root)).not.toBeNull()
    const r = verifySchedule(new Set(['1:C 1']), a)
    expect(r.isValid).toBe(false)
    expect(r.missing.join(' ')).toMatch(/malformed/)
  })
  it('a well-formed tree with an optional subtree is not flagged', () => {
    const a = tree([row, { kind: 'node', type: 'AND', required: false, children: [{ ...row, id: 'R2' }] }])
    expect(malformed(a.root)).toBeNull()
    expect(verifySchedule(new Set(['1:C 1']), a).isValid).toBe(true)
  })
  it('no real agreement is malformed', () => {
    for (const a of [ME, MAE, MCS, CSE]) expect(malformed(a.root)).toBeNull()
  })
})

describe('M-4 safety net: "choose 2+ of" groups are flagged for review', () => {
  // X is one course that articulates to both rows A and B: today it fills two slots, so the result must carry `review`
  const X = (id: string): Requirement => ({ kind: 'req', id, label: id, units: 4, groups: [{ institutionId: 1, courses: ['1:X'] }] })
  it('flags a required choose-2 group, even when one course fills both slots', () => {
    const a = ag({ ...NOF(2, X('A'), X('B'), C('D')), title: 'Choose 2' })
    const r = v(a, 'X')
    expect(r.review).toEqual(['"Choose 2"'])
  })
  it('flags an untitled choose-2 group and one nested under a required AND', () => {
    expect(v(ag(AND(NOF(2, C('A'), C('B'), C('D')))), 'A', 'B').review).toEqual(['choose 2 of 3'])
  })
  it('does not flag choose-1 groups, OR groups, or choose-2 groups inside optional sections', () => {
    expect(v(ag(NOF(1, C('A'), C('B')), OR(C('D'), C('E'))), 'A', 'D').review).toBeUndefined()
    expect(v(ag(C('Z'), opt(NOF(2, C('A'), C('B'), C('D')))), 'Z').review).toBeUndefined()
  })
  it('no bundled agreement has a required choose-2+ group today (the net is dormant on current data)', () => {
    for (const a of [me, mae, mcs, cse, cs, ime, ece, dme] as unknown as Agreement[]) expect(verifySchedule(new Set(), a).review).toBeUndefined()
  })
})

describe('round 7 M-1: only an allowlisted ASSIST reason makes a row UC-only', () => {
  const row = (noArticulation: Record<number, unknown>): Requirement =>
    ({ kind: 'req', id: 'D', label: 'D', units: 4, groups: [], noArticulation: noArticulation as Record<number, string> })
  const bad: [string, unknown][] = [['blank', ''], ['spaces', '   '], ['null', null], ['denied', 'Course(s) Denied'], ['pending', 'Pending'],
    ['NOT_LISTED', 'No articulation listed'], ['new wording', 'Articulation under review']]
  for (const [name, why] of bad) it(`${name}: not UC-only, stays open (counselor), never deferred or green`, () => {
    const d = row({ 1: why, 2: why })
    expect(ucOnly(d)).toBe(false)
    expect(isDeferrable(d)).toBe(false)
    expect(v(ag(C('A'), d), 'A')).toMatchObject({ isValid: false, missing: ['D'], deferred: [] })
  })
  it('an allowlisted reason (any case / spacing) at one college is proof, even beside other values', () => {
    for (const why of ['No Course Articulated', '  this course must be taken at the university  after transfer ', 'THIS COURSE IS NEVER ARTICULATED']) {
      const d = row({ 1: 'Course(s) Denied', 2: why })
      expect(ucOnly(d)).toBe(true)
      expect(v(ag(C('A'), d), 'A')).toMatchObject({ isValid: true, deferred: ['D'] })
    }
  })
  it('a row with groups is never UC-only, whatever the reason', () => {
    expect(ucOnly({ ...C('A'), noArticulation: { 2: 'No Course Articulated' } })).toBe(false)
  })
})

describe('round 7 M-2: schema errors the fold would read loosely fail closed, without throwing', () => {
  const A = C('A'), B = C('B')
  const raw = (n: unknown) => n as ReqNode
  const cases: [string, unknown][] = [
    ['lowercase "and" (was choose-1)', { kind: 'node', type: 'and', required: true, children: [A, B] }],
    ['type undefined', { kind: 'node', required: true, children: [A, B] }],
    ['lowercase "n_of"', { kind: 'node', type: 'n_of', n: 1, required: true, children: [A, B] }],
    ['required missing (was optional)', { kind: 'node', type: 'AND', children: [B] }],
    ['required a string', { kind: 'node', type: 'AND', required: 'true', children: [B] }],
    ['kind typo', { kind: 'Req', id: 'Q', groups: [] }],
    ['children missing', { kind: 'node', type: 'OR', required: true }],
    ['row groups missing', { kind: 'req', id: 'Q', label: 'Q', units: 4 }],
    ['row group with courses []', { kind: 'req', id: 'E', label: 'E', units: 4, groups: [{ institutionId: 1, courses: [] }] }],
    ['null child', null],
  ]
  for (const [name, bad] of cases) it(`${name}: malformed, never valid`, () => {
    const a = ag(A, raw(bad))
    expect(malformed(a.root)).not.toBeNull()
    const r = v(a, 'A', 'B')
    expect(r.isValid).toBe(false)
    expect(r.missing.join(' ')).toMatch(/malformed/)
  })
  it('the same shapes in an optional subtree are still flagged (the gate rejects them anywhere)', () => {
    const a = ag(A, opt(AND(raw({ kind: 'node', type: 'and', required: true, children: [B] }))))
    expect(malformed(a.root)).toMatch(/unknown type/)
    expect(v(a, 'A', 'B').isValid).toBe(false)
  })
  it('a missing root or a root without children does not throw', () => {
    for (const root of [undefined, null, { kind: 'node', type: 'AND', required: true }]) {
      const a = { ...ME, root: raw(root) } as Agreement
      expect(malformed(a.root)).not.toBeNull()
      expect(v(a).isValid).toBe(false)
    }
  })
  it('reqStatus never satisfies a row from an empty group, and tolerates missing groups', () => {
    expect(reqStatus({ ...C('E'), groups: [{ institutionId: 1, courses: [] }] }, new Set()).satisfied).toBeUndefined()
    expect(reqStatus(raw({ kind: 'req', id: 'Q' }) as unknown as Requirement, new Set(['1:A'])).satisfied).toBeUndefined()
    expect(isDeferrable(raw({ kind: 'req', id: 'Q', noArticulation: { 1: 'No Course Articulated' } }))).toBe(false)
  })
})

describe('UC-only proof ignores a trailing period', () => {
  it('accepts "…after transfer." and still rejects other wording', async () => {
    const { isUcOnlyProof } = await import('./normalize')
    expect(isUcOnlyProof('This course must be taken at the university after transfer.')).toBe(true)
    expect(isUcOnlyProof('No Course Articulated.')).toBe(true)
    expect(isUcOnlyProof('Pending.')).toBe(false)
    expect(isUcOnlyProof('Course(s) Denied.')).toBe(false)
  })
})
