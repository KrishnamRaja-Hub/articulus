import { describe, expect, it } from 'vitest'
import institutions from '../../data/institutions.json'
import type { Agreement, Course, Institution, Requirement } from './types'
import { solve } from './solve'
import { prereqGraph } from './prereq'

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

// Round 10: a title is not a course's identity. Foothill titles MATH 1A, 1B, 1C and 1D all "Calculus" (and PHYS 4A-4D
// all "General Physics (Calculus)"), so two different courses with the same title must never stand in for each other.
describe('same-titled courses are different courses (Foothill "Calculus")', () => {
  const fh = (...extra: Course[]) => [course('51:MATH 1A', 'Calculus'), course('51:MATH 1B', 'Calculus'), course('51:MATH 1C', 'Calculus'),
    course('51:MATH 1D', 'Calculus'), ...extra]
  const foothill = { allowed: [51], home: 51 }

  it('planned Calculus II does not stand in for Calculus I, nor Calculus IV for Calculus III', () => {
    const a = agreement([row('MATH 2B', ['51:MATH 1B']), row('MATH 2D', ['51:MATH 1D'])], fh())
    const p = solve(new Set(), a, foothill)
    expect(planned(p)).toEqual(['51:MATH 1A', '51:MATH 1B', '51:MATH 1C', '51:MATH 1D'])
    expect(p.prereqOnly).toEqual(['51:MATH 1A', '51:MATH 1C'])
    const order = ['51:MATH 1A', '51:MATH 1B', '51:MATH 1C', '51:MATH 1D'].map((c) => termOf(p, c))
    expect(new Set(order).size).toBe(4)
    expect(order).toEqual([...order].sort((x, y) => x - y))
  })

  it('a taken Calculus I does not stand in for Calculus II', () => {
    const a = agreement([row('MATH 2C', ['51:MATH 1C'])], fh())
    const p = solve(new Set(['51:MATH 1A']), a, foothill)
    expect(planned(p)).toEqual(['51:MATH 1B', '51:MATH 1C'])
    expect(p.prereqOnly).toEqual(['51:MATH 1B'])
    expect(termOf(p, '51:MATH 1B')).toBeLessThan(termOf(p, '51:MATH 1C'))
  })

  it('a taken higher course still covers the lower one it follows (no false additions)', () => {
    const a = agreement([row('MATH 2D', ['51:MATH 1D'])], fh())
    const p = solve(new Set(['51:MATH 1C']), a, foothill)
    expect(planned(p)).toEqual(['51:MATH 1D'])
    expect(p.prereqOnly).toBeUndefined()
  })

  it('generic physics titles: taken PHYS 4A (mechanics) does not stand in for PHYS 4B (E&M)', () => {
    const phys = ['A', 'B', 'C'].map((l) => course(`51:PHYS 4${l}`, 'General Physics (Calculus)'))
    const a = agreement([row('PHYSICS 7C', ['51:PHYS 4C'])], phys)
    const p = solve(new Set(['51:PHYS 4A']), a, foothill)
    expect(planned(p)).toEqual(['51:PHYS 4B', '51:PHYS 4C'])
    expect(p.prereqOnly).toEqual(['51:PHYS 4B'])
  })

  it('across colleges a shared generic title never overrides the level: De Anza MATH 1A "Calculus" is not Calculus II', () => {
    const a = agreement([row('MATH 2C', ['51:MATH 1C'])],
      [course('51:MATH 1B', 'Calculus'), course('51:MATH 1C', 'Calculus III'), course('113:MATH 1A', 'Calculus')])
    const p = solve(new Set(['113:MATH 1A']), a, foothill)
    expect(planned(p)).toEqual(['51:MATH 1B', '51:MATH 1C'])
    expect(p.prereqOnly).toEqual(['51:MATH 1B'])
  })

  it('a distinctive title still counts across colleges (legitimate heuristic): "Discrete Structures" at De Anza and Foothill', () => {
    const cat = Object.fromEntries([course('51:C S 18', 'Discrete Structures'), course('113:CIS 18', 'Discrete Structures')].map((c) => [c.id, c]))
    expect(prereqGraph(cat, []).equiv('51:C S 18', '113:CIS 18')).toBe(true)
  })

  it('the prerequisite graph: same-titled Foothill courses are equivalent only to themselves and their honors twin', () => {
    const cat = Object.fromEntries(fh(course('51:MATH 1AH', 'Calculus - Honors')).map((c) => [c.id, c]))
    const g = prereqGraph(cat, [])
    const ids = ['51:MATH 1A', '51:MATH 1B', '51:MATH 1C', '51:MATH 1D']
    for (const p of ids) for (const q of ids) expect(g.equiv(p, q)).toBe(p === q)
    expect(g.equiv('51:MATH 1A', '51:MATH 1AH')).toBe(true)
    expect(g.equiv('51:MATH 1B', '51:MATH 1AH')).toBe(false)
  })

  // Tester regressions on the first round-10 fix: identity must not be lost where titles do not show it.
  it('articulation-backed: a course ASSIST lists beside it for the same UC row covers it (De Anza PHYS 4B for Saddleback 4B)', () => {
    const phys = [course('113:PHYS 4B', 'Physics for Scientists and Engineers: Electricity and Magnetism'),
      ...['A', 'B', 'C'].map((l) => course(`65:PHYS 4${l}`, 'General Physics'))]
    const a = agreement([row('PHYS 2B', ['113:PHYS 4B'], ['65:PHYS 4B']), row('PHYS 2C', ['65:PHYS 4C'])], phys)
    const p = solve(new Set(['113:PHYS 4B']), a, { allowed: [65], home: 65 })
    expect(planned(p)).toEqual(['65:PHYS 4C'])
    expect(p.prereqOnly).toBeUndefined()
  })

  it('articulation-backed equivalence never makes business calculus Calculus I', () => {
    const a = agreement([row('MATH 2A', ['113:MATH 12'], ['51:MATH 1A']), row('MATH 2B', ['51:MATH 1B'])],
      [course('113:MATH 12', 'Introductory Calculus for Business and Social Science'), course('51:MATH 1A', 'Calculus'), course('51:MATH 1B', 'Calculus')])
    const p = solve(new Set(['113:MATH 12']), a, foothill)
    expect(planned(p)).toEqual(['51:MATH 1A', '51:MATH 1B'])
    expect(prereqGraph(a.catalog, [], a.root).articulated('51:MATH 1A', '113:MATH 12')).toBe(false)
  })

  it('cross-listed courses (same number and title, another prefix) are one course: Irvine Valley CS 6A / MATH 6A', () => {
    const cs = [course('124:CS 6A', 'Computer Discrete Mathematics I'), course('124:MATH 6A', 'Computer Discrete Mathematics I'),
      course('124:CS 6B', 'Computer Discrete Mathematics II'), course('124:MATH 6B', 'Computer Discrete Mathematics II')]
    const a = agreement([row('X', ['124:CS 6B'])], cs), ivc = { allowed: [124], home: 124 }
    expect(planned(solve(new Set(), a, ivc))).toEqual(['124:CS 6A', '124:CS 6B'])
    expect(planned(solve(new Set(['124:MATH 6A']), a, ivc))).toEqual(['124:CS 6B'])
    const g = prereqGraph(a.catalog, [])
    expect(g.equiv('124:CS 6A', '124:MATH 6A')).toBe(true)
    expect(g.equiv('124:CS 6A', '124:MATH 6B')).toBe(false)
  })

  it('a title shared at one college matches across colleges only with ASSIST evidence (Foothill C S 18 / MATH 22)', () => {
    const cs = [course('113:MATH 22', 'Discrete Mathematics'), course('51:C S 18', 'Discrete Mathematics'), course('51:MATH 22', 'Discrete Mathematics')]
    const a = agreement([row('CSE 20', ['113:MATH 22'], ['51:C S 18'])], cs)
    const g = prereqGraph(a.catalog, [], a.root)
    expect(g.articulated('113:MATH 22', '51:C S 18')).toBe(true)
    expect(g.articulated('113:MATH 22', '51:MATH 22') || g.equiv('113:MATH 22', '51:MATH 22')).toBe(false)
    expect(prereqGraph(a.catalog, []).articulated('113:MATH 22', '51:C S 18')).toBe(false)
  })
})

// Tester repro (round 10, bug 3): a row that accepts a first course at one college OR a first or second course at
// another only proves the taken course is worth the lowest of them.
describe('a taken course stands only for the lowest alternative a UC row lists at a college', () => {
  const cs = [course('113:CIS 22A', 'Beginning Programming Methodologies in C++'), course('65:CS 1A', 'Introduction to Computer Science I'),
    course('65:CS 1B', 'Introduction to Computer Science II'), course('65:CS 1C', 'Introduction to Computer Science III')]
  const a = agreement([row('ECS 36A', ['113:CIS 22A'], ['65:CS 1A'], ['65:CS 1B']), row('ECS 36B', ['65:CS 1C'])], cs)

  it('UC Davis ECS 036A: taken De Anza CIS 22A covers Saddleback CS 1A, not CS 1B', () => {
    const p = solve(new Set(['113:CIS 22A']), a, { allowed: [65], home: 65 })
    expect(planned(p)).toEqual(['65:CS 1B', '65:CS 1C'])
    expect(termOf(p, '65:CS 1B')).toBeLessThan(termOf(p, '65:CS 1C'))
    const g = prereqGraph(a.catalog, ['113:CIS 22A'], a.root)
    expect(g.articulated('65:CS 1A', '113:CIS 22A')).toBe(true)
    expect(g.articulated('65:CS 1B', '113:CIS 22A')).toBe(false)
  })

  it('a row listing only higher courses at a college: the lowest listed one is what the taken course proves', () => {
    const b = agreement([row('COM SCI 31', ['124:CS 37'], ['65:CS 1B'], ['65:CS 1C']), row('X', ['65:CS 1D'])],
      [...cs, course('124:CS 37', 'C++ Programming'), course('65:CS 1D', 'Introduction to Computer Science IV')])
    const g = prereqGraph(b.catalog, ['124:CS 37'], b.root)
    expect(g.articulated('65:CS 1B', '124:CS 37')).toBe(true)
    expect(g.articulated('65:CS 1C', '124:CS 37')).toBe(false)
    expect(planned(solve(new Set(['124:CS 37']), b, { allowed: [65], home: 65 }))).toEqual(['65:CS 1C', '65:CS 1D'])
  })
})

// Tester repros on the real fixtures (cross-college transcripts): a course taken elsewhere that ASSIST articulates to the
// same UC course is not planned again as a prerequisite.
describe('a course taken at another college still counts (real agreements)', () => {
  const files = import.meta.glob('../../data/agreements/*.json', { eager: true, import: 'default' }) as Record<string, Agreement>
  const systems = Object.fromEntries((institutions as Institution[]).map((i) => [i.id, i.terms]))
  const cases: [string, number, string, string][] = [['7-mae-mechanical-engineering-b-s', 65, '113:PHYS 4B', '65:PHYS 4B'],
    ['120-electrical-engineering-b-s', 51, '113:PHYS 4C', '51:PHYS 4C'], ['120-electrical-engineering-b-s', 124, '51:PHYS 4B', '124:PHYS 4B']]
  it.each(cases)('%s home %i, taken %s: %s is not planned', (name, home, took, twin) => {
    const a = Object.entries(files).find(([f]) => f.includes(`/${name}.json`))![1]
    const p = solve(new Set([took]), a, { allowed: [home], home, termSystem: systems[home], unitSystems: systems })
    expect(planned(p)).not.toContain(twin)
  })

  // bug 3: UC Davis / UC Irvine rows accept De Anza CIS 22A or Saddleback CS 1A or CS 1B; CS 1C still needs CS 1B first
  it.each(['89-computer-science-b-s', '89-computer-science-engineering-b-s', '120-electrical-engineering-b-s'])('%s home Saddleback, taken De Anza CIS 22A: CS 1B before CS 1C', (name) => {
    const a = Object.entries(files).find(([f]) => f.includes(`/${name}.json`))![1]
    const p = solve(new Set(['113:CIS 22A']), a, { allowed: [65], home: 65, termSystem: systems[65], unitSystems: systems })
    if (termOf(p, '65:CS 1C') < 0) return
    expect(termOf(p, '65:CS 1B'), name).toBeGreaterThanOrEqual(0)
    expect(termOf(p, '65:CS 1B')).toBeLessThan(termOf(p, '65:CS 1C'))
  })
})

// Real 2025-26 fixtures: West Valley titles MATH 003A and 003B both "Calculus and Analytic Geometry" and Foothill MATH
// 1A-1D all "Calculus". Before round 10, UCLA ME at Foothill planned PHYS 4B (E&M, after Calculus II) with Calculus I
// only, and West Valley added honors 003BH because 003A "covered" 003B by title.
describe('same-titled courses on real agreements (every plan at Foothill / West Valley)', () => {
  const files = import.meta.glob('../../data/agreements/*.json', { eager: true, import: 'default' }) as Record<string, Agreement>
  const systems = Object.fromEntries((institutions as Institution[]).map((i) => [i.id, i.terms]))
  const cases: [number, string, string[]][] = [[51, '51:PHYS 4B', ['51:MATH 1B', '51:MATH 1BH']], [80, '80:PHYS 004B', ['80:MATH 003B', '80:MATH 003BH']]]
  it.each(cases)('home %i: a plan with %s also has Calculus II in an earlier term', (home, em, calc2) => {
    let seen = 0
    for (const [f, a] of Object.entries(files)) {
      if (!a.sendingIds.includes(home)) continue
      const p = solve(new Set(), a, { allowed: [home], home, termSystem: systems[home], unitSystems: systems })
      const at = termOf(p, em)
      if (at < 0) continue
      seen++
      const c2 = calc2.map((c) => termOf(p, c)).filter((i) => i >= 0)
      expect(c2.length, `${f}: ${em} planned without ${calc2.join(' / ')}`).toBeGreaterThan(0)
      expect(Math.min(...c2), f).toBeLessThan(at)
      // the regular course is preferred over the honors twin when it is only a prerequisite
      expect(planned(p).includes(calc2[1]) && !Object.values(p.chosen).some((g) => g.courses.includes(calc2[1])), f).toBe(false)
    }
    expect(seen).toBeGreaterThan(0)
  })
})
