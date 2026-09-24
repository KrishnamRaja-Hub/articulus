import { describe, expect, it } from 'vitest'
import type { Agreement, Course, Requirement } from './types'
import { solve } from './solve'

const course = (id: string, title: string, units = 5): Course => {
  const [inst, rest] = id.split(':'), [prefix, number] = rest.split(' ')
  return { id, institutionId: Number(inst), prefix, number, title, units }
}
const row = (id: string, ...groups: string[][]): Requirement =>
  ({ kind: 'req', id, label: id, units: 4, groups: groups.map((cs) => ({ institutionId: Number(cs[0].split(':')[0]), courses: cs })) })
const agreement = (rows: Requirement[], courses: Course[]): Agreement => ({
  receivingId: 1, major: 'T', year: 'x', sendingIds: [...new Set(courses.map((c) => c.institutionId))],
  root: { kind: 'node', type: 'AND', required: true, children: rows }, catalog: Object.fromEntries(courses.map((c) => [c.id, c])),
})
const opts = { allowed: [113], home: 113 }
const planned = (p: ReturnType<typeof solve>) => p.terms.flatMap((t) => t.courses).sort()
const termOf = (p: ReturnType<typeof solve>, c: string) => p.terms.findIndex((t) => t.courses.includes(c))

// UCI-style rows: business calculus articulates to the first-calculus row, but it is no prerequisite for Calculus II.
const calc = agreement(
  [row('MATH 2A', ['113:MATH 12'], ['113:MATH 1A']), row('MATH 2B', ['113:MATH 1B']), row('MATH 2D', ['113:MATH 1D'])],
  [course('113:MATH 12', 'Introductory Calculus for Business and Social Science'), course('113:MATH 1A', 'Calculus I'),
    course('113:MATH 1B', 'Calculus II'), course('113:MATH 1C', 'Calculus III'), course('113:MATH 1D', 'Calculus IV'),
    course('51:MATH 1C', 'Calculus III')])

describe('enrollment prerequisites (TESTER1 H-1)', () => {
  it('business calculus: Calculus I replaces it, Calculus III is added as a labelled prerequisite and counted, in order', () => {
    const p = solve(new Set(), calc, opts)
    expect(planned(p)).toEqual(['113:MATH 1A', '113:MATH 1B', '113:MATH 1C', '113:MATH 1D'])
    expect(p.prereqOnly).toEqual(['113:MATH 1C'])
    expect(p.chosen['MATH 2A'].courses).toEqual(['113:MATH 1A'])
    expect(p.totalUnits).toBe(20)
    expect(p.optimal).toBe(false) // 5 units above the search's optimum, which ignores prerequisites
    const order = ['113:MATH 1A', '113:MATH 1B', '113:MATH 1C', '113:MATH 1D'].map((c) => termOf(p, c))
    expect(order).toEqual([...order].sort((x, y) => x - y))
    expect(new Set(order).size).toBe(4)
    expect(p.result.isValid).toBe(true)
    expect(p.prereqWarnings).toBeUndefined()
  })

  it('a prerequisite already taken (here or elsewhere) is not added', () => {
    const p = solve(new Set(['113:MATH 1A', '51:MATH 1C']), calc, opts)
    expect(planned(p)).toEqual(['113:MATH 1B', '113:MATH 1D'])
    expect(p.prereqOnly).toBeUndefined()
    expect(p.optimal).toBe(true)
  })

  it('a prerequisite the agreement lists only at another college is not added: a warning instead', () => {
    const a = agreement([row('MATH 2B', ['113:MATH 1B'])], [course('113:MATH 1B', 'Calculus II'), course('51:MATH 1A', 'Calculus I')])
    const p = solve(new Set(), a, opts)
    expect(planned(p)).toEqual(['113:MATH 1B'])
    expect(p.prereqOnly).toBeUndefined()
    expect(p.prereqWarnings).toHaveLength(1)
    expect(p.prereqWarnings![0]).toMatch(/MATH 1B.*MATH 1A "Calculus I"/)
    expect(p.optimal).toBe(true)
  })
})
