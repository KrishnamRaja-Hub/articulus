import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import me from '../../data/agreements/79-mechanical-engineering-b-s.json'
import institutions from '../../data/institutions.json'
import type { Agreement, Course, Institution, Plan, ReqNode, Requirement } from './types'
import { solve } from './solve'

/** "Prefer home college" (SolveOptions.preferHome): home courses for every requirement home can cover; another
 *  college only where home has no articulated course, and then the plan says so in plain words. */

const DA = 113, FH = 51, SM = 137 // De Anza (home), Foothill, Santa Monica
const ME = me as unknown as Agreement
const unitSystems = Object.fromEntries((institutions as Institution[]).map((i) => [i.id, i.terms]))

const catalog = (courses: [string, number][]) => Object.fromEntries(courses.map(([id, units]): [string, Course] => {
  const [inst, rest] = id.split(':'); const [prefix, number] = rest.split(' ')
  return [id, { id, institutionId: +inst, prefix, number, title: `Course ${prefix}${number}`, units }]
}))
const req = (id: string, groups: string[][]): Requirement =>
  ({ kind: 'req', id, label: id, units: 4, groups: groups.map((courses) => ({ institutionId: +courses[0].split(':')[0], courses })) })
const and = (...children: (ReqNode | Requirement)[]): ReqNode => ({ kind: 'node', type: 'AND', required: true, children })
const or = (...children: (ReqNode | Requirement)[]): ReqNode => ({ kind: 'node', type: 'OR', required: true, children })
const agreement = (root: ReqNode, courses: [string, number][]): Agreement =>
  ({ receivingId: 79, major: 'T', year: 'x', sendingIds: [DA, FH, SM], root, catalog: catalog(courses) })
const planned = (p: Plan) => p.terms.flatMap((t) => t.courses).sort()
const colleges = (p: Plan) => [...new Set(planned(p).map((c) => Number(c.split(':')[0])))].sort()
const HOME = { allowed: [DA, FH], home: DA, preferHome: true }

describe('solve: prefer home college', () => {
  // MATH 1A: De Anza 5 units, Foothill 3 units. MATH 1C: Foothill only.
  const both = agreement(and(req('MATH 1', [[`${DA}:MATH 1A`], [`${FH}:MATH 1A`]])), [[`${DA}:MATH 1A`, 5], [`${FH}:MATH 1A`, 3]])

  it('home course wins when both colleges articulate the requirement, even when the other is cheaper', () => {
    // pure units would take Foothill's 3-unit course
    expect(planned(solve(new Set(), both, { allowed: [DA, FH], home: DA, collegePenalty: 0, chainPenalty: 0 }))).toEqual([`${FH}:MATH 1A`])
    for (const extra of [{}, { collegePenalty: 0, chainPenalty: 0 }]) {
      const p = solve(new Set(), both, { ...HOME, ...extra })
      expect(planned(p)).toEqual([`${DA}:MATH 1A`])
      expect(p.chosen['MATH 1'].institutionId).toBe(DA)
      expect(p.fallbacks).toBeUndefined()
    }
  })

  it('uses another college only for the requirement home has no articulated course for, and labels it', () => {
    const a = agreement(and(req('MATH 1', [[`${DA}:MATH 1A`], [`${FH}:MATH 1A`]]), req('MATH 3', [[`${FH}:MATH 1C`]])),
      [[`${DA}:MATH 1A`, 5], [`${FH}:MATH 1A`, 3], [`${FH}:MATH 1C`, 5]])
    const p = solve(new Set(), a, HOME)
    // Foothill is in the plan anyway (for MATH 3), yet MATH 1 still stays at De Anza
    expect(planned(p)).toEqual([`${FH}:MATH 1C`, `${DA}:MATH 1A`].sort())
    expect(p.unsolvable).toEqual([])
    expect(p.fallbacks).toEqual([{ requirementIds: ['MATH 3'], institutionId: FH, courses: [`${FH}:MATH 1C`], reason: 'not-at-home',
      note: 'Not offered at De Anza; take MATH 1C at Foothill.' }])
  })

  it('a home college that covers everything uses no other college, even through a cheaper OR alternative', () => {
    // OR: PHYS at De Anza (3 x 5 units) or ENGR at Foothill (1 x 2 units); CHEM at both
    const a = agreement(and(
      or(req('PHYS', [[`${DA}:PHYS 4A`, `${DA}:PHYS 4B`, `${DA}:PHYS 4C`]]), req('ENGR', [[`${FH}:ENGR 10`]])),
      req('CHEM', [[`${DA}:CHEM 1A`], [`${FH}:CHEM 1A`]]),
    ), [[`${DA}:PHYS 4A`, 5], [`${DA}:PHYS 4B`, 5], [`${DA}:PHYS 4C`, 5], [`${FH}:ENGR 10`, 2], [`${DA}:CHEM 1A`, 5], [`${FH}:CHEM 1A`, 4]])
    expect(colleges(solve(new Set(), a, { allowed: [DA, FH], home: DA }))).toContain(FH) // the cost rule alone leaves home
    const p = solve(new Set(), a, HOME)
    expect(colleges(p)).toEqual([DA])
    expect(p.result.isValid).toBe(true)
    expect(p.fallbacks).toBeUndefined()
  })

  it('never falls back to a college the student did not select', () => {
    const a = agreement(and(req('MATH 1', [[`${DA}:MATH 1A`]]), req('BIO', [[`${SM}:BIO 1`]])), [[`${DA}:MATH 1A`, 5], [`${SM}:BIO 1`, 4]])
    const p = solve(new Set(), a, HOME)
    expect(planned(p)).toEqual([`${DA}:MATH 1A`])
    expect(p.unsolvable).toEqual(['BIO — offered at Santa Monica'])
    expect(p.fallbacks).toBeUndefined()
  })

  it('finishes a series the student already started elsewhere instead of retaking it at home, and says so', () => {
    const a = agreement(and(req('CALC', [[`${DA}:MATH 1A`, `${DA}:MATH 1B`], [`${FH}:MATH 1A`, `${FH}:MATH 1B`]])),
      [[`${DA}:MATH 1A`, 5], [`${DA}:MATH 1B`, 5], [`${FH}:MATH 1A`, 5], [`${FH}:MATH 1B`, 5]])
    const p = solve(new Set([`${FH}:MATH 1A`]), a, HOME)
    expect(planned(p)).toEqual([`${FH}:MATH 1B`])
    expect(p.result.splitSeriesViolations).toEqual([])
    expect(p.fallbacks?.map((f) => [f.reason, f.note])).toEqual([['started', 'Finish the series you started at Foothill: take MATH 1B at Foothill.']])
  })

  it('is off by default and ignored when home is not an allowed college', () => {
    expect(planned(solve(new Set(), both, { allowed: [DA, FH], home: DA, collegePenalty: 0, chainPenalty: 0, preferHome: false }))).toEqual([`${FH}:MATH 1A`])
    expect(planned(solve(new Set(), both, { allowed: [FH], home: DA, preferHome: true }))).toEqual([`${FH}:MATH 1A`])
  })

  it('real agreement (Berkeley ME, De Anza + Foothill): every Foothill course is a labeled fallback home cannot cover', () => {
    const opts = { ...HOME, termSystem: 'quarter' as const, unitSystems, startTerm: { season: 'Fall' as const, year: 2026 } }
    const p = solve(new Set(), ME, opts)
    expect(p.result.splitSeriesViolations.filter((v) => v.blocking)).toEqual([])
    const away = planned(p).filter((c) => !c.startsWith(`${DA}:`))
    const labeled = (p.fallbacks ?? []).flatMap((f) => f.courses)
    expect(labeled.sort()).toEqual(away) // every course away from home is in the box, once
    for (const f of p.fallbacks ?? []) expect(f.note).toMatch(/ at Foothill\./)
    // the same plan with De Anza alone never has more requirements met than with the fallback
    expect(Object.keys(p.result.satisfied).length).toBeGreaterThanOrEqual(Object.keys(solve(new Set(), ME, { ...opts, allowed: [DA] }).result.satisfied).length)
  })

  /* ---- regressions (tester round 1) ---- */

  it('F1: a course already taken at a college the student did not select still counts; nothing is retaken at home', () => {
    const a = agreement(and(req('MATH 1', [[`${DA}:MATH 1A`], [`${SM}:MATH 1A`]])), [[`${DA}:MATH 1A`, 5], [`${SM}:MATH 1A`, 5]])
    const p = solve(new Set([`${SM}:MATH 1A`]), a, HOME)
    expect(planned(p)).toEqual([])
    expect(p.result.isValid).toBe(true)
  })

  it('F1: real UCLA CS with ENGL 1D and MATH 7 taken at Santa Monica (not selected) costs no more units than without the setting', () => {
    const ucla = JSON.parse(readFileSync('data/agreements/117-computer-science-b-s.json', 'utf8')) as Agreement
    const taken = new Set([`${SM}:ENGL 1D`, `${SM}:MATH 7`])
    const base = { allowed: [DA, FH], home: DA, termSystem: 'quarter' as const, unitSystems, startTerm: { season: 'Fall' as const, year: 2026 } }
    const on = solve(taken, ucla, { ...base, preferHome: true }), off = solve(taken, ucla, base)
    expect(on.totalUnits).toBeLessThanOrEqual(off.totalUnits)
    expect(planned(on)).not.toContain(`${DA}:ENGL C1000`)
  })

  it('F2: when home cannot finish a series, the whole series comes from the college that can (no course taken twice)', () => {
    // PHYS 2A-2C at home or De Anza; PHYS 2D only at De Anza, whose PHYS 4D needs 4A-4C there
    const a = agreement(and(
      req('PHYS 2A', [[`${FH}:PHYS 4A`], [`${DA}:PHYS 4A`]]), req('PHYS 2B', [[`${FH}:PHYS 4B`], [`${DA}:PHYS 4B`]]),
      req('PHYS 2C', [[`${FH}:PHYS 4C`], [`${DA}:PHYS 4C`]]), req('PHYS 2D', [[`${DA}:PHYS 4D`]]),
    ), [[`${FH}:PHYS 4A`, 5], [`${FH}:PHYS 4B`, 5], [`${FH}:PHYS 4C`, 5], [`${DA}:PHYS 4A`, 5], [`${DA}:PHYS 4B`, 5], [`${DA}:PHYS 4C`, 5], [`${DA}:PHYS 4D`, 5]])
    // titles that do not match across colleges: no home course stands in for a De Anza prerequisite
    ;(['A', 'B', 'C'] as const).forEach((x, i) => { a.catalog[`${FH}:PHYS 4${x}`].title = ['Mechanics', 'Electricity', 'Waves'][i] })
    const p = solve(new Set(), a, { allowed: [FH, DA], home: FH, preferHome: true })
    expect(planned(p)).toEqual([`${DA}:PHYS 4A`, `${DA}:PHYS 4B`, `${DA}:PHYS 4C`, `${DA}:PHYS 4D`])
    expect(p.fallbacks?.map((f) => f.note)).toEqual([
      'Not offered at Foothill; take PHYS 4D at De Anza.',
      'Foothill cannot finish this series (it has no course for PHYS 2D); take PHYS 4A + PHYS 4B + PHYS 4C at De Anza.',
    ])
  })

  it('F2: a prerequisite a home course stands in for is not pulled away from home', () => {
    const a = agreement(and(req('PHYS 2A', [[`${FH}:PHYS 4A`], [`${DA}:PHYS 4A`]]), req('PHYS 2B', [[`${DA}:PHYS 4B`]])),
      [[`${FH}:PHYS 4A`, 5], [`${DA}:PHYS 4A`, 5], [`${DA}:PHYS 4B`, 5]]) // same titles: Foothill 4A covers De Anza 4B's prerequisite
    const p = solve(new Set(), a, { allowed: [FH, DA], home: FH, preferHome: true })
    expect(planned(p)).toEqual([`${DA}:PHYS 4B`, `${FH}:PHYS 4A`])
  })

  it('F2: real UCSD ECE, home Irvine Valley + De Anza: no physics course taken twice', () => {
    const ece = JSON.parse(readFileSync('data/agreements/7-ece-electrical-engineering-b-s.json', 'utf8')) as Agreement
    const p = solve(new Set(), ece, { allowed: [124, DA], home: 124, preferHome: true, termSystem: 'semester', unitSystems, startTerm: { season: 'Fall', year: 2026 } })
    const phys = planned(p).filter((c) => c.split(':')[1].startsWith('PHYS '))
    const level = phys.map((c) => c.split(':')[1])
    expect(new Set(level).size).toBe(level.length) // PHYS 4B at both colleges was the bug
    expect(phys).toContain(`${DA}:PHYS 4D`)
    expect(p.totalUnits).toBeLessThan(53)
  })

  it('F3: among colleges for a requirement home cannot cover, the fewest units win (not the fewest courses)', () => {
    const a = agreement(and(req('B', [[`${FH}:B 1`, `${FH}:B 2`], [`${SM}:B 9`]])), [[`${FH}:B 1`, 2], [`${FH}:B 2`, 2], [`${SM}:B 9`, 10]])
    const p = solve(new Set(), a, { allowed: [DA, FH, SM], home: DA, preferHome: true })
    expect(planned(p)).toEqual([`${FH}:B 1`, `${FH}:B 2`])
    expect(p.fallbacks?.[0].note).toBe('Not offered at De Anza; take B 1 + B 2 at Foothill.')
  })

  it('F4: home articulates the course but its course data is missing: says so instead of "Not offered"', () => {
    const a = agreement(and(req('MATH 1', [[`${DA}:MATH 1A`], [`${FH}:MATH 1A`]])), [[`${FH}:MATH 1A`, 5]])
    const p = solve(new Set(), a, HOME)
    expect(p.fallbacks?.map((f) => [f.reason, f.note])).toEqual([['no-data', 'Course details for De Anza are missing; take MATH 1A at Foothill.']])
  })

  it('F5: a prerequisite planned away from home is listed with its reason; a course serving two requirements is listed once', () => {
    // Foothill ENGR 2 (only there) needs ENGR 1 there; ENGR 2 also covers ROW Y, which home covers too
    const a = agreement(and(req('X', [[`${FH}:ENGR 2`]]), req('Y', [[`${DA}:ENGR 5`], [`${FH}:ENGR 2`]])),
      [[`${FH}:ENGR 1`, 4], [`${FH}:ENGR 2`, 4], [`${DA}:ENGR 5`, 4]])
    a.catalog[`${FH}:ENGR 1`].title = 'Engineering I'; a.catalog[`${FH}:ENGR 2`].title = 'Engineering II'
    const p = solve(new Set(), a, HOME)
    expect(planned(p)).toEqual([`${FH}:ENGR 1`, `${FH}:ENGR 2`])
    expect(p.fallbacks?.map((f) => [f.requirementIds, f.courses, f.note])).toEqual([
      [['X', 'Y'], [`${FH}:ENGR 2`], 'Not offered at De Anza; take ENGR 2 at Foothill. ENGR 2 also counts for Y.'],
      [[], [`${FH}:ENGR 1`], 'Prerequisite for ENGR 2 at Foothill; take ENGR 1 at Foothill.'],
    ])
  })

  /* ---- regressions (tester round 2): series pulls ---- */

  // De Anza PHYS 4A 15 units, Foothill 4A 2 units; Foothill 4B (needs Foothill 4A) is Foothill's only course for Y
  const titled = (a: Agreement, titles: Record<string, string>) => { for (const [c, t] of Object.entries(titles)) a.catalog[c].title = t; return a }
  const B = (root: ReqNode, more: [string, number][] = []) => titled(agreement(root,
    [[`${DA}:PHYS 4A`, 15], [`${FH}:PHYS 4A`, 2], [`${FH}:PHYS 4B`, 10], [`${SM}:PHYS 2`, 1], ...more]),
  { [`${DA}:PHYS 4A`]: 'Mechanics', [`${FH}:PHYS 4A`]: 'Kinetics', [`${FH}:PHYS 4B`]: 'Kinetics', [`${SM}:PHYS 2`]: 'Waves' })
  const X = req('X 1', [[`${DA}:PHYS 4A`], [`${FH}:PHYS 4A`]])

  it('B1: a row home covers goes back home when the row that pulled it away is planned at a third college', () => {
    const a = B(and(X, req('Y 1', [[`${FH}:PHYS 4B`], [`${SM}:PHYS 2`]])))
    a.catalog[`${FH}:PHYS 4B`].units = 30 // Foothill 4A + 4B (32) now costs more than De Anza 4A + Santa Monica PHYS 2 (16)
    const p = solve(new Set(), a, { allowed: [DA, FH, SM], home: DA, preferHome: true })
    expect(planned(p)).toEqual([`${DA}:PHYS 4A`, `${SM}:PHYS 2`])
    expect(p.fallbacks?.map((f) => f.note)).toEqual(['Not offered at De Anza; take PHYS 2 at Santa Monica.'])
  })

  it('R1: dropping a series pull does not lose the cheaper plan with both rows at the series college', () => {
    const a = B(and(X, req('Y 1', [[`${FH}:PHYS 4B`], [`${SM}:PHYS 2`]])))
    for (const extra of [{}, { collegePenalty: 0, chainPenalty: 0 }]) for (const allowed of [[DA, FH], [DA, FH, SM]]) {
      const p = solve(new Set(), a, { allowed, home: DA, preferHome: true, ...extra })
      expect(planned(p)).toEqual([`${FH}:PHYS 4A`, `${FH}:PHYS 4B`])
      expect(p.totalUnits).toBe(12)
      expect(p.fallbacks?.map((f) => f.note)).toEqual([
        'Not offered at De Anza; take PHYS 4B at Foothill.',
        'De Anza cannot finish this series (it has no course for Y 1); take PHYS 4A at Foothill.',
      ])
    }
  })

  it('candidates share one time limit: an exhausted limit still returns the first finished plan', () => {
    const p = solve(new Set(), B(and(X, req('Y 1', [[`${FH}:PHYS 4B`], [`${SM}:PHYS 2`]]))), { allowed: [DA, FH, SM], home: DA, preferHome: true, timeLimitMs: 0 })
    expect(p.result.isValid).toBe(true)
  })

  it('K1: two or three idle series at once, and a tiny time limit: never a plan with a false series note', () => {
    const subjects = ['PHYS', 'CHEM', 'BIOL']
    const kit = (n: number) => {
      const s = subjects.slice(0, n), rows = s.flatMap((x, i) => [
        req(`X${i} 1`, [[`${DA}:${x} 4A`], [`${FH}:${x} 4A`]]), req(`Y${i} 1`, [[`${FH}:${x} 4B`], [`${SM}:${x}Z 2`]])])
      const a = agreement(and(...rows), s.flatMap((x): [string, number][] => [[`${DA}:${x} 4A`, 15], [`${FH}:${x} 4A`, 2], [`${FH}:${x} 4B`, 10], [`${SM}:${x}Z 2`, 1]]))
      return titled(a, Object.fromEntries(s.flatMap((x) => [[`${DA}:${x} 4A`, `Mech ${x}`], [`${FH}:${x} 4A`, `Kin ${x}`], [`${FH}:${x} 4B`, `Kin ${x}`], [`${SM}:${x}Z 2`, `Wave ${x}`]])))
    }
    /** Every row planned away from home that home covers is met together with the row that pulled it there. */
    const honest = (p: Plan, n: number) => {
      for (let i = 0; i < n; i++) if (p.chosen[`X${i} 1`]?.institutionId === FH) expect(p.chosen[`Y${i} 1`]?.institutionId).toBe(FH)
      for (const f of p.fallbacks ?? []) expect(f.note).not.toMatch(/a later requirement/)
    }
    for (const n of [1, 2, 3]) {
      const a = kit(n)
      for (const extra of [{}, { collegePenalty: 0, chainPenalty: 0 }]) {
        const p = solve(new Set(), a, { allowed: [DA, FH, SM], home: DA, preferHome: true, ...extra })
        honest(p, n)
        expect(p.totalUnits).toBe(12 * n) // every pair at Foothill: the cheapest valid plan
      }
      for (const timeLimitMs of [0, 1]) {
        const p = solve(new Set(), a, { allowed: [DA, FH, SM], home: DA, preferHome: true, timeLimitMs })
        honest(p, n)
        // a starved search may stop before the plan is complete (the slot search honours timeLimitMs): then it fails
        // closed, naming every requirement still missing, never a false green
        if (!p.result.isValid) for (const m of p.result.missing) expect(p.unsolvable.some((u) => u === m || u.startsWith(`${m} (`))).toBe(true)
      }
    }
  })

  const PSE = 'Physics for Scientists and Engineers: '
  const physics = (more: [string, number][]) => (root: ReqNode) => titled(agreement(root, [
    [`124:PHYS 4A`, 5], [`124:PHYS 4B`, 5], [`124:PHYS 4C`, 5], [`${DA}:PHYS 4A`, 5], [`${DA}:PHYS 4B`, 5], [`${DA}:PHYS 4C`, 5], [`${DA}:PHYS 4D`, 5], [`${SM}:PHYS 9`, 8], ...more]),
  { '124:PHYS 4A': PSE + 'Mechanics', '124:PHYS 4B': PSE + 'Electricity and Magnetism', '124:PHYS 4C': PSE + 'Waves',
    [`${DA}:PHYS 4A`]: PSE + 'Mechanics', [`${DA}:PHYS 4B`]: PSE + 'Electricity and Magnetism', [`${DA}:PHYS 4C`]: PSE + 'Waves',
    [`${DA}:PHYS 4D`]: PSE + 'Modern Physics', [`${SM}:PHYS 9`]: 'Modern Physics Survey' })
  const P2D = req('P 2D', [[`${DA}:PHYS 4D`], [`${SM}:PHYS 9`]])
  const IVH = { allowed: [124, DA, SM], home: 124, preferHome: true }

  it('R2: a prerequisite whose home stand-in is never planned is priced in full (Santa Monica PHYS 9, 8 units, not De Anza 4A-4D)', () => {
    const optional: ReqNode = { kind: 'node', type: 'AND', required: false, children: [req('OPT', [['124:PHYS 4A', '124:PHYS 4B', '124:PHYS 4C']])] }
    const p = solve(new Set(), physics([])(and(P2D, optional)), IVH)
    expect(planned(p)).toEqual([`${SM}:PHYS 9`])
    expect(p.totalUnits).toBe(8)
  })

  it('R3: the stand-in only partly planned: the finished plan with the lowest real cost wins, prerequisites included', () => {
    // ALT A (Irvine Valley PHYS 4C) is home's route through the OR, and needs PHYS 4A + 4B first. Santa Monica PHYS 9
    // would cost 4C + 4A + 4B at Irvine Valley + PHYS 9 = 23 units; De Anza 4D, whose 4A + 4B also serve Irvine
    // Valley 4C, costs 20.
    const a = physics([[`${SM}:Q 1`, 1]])(and(P2D, or(req('ALT A', [['124:PHYS 4C']]), req('ALT B', [[`${SM}:Q 1`]]))))
    const p = solve(new Set(), a, IVH)
    expect(p.totalUnits).toBe(20)
    expect(planned(p)).toContain('124:PHYS 4C')
    expect(planned(p)).toContain(`${DA}:PHYS 4D`)
    expect(p.totalUnits).toBeLessThan(solve(new Set(), a, { ...IVH, allowed: [124, SM] }).totalUnits)
  })

  it('B2: a row the OR cut removes (home completes the other alternative) pulls nothing away', () => {
    const p = solve(new Set(), B(and(X, or(req('Y 1', [[`${FH}:PHYS 4B`]]), req('Z 1', [[`${DA}:Z 1`]]))), [[`${DA}:Z 1`, 1]]), HOME)
    expect(planned(p)).toEqual([`${DA}:PHYS 4A`, `${DA}:Z 1`])
    expect(p.fallbacks).toBeUndefined()
  })

  it('B2b: a row in an optional subtree pulls nothing away', () => {
    const optional: ReqNode = { kind: 'node', type: 'AND', required: false, children: [req('Y 1', [[`${FH}:PHYS 4B`]])] }
    const p = solve(new Set(), B(and(X, optional)), HOME)
    expect(planned(p)).toEqual([`${DA}:PHYS 4A`])
    expect(p.fallbacks).toBeUndefined()
  })

  it('B3: an away course is priced without prerequisites a home course stands in for', () => {
    const IV = 124, t = 'Physics for Scientists and Engineers: '
    const a = agreement(and(
      req('P 2A', [[`${IV}:PHYS 4A`], [`${DA}:PHYS 4A`]]), req('P 2B', [[`${IV}:PHYS 4B`], [`${DA}:PHYS 4B`]]),
      req('P 2C', [[`${IV}:PHYS 4C`], [`${DA}:PHYS 4C`]]), req('P 2D', [[`${DA}:PHYS 4D`], [`${SM}:PHYS 9`]]),
    ), [[`${IV}:PHYS 4A`, 5], [`${IV}:PHYS 4B`, 5], [`${IV}:PHYS 4C`, 5], [`${DA}:PHYS 4A`, 5], [`${DA}:PHYS 4B`, 5], [`${DA}:PHYS 4C`, 5], [`${DA}:PHYS 4D`, 5], [`${SM}:PHYS 9`, 8]])
    titled(a, { [`${IV}:PHYS 4A`]: t + 'Mechanics', [`${IV}:PHYS 4B`]: t + 'Electricity and Magnetism', [`${IV}:PHYS 4C`]: t + 'Waves',
      [`${DA}:PHYS 4A`]: t + 'Mechanics', [`${DA}:PHYS 4B`]: t + 'Electricity and Magnetism', [`${DA}:PHYS 4C`]: t + 'Waves',
      [`${DA}:PHYS 4D`]: t + 'Modern Physics', [`${SM}:PHYS 9`]: 'Modern Physics Survey' })
    const p = solve(new Set(), a, { allowed: [IV, DA, SM], home: IV, preferHome: true })
    expect(planned(p)).toEqual([`${DA}:PHYS 4D`, `${IV}:PHYS 4A`, `${IV}:PHYS 4B`, `${IV}:PHYS 4C`])
    expect(p.totalUnits).toBe(20)
  })

  it('B4-B7 stay as confirmed: home finishes the series; choose-N and OR routes; a series started at an unselected college', () => {
    const b4 = agreement(and(req('X 1', [[`${DA}:PHYS 4A`], [`${FH}:PHYS 4A`]]), req('Y 1', [[`${DA}:PHYS 4B`], [`${FH}:PHYS 4B`]])),
      [[`${DA}:PHYS 4A`, 15], [`${DA}:PHYS 4B`, 15], [`${FH}:PHYS 4A`, 2], [`${FH}:PHYS 4B`, 2]])
    expect(planned(solve(new Set(), b4, HOME))).toEqual([`${DA}:PHYS 4A`, `${DA}:PHYS 4B`])
    const b5 = agreement({ kind: 'node', type: 'N_OF', n: 2, required: true, children: [req('A 1', [[`${DA}:A 1`], [`${FH}:A 1`]]), req('B 1', [[`${FH}:B 1`]]), req('C 1', [[`${SM}:C 1`]])] },
      [[`${DA}:A 1`, 10], [`${FH}:A 1`, 1], [`${FH}:B 1`, 3], [`${SM}:C 1`, 2]])
    expect(planned(solve(new Set(), b5, { allowed: [DA, FH, SM], home: DA, preferHome: true }))).toEqual([`${DA}:A 1`, `${SM}:C 1`])
    const b6 = agreement(or(and(req('X 1', [[`${DA}:X 1`]]), req('Y 1', [[`${FH}:Y 1`]])), req('P 1', [[`${DA}:P 1`, `${DA}:P 2`]])),
      [[`${DA}:X 1`, 1], [`${FH}:Y 1`, 1], [`${DA}:P 1`, 10], [`${DA}:P 2`, 10]])
    expect(planned(solve(new Set(), b6, HOME))).toEqual([`${DA}:P 1`, `${DA}:P 2`])
    const b7 = agreement(and(req('CALC', [[`${DA}:MATH 1A`, `${DA}:MATH 1B`], [`${SM}:MATH 1A`, `${SM}:MATH 1B`]])),
      [[`${DA}:MATH 1A`, 5], [`${DA}:MATH 1B`, 5], [`${SM}:MATH 1A`, 5], [`${SM}:MATH 1B`, 5]])
    expect(planned(solve(new Set([`${SM}:MATH 1A`]), b7, HOME))).toEqual([`${DA}:MATH 1A`, `${DA}:MATH 1B`])
  })

  it('B1-B2: a series pull the plan uses names the row really planned there', () => {
    const p = solve(new Set(), B(and(X, req('Y 1', [[`${FH}:PHYS 4B`]]))), HOME)
    expect(planned(p)).toEqual([`${FH}:PHYS 4A`, `${FH}:PHYS 4B`])
    expect(p.fallbacks?.map((f) => f.note)).toEqual([
      'Not offered at De Anza; take PHYS 4B at Foothill.',
      'De Anza cannot finish this series (it has no course for Y 1); take PHYS 4A at Foothill.',
    ])
  })
})
