import { describe, expect, it } from 'vitest'
import institutions from '../../data/institutions.json'
import type { Agreement, Course, CourseId, Institution, Requirement, Term } from './types'
import { solve } from './solve'
import { pack, type PackOptions } from './pack'
import { prereqs } from './sequence'
import type { TermSystem } from './calendar'

/* Round 10, fix C: critical-path priority in term packing (src/engine/pack.ts). */

const unitSystems = Object.fromEntries((institutions as Institution[]).map((i) => [i.id, i.terms])) as Record<number, TermSystem>
const FALL = { season: 'Fall' as const, year: 2026 }

/** Synthetic agreement: each req is one single-college group. Courses are [id, units, title?]. */
const agreement = (reqs: string[][], list: [string, number, string?][]): Agreement => {
  const catalog = Object.fromEntries(list.map(([id, units, title]): [string, Course] => {
    const [inst, rest] = id.split(':'); const [prefix, number] = rest.split(' ')
    return [id, { id, institutionId: +inst, prefix, number, title: title ?? id, units }]
  }))
  const children = reqs.map((cs, i): Requirement => ({ kind: 'req', id: `R${i}`, label: `R${i}`, units: 4, groups: [{ institutionId: catalog[cs[0]].institutionId, courses: cs }] }))
  return { receivingId: 0, major: 'T', year: '', sendingIds: [], catalog, root: { kind: 'node', type: 'AND', required: true, children } }
}

/** Plan length: when the last term ends on the timeline, then how many terms. */
const lengthOf = (ts: Term[]) => [Math.max(-Infinity, ...ts.map((t) => t.span![1])), ts.length]
const notLonger = (x: Term[], y: Term[]) => { const a = lengthOf(x), b = lengthOf(y); return a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]) }

/** Every inferred prerequisite holds on the timeline: strictly earlier, or (a lab) not before its lecture. */
function violations(ts: Term[], courses: CourseId[], titleOf: (c: CourseId) => string): string[] {
  const at = new Map(ts.flatMap((t) => t.courses.map((c): [CourseId, Term] => [c, t])))
  const out: string[] = []
  for (const e of prereqs(courses, titleOf).edges) {
    const p = at.get(e.from)!.span!, q = at.get(e.to)!.span!
    if (e.rule === 'co' ? q[0] < p[0] : q[0] <= p[1]) out.push(`${e.rule} ${e.from} -> ${e.to}`)
  }
  return out
}

/** pack() with the inputs solve() would give it, for a planned course list. */
function packer(catalog: Record<CourseId, { units: number; title: string; institutionId: number }>, systems: Record<number, TermSystem>, home: TermSystem) {
  const sysOf = (c: CourseId) => systems[catalog[c].institutionId] ?? home
  const unitsOf = (c: CourseId) => { const u = catalog[c].units, f = sysOf(c); return f === home ? u : f === 'semester' ? u * 1.5 : u / 1.5 }
  const titleOf = (c: CourseId) => catalog[c]?.title ?? ''
  return { titleOf, run: (cs: CourseId[], cap: number, o: PackOptions = {}) => pack(cs, unitsOf, cap, FALL, home, titleOf, sysOf, o) }
}

describe('pack: critical path first (Round 10, C)', () => {
  // A three-course chain (PHYS 4A < 4B < 4C) and three unrelated courses, two courses per term.
  const a = agreement([['1:PHYS 4A', '1:PHYS 4B', '1:PHYS 4C'], ['1:ANTH 1'], ['1:BIOL 5'], ['1:ECON 7']],
    [['1:PHYS 4A', 5], ['1:PHYS 4B', 5], ['1:PHYS 4C', 5], ['1:ANTH 1', 5], ['1:BIOL 5', 5], ['1:ECON 7', 5]])
  const courses = Object.keys(a.catalog).sort()
  const { run } = packer(a.catalog, { 1: 'quarter' }, 'quarter')

  it('the old order needs an extra term; the chain head first does not', () => {
    // legacy: every course with no prerequisite first, so ANTH and BIOL take the first term and PHYS 4A waits a term
    const old = run(courses, 10, { order: 'legacy' })
    expect(old.map((t) => t.courses)).toEqual([['1:ANTH 1', '1:BIOL 5'], ['1:ECON 7', '1:PHYS 4A'], ['1:PHYS 4B'], ['1:PHYS 4C']])
    const p = solve(new Set(), a, { allowed: [1], unitCap: 10, startTerm: FALL, termSystem: 'quarter', unitSystems: { 1: 'quarter' } })
    expect(p.terms.map((t) => t.name)).toEqual(['Fall 2026', 'Winter 2027', 'Spring 2027'])
    expect(p.terms[0].courses).toContain('1:PHYS 4A')
    expect(p.terms[1].courses).toContain('1:PHYS 4B')
    expect(p.terms[2].courses).toContain('1:PHYS 4C')
    expect(p.terms.every((t) => t.units <= 10)).toBe(true)
  })

  it('chains are measured in time: two semesters outrank two quarters (quarter home, mixed calendars)', () => {
    // SS runs on semesters (Fall = 1 period, Spring = 2), QQ on quarters; one 6-unit course fits per period.
    const m = agreement([['1:QQ 1A', '1:QQ 1B'], ['2:SS 1A', '2:SS 1B']], [['1:QQ 1A', 6], ['1:QQ 1B', 6], ['2:SS 1A', 4], ['2:SS 1B', 4]])
    const k = packer(m.catalog, { 1: 'quarter', 2: 'semester' }, 'quarter')
    const cs = Object.keys(m.catalog).sort()
    // counting terms, the chains tie and the old order starts QQ (first id): SS 1B then lands in Spring 2028
    const old = k.run(cs, 6, { order: 'legacy' })
    expect(old.at(-1)!.courses).toEqual(['2:SS 1B'])
    expect(old.at(-1)!.name).toBe('Spring 2028 (semester)')
    // in time, the semester chain is longer (3 periods to 2): it starts first, QQ fits in Winter and Spring, and the
    // plan ends in Fall 2027
    const p = k.run(cs, 6)
    expect(p.map((t) => [t.name, t.courses])).toEqual([['Fall 2026 (semester)', ['2:SS 1A']], ['Winter 2027 (quarter)', ['1:QQ 1A']],
      ['Spring 2027 (quarter)', ['1:QQ 1B']], ['Fall 2027 (semester)', ['2:SS 1B']]])
    expect(lengthOf(p)[0]).toBeLessThan(lengthOf(old)[0])
  })

  it('a lab still shares its lecture\'s term, and the cap and start term hold', () => {
    const l = agreement([['1:PHYS 4A', '1:PHYS 4AL', '1:PHYS 4B', '1:PHYS 4C'], ['1:ANTH 1'], ['1:BIOL 5']], [
      ['1:PHYS 4A', 4, 'Mechanics'], ['1:PHYS 4AL', 1, 'Mechanics Lab'], ['1:PHYS 4B', 5], ['1:PHYS 4C', 5], ['1:ANTH 1', 5], ['1:BIOL 5', 5]])
    const k = packer(l.catalog, { 1: 'quarter' }, 'quarter')
    const cs = Object.keys(l.catalog).sort()
    for (const cap of [5, 6, 10, 16]) {
      const p = k.run(cs, cap)
      const termOf = (c: string) => p.findIndex((t) => t.courses.includes(c))
      expect(termOf('1:PHYS 4AL')).toBe(termOf('1:PHYS 4A'))
      expect(p[0].name).toBe('Fall 2026')
      expect(p.every((t) => t.units <= cap)).toBe(true)
      expect(violations(p, cs, k.titleOf)).toEqual([])
    }
  })

  it('is deterministic', () => {
    expect(run(courses, 10)).toEqual(run(courses, 10))
  })
})

/* ---- property: never longer than the old order, never a prerequisite out of order ---- */

/** Seeded PRNG (mulberry32), so a failure reproduces. */
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'omega', 'sigma']

/** Random plan: letter chains (with labs) at 1-3 colleges of random calendars, plus loose courses. */
function randomCase(seed: number) {
  const r = rng(seed), pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)]
  const colleges = Array.from({ length: 1 + Math.floor(r() * 3) }, (_, i) => i + 1)
  const systems = Object.fromEntries(colleges.map((c) => [c, r() < 0.5 ? 'quarter' : 'semester'])) as Record<number, TermSystem>
  const home: TermSystem = r() < 0.5 ? 'quarter' : 'semester'
  const catalog: Record<CourseId, { units: number; title: string; institutionId: number }> = {}
  const add = (inst: number, code: string, units: number, title: string) => { catalog[`${inst}:${code}`] = { units, title, institutionId: inst } }
  const chains = 1 + Math.floor(r() * 4)
  for (let k = 0; k < chains; k++) {
    const inst = pick(colleges), prefix = `S${String.fromCharCode(65 + k)}`, len = 1 + Math.floor(r() * 4), w = pick(WORDS)
    for (let j = 0; j < len; j++) {
      const code = `${prefix} 1${String.fromCharCode(65 + j)}`
      add(inst, code, 1 + Math.floor(r() * 6), `Subject ${w} part ${WORDS[j]}`)
      if (r() < 0.2) add(inst, `${code}L`, 1 + Math.floor(r() * 2), `Subject ${w} part ${WORDS[j]} Lab`)
    }
  }
  const loose = Math.floor(r() * 5)
  for (let k = 0; k < loose; k++) add(pick(colleges), `L${String.fromCharCode(65 + k)} ${10 + k}`, 1 + Math.floor(r() * 6), `Loose ${WORDS[k % WORDS.length]}`)
  const cap = pick([4, 5, 6, 8, 10, 12, 16])
  return { catalog, systems, home, cap, courses: Object.keys(catalog).sort() }
}

describe('pack: never longer than the old order, prerequisites always hold (Round 10, C)', () => {
  it('random plans (quarter, semester and mixed calendars)', () => {
    let shorter = 0
    for (let seed = 1; seed <= 1500; seed++) {
      const c = randomCase(seed), k = packer(c.catalog, c.systems, c.home)
      const now = k.run(c.courses, c.cap), old = k.run(c.courses, c.cap, { order: 'legacy' })
      expect(notLonger(now, old), `seed ${seed}`).toBe(true)
      expect(violations(now, c.courses, k.titleOf), `seed ${seed}`).toEqual([])
      expect(now.flatMap((t) => t.courses).sort(), `seed ${seed}`).toEqual(c.courses)
      if (!notLonger(old, now)) shorter++
    }
    expect(shorter).toBeGreaterThan(0)
  }, 60_000)

  // (every agreement with all 15 colleges is in pack.golden.test.ts, which needs no solving)
  it('real plans: every agreement, quarter and semester homes, default and low caps', () => {
    const files = import.meta.glob('../../data/agreements/*.json', { eager: true, import: 'default' }) as Record<string, Agreement>
    let checked = 0
    for (const a of Object.values(files)) for (const [home, allowed] of [[113, [113, 51]], [137, [137, 51]]] as [number, number[]][]) {
      const sys = unitSystems[home]
      for (const cap of sys === 'quarter' ? [16, 10] : [12, 7]) {
        const p = solve(new Set(), a, { allowed, home, termSystem: sys, unitSystems, unitCap: cap, startTerm: FALL })
        const cs = p.terms.flatMap((t) => t.courses).sort()
        const k = packer(a.catalog, unitSystems, sys)
        const old = k.run(cs, cap, { order: 'legacy' })
        expect(p.terms).toEqual(k.run(cs, cap))
        expect(notLonger(p.terms, old), `${a.major} home ${home} cap ${cap}`).toBe(true)
        expect(violations(p.terms, cs, k.titleOf), `${a.major} home ${home} cap ${cap}`).toEqual([])
        checked++
      }
    }
    expect(checked).toBe(Object.keys(files).length * 4)
  }, 60_000)
})
