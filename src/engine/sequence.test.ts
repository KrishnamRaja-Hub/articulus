import { describe, expect, it } from 'vitest'
import { prereqs, topic, type Edge } from './sequence'

const T: Record<string, string> = {}
const run = (list: [string, string][]) => { list.forEach(([c, t]) => (T[c] = t)); return prereqs(list.map(([c]) => c), (c) => T[c] ?? '') }
const pairs = (es: Edge[]) => es.map((e) => `${e.rule} ${e.from} > ${e.to}`).sort()

describe('prereqs: topic ladders', () => {
  it('math: precalculus < I < II < multivariable < IV; linear algebra / ODE after II only', () => {
    const { edges } = run([['1:MATH 2', 'Precalculus'], ['1:MATH 7', 'Calculus 1'], ['2:MATH 3B', 'Analytic Geometry and Calculus II'],
      ['3:MATH 11', 'Multivariable Calculus'], ['4:MATH 1D', 'Calculus IV'], ['3:MATH 13', 'Linear Algebra']])
    const has = (a: string, b: string) => edges.some((e) => e.from === a && e.to === b)
    expect(has('1:MATH 2', '1:MATH 7') && has('1:MATH 7', '2:MATH 3B') && has('2:MATH 3B', '3:MATH 11') && has('3:MATH 11', '4:MATH 1D')).toBe(true)
    expect(has('2:MATH 3B', '3:MATH 13') && has('1:MATH 7', '3:MATH 13')).toBe(true)
    expect(has('3:MATH 11', '3:MATH 13') || has('3:MATH 13', '3:MATH 11') || has('4:MATH 1D', '3:MATH 13')).toBe(false)
  })
  it('physics: mechanics < E&M < optics/modern; waves/thermo after mechanics only (El Camino 1B before 1C)', () => {
    const { edges, dropped } = run([['103:PHYS 1A', 'Mechanics of Solids'], ['103:PHYS 1B', 'Fluids, Heat and Sound'],
      ['103:PHYS 1C', 'Electricity and Magnetism'], ['103:PHYS 1D', 'Optics and Modern Physics']])
    expect(dropped).toEqual([])
    expect(pairs(edges)).toEqual(pairs([
      { rule: 'letter', from: '103:PHYS 1A', to: '103:PHYS 1B' }, { rule: 'letter', from: '103:PHYS 1B', to: '103:PHYS 1C' },
      { rule: 'letter', from: '103:PHYS 1C', to: '103:PHYS 1D' }, { rule: 'physics', from: '103:PHYS 1A', to: '103:PHYS 1C' },
      { rule: 'physics', from: '103:PHYS 1A', to: '103:PHYS 1D' },
    ]))
  })
  it('chemistry: general I < II < organic, across colleges; organic I < II', () => {
    const { edges } = run([['113:CHEM 1A', 'General Chemistry I'], ['137:CHEM 12', 'General Chemistry II'], ['51:CHEM 12A', 'Organic Chemistry'],
      ['92:CHEM 212', 'Organic Chemistry II']])
    expect(pairs(edges)).toEqual(pairs([
      { rule: 'title', from: '113:CHEM 1A', to: '137:CHEM 12' }, { rule: 'chem', from: '113:CHEM 1A', to: '51:CHEM 12A' },
      { rule: 'chem', from: '113:CHEM 1A', to: '92:CHEM 212' }, { rule: 'chem', from: '137:CHEM 12', to: '51:CHEM 12A' },
      { rule: 'chem', from: '137:CHEM 12', to: '92:CHEM 212' }, { rule: 'chem', from: '51:CHEM 12A', to: '92:CHEM 212' },
    ]))
  })
  it('applied, generic and unknown titles get no topic', () => {
    for (const [c, t] of [['1:MATH 16A', 'Calculus for Business and the Life and Social Sciences'], ['33:MATH 100A', 'Short Calculus I'],
      ['51:PHYS 4A', 'General Physics (Calculus)'], ['137:PHYS 3', 'Human Physiology'], ['1:MATH 4A', 'Intermediate Calculus'],
      ['1:CS 55', 'JAVA Programming'], ['1:ENGR 16', 'Dynamics'], ['1:MATH 9', 'Calculus']]) expect(topic(c, t), t).toBeUndefined()
  })
})

describe('prereqs: labs, colleges, cycles', () => {
  it('a lab pairs with its lecture (co), never strictly after it', () => {
    const { edges } = run([['137:ENGR 21', 'Circuit Analysis'], ['137:ENGR 22', 'Circuit Analysis Lab'],
      ['51:ENGR 37', 'Introduction to Circuit Analysis'], ['51:ENGR 37L', 'Circuit Analysis Laboratory']])
    expect(pairs(edges)).toEqual(pairs([{ rule: 'co', from: '137:ENGR 21', to: '137:ENGR 22' }, { rule: 'co', from: '51:ENGR 37', to: '51:ENGR 37L' }]))
  })
  it('letters order within one college only', () => {
    expect(run([['51:PHYS 4A', 'x'], ['113:PHYS 4B', 'y']]).edges).toEqual([])
  })
  it('the series guess skips a course whose title says it starts something', () => {
    expect(run([['80:CIST 004B', 'Data Structures Using Advanced C++'], ['80:CIST 005A', 'Introduction to Python']]).edges).toEqual([])
    expect(pairs(run([['113:MATH 1C', 'Calculus III'], ['113:MATH 2A', 'Differential Equations']]).edges)).toEqual(['series 113:MATH 1C > 113:MATH 2A'])
  })
  it('a cycle drops the weakest edge, deterministically', () => {
    // letter says 1A < 1B; the physics ladder says the reverse
    const list: [string, string][] = [['9:PHYS 1A', 'Optics and Modern Physics'], ['9:PHYS 1B', 'Mechanics']]
    const one = run(list), two = run([...list].reverse())
    expect(pairs(one.edges)).toEqual(['letter 9:PHYS 1A > 9:PHYS 1B'])
    expect(pairs(one.dropped)).toEqual(['physics 9:PHYS 1B > 9:PHYS 1A'])
    expect(pairs(two.edges)).toEqual(pairs(one.edges))
  })
})
