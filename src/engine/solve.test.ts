import { describe, expect, it } from 'vitest'
import me from '../../data/agreements/79-mechanical-engineering-b-s.json'
import mae from '../../data/agreements/7-mae-mechanical-engineering-b-s.json'
import institutions from '../../data/institutions.json'
import type { Agreement, Course, CourseId, Institution, Plan, ReqNode, Requirement } from './types'
import { solve, type SolveOptions } from './solve'
import { has, honorsColleges, reqStatus, verifySchedule } from './verify'
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

// verify.ts with blocking / deferred (merged separately). Checks of plan.result against those rules run only then.
const NEW_VERIFY = verifySchedule(new Set(), agreement(and(req('D', [])), [])).deferred.length > 0

describe('solve: split series under the blocking rule (F-06)', () => {
  // Taken 2:P 2 is half of U at college 2. Planning 1:P 1 for R puts U at two colleges.
  const a = agreement(and(req('R', [['1:P 1'], ['3:Q 1']]), or(req('U', [['1:P 1', '1:P 2'], ['2:P 1', '2:P 2']]), req('V', [['3:V 1']]))),
    [['1:P 1', 3], ['1:P 2', 3], ['2:P 1', 3], ['2:P 2', 3], ['3:Q 1', 4], ['3:V 1', 1]])
  it('takes the cheaper group when the split it opens is in an unused OR alternative (a warning)', () => {
    const p = solve(new Set(['2:P 2']), a, { allowed: [1, 3], home: 1 })
    expect(p.chosen.R.institutionId).toBe(1)
    expect(plannedOf(p).sort()).toEqual(['1:P 1', '3:V 1'])
    expect(p.totalUnits).toBe(4)
    expect(p.unsolvable).toEqual([])
    expect(p.optimal).toBe(true)
  })
  it.runIf(NEW_VERIFY)('... and the verifier calls that split non-blocking', () => {
    const r = solve(new Set(['2:P 2']), a, { allowed: [1, 3], home: 1 }).result
    expect(r.splitSeriesViolations.map((v) => [v.requirementId, v.blocking])).toEqual([['U', false]])
    expect(r.isValid).toBe(true)
  })
  it('equal units: avoids opening even a non-blocking split', () => {
    const b = agreement(and(req('R', [['1:P 1'], ['3:Q 1']]), or(req('U', [['1:P 1', '1:P 2'], ['2:P 1', '2:P 2']]), req('V', [['3:V 1']]))),
      [['1:P 1', 3], ['1:P 2', 3], ['2:P 1', 3], ['2:P 2', 3], ['3:Q 1', 3], ['3:V 1', 1]])
    const p = solve(new Set(['2:P 2']), b, { allowed: [1, 3], home: 1 }) // home college loses to "no new split"
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
    for (const a of [ME, MAE]) {
      const o: SolveOptions = { allowed: [DA, FH, SM], home: DA, unitSystems }
      const x = solve(new Set(), a, o), g = solve(new Set(), a, { ...o, budget: 0 })
      expect(x.optimal).toBe(true)
      expect(g.optimal).toBe(false)
      expect(x.unsolvable.length).toBeLessThanOrEqual(g.unsolvable.length)
      if (x.unsolvable.length === g.unsolvable.length) expect(x.totalUnits).toBeLessThanOrEqual(g.totalUnits)
    }
  })
})

/* ---- brute-force oracle over random small agreements ---- */

type N = ReqNode | Requirement
const kidsOf = (n: ReqNode) => n.children.filter((c) => c.kind === 'req' || c.required)
/** The rules as stated: a deferred child fills an OR / N_OF slot only when the articulable children cannot reach n. */
const passes = (n: N, ok: (r: Requirement) => boolean): boolean => {
  if (n.kind === 'req') return !n.groups.length || ok(n)
  const ks = kidsOf(n), fixed = n.children.length - ks.length
  if (n.type === 'AND') return ks.every((c) => passes(c, ok))
  const need = n.type === 'OR' ? 1 : n.n ?? 1, art = ks.filter((c) => !passes(c, () => false)), def = ks.length - art.length
  return art.filter((c) => passes(c, ok)).length + fixed + Math.min(def, Math.max(0, need - fixed - art.length)) >= need
}
const code = (c: CourseId) => c.slice(c.indexOf(':') + 1).replace(/H$/, '')
const splitIn = (r: Requirement, h: Set<CourseId>) => {
  const s = reqStatus(r, h)
  return !s.satisfied && new Set(s.partials.map((p) => p.institutionId)).size > 1 && new Set(s.partials.flatMap((p) => p.have.map(code))).size > 1
}
const leavesOf = (n: N): Requirement[] => (n.kind === 'req' ? [n] : n.children.flatMap(leavesOf))

/** Every subset of plannable courses, scored: unmet (fewest over all ways to pass the tree; an OR / N_OF with too few
 *  completable alternatives is one unmet entry), units, new splits, units away from home, honors, courses, ids. */
function oracle(taken: Set<CourseId>, a: Agreement, allowed: number[], home: number, units: (c: CourseId) => number) {
  const leaves = [...new Map(leavesOf(a.root).map((r) => [r.id, r])).values()]
  const U = Object.keys(a.catalog).filter((c) => allowed.includes(a.catalog[c].institutionId) && !taken.has(c)).sort()
  const sat = (h: Set<CourseId>) => (r: Requirement) => !!reqStatus(r, h).satisfied
  const all = sat(new Set([...taken, ...U]))
  let marks = 0
  const cross = (ls: string[][][]) => ls.reduce<string[][]>((acc, l) => acc.flatMap((x) => l.map((y) => [...x, ...y])), [[]])
  const sels = (n: N): string[][] => {
    if (n.kind === 'req') return [n.groups.length ? [n.id] : []]
    const ks = kidsOf(n), fixed = n.children.length - ks.length
    if (n.type === 'AND') return cross(ks.map(sels))
    const need = n.type === 'OR' ? 1 : n.n ?? 1, art = ks.filter((c) => !passes(c, () => false))
    const k = need - fixed - Math.min(ks.length - art.length, Math.max(0, need - fixed - art.length)), ok = art.filter((c) => passes(c, all))
    if (k <= 0) return [[]]
    if (ok.length < k) return cross([...ok.map(sels), [[`#${marks++}`]]])
    const out: string[][] = []
    const pick = (from: number, got: N[]): void => {
      if (got.length === k) { out.push(...cross(got.map(sels))); return }
      for (let i = from; i < ok.length; i++) pick(i + 1, [...got, ok[i]])
    }
    pick(0, [])
    return out
  }
  const S = a.root.required ? sels(a.root).map((s) => [...new Set(s)]) : [[]]
  const split0 = new Set(leaves.filter((r) => splitIn(r, taken)).map((r) => r.id))
  let best: { key: (number | string)[]; P: CourseId[] } | null = null
  for (let m = 0; m < 1 << U.length; m++) {
    const P = U.filter((_, i) => m & (1 << i)), h = new Set([...taken, ...P]), ok = sat(h)
    const fresh = leaves.filter((r) => !split0.has(r.id) && splitIn(r, h))
    const needed = new Set<string>()
    const walk = (n: N): void => { if (passes(n, ok)) return; if (n.kind === 'req') needed.add(n.id); else kidsOf(n).forEach(walk) }
    if (a.root.required) walk(a.root)
    if (fresh.some((r) => needed.has(r.id))) continue // a new split the agreement still needs
    const byId = new Map(leaves.map((r) => [r.id, r]))
    const unmet = Math.min(...S.map((s) => s.filter((x) => x.startsWith('#') || !ok(byId.get(x)!)).length))
    const u = P.reduce((t, c) => t + units(c), 0), away = P.reduce((t, c) => t + (a.catalog[c].institutionId === home ? 0 : units(c)), 0)
    const key = [unmet, u, fresh.length, away, P.filter((c) => /H$/.test(c)).length, P.length, ...P]
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

/** Seeded random agreement: up to 3 colleges (3 is semester), shared course codes, honors twins, courses missing
 *  from the catalog, deferred rows, repeated rows, optional subtrees, OR / N_OF, a random transcript. */
function randomCase(seed: number, hard = false) {
  let s = seed
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32)
  const int = (n: number) => Math.floor(rnd() * n), one = <T,>(xs: T[]) => xs[int(xs.length)]
  const courses: [string, number][] = [], ghosts: string[] = []
  const at: Record<number, string[]> = {}
  for (const c of [1, 2, 3]) {
    at[c] = []
    for (const k of ['M 1A', 'M 1B', 'P 1', 'Q 2'].filter(() => rnd() < 0.55)) {
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
      const c = one([1, 2, 3]), reg = at[c].filter((x) => !x.endsWith('H'))
      if (!reg.length) continue
      const gs = [...new Set([one(reg), ...(rnd() < (hard ? 0.85 : 0.5) ? [one(reg)] : [])])]
      groups.push(gs)
      if (gs.every((x) => at[c].includes(`${x}H`)) && rnd() < 0.6) groups.push(gs.map((x) => `${x}H`))
    }
    rows.push(req(`R${i}`, groups))
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
  const a = agreement(root, courses, [1, 2, 3])
  const taken = new Set([...courses.map(([c]) => c), ...ghosts].filter(() => rnd() < (hard ? 0.3 : 0.15)).concat(trap))
  const allowed = [1, 2, 3].filter(() => rnd() < 0.6)
  if (!allowed.length) allowed.push(one([1, 2, 3]))
  return { a, taken, allowed, home: one([1, 2, 3]) }
}

// Stress run: ORACLE_CASES=20000 ORDER_CASES=20000 npx vitest run src/engine/solve.test.ts --reporter=verbose
describe('solve: matches a brute-force oracle on random agreements', () => {
  const sys = { 1: 'quarter', 2: 'quarter', 3: 'semester' } as const
  const units = (a: Agreement) => (c: CourseId) => a.catalog[c].units * (a.catalog[c].institutionId === 3 ? 1.5 : 1)
  // Every third case is "hard": many courses missing from the catalog and a bigger transcript, so requirements that
  // cannot be met sit next to splits the solver must not deepen (the guarded second pass).
  const cases = Array.from({ length: Number(process.env.ORACLE_CASES ?? 600) }, (_, i) => ({ seed: i + 1, ...randomCase(i + 1, i % 3 === 2) }))
    .filter(({ a, allowed, taken }) => Object.values(a.catalog).filter((c) => allowed.includes(c.institutionId) && !taken.has(c.id)).length <= 11)
  it(`${cases.length} cases: proven-optimal plans equal the oracle; every plan obeys the rules`, () => {
    let proven = 0, same = 0
    for (const { seed, a, taken, allowed, home } of cases) {
      const p = solve(taken, a, { allowed, home, unitSystems: sys }), greedy = solve(taken, a, { allowed, home, unitSystems: sys, budget: 0 })
      const best = oracle(taken, a, allowed, home, units(a)), P = plannedOf(p).sort()
      const ctx = `seed ${seed}`
      // Rules hold for every plan, proven or not, and for the greedy fallback.
      for (const q of [p, greedy]) {
        const Q = plannedOf(q), h = new Set([...taken, ...Q])
        expect(Q.every((c) => allowed.includes(a.catalog[c]?.institutionId)), ctx).toBe(true)
        const leaves = leavesOf(a.root), ok = (r: Requirement) => !!reqStatus(r, h).satisfied
        if (!q.unsolvable.length) expect(passes(a.root, ok), ctx).toBe(true)
        const needed = new Set<string>()
        const walk = (n: N): void => { if (passes(n, ok)) return; if (n.kind === 'req') needed.add(n.id); else kidsOf(n).forEach(walk) }
        walk(a.root)
        expect(leaves.filter((r) => needed.has(r.id) && splitIn(r, h) && !splitIn(r, taken)).map((r) => r.id), ctx).toEqual([])
        for (const [id, g] of Object.entries(q.chosen)) expect(g.courses.every((c) => has(h, c, honorsColleges(leaves.find((r) => r.id === id)!))), ctx).toBe(true)
        expect(q.unsolvable.length > 0, ctx).toBe((best.key[0] as number) > 0)
        if (NEW_VERIFY) {
          expect(q.result.isValid, ctx).toBe(q.unsolvable.length === 0)
          expect(q.result.splitSeriesViolations.filter((v) => v.blocking && !splitIn(leaves.find((r) => r.id === v.requirementId)!, taken)), ctx).toEqual([])
        }
      }
      if (greedy.optimal) expect(plannedOf(greedy).sort(), ctx).toEqual(P) // nothing to search: proven at no cost
      expect(p.unsolvable.length, ctx).toBeGreaterThanOrEqual(best.key[0] as number)
      if (!p.optimal && p.unsolvable.length === best.key[0] && JSON.stringify(P) === JSON.stringify(best.P)) same++
      if (p.optimal) {
        proven++
        expect(p.unsolvable.length, ctx).toBe(best.key[0])
        expect(P, ctx).toEqual(best.P)
        expect(Math.abs(P.reduce((t, c) => t + units(a)(c), 0) - (best.key[1] as number)), ctx).toBeLessThan(1e-9)
      }
    }
    if (process.env.ORACLE_CASES) console.log(`oracle: ${cases.length} cases, ${proven} proven optimal, ${same} unproven but equal to the oracle`)
    expect(proven / cases.length).toBeGreaterThan(0.95)
  }, 600_000)
  it('the same plan whatever the input order', () => {
    const rev = (n: N): N => (n.kind === 'req' ? { ...n, groups: [...n.groups].reverse() } : { ...n, children: n.children.map(rev).reverse() })
    for (const { a, taken, allowed, home } of cases.slice(0, Number(process.env.ORDER_CASES ?? 200))) {
      const p1 = solve(taken, a, { allowed, home, unitSystems: sys })
      const p2 = solve(new Set([...taken].reverse()), { ...a, root: rev(a.root) as ReqNode }, { allowed: [...allowed].reverse(), home, unitSystems: sys })
      expect(plannedOf(p2).sort()).toEqual(plannedOf(p1).sort())
      expect(p2.chosen).toEqual(p1.chosen)
      expect([...p2.unsolvable].sort()).toEqual([...p1.unsolvable].sort())
    }
  }, 600_000)
})
