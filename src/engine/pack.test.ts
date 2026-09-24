import { describe, expect, it } from 'vitest'
import ee from '../../data/agreements/117-electrical-engineering-b-s.json'
import bme from '../../data/agreements/79-mechanical-engineering-b-s.json'
import institutions from '../../data/institutions.json'
import type { Agreement, Course, Institution, Plan, Requirement } from './types'
import { solve, type SolveOptions } from './solve'
import { prereqs } from './sequence'
import { nextOpenTerm } from './calendar'

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

describe('pack: topic prerequisites (MED-3)', () => {
  const before = (p: Plan, x: string, y: string) => {
    expect(termOf(p, x)).toBeGreaterThanOrEqual(0)
    expect(termOf(p, x)).toBeLessThan(termOf(p, y))
  }
  it('Berkeley ME at Santa Monica only: Calculus 1 < 2 < Multivariable < Linear Algebra / ODE; physics and chemistry in order', () => {
    const SM = 137
    const p = solve(new Set(), bme as unknown as Agreement, { allowed: [SM], home: SM, termSystem: 'semester', unitSystems })
    const c = (x: string) => `${SM}:${x}`
    before(p, c('MATH 7'), c('MATH 8'))
    before(p, c('MATH 8'), c('MATH 11'))
    for (const x of ['MATH 13', 'MATH 15']) before(p, c('MATH 8'), c(x))
    before(p, c('PHYSCS 21'), c('PHYSCS 22'))
    before(p, c('PHYSCS 22'), c('PHYSCS 23'))
    before(p, c('CHEM 11'), c('CHEM 12'))
  })
  it('De Anza + Foothill: generic Foothill "Calculus" takes its level from the letter; physics by topic', () => {
    const a = agreement([['113:MATH 1A'], ['51:MATH 1B'], ['113:MATH 1C'], ['51:MATH 2B'], ['51:PHYS 4X'], ['113:PHYS 4B'], ['137:PHYSCS 21']], [
      ['113:MATH 1A', 5, 'Calculus I'], ['51:MATH 1B', 5, 'Calculus'], ['113:MATH 1C', 5, 'Calculus III'], ['51:MATH 2B', 5, 'Linear Algebra'],
      ['51:PHYS 4X', 6, 'General Physics (Calculus)'], ['113:PHYS 4B', 6, 'Physics for Scientists and Engineers: Electricity and Magnetism'],
      ['137:PHYSCS 21', 5, 'Mechanics with Lab'],
    ])
    const p = run(a, { unitCap: 30 })
    before(p, '113:MATH 1A', '51:MATH 1B')
    before(p, '51:MATH 1B', '113:MATH 1C')
    before(p, '51:MATH 1B', '51:MATH 2B')
    expect(termOf(p, '113:MATH 1C')).toBe(termOf(p, '51:MATH 2B')) // multivariable and linear algebra: no order
    before(p, '137:PHYSCS 21', '113:PHYS 4B')
    expect(termOf(p, '51:PHYS 4X')).toBe(0) // "General Physics" names no topic: unordered
  })
  it('cross-college Calc 1 -> Calc 2 (De Anza Calculus I, Santa Monica Calculus 2), even when Calc 2 is bigger', () => {
    const p = run(agreement([['137:MATH 8'], ['113:MATH 1A']], [['137:MATH 8', 6, 'Calculus 2'], ['113:MATH 1A', 5, 'Calculus I']]))
    before(p, '113:MATH 1A', '137:MATH 8')
  })
  it('a lab shares its lecture\'s term and never comes before it', () => {
    const a = agreement([['137:ENGR 21', '137:ENGR 22'], ['33:PHYC 4A', '33:PHYC 4AL'], ['33:PHYC 4B', '33:PHYC 4BL']], [
      ['137:ENGR 21', 3, 'Circuit Analysis'], ['137:ENGR 22', 1, 'Circuit Analysis Lab'],
      ['33:PHYC 4A', 3, 'Classical Mechanics for Scientists and Engineers'], ['33:PHYC 4AL', 1, 'Mechanics Laboratory for Scientists and Engineers'],
      ['33:PHYC 4B', 3, 'Electromagnetism for Scientists and Engineers'], ['33:PHYC 4BL', 1, 'Electromagnetism Laboratory for Scientists and Engineers'],
    ])
    for (const unitCap of [4, 8, 16]) {
      const p = run(a, { unitCap, termSystem: 'semester', unitSystems: { 33: 'semester', 137: 'semester' } })
      expect(termOf(p, '137:ENGR 22')).toBe(termOf(p, '137:ENGR 21'))
      expect(termOf(p, '33:PHYC 4AL')).toBe(termOf(p, '33:PHYC 4A'))
      expect(termOf(p, '33:PHYC 4BL')).toBe(termOf(p, '33:PHYC 4B'))
      before(p, '33:PHYC 4A', '33:PHYC 4B')
      expect(p.terms.every((t) => t.units <= unitCap)).toBe(true)
    }
  })
  it('unknown and applied titles stay unordered', () => {
    const a = agreement([['1:FOO 9'], ['2:BAR 1'], ['1:MATH 16'], ['2:MATH 5']], [
      ['1:FOO 9', 3, 'Foundations of Widgets II'], ['2:BAR 1', 3, 'Widget Studio'],
      ['1:MATH 16', 4, 'Calculus for Business and the Life and Social Sciences'], ['2:MATH 5', 4, 'Calculus II'],
    ])
    expect(run(a, { unitCap: 20 }).terms).toHaveLength(1)
  })
  it('every inferred prerequisite is respected on every real agreement (home, home + Foothill, all colleges)', () => {
    const all = (institutions as Institution[]).filter((i) => i.isCC).map((i) => i.id)
    const files = import.meta.glob('../../data/agreements/*.json', { eager: true, import: 'default' }) as Record<string, Agreement>
    let checked = 0
    for (const a of Object.values(files)) for (const [home, allowed] of [[137, [137]], [113, [113, 51]], [32, all]] as [number, number[]][]) {
      const p = solve(new Set(), a, { allowed, home, termSystem: unitSystems[home], unitSystems })
      const at = new Map(p.terms.flatMap((t, i) => t.courses.map((c): [string, number] => [c, i])))
      for (const e of prereqs([...at.keys()], (c) => a.catalog[c]?.title ?? '').edges) {
        checked++
        if (e.rule === 'co') expect(at.get(e.from)!, `${e.from} -> ${e.to}`).toBeLessThanOrEqual(at.get(e.to)!)
        else expect(at.get(e.from)!, `${e.rule} ${e.from} -> ${e.to}`).toBeLessThan(at.get(e.to)!)
      }
    }
    expect(checked).toBeGreaterThan(500)
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

describe('pack: real calendars (H-3)', () => {
  const sys = { 1: 'quarter' as const, 2: 'semester' as const }
  const fall = { season: 'Fall' as const, year: 2026 }
  it('De Anza + Orange Coast: every course sits in a term of its own college calendar', () => {
    const p = solve(new Set(), bme as unknown as Agreement, { allowed: [113, 74], home: 113, termSystem: 'quarter', unitSystems, startTerm: fall })
    expect(p.terms.some((t) => t.system === 'semester')).toBe(true)
    for (const t of p.terms) for (const c of t.courses) expect(t.system, `${c} in ${t.name}`).toBe(unitSystems[+c.split(':')[0]])
    for (const t of p.terms.filter((x) => x.system === 'semester')) expect(['Fall', 'Spring']).toContain(t.season)
  })
  it('mixed plan: quarter and semester terms aligned on one timeline, named by calendar', () => {
    const a = agreement([['1:A 1A', '1:A 1B', '1:A 1C'], ['2:S 1A', '2:S 1B']],
      [['1:A 1A', 4], ['1:A 1B', 4], ['1:A 1C', 4], ['2:S 1A', 3], ['2:S 1B', 3]])
    const p = run(a, { unitSystems: sys, termSystem: 'quarter', startTerm: fall, unitCap: 30 })
    expect(p.terms.map((t) => [t.name, t.courses])).toEqual([
      ['Fall 2026 (quarter)', ['1:A 1A']], ['Fall 2026 (semester)', ['2:S 1A']],
      ['Winter 2027 (quarter)', ['1:A 1B']], ['Spring 2027 (semester)', ['2:S 1B']], ['Spring 2027 (quarter)', ['1:A 1C']],
    ])
    const spring = p.terms.find((t) => t.name === 'Spring 2027 (semester)')!
    expect(spring.span).toEqual([3 * 2026 + 1, 3 * 2026 + 2])
    expect(spring.concurrent).toEqual(['Winter 2027 (quarter)', 'Spring 2027 (quarter)'])
    expect(p.terms[0].concurrent).toEqual(['Fall 2026 (semester)'])
  })
  it('a semester prerequisite holds a quarter course until the semester ends', () => {
    const a = agreement([['2:MATH 1'], ['1:MATH 2']], [['2:MATH 1', 4, 'Calculus I'], ['1:MATH 2', 5, 'Calculus II']])
    const p = run(a, { unitSystems: sys, termSystem: 'quarter', startTerm: { season: 'Winter', year: 2027 } })
    expect(p.terms.map((t) => t.name)).toEqual(['Spring 2027 (semester)', 'Fall 2027 (quarter)'])
  })
  it('the cap applies to the combined load of overlapping terms', () => {
    // quarter home, cap 16: a Spring semester course (4s = 6q) runs alongside both Winter and Spring quarter
    const a = agreement([['1:A 1'], ['1:B 1'], ['1:C 1'], ['2:S 1']], [['1:A 1', 5], ['1:B 1', 5], ['1:C 1', 5], ['2:S 1', 4]])
    const p = run(a, { unitSystems: sys, termSystem: 'quarter', startTerm: { season: 'Winter', year: 2027 }, unitCap: 16 })
    expect(p.terms.map((t) => [t.name, t.units, t.load])).toEqual([
      ['Winter 2027 (quarter)', 10, 16], ['Spring 2027 (semester)', 6, 16], ['Spring 2027 (quarter)', 5, 11],
    ])
    expect(p.terms.some((t) => t.overCap)).toBe(false)
  })
  it('overCap: a course over the cap alone runs with nothing alongside and is flagged', () => {
    const a = agreement([['1:BIG 1'], ['2:S 1']], [['1:BIG 1', 20], ['2:S 1', 4]])
    const p = run(a, { unitSystems: sys, termSystem: 'quarter', startTerm: fall, unitCap: 16 })
    const big = p.terms.find((t) => t.courses.includes('1:BIG 1'))!
    expect(big.overCap).toBe(true)
    expect(big.concurrent).toEqual([])
    expect(p.terms.filter((t) => t.overCap)).toHaveLength(1)
  })
})

describe('start term', () => {
  const a = agreement([['1:A 1A', '1:A 1B']], [['1:A 1A', 4], ['1:A 1B', 4]])
  it('nextOpenTerm follows the registration cutoffs in src/terms.ts', () => {
    expect(nextOpenTerm(new Date(Date.UTC(2026, 2, 31)))).toEqual({ season: 'Spring', year: 2026 })
    expect(nextOpenTerm(new Date(Date.UTC(2026, 3, 1)))).toEqual({ season: 'Fall', year: 2026 })
    expect(nextOpenTerm(new Date(Date.UTC(2026, 8, 24)), 'semester')).toEqual({ season: 'Spring', year: 2027 })
    expect(nextOpenTerm(new Date(Date.UTC(2026, 11, 20)))).toEqual({ season: 'Winter', year: 2027 })
    expect(nextOpenTerm(new Date(NaN)).season).toBe('Fall') // invalid date: never throws
  })
  it('default start is nextOpenTerm(today) in the home calendar', () => {
    const q = nextOpenTerm(new Date(), 'quarter'), s = nextOpenTerm(new Date(), 'semester')
    expect(run(a).terms[0].name).toBe(`${q.season} ${q.year}`)
    expect(run(a, { termSystem: 'semester', unitSystems: { 1: 'semester' } }).terms[0].name).toBe(`${s.season} ${s.year}`)
  })
  it('explicit start is honored; a quarter Spring start skips the Spring semester already under way', () => {
    expect(run(a, { startTerm: { season: 'Spring', year: 2028 } }).terms.map((t) => t.name)).toEqual(['Spring 2028', 'Fall 2028'])
    const p = run(agreement([['2:S 1']], [['2:S 1', 3]]), { unitSystems: { 2: 'semester' }, startTerm: { season: 'Spring', year: 2027 } })
    expect(p.terms.map((t) => t.name)).toEqual(['Fall 2027'])
  })
})
