import { describe, expect, it } from 'vitest'
import ee from '../../data/agreements/117-electrical-engineering-b-s.json'
import institutions from '../../data/institutions.json'
import type { Agreement, Course, Institution, Plan, Requirement } from './types'
import { solve, type SolveOptions } from './solve'

const EC = 103
const unitSystems = Object.fromEntries((institutions as Institution[]).map((i) => [i.id, i.terms]))

/** Synthetic agreement: each req is one single-college group. Courses are [id, units, title?]. */
const agreement = (reqs: string[][], list: [string, number, string?][]): Agreement => {
  const catalog = Object.fromEntries(list.map(([id, units, title]): [string, Course] => {
    const [inst, rest] = id.split(':'); const [prefix, number] = rest.split(' ')
    return [id, { id, institutionId: +inst, prefix, number, title: title ?? id, units }]
  }))
  const children = reqs.map((cs, i): Requirement => ({ kind: 'req', id: `R${i}`, label: `R${i}`, units: 4, groups: [{ institutionId: catalog[cs[0]].institutionId, courses: cs }] }))
  return { receivingId: 0, major: 'T', year: '', sendingIds: [], catalog, root: { kind: 'node', type: 'AND', required: true, children } }
}
const insts = (a: Agreement) => [...new Set(Object.values(a.catalog).map((c) => c.institutionId))]
const run = (a: Agreement, o: Partial<SolveOptions> = {}) => solve(new Set(), a, { allowed: insts(a), ...o })
const termOf = (p: Plan, c: string) => p.terms.findIndex((t) => t.courses.includes(c))

describe('pack: sequence order (F-05)', () => {
  it('UCLA EE at El Camino: PHYS 1A before PHYS 1C even though 1B is not planned', () => {
    const p = solve(new Set(), ee as unknown as Agreement, { allowed: [EC], home: EC, termSystem: 'semester', unitSystems })
    expect(termOf(p, `${EC}:PHYS 1A`)).toBeGreaterThanOrEqual(0)
    expect(termOf(p, `${EC}:PHYS 1A`)).toBeLessThan(termOf(p, `${EC}:PHYS 1C`))
  })
  it('skipped middle letter still gates: 1A < 1C < 1D', () => {
    const a = agreement([['1:PHYS 1A', '1:PHYS 1C', '1:PHYS 1D'], ['1:X 9']], [['1:PHYS 1A', 5], ['1:PHYS 1C', 5], ['1:PHYS 1D', 5], ['1:X 9', 5]])
    for (const unitCap of [5, 10, 16]) {
      const p = run(a, { unitCap })
      expect(termOf(p, '1:PHYS 1A')).toBeLessThan(termOf(p, '1:PHYS 1C'))
      expect(termOf(p, '1:PHYS 1C')).toBeLessThan(termOf(p, '1:PHYS 1D'))
    }
  })
  it('a smaller lower letter is not overtaken by a bigger higher letter (S21: 1A 4u, 1C 5u, cap 5)', () => {
    const p = run(agreement([['1:PHYS 1A', '1:PHYS 1C']], [['1:PHYS 1A', 4], ['1:PHYS 1C', 5]]), { unitCap: 5 })
    expect(termOf(p, '1:PHYS 1A')).toBeLessThan(termOf(p, '1:PHYS 1C'))
  })
})

describe('pack: series stay within one college (F-18)', () => {
  it('De Anza PHYS 4B is not gated by Foothill PHYS 4A', () => {
    const p = run(agreement([['51:PHYS 4A'], ['113:PHYS 4B']], [['51:PHYS 4A', 5], ['113:PHYS 4B', 5]]))
    expect(p.terms).toHaveLength(1)
  })
  it('plain numbers are ordered only when titles differ just by ordinal', () => {
    const a = agreement([['137:CHEM 11', '137:CHEM 12'], ['137:ENGR 11', '137:ENGR 12']], [
      ['137:CHEM 11', 5, 'General Chemistry I'], ['137:CHEM 12', 5, 'General Chemistry II'],
      ['137:ENGR 11', 3, 'Engineering Graphics and Design'], ['137:ENGR 12', 3, 'Statics'],
    ])
    const p = run(a, { unitCap: 20 })
    expect(termOf(p, '137:CHEM 11')).toBeLessThan(termOf(p, '137:CHEM 12'))
    expect(termOf(p, '137:ENGR 11')).toBe(termOf(p, '137:ENGR 12'))
  })
  it('a plain honors number (MATH 071H) is not read as letter H of a series', () => {
    const a = agreement([['136:MATH 070'], ['136:MATH 071H']], [['136:MATH 070', 4, 'Discrete Mathematics'], ['136:MATH 071H', 5, 'Honors Calculus I']])
    expect(run(a).terms).toHaveLength(1)
  })
})

describe('pack: unit cap (F-14)', () => {
  const four = agreement([['1:A 1', '1:B 1', '1:C 1', '1:D 1']], [['1:A 1', 5], ['1:B 1', 5], ['1:C 1', 5], ['1:D 1', 5]])
  it.each([NaN, 0, -4, Infinity])('invalid unitCap %s falls back to the default', (unitCap) => {
    const p = run(four, { unitCap })
    expect(p.terms.map((t) => t.units)).toEqual([15, 5]) // default 16: three 5u, then one
  })
  it('a single course larger than the cap is placed alone and flagged overCap', () => {
    const p = run(agreement([['1:BIG 1', '1:S 1']], [['1:BIG 1', 5], ['1:S 1', 2]]), { unitCap: 3 })
    const big = p.terms[termOf(p, '1:BIG 1')]
    expect(big.courses).toEqual(['1:BIG 1'])
    expect(big.overCap).toBe(true)
    expect(p.terms.filter((t) => t.overCap)).toHaveLength(1)
  })
})

describe('pack: term names (F-15)', () => {
  const a = agreement([['1:A 1A', '1:A 1B', '1:A 1C']], [['1:A 1A', 4], ['1:A 1B', 4], ['1:A 1C', 4]])
  it('semester start in Winter begins the next Spring, not the same-year Fall', () => {
    const p = run(a, { termSystem: 'semester', startTerm: { season: 'Winter', year: 2027 } })
    expect(p.terms.map((t) => t.name)).toEqual(['Spring 2027', 'Fall 2027', 'Spring 2028'])
  })
  it('quarter start in Winter keeps Winter', () => {
    const p = run(a, { startTerm: { season: 'Winter', year: 2027 } })
    expect(p.terms.map((t) => t.name)).toEqual(['Winter 2027', 'Spring 2027', 'Fall 2027'])
  })
})

describe('units (F-16)', () => {
  const opts = { termSystem: 'semester' as const, unitSystems: { 1: 'quarter' as const } }
  it('three 5-unit quarter courses are 10 semester units, not 10.5', () => {
    const p = run(agreement([['1:A 1', '1:B 1', '1:C 1']], [['1:A 1', 5], ['1:B 1', 5], ['1:C 1', 5]]), opts)
    expect(p.totalUnits).toBe(10)
  })
  it('three 1-unit quarter courses are 2 semester units, not 1.5', () => {
    const p = run(agreement([['1:A 1', '1:B 1', '1:C 1']], [['1:A 1', 1], ['1:B 1', 1], ['1:C 1', 1]]), opts)
    expect(p.totalUnits).toBe(2)
  })
})
