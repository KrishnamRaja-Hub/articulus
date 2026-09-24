import { describe, expect, it, vi } from 'vitest'
import me from '../../data/agreements/79-mechanical-engineering-b-s.json'
import mae from '../../data/agreements/7-mae-mechanical-engineering-b-s.json'
import institutions from '../../data/institutions.json'
import type { Agreement, Course, CourseId, Institution, Plan, ReqNode, Requirement } from './types'
import { solve, treeState, type SolveOptions } from './solve'
import { has, honorsColleges, malformed, reqStatus, verifySchedule } from './verify'
import { NOT_LISTED } from './normalize'

const ME = me as unknown as Agreement, MAE = mae as unknown as Agreement
const DA = 113, FH = 51, SM = 137
const unitSystems = Object.fromEntries((institutions as Institution[]).map((i) => [i.id, i.terms]))

/** Synthetic agreement: `courses` as [id, units], each requirement as a list of groups. */
const catalog = (courses: [string, number][]) => Object.fromEntries(courses.map(([id, units]): [string, Course] => {
  const [inst, rest] = id.split(':'); const [prefix, number] = rest.split(' ')
  return [id, { id, institutionId: +inst, prefix, number, title: id, units }]
}))
// A row with no groups carries an explicit ASSIST reason, as real UC-only rows do (see verify.ucOnly).
const req = (id: string, groups: string[][]): Requirement =>
  ({ kind: 'req', id, label: id, units: 4, groups: groups.map((courses) => ({ institutionId: +courses[0].split(':')[0], courses })),
    ...(groups.length ? {} : { noArticulation: { 1: 'This course must be taken at the university after transfer.' } }) })
const and = (...children: (ReqNode | Requirement)[]): ReqNode => ({ kind: 'node', type: 'AND', required: true, children })
const or = (...children: (ReqNode | Requirement)[]): ReqNode => ({ kind: 'node', type: 'OR', required: true, children })
const agreement = (root: ReqNode, courses: [string, number][], sendingIds: number[] = []): Agreement =>
  ({ receivingId: 1, major: 'T', year: 'x', sendingIds, root, catalog: catalog(courses) })
const plannedOf = (p: Plan) => p.terms.flatMap((t) => t.courses)
/** Pure minimum units: the tests of the transfer rules below predate the college and chain penalties. */
const UNITS = { collegePenalty: 0, chainPenalty: 0 }

// verify.ts with blocking / deferred (merged separately). Checks of plan.result against those rules run only then.
const NEW_VERIFY = verifySchedule(new Set(), agreement(and(req('D', [])), [])).deferred.length > 0

describe('solve: split series under the blocking rule (F-06), pure minimum units', () => {
  // Taken 2:P 2 is half of U at college 2. Planning 1:P 1 for R puts U at two colleges.
  const a = agreement(and(req('R', [['1:P 1'], ['3:Q 1']]), or(req('U', [['1:P 1', '1:P 2'], ['2:P 1', '2:P 2']]), req('V', [['3:V 1']]))),
    [['1:P 1', 3], ['1:P 2', 3], ['2:P 1', 3], ['2:P 2', 3], ['3:Q 1', 4], ['3:V 1', 1]])
  it('takes the cheaper group when the split it opens is in an unused OR alternative (a warning)', () => {
    const p = solve(new Set(['2:P 2']), a, { allowed: [1, 3], home: 1, ...UNITS })
    expect(p.chosen.R.institutionId).toBe(1)
    expect(plannedOf(p).sort()).toEqual(['1:P 1', '3:V 1'])
    expect(p.totalUnits).toBe(4)
    expect(p.unsolvable).toEqual([])
    expect(p.optimal).toBe(true)
  })
  it.runIf(NEW_VERIFY)('... and the verifier calls that split non-blocking', () => {
    const r = solve(new Set(['2:P 2']), a, { allowed: [1, 3], home: 1, ...UNITS }).result
    expect(r.splitSeriesViolations.map((v) => [v.requirementId, v.blocking])).toEqual([['U', false]])
    expect(r.isValid).toBe(true)
  })
  it('equal units: avoids opening even a non-blocking split', () => {
    const b = agreement(and(req('R', [['1:P 1'], ['3:Q 1']]), or(req('U', [['1:P 1', '1:P 2'], ['2:P 1', '2:P 2']]), req('V', [['3:V 1']]))),
      [['1:P 1', 3], ['1:P 2', 3], ['2:P 1', 3], ['2:P 2', 3], ['3:Q 1', 3], ['3:V 1', 1]])
    const p = solve(new Set(['2:P 2']), b, { allowed: [1, 3], home: 1, ...UNITS }) // home college loses to "no new split"
    expect(p.chosen.R.institutionId).toBe(3)
    expect(p.result.splitSeriesViolations).toHaveLength(0)
  })
  it('never opens a split in a requirement the agreement still needs; reports why instead', () => {
    // R1 cannot be met at college 2 (a course is missing from the catalog). 2:X 1 for R2 would split R1 against taken 1:X 2.
    const cs: [string, number][] = [['1:X 1', 3], ['1:X 2', 3], ['2:X 1', 3], ['2:Y 1', 4]]
    const r1 = req('R1', [['1:X 1', '1:X 2'], ['2:X 1', '2:GHOST 1']])
    const p = solve(new Set(['1:X 2']), agreement(and(r1, req('R2', [['2:X 1']])), cs), { allowed: [2], home: 2 })
    expect(plannedOf(p)).toEqual([])
    expect(p.unsolvable).toEqual(['R1', 'R2 (only by splitting R1)'])
    const q = solve(new Set(['1:X 2']), agreement(and(r1, req('R2', [['2:X 1'], ['2:Y 1']])), cs), { allowed: [2], home: 2 })
    expect(plannedOf(q)).toEqual(['2:Y 1'])
    expect(q.unsolvable).toEqual(['R1'])
  })
  it('Berkeley ME, Santa Monica only: the PHYSICS 7C split is in an unused N_OF alternative, so the plan stands', () => {
    // Santa Monica PHYSCS 23 (for 7A / 7B) with Foothill PHYS 4C splits PHYSICS 7C; chemistry already covers the N_OF.
    const p = solve(new Set([`${DA}:PHYS 4B`, `${FH}:PHYS 4C`]), ME, { allowed: [SM], home: SM, termSystem: 'semester', unitSystems })
    expect(p.unsolvable).toEqual([])
    expect(p.chosen['PHYSICS 7B'].institutionId).toBe(SM)
    expect(p.optimal).toBe(true)
    if (NEW_VERIFY) {
      expect(p.result.isValid).toBe(true)
      expect(p.result.splitSeriesViolations.map((v) => [v.requirementId, v.blocking])).toEqual([['PHYSICS 7C', false]])
    }
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
  it('a row listed twice with its groups in another order is one requirement', () => {
    // Z is also an alternative of the OR: completing Z passes it, so B is not part of the plan's config
    const cs: [string, number][] = [['1:X 1', 2], ['1:X 2', 3]]
    const z1 = req('Z', [['1:X 1'], ['1:X 2']]), z2 = req('Z', [['1:X 2'], ['1:X 1']]), b = req('B', [['1:X 1']])
    for (const w of [UNITS, {}]) for (const second of [z1, z2]) {
      const p = solve(new Set(), agreement(and(z1, or(b, second)), cs), { allowed: [1], home: 1, ...w })
      expect(Object.keys(p.chosen)).toEqual(['Z'])
      expect(plannedOf(p)).toEqual(['1:X 1'])
    }
  })
})

describe('solve: the same plan under every input order, real agreements, all 15 colleges', () => {
  // The independent suite's permutation: tree children, groups, the courses of each group, catalog keys, sendingIds,
  // allowed colleges and the transcript are all shuffled.
  const files = import.meta.glob('../../data/agreements/*.json', { eager: true, import: 'default' }) as Record<string, Agreement>
  const CCS = (institutions as Institution[]).filter((i) => i.isCC).map((i) => i.id)
  let s = 7
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32)
  const shuffle = <T,>(xs: readonly T[]) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] } return a }
  const perm = (n: ReqNode | Requirement): ReqNode | Requirement => n.kind === 'req'
    ? { ...n, groups: shuffle(n.groups.map((g) => ({ ...g, courses: shuffle(g.courses) }))) }
    : { ...n, children: shuffle(n.children.map(perm)) }
  const sig = (p: Plan) => ({
    terms: p.terms.map((t) => [t.name, [...t.courses].sort(), t.units]), unsolvable: p.unsolvable, total: p.totalUnits, optimal: p.optimal,
    chosen: Object.keys(p.chosen).sort().map((id) => [id, p.chosen[id].institutionId, [...p.chosen[id].courses].sort()]),
  })
  for (const [name, w] of [['pure units', UNITS], ['default weights', {}]] as const) it(`${name}: every agreement, a different home each, with and without a transcript`, () => {
    Object.values(files).forEach((a, k) => {
      const home = CCS[k % CCS.length], sys = unitSystems[home] as 'quarter' | 'semester'
      const taken = Object.keys(a.catalog).filter((c) => a.catalog[c].institutionId === CCS[(k + 3) % CCS.length] || rnd() < 0.05)
      for (const T of [[], taken]) {
        const o = { home, termSystem: sys, unitSystems, ...w }
        const p1 = solve(new Set(T), a, { ...o, allowed: CCS })
        const p2 = solve(new Set(shuffle(T)), { ...a, root: perm(a.root) as ReqNode, catalog: Object.fromEntries(shuffle(Object.entries(a.catalog))), sendingIds: shuffle(a.sendingIds) }, { ...o, allowed: shuffle(CCS) })
        expect(sig(p2), `${a.receivingId} ${a.major}, home ${home}`).toEqual(sig(p1))
      }
    })
  }, 120_000)
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

describe('solve: requirements completed after transfer (no articulation anywhere)', () => {
  const cs: [string, number][] = [['1:A 1', 3], ['1:B 1', 4]]
  it('a row with no groups and no ASSIST reason is neither deferred nor planned: it is sent to a counselor', () => {
    const unrecorded: Requirement = { kind: 'req', id: 'U', label: 'U', units: 4, groups: [], noArticulation: { 1: NOT_LISTED } }
    const a = agreement(and(req('A', [['1:A 1']]), unrecorded), [['1:A 1', 4]])
    const p = solve(new Set(), a, { allowed: [1] })
    expect(plannedOf(p)).toEqual(['1:A 1'])
    expect(p.unsolvable).toEqual(['U — no ASSIST articulation record; confirm with a counselor'])
    expect(p.result.isValid).toBe(false)
    expect(p.result.deferred).toEqual([])
  })
  it('are never planned and never unsolvable', () => {
    const p = solve(new Set(), agreement(and(req('A', [['1:A 1']]), req('D', [])), cs), { allowed: [1] })
    expect(plannedOf(p)).toEqual(['1:A 1'])
    expect(p.unsolvable).toEqual([])
  })
  it('OR: a deferred alternative does not satisfy it while an articulable one exists', () => {
    const p = solve(new Set(), agreement(and(or(req('D', []), req('B', [['1:B 1']]))), cs), { allowed: [1] })
    expect(plannedOf(p)).toEqual(['1:B 1'])
    expect(p.unsolvable).toEqual([])
  })
  it('OR of deferred alternatives only (UCSD CSE 15L / CSE 29) needs nothing', () => {
    const p = solve(new Set(), agreement(and(or(and(req('D1', [])), and(req('D2', [])))), cs), { allowed: [1] })
    expect(plannedOf(p)).toEqual([])
    expect(p.unsolvable).toEqual([])
  })
  it('N_OF: the rest may be deferred only when the articulable children cannot reach n', () => {
    const n = (k: number): ReqNode => ({ kind: 'node', type: 'N_OF', n: k, required: true, children: [req('A', [['1:A 1']]), req('B', [['1:B 1']]), req('D', [])] })
    expect(plannedOf(solve(new Set(), agreement(and(n(1)), cs), { allowed: [1] }))).toEqual(['1:A 1'])
    expect(plannedOf(solve(new Set(), agreement(and(n(2)), cs), { allowed: [1] })).sort()).toEqual(['1:A 1', '1:B 1'])
    const p = solve(new Set(), agreement(and(n(3)), cs), { allowed: [1] }) // 2 articulable + 1 deferred
    expect(plannedOf(p).sort()).toEqual(['1:A 1', '1:B 1'])
    expect(p.unsolvable).toEqual([])
  })
  it('an alternative mixing deferred and articulable rows counts as articulable (UC Davis CSE)', () => {
    const p = solve(new Set(), agreement(and(or(and(req('A', [['1:A 1']]), req('D', [])), req('B', [['1:B 1']]))), cs), { allowed: [1] })
    expect(plannedOf(p)).toEqual(['1:A 1'])
  })
  it.runIf(NEW_VERIFY)('real agreements: every plan with nothing unsolvable verifies clean', () => {
    for (const a of Object.values(import.meta.glob('../../data/agreements/*.json', { eager: true, import: 'default' })) as Agreement[]) {
      for (const allowed of [[DA], [SM, FH]]) {
        const p = solve(new Set(), a, { allowed, home: allowed[0], termSystem: unitSystems[allowed[0]], unitSystems })
        expect(p.result.isValid).toBe(p.unsolvable.length === 0)
        expect(p.result.splitSeriesViolations.filter((v) => v.blocking)).toEqual([])
      }
    }
  })
})

describe('solve: unsolvable entries say where to go', () => {
  it('names the in-scope colleges that articulate the requirement', () => {
    const a = agreement(and(req('R', [[`${DA}:A 1`], [`${FH}:A 1`]])), [[`${DA}:A 1`, 3], [`${FH}:A 1`, 3]], [DA, FH, SM])
    expect(solve(new Set(), a, { allowed: [SM], home: SM }).unsolvable).toEqual(['R — offered at De Anza, Foothill'])
  })
  it('an OR that cannot be completed: nothing planned toward it, one entry naming the alternatives', () => {
    const a = agreement(and(or(and(req('A', [['1:A 1']]), req('B', [[`${DA}:B 1`]])), req('C', [[`${FH}:C 1`]]))),
      [['1:A 1', 3], [`${DA}:B 1`, 3], [`${FH}:C 1`, 3]], [DA, FH])
    const p = solve(new Set(), a, { allowed: [1], home: 1 })
    expect(plannedOf(p)).toEqual([])
    expect(p.unsolvable).toEqual(['1 of: (A + B), C — offered at De Anza, Foothill'])
  })
  it('real agreement: Berkeley ME at Santa Monica alone', () => {
    const p = solve(new Set(), ME, { allowed: [SM], home: SM, termSystem: 'semester', unitSystems })
    for (const u of p.unsolvable) expect(u).toMatch(/ — offered at [A-Z]/)
  })
})

describe('solve: exact minimum units', () => {
  it('one 5-unit course covering both requirements beats 3 + 3 (S01)', () => {
    const a = agreement(and(req('R1', [['1:A 1'], ['1:C 1']]), req('R2', [['1:B 1'], ['1:C 1']])), [['1:A 1', 3], ['1:B 1', 3], ['1:C 1', 5]])
    const p = solve(new Set(), a, { allowed: [1], home: 1 })
    expect(plannedOf(p)).toEqual(['1:C 1'])
    expect(p.totalUnits).toBe(5)
    expect(p.optimal).toBe(true)
  })
  it('a shared series across requirements counts once (De Anza MATH 1B for MATH 51 and 52)', () => {
    const p = solve(new Set(), ME, { allowed: [DA], home: DA })
    expect(plannedOf(p).filter((c) => c === `${DA}:MATH 1B`)).toHaveLength(1)
    expect(p.chosen['MATH 51'].courses).toContain(`${DA}:MATH 1B`)
    expect(p.chosen['MATH 52'].courses).toContain(`${DA}:MATH 1B`)
  })
  it('budget exhausted: falls back to greedy, flagged not optimal, never better than the exact plan', () => {
    for (const a of [ME, MAE]) for (const w of [UNITS, {}]) {
      const o: SolveOptions = { allowed: [DA, FH, SM], home: DA, unitSystems, ...w }
      const x = solve(new Set(), a, o), g = solve(new Set(), a, { ...o, budget: 0 })
      expect(x.optimal).toBe(true)
      expect(g.optimal).toBe(false)
      expect(x.unsolvable.length).toBeLessThanOrEqual(g.unsolvable.length)
      const cost = (p: Plan) => p.totalUnits + (w === UNITS ? 0 : 5 * penalties(a, new Set(), plannedOf(p), DA))
      if (x.unsolvable.length === g.unsolvable.length) expect(cost(x)).toBeLessThanOrEqual(cost(g) + 0.5) // totals round to 0.5
    }
  })
  it('time limit (M-4): past the deadline, returns the best plan found, never claimed optimal', () => {
    for (const a of [ME, MAE]) for (const w of [UNITS, {}]) {
      const o: SolveOptions = { allowed: [DA, FH, SM], home: DA, unitSystems, ...w }
      const x = solve(new Set(), a, o)
      expect(solve(new Set(), a, { ...o, timeLimitMs: 60_000 })).toEqual(x) // a generous limit changes nothing
      // every clock read jumps 1 s: the deadline has passed at the first search node
      let t = Date.now()
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => (t += 1000))
      try {
        const g = solve(new Set(), a, { ...o, timeLimitMs: 100 })
        expect(g.optimal).toBe(false)
        expect(x.unsolvable.length).toBeLessThanOrEqual(g.unsolvable.length)
        expect(plannedOf(g).length).toBeGreaterThan(0)
      } finally { clock.mockRestore() }
    }
  })
})


describe('solve: stays at home and keeps a subject chain at one college (MED-4)', () => {
  it('home alone can finish: a course elsewhere must save more units than a college costs', () => {
    const a = agreement(and(req('R', [['1:A 1'], ['2:A 1']])), [['1:A 1', 5], ['2:A 1', 3]])
    expect(plannedOf(solve(new Set(), a, { allowed: [1, 2], home: 1 }))).toEqual(['1:A 1']) // 2 units saved < 5
    expect(plannedOf(solve(new Set(), a, { allowed: [1, 2], home: 1, ...UNITS }))).toEqual(['2:A 1'])
    const b = agreement(and(req('R', [['1:A 1'], ['2:A 1']])), [['1:A 1', 9], ['2:A 1', 3]])
    expect(plannedOf(solve(new Set(), b, { allowed: [1, 2], home: 1 }))).toEqual(['2:A 1']) // 6 units saved > 5
  })
  it('each college costs once: courses gather at one college', () => {
    // A and B are different subjects (no chain). Cheapest per row: A at 2, B at 3 (6 units, two colleges).
    const a = agreement(and(req('A 1', [['2:A 1'], ['3:A 1']]), req('B 1', [['2:B 1'], ['3:B 1']])),
      [['2:A 1', 3], ['3:A 1', 4], ['2:B 1', 5], ['3:B 1', 3]])
    expect(plannedOf(solve(new Set(), a, { allowed: [1, 2, 3], home: 1 })).sort()).toEqual(['3:A 1', '3:B 1'])
    expect(plannedOf(solve(new Set(), a, { allowed: [1, 2, 3], home: 1, ...UNITS })).sort()).toEqual(['2:A 1', '3:B 1'])
  })
  it('a subject chain (MATH 1, MATH 2) stays at one college, counting where the student took its first part', () => {
    const cs: [string, number][] = [['2:M 1', 3], ['3:M 1', 4], ['2:M 2', 5], ['3:M 2', 3]]
    const a = agreement(and(req('MATH 1', [['2:M 1'], ['3:M 1']]), req('MATH 2', [['2:M 2'], ['3:M 2']])), cs)
    const chainOnly = { allowed: [1, 2, 3], home: 1, collegePenalty: 0 }
    expect(plannedOf(solve(new Set(), a, chainOnly)).sort()).toEqual(['3:M 1', '3:M 2']) // 7 < 6 + 5
    expect(plannedOf(solve(new Set(), a, { ...chainOnly, chainPenalty: 0 })).sort()).toEqual(['2:M 1', '3:M 2'])
    // MATH 1 taken at college 2: MATH 2 there (5) beats college 3 (3 + 5)
    expect(plannedOf(solve(new Set(['2:M 1']), a, chainOnly))).toEqual(['2:M 2'])
    expect(plannedOf(solve(new Set(['2:M 1']), a, { ...chainOnly, chainPenalty: 0 }))).toEqual(['3:M 2'])
    // different subjects are not a chain
    const b = agreement(and(req('MATH 1', [['2:M 1'], ['3:M 1']]), req('PHYS 2', [['2:M 2'], ['3:M 2']])), cs)
    expect(plannedOf(solve(new Set(), b, chainOnly)).sort()).toEqual(['2:M 1', '3:M 2'])
  })
  it('a chain across 3 colleges costs twice one across 2 (TESTER1 M-4)', () => {
    const cs: [string, number][] = [['2:M 1', 1], ['3:M 1', 7], ['4:M 1', 7], ['2:M 2', 7], ['3:M 2', 1], ['4:M 2', 7], ['2:M 3', 6], ['3:M 3', 7], ['4:M 3', 3]]
    const a = agreement(and(...[1, 2, 3].map((n) => req(`MATH ${n}`, [2, 3, 4].map((k) => [`${k}:M ${n}`])))), cs)
    const chainOnly = { allowed: [1, 2, 3, 4], home: 1, collegePenalty: 0 }
    // 3 colleges: 5 + 2 × 5 = 15; 2 colleges: 8 + 5 = 13; 1 college: 14. (A flat penalty would pick 3 colleges: 10.)
    const p = solve(new Set(), a, chainOnly)
    expect(plannedOf(p).sort()).toEqual(['2:M 1', '2:M 3', '3:M 2'])
    expect(p.optimal).toBe(true)
  })
  it('penalties are quarter units, converted for a semester home', () => {
    const a = (away: number) => agreement(and(req('R', [['1:A 1'], ['2:A 1']])), [['1:A 1', 4], ['2:A 1', away]])
    const sem = { allowed: [1, 2], home: 1, termSystem: 'semester' as const, unitSystems: { 1: 'semester', 2: 'semester' } as const }
    expect(plannedOf(solve(new Set(), a(0.5), sem))).toEqual(['2:A 1']) // 0.5 + 3.33 < 4
    expect(plannedOf(solve(new Set(), a(1), sem))).toEqual(['1:A 1'])   // 1 + 3.33 > 4
    expect(plannedOf(solve(new Set(), a(0.5), { ...sem, termSystem: 'quarter', unitSystems: {} }))).toEqual(['1:A 1'])
  })
  it('real agreements: a plan leaves a home that could finish alone only to save more than a college costs', () => {
    for (const a of Object.values(import.meta.glob('../../data/agreements/*.json', { eager: true, import: 'default' })) as Agreement[]) {
      for (const [home, extra] of [[DA, FH], [SM, FH], [FH, DA]]) {
        const o: SolveOptions = { allowed: [home], home, termSystem: unitSystems[home], unitSystems }
        const h = solve(new Set(), a, o)
        if (h.unsolvable.length) continue
        const p = solve(new Set(), a, { ...o, allowed: [home, extra] })
        expect(p.unsolvable).toEqual([])
        expect(p.optimal).toBe(true)
        const away = plannedOf(p).some((c) => !c.startsWith(`${home}:`))
        const pen = unitSystems[home] === 'semester' ? 5 / 1.5 : 5
        if (away) expect(h.totalUnits - p.totalUnits, a.major).toBeGreaterThanOrEqual(pen - 0.5) // totals round to 0.5
        else expect(plannedOf(p).sort()).toEqual(plannedOf(h).sort())
      }
    }
  })
})

describe('solve: reads choices mixing UC-only and unrecorded rows as the verifier does (MED-1, MED-2)', () => {
  const unrec = (id: string): Requirement => ({ kind: 'req', id, label: id, units: 4, groups: [], noArticulation: { 1: NOT_LISTED } })
  const nof = (n: number, ...children: (ReqNode | Requirement)[]): ReqNode => ({ kind: 'node', type: 'N_OF', n, required: true, children })
  const row = (id: string) => req(id, [[`1:${id} 1`]])
  it('MED-1: a row with no ASSIST record is no alternative; the UC-only row fills the slot', () => {
    const a = agreement(and(nof(3, unrec('R2'), row('R3'), req('R4', []), row('R5'))), [['1:R3 1', 3], ['1:R5 1', 3]])
    const p = solve(new Set(), a, { allowed: [1], home: 1 })
    expect(plannedOf(p).sort()).toEqual(['1:R3 1', '1:R5 1'])
    expect(p.unsolvable).toEqual([])
    expect(p.result.isValid).toBe(true)
    const q = solve(new Set(), agreement(and(or(unrec('P1'), req('U1', []))), []), { allowed: [1], home: 1 })
    expect(plannedOf(q)).toEqual([])
    expect(q.unsolvable).toEqual([])
    expect(q.result.isValid).toBe(true)
  })
  it('MED-2: an alternative that passes only through a UC-only slot does not satisfy the choice', () => {
    // The inner N_OF(4) passes with R1, R7, R8 (3 units) only because R9 is UC-only; the CC alternative is owed first.
    const root = and(nof(1, or(and(row('R1'), row('R2')), row('R3')), nof(4, or(row('R1')), and(req('R6', []), row('R7')), row('R8'), req('R9', []))))
    const a = agreement(root, [['1:R1 1', 1], ['1:R2 1', 5], ['1:R3 1', 5], ['1:R7 1', 1], ['1:R8 1', 1]])
    const p = solve(new Set(), a, { allowed: [1], home: 1 })
    expect(plannedOf(p)).toEqual(['1:R3 1'])
    expect(p.unsolvable).toEqual([])
    expect(p.optimal).toBe(true)
    expect(p.result.isValid).toBe(true)
  })
})

/* ---- random synthetic trees ---- */

type N = ReqNode | Requirement
type St = 'sat' | 'def' | 'open'
const kidsOf = (n: ReqNode) => n.children.filter((c) => c.kind === 'req' || c.required)
const need = (n: ReqNode) => (n.type === 'OR' ? 1 : n.n ?? 1)
const isUcOnly = (r: Requirement) => !r.groups.length && Object.values(r.noArticulation ?? {}).some((w) => w !== NOT_LISTED)
/** The rules as stated (FIXES round 3), written out again: `sat`, `def` (passes as UC-only), `open`. */
const stateOf = (n: N, ok: (r: Requirement) => boolean): St => {
  if (n.kind === 'req') return ok(n) ? 'sat' : isUcOnly(n) ? 'def' : 'open'
  const s = kidsOf(n).map((c) => stateOf(c, ok)), sat = s.filter((x) => x === 'sat').length
  if (n.type === 'AND') return s.includes('open') ? 'open' : sat || !s.length ? 'sat' : 'def'
  const art = kidsOf(n).filter((c, j) => s[j] === 'open' && routes(c)).length, def = s.filter((x) => x === 'def').length
  return sat >= need(n) ? 'sat' : art || sat + def < need(n) ? 'open' : 'def'
}
/** Articulable: passes once every row with a CC group is done. */
const routes = (n: N) => stateOf(n, (r) => r.groups.length > 0) !== 'open'
const canDef = (n: N): boolean => n.kind === 'req' ? isUcOnly(n)
  : n.type === 'AND' ? kidsOf(n).length > 0 && kidsOf(n).every(canDef)
  : need(n) > 0 && kidsOf(n).filter(routes).length >= need(n) && kidsOf(n).filter(routes).some(canDef)

describe('solve: the planner reads the tree as the verifier does', () => {
  /** Random tree over G (one-course group), U (UC-only), X (no ASSIST record) rows; nested AND / OR / N_OF, optional children. */
  const tree = (seed: number) => {
    let s = seed
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32)
    const int = (n: number) => Math.floor(rnd() * n)
    const rows = Array.from({ length: 2 + int(5) }, (_, i): Requirement => {
      const k = rnd()
      return k < 0.6 ? req(`G${i}`, [[`1:G${i} 1`]]) : k < 0.8 ? req(`U${i}`, []) : { kind: 'req', id: `X${i}`, label: '', units: 4, groups: [], noArticulation: { 1: NOT_LISTED } }
    })
    const node = (d: number): N => {
      if (d > 2 || rnd() < 0.35) return rows[int(rows.length)]
      const type = (['AND', 'OR', 'N_OF'] as const)[int(3)]
      return { kind: 'node', type, n: type === 'N_OF' ? int(4) : undefined, required: rnd() < 0.85, children: Array.from({ length: 1 + int(4) }, () => node(d + 1)) }
    }
    const r = node(0)
    const root: ReqNode = r.kind === 'req' ? and(r) : { ...r, required: true }
    const a = agreement(root, rows.filter((x) => x.groups.length).map((x): [string, number] => [x.groups[0].courses[0], 1 + int(5)]))
    const done = new Set(rows.filter((x) => x.groups.length && rnd() < 0.5).map((x) => x.id))
    return { a, done, taken: new Set(rows.filter((x) => done.has(x.id)).map((x) => x.groups[0].courses[0])) }
  }
  // degenerate trees (choose 0, an AND with nothing required) are malformed data: verifySchedule fails closed on them and
  // the gate rejects them (TESTER2 M-3), so the planner's reading is not compared there
  const trees = Array.from({ length: Number(process.env.TREE_CASES ?? 5000) }, (_, i) => tree(i + 1)).filter(({ a }) => !malformed(a.root))
  it(`${trees.length} random trees: the planner's reading of the tree equals verifySchedule's`, () => {
    for (const [i, { a, done, taken }] of trees.entries()) {
      const s = treeState(a.root, (r) => done.has(r.id))
      expect(s, `tree ${i + 1}`).toBe(stateOf(a.root, (r) => done.has(r.id)))
      expect(s !== 'open', `tree ${i + 1}`).toBe(verifySchedule(taken, a).isValid)
    }
  }, 600_000)
  it(`${trees.length} random trees: a plan verifies exactly when nothing is reported unsolvable`, () => {
    for (const [i, { a, taken }] of trees.entries()) for (const budget of [undefined, 0]) {
      const p = solve(taken, a, { allowed: [1], home: 1, budget })
      expect(p.result.isValid, `tree ${i + 1} budget ${budget}`).toBe(p.unsolvable.length === 0)
      expect(p.unsolvable.length === 0, `tree ${i + 1} budget ${budget}`).toBe(verifySchedule(new Set([...taken, ...Object.keys(a.catalog)]), a).isValid)
    }
  }, 600_000)
})

/* ---- brute-force oracle over random small agreements ---- */

const code = (c: CourseId) => c.slice(c.indexOf(':') + 1).replace(/H$/, '')
const splitIn = (r: Requirement, h: Set<CourseId>) => {
  const s = reqStatus(r, h)
  return !s.satisfied && new Set(s.partials.map((p) => p.institutionId)).size > 1 && new Set(s.partials.flatMap((p) => p.have.map(code))).size > 1
}
const leavesOf = (n: N): Requirement[] => (n.kind === 'req' ? [n] : n.children.flatMap(leavesOf))
const instOf = (c: CourseId) => Number(c.split(':')[0])

/** [colleges other than home that planned courses `P` use, sum over subject chains (2+ rows with CC groups sharing a
 *  UC subject) with a planned course of k - 1, k the colleges of its planned and taken courses]. */
function penaltyCounts(a: Agreement, taken: Set<CourseId>, P: CourseId[], home: number) {
  const subject = (id: string) => { const t = id.split(',')[0].trim().split(/\s+/), k = t.findIndex((w) => /\d/.test(w)); return t.slice(0, k < 0 ? t.length : k).join(' ') }
  const rows = [...new Map(leavesOf(a.root).filter((r) => r.groups.length && subject(r.id)).map((r) => [r.id, r])).values()]
  let chains = 0
  for (const sub of new Set(rows.map((r) => subject(r.id)))) {
    const rs = rows.filter((r) => subject(r.id) === sub)
    if (rs.length < 2) continue
    const inChain = (c: CourseId) => rs.some((r) => r.groups.some((g) => g.courses.some((x) => c === x || c === `${x}H` || c === x.replace(/H$/, ''))))
    const planned = new Set(P.filter(inChain).map(instOf)), all = new Set([...planned, ...[...taken].filter(inChain).map(instOf)])
    if (planned.size) chains += all.size - 1
  }
  return [new Set(P.map(instOf).filter((i) => i !== home)).size, chains]
}
/** Colleges plus split chains: the penalty at equal weights, in units of the weight. */
const penalties = (a: Agreement, taken: Set<CourseId>, P: CourseId[], home: number) => penaltyCounts(a, taken, P, home).reduce((x, y) => x + y, 0)

/** Every subset of plannable courses, scored: unmet (fewest over all ways to pass the tree; an OR / N_OF with too few
 *  completable alternatives is one unmet entry), units + penalties, new splits, units away from home, honors,
 *  courses, ids. Plans that open a split the verifier calls blocking are out. */
function oracle(taken: Set<CourseId>, a: Agreement, allowed: number[], home: number, units: (c: CourseId) => number, pc = 5, pch = 5) {
  const leaves = [...new Map(leavesOf(a.root).map((r) => [r.id, r])).values()]
  const U = Object.keys(a.catalog).filter((c) => allowed.includes(a.catalog[c].institutionId) && !taken.has(c)).sort()
  const sat = (h: Set<CourseId>) => (r: Requirement) => !!reqStatus(r, h).satisfied
  const all = sat(new Set([...taken, ...U]))
  let marks = 0
  const cross = (ls: string[][][]) => ls.reduce<string[][]>((acc, l) => acc.flatMap((x) => l.map((y) => [...x, ...y])), [[]])
  // S: ways to make the subtree `sat`; P: ways to make it pass (also: every articulable alternative passes)
  const sels = (n: N): { S: string[][]; P: string[][] } => {
    if (n.kind === 'req') return isUcOnly(n) ? { S: [], P: [[]] } : { S: [[n.id]], P: [[n.id]] }
    const ks = kidsOf(n), fs = ks.map(sels)
    if (n.type === 'AND') {
      const P = cross(fs.map((f) => f.P))
      return { S: ks.length && ks.every(canDef) ? fs.flatMap((f) => cross([f.S, P])) : P, P }
    }
    const k = need(n)
    if (k <= 0) return { S: [[]], P: [[]] }
    const ok = ks.flatMap((c, j) => (stateOf(c, all) === 'sat' ? [j] : []))
    const S: string[][] = []
    if (ok.length < k) S.push(...cross([...ok.map((j) => fs[j].S), [[`#${marks++}`]]]))
    else {
      const pick = (from: number, got: number[]): void => {
        if (got.length === k) { S.push(...cross(got.map((j) => fs[j].S))); return }
        for (let i = from; i < ok.length; i++) pick(i + 1, [...got, ok[i]])
      }
      pick(0, [])
    }
    const art = ks.flatMap((c, j) => (routes(c) ? [j] : []))
    return { S, P: art.length >= k && art.some((j) => canDef(ks[j])) ? [...S, ...cross(art.map((j) => fs[j].P))] : S }
  }
  const S = a.root.required ? sels(a.root).P.map((s) => [...new Set(s)]) : [[]]
  const split0 = new Set(leaves.filter((r) => splitIn(r, taken)).map((r) => r.id))
  const byId = new Map(leaves.map((r) => [r.id, r]))
  let best: { key: (number | string)[]; P: CourseId[] } | null = null
  for (let m = 0; m < 1 << U.length; m++) {
    const P = U.filter((_, i) => m & (1 << i)), h = new Set([...taken, ...P]), ok = sat(h)
    const fresh = leaves.filter((r) => !split0.has(r.id) && splitIn(r, h))
    if (fresh.length && verifySchedule(h, a).splitSeriesViolations.some((v) => v.blocking && !split0.has(v.requirementId))) continue
    const unmet = Math.min(...S.map((s) => s.filter((x) => x.startsWith('#') || !ok(byId.get(x)!)).length))
    const [cols, chains] = penaltyCounts(a, taken, P, home)
    const u = P.reduce((t, c) => t + units(c), 0), away = P.reduce((t, c) => t + (a.catalog[c].institutionId === home ? 0 : units(c)), 0)
    const key = [unmet, u + pc * cols + pch * chains, fresh.length, away, P.filter((c) => /H$/.test(c)).length, P.length, ...P]
    if (!best || cmpKey(key, best.key) < 0) best = { key, P }
  }
  return best!
}
const cmpKey = (x: (number | string)[], y: (number | string)[]) => {
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i], q = y[i]
    if (typeof p === 'number' && typeof q === 'number' ? Math.abs(p - q) > 1e-9 : p !== q) return p === undefined ? -1 : q === undefined || p > q ? 1 : -1
  }
  return 0
}

/** Seeded random agreement: up to 3 colleges (3 is semester; 5 in every fifth case), shared course codes, honors twins, courses missing
 *  from the catalog, UC-only and unrecorded rows, repeated rows, rows sharing a UC subject, optional subtrees,
 *  OR / N_OF, a random transcript, and the penalty weights. */
function randomCase(seed: number, hard = false) {
  let s = seed
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32)
  const int = (n: number) => Math.floor(rnd() * n), one = <T,>(xs: T[]) => xs[int(xs.length)]
  const courses: [string, number][] = [], ghosts: string[] = []
  const at: Record<number, string[]> = {}
  // every fifth case: five colleges (3 and 5 are semester), fewer courses at each, for the search over colleges
  const cols = seed % 5 === 4 ? [1, 2, 3, 4, 5] : [1, 2, 3]
  for (const c of cols) {
    at[c] = []
    for (const k of ['M 1A', 'M 1B', 'P 1', 'Q 2'].filter(() => rnd() < (cols.length > 3 ? 0.4 : 0.55))) {
      const id = `${c}:${k}`, u = 1 + int(5)
      if (rnd() < (hard ? 0.3 : 0.08)) ghosts.push(id); else courses.push([id, u])
      at[c].push(id)
      if (rnd() < 0.3) { courses.push([`${id}H`, u + (rnd() < 0.2 ? 1 : 0)]); at[c].push(`${id}H`) }
    }
  }
  const rows: Requirement[] = []
  for (let i = 0, n = 2 + int(4); i < n; i++) {
    const groups: string[][] = []
    if (rnd() > 0.15) for (let g = 0, m = 1 + int(3); g < m; g++) {
      const c = one(cols), reg = at[c].filter((x) => !x.endsWith('H'))
      if (!reg.length) continue
      const gs = [...new Set([one(reg), ...(rnd() < (hard ? 0.85 : 0.5) ? [one(reg)] : [])])]
      groups.push(gs)
      if (gs.every((x) => at[c].includes(`${x}H`)) && rnd() < 0.6) groups.push(gs.map((x) => `${x}H`))
    }
    const id = `${one(['MATH', 'PHYS'])} ${i}`
    rows.push(groups.length || rnd() < 0.7 ? req(id, groups) : { kind: 'req', id, label: id, units: 4, groups: [], noArticulation: { 1: NOT_LISTED } })
  }
  const node = (d: number): N => {
    if (d > 1 || rnd() < 0.45) return one(rows)
    const type = one(['AND', 'OR', 'N_OF'] as const), children = Array.from({ length: 2 + int(2) }, () => node(d + 1))
    return { kind: 'node', type, n: type === 'N_OF' ? 1 + int(2) : undefined, required: rnd() < 0.9, children }
  }
  const root = and(...rows.slice(0, 1 + int(2)), ...Array.from({ length: int(3) }, () => node(1)))
  const trap: string[] = []
  if (hard) {
    // X cannot be met at c2 (T 9 is not in the catalog); planning c2 T 1 for Y splits X against a taken c1 T 2.
    const [c1, c2] = one([[1, 2], [2, 3], [3, 1]])
    courses.push([`${c1}:T 1`, 1 + int(4)], [`${c1}:T 2`, 1 + int(4)], [`${c2}:T 1`, 1 + int(4)], [`${c2}:T 3`, 1 + int(4)])
    const y = req('Y', [[`${c2}:T 1`], ...(rnd() < 0.5 ? [[`${c2}:T 3`]] : []), ...(rnd() < 0.3 ? [[`${c1}:T 1`]] : [])])
    root.children.push(req('X', [[`${c1}:T 1`, `${c1}:T 2`], [`${c2}:T 1`, `${c2}:T 9`]]), rnd() < 0.7 ? y : or(y, one(rows)))
    if (rnd() < 0.7) trap.push(`${c1}:T 2`)
  }
  const a = agreement(root, courses, cols)
  const taken = new Set([...courses.map(([c]) => c), ...ghosts].filter(() => rnd() < (hard ? 0.3 : 0.15)).concat(trap))
  const allowed = cols.filter(() => rnd() < (cols.length > 3 ? 0.8 : 0.6))
  if (!allowed.length) allowed.push(one(cols))
  // default weights for most cases; pure units, college only, chain only and odd weights for the rest
  const w: { collegePenalty?: number; chainPenalty?: number } = [{}, {}, {}, UNITS, { chainPenalty: 0 }, { collegePenalty: 0 }, { collegePenalty: 2.5, chainPenalty: 8 }][seed % 7]
  return { a, taken, allowed, home: one(cols), w }
}

// Stress run: ORACLE_CASES=20000 ORDER_CASES=20000 npx vitest run src/engine/solve.test.ts --reporter=verbose
describe('solve: matches a brute-force oracle on random agreements', () => {
  const sys = { 1: 'quarter', 2: 'quarter', 3: 'semester', 4: 'quarter', 5: 'semester' } as const
  const units = (a: Agreement) => (c: CourseId) => a.catalog[c].units * ([3, 5].includes(a.catalog[c].institutionId) ? 1.5 : 1)
  // Every third case is "hard": many courses missing from the catalog and a bigger transcript, so requirements that
  // cannot be met sit next to splits the solver must not deepen (the guarded second pass).
  const cases = Array.from({ length: Number(process.env.ORACLE_CASES ?? 620) }, (_, i) => ({ seed: i + 1, ...randomCase(i + 1, i % 3 === 2) }))
    .filter(({ a, allowed, taken }) => Object.values(a.catalog).filter((c) => allowed.includes(c.institutionId) && !taken.has(c.id)).length <= 11)
  it(`${cases.length} cases: proven-optimal plans equal the oracle; every plan obeys the rules`, () => {
    let proven = 0, same = 0
    for (const { seed, a, taken, allowed, home, w } of cases) {
      const o: SolveOptions = { allowed, home, unitSystems: sys, ...w }
      const p = solve(taken, a, o), greedy = solve(taken, a, { ...o, budget: 0 })
      const best = oracle(taken, a, allowed, home, units(a), w.collegePenalty ?? 5, w.chainPenalty ?? 5), P = plannedOf(p).sort()
      const ctx = `seed ${seed}`
      // Rules hold for every plan, proven or not, and for the greedy fallback.
      for (const q of [p, greedy]) {
        const Q = plannedOf(q), h = new Set([...taken, ...Q]), leaves = leavesOf(a.root)
        expect(Q.every((c) => allowed.includes(a.catalog[c]?.institutionId)), ctx).toBe(true)
        expect(q.result.isValid, ctx).toBe(q.unsolvable.length === 0)
        expect(q.result.splitSeriesViolations.filter((v) => v.blocking && !splitIn(leaves.find((r) => r.id === v.requirementId)!, taken)), ctx).toEqual([])
        for (const [id, g] of Object.entries(q.chosen)) expect(g.courses.every((c) => has(h, c, honorsColleges(leaves.find((r) => r.id === id)!))), ctx).toBe(true)
        expect(q.unsolvable.length > 0, ctx).toBe((best.key[0] as number) > 0)
      }
      if (greedy.optimal) expect(plannedOf(greedy).sort(), ctx).toEqual(P) // nothing to search: proven at no cost
      expect(p.unsolvable.length, ctx).toBeGreaterThanOrEqual(best.key[0] as number)
      if (!p.optimal && p.unsolvable.length === best.key[0] && JSON.stringify(P) === JSON.stringify(best.P)) same++
      if (p.optimal) {
        proven++
        expect(p.unsolvable.length, ctx).toBe(best.key[0])
        expect(P, ctx).toEqual(best.P)
      }
    }
    if (process.env.ORACLE_CASES) console.log(`oracle: ${cases.length} cases, ${proven} proven optimal, ${same} unproven but equal to the oracle`)
    expect(proven / cases.length).toBeGreaterThan(0.95)
  }, 600_000)
  it('the same plan whatever the input order', () => {
    const rev = (n: N): N => (n.kind === 'req' ? { ...n, groups: [...n.groups].reverse() } : { ...n, children: n.children.map(rev).reverse() })
    for (const { a, taken, allowed, home, w } of cases.slice(0, Number(process.env.ORDER_CASES ?? 200))) {
      const p1 = solve(taken, a, { allowed, home, unitSystems: sys, ...w })
      const p2 = solve(new Set([...taken].reverse()), { ...a, root: rev(a.root) as ReqNode }, { allowed: [...allowed].reverse(), home, unitSystems: sys, ...w })
      expect(plannedOf(p2).sort()).toEqual(plannedOf(p1).sort())
      expect(p2.chosen).toEqual(p1.chosen)
      expect([...p2.unsolvable].sort()).toEqual([...p1.unsolvable].sort())
    }
  }, 600_000)
})
