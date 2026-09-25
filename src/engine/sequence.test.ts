import { describe, expect, it } from 'vitest'
import institutions from '../../data/institutions.json'
import { prereqs, topic, type Edge } from './sequence'
import { solve } from './solve'
import type { Agreement, Institution } from './types'

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
      ['51:PHYS 4C', 'General Physics (Calculus)'], ['124:PHYS 4B', 'General Physics'], ['137:PHYS 3', 'Human Physiology'], ['1:MATH 4A', 'Intermediate Calculus'],
      ['1:CS 55', 'JAVA Programming'], ['1:ENGR 16', 'Engineering Graphics'], ['1:ENGR 31', 'Introduction to Digital Systems'],
      ['1:ENGR 54', 'Principles of Materials Science and Engineering'], ['1:ENGR 7', 'Introduction to Engineering Methods'],
      ['1:ENGR 11', 'Programming & Problem-Solving in MATLAB'], ['1:ENGL 16', 'Dynamics'], ['1:MATH 9', 'Calculus']]) expect(topic(c, t), t).toBeUndefined()
  })
})

describe('prereqs: calculus before physics (H-2)', () => {
  const has = (edges: Edge[], a: string, b: string) => edges.some((e) => e.from === a && e.to === b)
  it('Foothill: MATH 1A < PHYS 4A (Mechanics), MATH 1B < PHYS 4B (E&M), a term apart', () => {
    const { edges, dropped } = run([['51:MATH 1A', 'Calculus'], ['51:MATH 1B', 'Calculus'], ['51:MATH 1C', 'Calculus'],
      ['51:PHYS 4A', 'General Physics (Calculus)'], ['51:PHYS 4B', 'General Physics (Calculus)']])
    expect(dropped).toEqual([])
    expect(pairs(edges.filter((e) => e.to.includes('PHYS'))))
      .toEqual(['letter 51:PHYS 4A > 51:PHYS 4B', 'math 51:MATH 1A > 51:PHYS 4A', 'math 51:MATH 1A > 51:PHYS 4B', 'math 51:MATH 1B > 51:PHYS 4B'])
    expect(has(edges, '51:MATH 1B', '51:PHYS 4A') || has(edges, '51:MATH 1C', '51:PHYS 4B')).toBe(false)
  })
  it('across colleges, by title: De Anza Calculus I/II before Pasadena / El Camino physics', () => {
    const { edges } = run([['113:MATH 1A', 'Calculus I'], ['113:MATH 1B', 'Calculus II'], ['113:MATH 1C', 'Calculus III'],
      ['113:PHYS 4A', 'Physics for Scientists and Engineers: Mechanics'], ['103:PHYS 1C', 'Electricity and Magnetism'],
      ['103:PHYS 1B', 'Fluids, Heat and Sound']])
    expect(has(edges, '113:MATH 1A', '113:PHYS 4A') && has(edges, '113:MATH 1B', '103:PHYS 1C')).toBe(true)
    expect(has(edges, '113:MATH 1B', '113:PHYS 4A') || has(edges, '113:MATH 1C', '103:PHYS 1C')).toBe(false)
    expect(edges.some((e) => e.to === '103:PHYS 1B' && e.from.includes('MATH'))).toBe(false)
  })
  it('not for algebra-based physics', () => {
    const { edges } = run([['1:MATH 1A', 'Calculus I'], ['1:PHYS 2A', 'College Physics: Mechanics'], ['1:PHYS 10', 'Algebra-Based Physics: Mechanics']])
    expect(edges).toEqual([])
  })
})

describe('prereqs: Linear Algebra / Differential Equations (L-6)', () => {
  it('De Anza MATH 2A DiffEq and 2B LinAlg: no letter edge, both after 1B, not after 1C', () => {
    const { edges } = run([['113:MATH 1A', 'Calculus I'], ['113:MATH 1B', 'Calculus II'], ['113:MATH 1C', 'Calculus III'],
      ['113:MATH 2A', 'Differential Equations'], ['113:MATH 2BH', 'Linear Algebra - HONORS']])
    const into = (c: string) => edges.filter((e) => e.to === c).map((e) => `${e.rule} ${e.from}`).sort()
    expect(into('113:MATH 2A')).toEqual(['math 113:MATH 1A', 'math 113:MATH 1B'])
    expect(into('113:MATH 2BH')).toEqual(['math 113:MATH 1A', 'math 113:MATH 1B'])
  })
  it('the letter rule still orders other series', () => {
    expect(pairs(run([['51:MATH 2A', 'Differential Equations'], ['51:MATH 2B', 'x']]).edges)).toEqual(['letter 51:MATH 2A > 51:MATH 2B'])
  })
})

describe('prereqs: engineering (N-1)', () => {
  const has = (es: Edge[], a: string, b: string) => es.some((e) => e.from === a && e.to === b)
  it('statics / dynamics / circuits after Calculus II and calculus-based mechanics; circuits after E&M; dynamics after statics', () => {
    const { edges, dropped } = run([['51:MATH 1A', 'Calculus'], ['51:MATH 1B', 'Calculus'], ['51:MATH 1C', 'Calculus'],
      ['51:PHYS 4A', 'Physics for Scientists and Engineers: Mechanics'], ['51:PHYS 4B', 'Physics for Scientists and Engineers: Electricity and Magnetism'],
      ['51:ENGR 35', 'Statics'], ['51:ENGR 47', 'Dynamics'], ['51:ENGR 37', 'Introduction to Circuit Analysis'], ['51:ENGR 37L', 'Circuit Analysis Laboratory'],
      ['51:ENGR 45', 'Properties of Materials'], ['51:ENGR 6', 'Engineering Graphics'], ['51:MATH 2A', 'Differential Equations']])
    expect(dropped).toEqual([])
    for (const [a, b] of [['51:MATH 1B', '51:ENGR 35'], ['51:PHYS 4A', '51:ENGR 35'], ['51:ENGR 35', '51:ENGR 47'], ['51:PHYS 4A', '51:ENGR 47'],
      ['51:PHYS 4B', '51:ENGR 37'], ['51:MATH 1B', '51:ENGR 37'], ['51:MATH 1B', '51:MATH 2A']]) expect(has(edges, a, b), `${a} > ${b}`).toBe(true)
    // Calculus III is not required; materials, graphics: no order; the lab rides with its lecture
    expect(edges.some((e) => e.from === '51:MATH 1C' && /ENGR/.test(e.to))).toBe(false)
    expect(edges.some((e) => /ENGR (45|6)$/.test(e.from) || /ENGR (45|6)$/.test(e.to))).toBe(false)
    expect(edges.filter((e) => e.rule === 'engr' && (e.from === '51:ENGR 37' || e.to === '51:ENGR 37L') && e.from.includes('ENGR'))).toEqual([])
  })
  it('across colleges, algebra physics never gates, and nothing without the prerequisite in the list', () => {
    expect(pairs(run([['113:PHYS 4A', 'Physics for Scientists and Engineers: Mechanics'], ['32:EGR 023', 'Mechanics - Statics'],
      ['33:ENGN 37', 'Engineering Mechanics - Dynamics']]).edges)).toEqual(['engr 113:PHYS 4A > 32:EGR 023', 'engr 113:PHYS 4A > 33:ENGN 37', 'engr 32:EGR 023 > 33:ENGN 37'])
    expect(run([['9:PHYS 2A', 'Algebra-Based Physics: Mechanics'], ['9:ENGR 12', 'Statics']]).edges).toEqual([])
    expect(run([['124:ENGR 80', 'Engineering Dynamics'], ['124:ENGR 70', 'Introduction to Network Analysis']]).edges).toEqual([])
    expect(topic('92:ENGR 115', 'Statics and Strength of Materials')?.kind).toBe('statics')
    expect(topic('49:ENGR 013', 'Strength of Materials')?.kind).toBe('mat')
    expect(topic('114:ENGIN 230', 'Introduction to Circuits and Devices')?.kind).toBe('circ')
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
    expect(pairs(run([['113:MATH 1C', 'Calculus III'], ['113:MATH 2A', 'Differential Equations']]).edges)).toEqual([])
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

describe('pack: engineering after calculus and physics (N-1 repros)', () => {
  const files = import.meta.glob('../../data/agreements/{117,120}-*.json', { eager: true, import: 'default' }) as Record<string, Agreement>
  const systems = Object.fromEntries((institutions as Institution[]).map((i) => [i.id, i.terms]))
  const cases: [string, number][] = [['120-mechanical-engineering-b-s', 51], ['117-mechanical-engineering-b-s', 51], ['120-electrical-engineering-b-s', 51],
    ['120-computer-science-and-engineering-b-s', 113], ['120-computer-science-and-engineering-b-s', 136], ['120-computer-science-and-engineering-b-s', 32]]
  it.each(cases)('%s @%i', (name, home) => {
    const a = Object.entries(files).find(([f]) => f.includes(`/${name}.json`))![1]
    const plan = solve(new Set(), a, { allowed: [home], home, termSystem: systems[home], unitSystems: systems, startTerm: { season: 'Fall', year: 2026 } })
    const T = (c: string) => a.catalog[c]?.title ?? ''
    const at = new Map<string, number>(); plan.terms.forEach((t) => t.courses.forEach((c) => at.set(c, t.span?.[0] ?? 0)))
    const firstCalc = Math.min(...[...at.keys()].filter((c) => /calculus|analytic geometry/i.test(T(c))).map((c) => at.get(c)!))
    const adv = [...at.keys()].filter((c) => /\b(statics|dynamics|circuit analysis)\b/i.test(T(c)))
    expect(adv.length).toBeGreaterThan(0)
    for (const c of adv) expect(at.get(c)!, `${c} ${T(c)}`).toBeGreaterThan(firstCalc)
    // every inferred edge among the planned courses holds (a lab may share its lecture's term); nothing lost from the plan
    for (const e of prereqs([...at.keys()], T).edges) expect(at.get(e.to)! - at.get(e.from)!, `${e.rule} ${e.from} > ${e.to}`).toBeGreaterThanOrEqual(e.rule === 'co' ? 0 : 1)
    expect(plan.terms.flatMap((t) => t.courses).length).toBe(at.size)
    expect(Object.keys(plan.result.satisfied).length).toBeGreaterThan(0)
  })
})
