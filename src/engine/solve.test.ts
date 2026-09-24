import { describe, expect, it } from 'vitest'
import me from '../../data/agreements/79-mechanical-engineering-b-s.json'
import mae from '../../data/agreements/7-mae-mechanical-engineering-b-s.json'
import institutions from '../../data/institutions.json'
import type { Agreement, Course, Institution, Plan, ReqNode, Requirement } from './types'
import { solve } from './solve'
import { verifySchedule } from './verify'

const ME = me as unknown as Agreement, MAE = mae as unknown as Agreement
const DA = 113, FH = 51, SM = 137
const unitSystems = Object.fromEntries((institutions as Institution[]).map((i) => [i.id, i.terms]))

/** Synthetic agreement: `courses` as [id, units], each requirement as a list of groups. */
const catalog = (courses: [string, number][]) => Object.fromEntries(courses.map(([id, units]): [string, Course] => {
  const [inst, rest] = id.split(':'); const [prefix, number] = rest.split(' ')
  return [id, { id, institutionId: +inst, prefix, number, title: id, units }]
}))
const req = (id: string, groups: string[][]): Requirement =>
  ({ kind: 'req', id, label: id, units: 4, groups: groups.map((courses) => ({ institutionId: +courses[0].split(':')[0], courses })) })
const and = (...children: (ReqNode | Requirement)[]): ReqNode => ({ kind: 'node', type: 'AND', required: true, children })
const agreement = (root: ReqNode, courses: [string, number][]): Agreement =>
  ({ receivingId: 1, major: 'T', year: 'x', sendingIds: [], root, catalog: catalog(courses) })
const plannedOf = (p: Plan) => p.terms.flatMap((t) => t.courses)

describe('solve: never opens a new split series (F-06)', () => {
  it('skips a cheaper group that would split an unused OR alternative against a taken course', () => {
    // Taken 2:P 2 is half of U at college 2. Planning 1:P 1 for R would put U at two colleges.
    const a = agreement(and(req('R', [['1:P 1'], ['3:Q 1']]),
      { kind: 'node', type: 'OR', required: true, children: [req('U', [['1:P 1', '1:P 2'], ['2:P 1', '2:P 2']]), req('V', [['3:V 1']])] }),
      [['1:P 1', 3], ['1:P 2', 3], ['2:P 1', 3], ['2:P 2', 3], ['3:Q 1', 4], ['3:V 1', 1]])
    const p = solve(new Set(['2:P 2']), a, { allowed: [1, 3], home: 1 })
    expect(p.chosen.R.institutionId).toBe(3)
    expect(p.result.splitSeriesViolations).toHaveLength(0)
    expect(p.result.isValid).toBe(true)
  })
  it('reports the split when every option opens one (Berkeley ME, Santa Monica only)', () => {
    // Every Santa Monica physics group uses PHYSCS 23, which with Foothill PHYS 4C splits PHYSICS 7C.
    const p = solve(new Set([`${DA}:PHYS 4B`, `${FH}:PHYS 4C`]), ME, { allowed: [SM], home: SM, termSystem: 'semester', unitSystems })
    expect(p.result.isValid).toBe(false)
    expect(p.unsolvable.some((u) => /splitting PHYSICS 7C/.test(u))).toBe(true)
  })
})

describe('solve: prunes groups made redundant by later picks (F-10)', () => {
  it('drops X 1 once Y 1 + Y 2 cover both requirements', () => {
    const a = agreement(and(req('R1', [['1:X 1'], ['1:Y 1', '1:Y 2']]), req('R2', [['1:Y 1', '1:Y 2']])), [['1:X 1', 4], ['1:Y 1', 4], ['1:Y 2', 4]])
    const p = solve(new Set(), a, { allowed: [1], home: 1 })
    expect(plannedOf(p).sort()).toEqual(['1:Y 1', '1:Y 2'])
    expect(p.chosen.R1.courses).toEqual(['1:Y 1', '1:Y 2'])
    expect(p.result.isValid).toBe(true)
  })
  it('every planned course is used by a satisfied requirement (UCSD MAE, CCSF + Foothill)', () => {
    const p = solve(new Set(), MAE, { allowed: [33, FH], home: 33, termSystem: unitSystems[33], unitSystems })
    const used = new Set(Object.values(p.result.satisfied).flatMap((g) => g.courses))
    expect(plannedOf(p).filter((c) => !used.has(c) && !used.has(`${c}H`) && !used.has(c.replace(/H$/, '')))).toEqual([])
  })
})

describe('solve: tie-breaks are strict and order-independent (F-11)', () => {
  it('equal cost at two non-home colleges prefers fewer honors courses', () => {
    const a = agreement(and(req('R', [['2:M 1H'], ['3:M 1']])), [['2:M 1H', 4], ['3:M 1', 4]])
    expect(solve(new Set(), a, { allowed: [1, 2, 3], home: 1 }).chosen.R.institutionId).toBe(3)
  })
  it('same college: fewer honors beats fewer courses, in either group order', () => {
    const cs: [string, number][] = [['1:P 1H', 4], ['1:Q 1', 2], ['1:Q 2', 2]]
    const g1 = ['1:P 1H'], g2 = ['1:Q 1', '1:Q 2']
    expect(solve(new Set(), agreement(and(req('R', [g1, g2])), cs), { allowed: [1], home: 1 }).chosen.R.courses).toEqual(g2)
    expect(solve(new Set(), agreement(and(req('R', [g2, g1])), cs), { allowed: [1], home: 1 }).chosen.R.courses).toEqual(g2)
  })
  it('real agreement: same plan when groups, requirements and allowed colleges are reordered', () => {
    const rev = (n: ReqNode | Requirement): ReqNode | Requirement =>
      n.kind === 'req' ? { ...n, groups: [...n.groups].reverse() } : { ...n, children: n.children.map(rev).reverse() }
    const opts = { allowed: [DA, FH, SM, 49, 114], home: DA, termSystem: 'quarter' as const, unitSystems }
    const p1 = solve(new Set(), ME, opts)
    const p2 = solve(new Set(), { ...ME, root: rev(ME.root) as ReqNode }, { ...opts, allowed: [...opts.allowed].reverse() })
    expect(p2.terms).toEqual(p1.terms)
    expect(p2.chosen).toEqual(p1.chosen)
  })
})

describe('solve: bounds and bad data (F-13, F-17)', () => {
  it('plans all 250 single-course requirements instead of stopping at a fixed 200', () => {
    const cs = Array.from({ length: 250 }, (_, i): [string, number] => [`1:C ${i + 10}`, 1])
    const p = solve(new Set(), agreement(and(...cs.map(([id]) => req(id, [[id]]))), cs), { allowed: [1], unitCap: 400 })
    expect(plannedOf(p)).toHaveLength(250)
    expect(p.result.isValid).toBe(true)
  })
  it('a course missing from the catalog is not a free 0-unit course', () => {
    const a = agreement(and(req('R', [['1:A 1'], ['1:GHOST 1']])), [['1:A 1', 5]])
    const p = solve(new Set(), a, { allowed: [1] })
    expect(p.chosen.R.courses).toEqual(['1:A 1'])
    expect(p.totalUnits).toBe(5)
  })
  it('only unknown courses: reported unsolvable, nothing planned', () => {
    const p = solve(new Set(), agreement(and(req('R', [['1:GHOST 1']])), []), { allowed: [1] })
    expect(p.unsolvable).toEqual(['R'])
    expect(p.terms).toHaveLength(0)
    expect(verifySchedule(new Set(), agreement(and(req('R', [['1:GHOST 1']])), [])).isValid).toBe(false)
  })
})
