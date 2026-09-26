import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import berkeleyMe from '../../data/agreements/79-mechanical-engineering-b-s.json'
import institutions from '../../data/institutions.json'
import type { Agreement, CourseId, Institution, Term } from './types'
import { solve } from './solve'
import { pack, SUMMER_MAX_COURSES, SUMMER_UNIT_CAP } from './pack'
import { summerSlot, type TermSystem } from './calendar'
import { FALL, lengthOf, notLonger, packer, randomCase, violations, type MiniCatalog } from './pack.testkit'

/* Round 10: summer is opt-in (PackOptions.summer / SolveOptions.summer). Off: exactly the plans without it (see also
 * pack.golden.test.ts). On: never a longer plan, the summer cap, and the same prerequisite rules. */

const unitSystems = Object.fromEntries((institutions as Institution[]).map((i) => [i.id, i.terms])) as Record<number, TermSystem>
const cat = (list: [CourseId, number, string?][]): MiniCatalog =>
  Object.fromEntries(list.map(([id, units, title]) => [id, { units, title: title ?? id, institutionId: Number(id.split(':')[0]) }]))

/** Every summer (per timeline slot, across colleges) holds at most SUMMER_MAX_COURSES courses and the summer unit cap. */
function summerProblems(ts: Term[], unitsOf: (c: CourseId) => number, cap: number, home: TermSystem): string[] {
  const by = new Map<number, CourseId[]>()
  for (const t of ts) if (t.season === 'Summer') by.set(t.span![0], [...(by.get(t.span![0]) ?? []), ...t.courses])
  const limit = Math.min(cap, SUMMER_UNIT_CAP[home])
  const out: string[] = []
  for (const [slot, cs] of by) {
    if (cs.length > SUMMER_MAX_COURSES) out.push(`${cs.length} courses in summer slot ${slot}`)
    const u = cs.reduce((s, c) => s + unitsOf(c), 0)
    if (u > limit + 1e-9) out.push(`${u} units in summer slot ${slot} (cap ${limit})`)
  }
  return out
}

describe('summer: the calendar', () => {
  it('a quarter chain uses the summer after Spring, named and placed by date', () => {
    const k = packer(cat([['1:PHYS 4A', 5], ['1:PHYS 4B', 5], ['1:PHYS 4C', 5], ['1:PHYS 4D', 5]]), { 1: 'quarter' }, 'quarter')
    const cs = ['1:PHYS 4A', '1:PHYS 4B', '1:PHYS 4C', '1:PHYS 4D']
    expect(k.run(cs, 16).map((t) => t.name)).toEqual(['Fall 2026', 'Winter 2027', 'Spring 2027', 'Fall 2027'])
    const on = k.run(cs, 16, { summer: true })
    expect(on.map((t) => t.name)).toEqual(['Fall 2026', 'Winter 2027', 'Spring 2027', 'Summer 2027'])
    expect(on[3]).toMatchObject({ season: 'Summer', year: 2027, system: 'quarter', courses: ['1:PHYS 4D'], span: [summerSlot(2027), summerSlot(2027)] })
    // Spring 2027 ends at slot 3*2026+2, Fall 2027 starts at 3*2027: summer sits between
    expect(summerSlot(2027)).toBeGreaterThan(on[2].span![1])
    expect(summerSlot(2027)).toBeLessThan(3 * 2027)
  })

  it('semester colleges have a summer session too', () => {
    const k = packer(cat([['2:MATH 1A', 4], ['2:MATH 1B', 4], ['2:MATH 1C', 4]]), { 2: 'semester' }, 'semester')
    const cs = ['2:MATH 1A', '2:MATH 1B', '2:MATH 1C']
    expect(k.run(cs, 12).map((t) => t.name)).toEqual(['Fall 2026', 'Spring 2027', 'Fall 2027'])
    expect(k.run(cs, 12, { summer: true }).map((t) => t.name)).toEqual(['Fall 2026', 'Spring 2027', 'Summer 2027'])
  })

  it('a plan never starts in summer; from a Spring start the first summer follows it', () => {
    const units = () => 5
    const cs = ['1:PHYS 4A', '1:PHYS 4B']
    const p = pack(cs, units, 16, { season: 'Spring', year: 2027 }, 'quarter', () => '', () => 'quarter', { summer: true })
    expect(p.map((t) => t.name)).toEqual(['Spring 2027', 'Summer 2027'])
    expect(() => pack(cs, units, 16, { season: 'Summer' as never, year: 2027 }, 'quarter', () => '', () => 'quarter', { summer: true })).toThrow(/Summer/)
  })

  it('a mixed plan names each summer by calendar', () => {
    const k = packer(cat([['1:PHYS 4A', 5], ['1:PHYS 4B', 5], ['1:PHYS 4C', 5], ['1:PHYS 4D', 5], ['2:MATH 1A', 3], ['2:MATH 1B', 3], ['2:MATH 1C', 3]]),
      { 1: 'quarter', 2: 'semester' }, 'quarter')
    const p = k.run(['1:PHYS 4A', '1:PHYS 4B', '1:PHYS 4C', '1:PHYS 4D', '2:MATH 1A', '2:MATH 1B', '2:MATH 1C'], 16, { summer: true })
    const summers = p.filter((t) => t.season === 'Summer').map((t) => t.name)
    expect(summers.length).toBeGreaterThan(0)
    for (const n of summers) expect(n).toMatch(/^Summer \d{4} \((quarter|semester)\)$/)
  })
})

describe('summer: load cap', () => {
  it(`at most ${SUMMER_MAX_COURSES} courses and ${SUMMER_UNIT_CAP.quarter} quarter / ${SUMMER_UNIT_CAP.semester} semester units`, () => {
    expect(SUMMER_MAX_COURSES).toBe(2)
    expect(SUMMER_UNIT_CAP).toEqual({ quarter: 10, semester: 8 })
    // three 2-unit chains (AA, BB of 4 courses, CC of 5): three 1D courses wait for summer, and 4 more units would fit,
    // but only two courses may go. CC 1D goes (longest chain), with AA 1D; BB 1D and CC 1E finish in Fall 2027.
    const list: [CourseId, number][] = []
    for (const [p, n] of [['AA', 4], ['BB', 4], ['CC', 5]] as const) for (const l of 'ABCDE'.slice(0, n)) list.push([`1:${p} 1${l}`, 2])
    const k = packer(cat(list), { 1: 'quarter' }, 'quarter')
    const cs = list.map(([c]) => c).sort()
    expect(k.run(cs, 16).at(-1)!.name).toBe('Winter 2028')
    const p = k.run(cs, 16, { summer: true })
    expect(p.map((t) => t.name)).toEqual(['Fall 2026', 'Winter 2027', 'Spring 2027', 'Summer 2027', 'Fall 2027'])
    expect(p[3].courses).toEqual(['1:CC 1D', '1:AA 1D'])
    expect(p[4].courses.sort()).toEqual(['1:BB 1D', '1:CC 1E'])
    expect(summerProblems(p, k.unitsOf, 16, 'quarter')).toEqual([])
  })

  it('summer is used only when it finishes the plan sooner', () => {
    // four 4-course chains: two 1D courses fit in summer, the other two still need Fall 2027, so no summer
    const list: [CourseId, number][] = []
    for (const p of ['AA', 'BB', 'CC', 'DD']) for (const l of 'ABCD') list.push([`1:${p} 1${l}`, 2])
    const k = packer(cat(list), { 1: 'quarter' }, 'quarter')
    const cs = list.map(([c]) => c).sort()
    expect(k.run(cs, 16, { summer: true })).toEqual(k.run(cs, 16))
  })

  it('a course over the summer unit cap never goes to summer', () => {
    const k = packer(cat([['1:PHYS 4A', 5], ['1:PHYS 4B', 5], ['1:PHYS 4C', 5], ['1:PHYS 4D', 12]]), { 1: 'quarter' }, 'quarter')
    const cs = ['1:PHYS 4A', '1:PHYS 4B', '1:PHYS 4C', '1:PHYS 4D']
    const on = k.run(cs, 16, { summer: true })
    expect(on.some((t) => t.season === 'Summer')).toBe(false)
    expect(on).toEqual(k.run(cs, 16))
  })

  it('the summer cap is never above the regular cap', () => {
    // regular cap 3: a 4-unit course never fits a summer, although the summer cap is 10
    const k = packer(cat([['1:PHYS 4A', 3], ['1:PHYS 4B', 3], ['1:PHYS 4C', 3], ['1:PHYS 4D', 4]]), { 1: 'quarter' }, 'quarter')
    const cs = ['1:PHYS 4A', '1:PHYS 4B', '1:PHYS 4C', '1:PHYS 4D']
    const p = k.run(cs, 3, { summer: true })
    expect(p.some((t) => t.season === 'Summer')).toBe(false)
    // and a 3-unit one does
    const q = packer(cat([['1:PHYS 4A', 3], ['1:PHYS 4B', 3], ['1:PHYS 4C', 3], ['1:PHYS 4D', 3]]), { 1: 'quarter' }, 'quarter').run(cs, 3, { summer: true })
    expect(q.at(-1)!.name).toBe('Summer 2027')
  })

  it('a lecture and its lab go to summer together, as two courses, or not at all', () => {
    const k = packer(cat([['1:PHYS 4A', 5], ['1:PHYS 4B', 5], ['1:PHYS 4C', 5], ['1:CHEM 1A', 4, 'Chemistry'], ['1:CHEM 1AL', 1, 'Chemistry Lab'],
      ['1:CHEM 1B', 4, 'Chemistry'], ['1:CHEM 1C', 4, 'Chemistry'], ['1:CHEM 1D', 4, 'Chemistry'], ['1:CHEM 1DL', 1, 'Chemistry Lab']]), { 1: 'quarter' }, 'quarter')
    const cs = ['1:CHEM 1A', '1:CHEM 1AL', '1:CHEM 1B', '1:CHEM 1C', '1:CHEM 1D', '1:CHEM 1DL', '1:PHYS 4A', '1:PHYS 4B', '1:PHYS 4C']
    for (const cap of [10, 16]) {
      const p = k.run(cs, cap, { summer: true })
      const termOf = (c: string) => p.find((t) => t.courses.includes(c))!
      expect(termOf('1:CHEM 1DL')).toBe(termOf('1:CHEM 1D'))
      expect(summerProblems(p, k.unitsOf, cap, 'quarter')).toEqual([])
      expect(violations(p, cs, k.titleOf)).toEqual([])
    }
  })
})

describe('summer: off by default, on never longer (properties)', () => {
  it('random plans: off is the default; on is never longer, holds the cap and every prerequisite', () => {
    let shorter = 0
    for (let seed = 1; seed <= 1000; seed++) {
      const c = randomCase(seed), k = packer(c.catalog, c.systems, c.home)
      const off = k.run(c.courses, c.cap), on = k.run(c.courses, c.cap, { summer: true })
      expect(k.run(c.courses, c.cap, { summer: false }), `seed ${seed}`).toEqual(off)
      expect(off.some((t) => t.season === 'Summer'), `seed ${seed}`).toBe(false)
      expect(lengthOf(on)[0] <= lengthOf(off)[0], `seed ${seed}`).toBe(true)
      expect(violations(on, c.courses, k.titleOf), `seed ${seed}`).toEqual([])
      expect(summerProblems(on, k.unitsOf, c.cap, c.home), `seed ${seed}`).toEqual([])
      expect(on.flatMap((t) => t.courses).sort(), `seed ${seed}`).toEqual(c.courses)
      // summer is used exactly when it finishes sooner
      const sooner = lengthOf(on)[0] < lengthOf(off)[0]
      expect(on.some((t) => t.season === 'Summer'), `seed ${seed}`).toBe(sooner)
      if (!sooner) expect(on, `seed ${seed}`).toEqual(off)
      if (sooner) shorter++
    }
    expect(shorter).toBeGreaterThan(100)
  }, 60_000)

  it('real plans (pack.golden.json): on is never longer, holds the cap and every prerequisite', () => {
    type G = { catalog: Record<CourseId, [number, string, TermSystem]>; cases: { name: string; home: TermSystem; cap: number; courses: CourseId[] }[] }
    const g = JSON.parse(readFileSync(new URL('./pack.golden.json', import.meta.url), 'utf8')) as G
    const mini: MiniCatalog = {}, systems: Record<number, TermSystem> = {}
    for (const [c, [units, title, sys]] of Object.entries(g.catalog)) {
      const inst = Number(c.split(':')[0])
      mini[c] = { units, title, institutionId: inst }
      systems[inst] = sys
    }
    let shorter = 0
    for (const c of g.cases) {
      const k = packer(mini, systems, c.home)
      const off = k.run(c.courses, c.cap), on = k.run(c.courses, c.cap, { summer: true })
      expect(notLonger(on, off) || lengthOf(on)[0] < lengthOf(off)[0], c.name).toBe(true)
      expect(violations(on, c.courses, k.titleOf), c.name).toEqual([])
      expect(summerProblems(on, k.unitsOf, c.cap, c.home), c.name).toEqual([])
      if (lengthOf(on)[0] < lengthOf(off)[0]) shorter++
    }
    expect(shorter).toBeGreaterThan(g.cases.length / 2)
  })

  it('solve: summer off (or unset) gives the same plan; on uses summer and finishes sooner (Berkeley ME, De Anza)', () => {
    const a = berkeleyMe as unknown as Agreement
    const o = { allowed: [113], home: 113, termSystem: 'quarter' as const, unitSystems, startTerm: FALL }
    const unset = solve(new Set(), a, o)
    expect(solve(new Set(), a, { ...o, summer: false })).toEqual(unset)
    expect(unset.terms.some((t) => t.season === 'Summer')).toBe(false)
    const on = solve(new Set(), a, { ...o, summer: true })
    expect(on.terms.some((t) => t.season === 'Summer')).toBe(true)
    expect(lengthOf(on.terms)[0]).toBeLessThan(lengthOf(unset.terms)[0])
    // same courses, same verdict: summer changes only when
    expect(on.terms.flatMap((t) => t.courses).sort()).toEqual(unset.terms.flatMap((t) => t.courses).sort())
    expect(on.result).toEqual(unset.result)
  })
})
