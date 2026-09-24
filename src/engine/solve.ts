import type { Agreement, CourseGroup, CourseId, Institution, Partial, Plan, ReqNode, Requirement, Term } from './types'
import { has, honorsColleges, reqStatus, verifySchedule, type ReqStatus } from './verify.ts'
import institutions from '../../data/institutions.json' with { type: 'json' }

export type TermSystem = 'quarter' | 'semester'

export interface SolveOptions {
  allowed: number[]       // institutions the student can enroll at
  home?: number           // tie-break preference
  unitCap?: number        // per term, in the home (termSystem) unit system; default 16 quarter / 12 semester
  maxTerms?: number
  startTerm?: { season: 'Fall' | 'Winter' | 'Spring'; year: number }
  termSystem?: TermSystem                     // home college's system; Plan units are reported in it
  unitSystems?: Record<number, TermSystem>    // institutionId -> native system; missing => assumed termSystem
  budget?: number                             // search nodes before falling back to greedy (optimal = false); default 200k
}

const half = (u: number) => Math.round(u * 2) / 2

/** Native course units -> home-system units, nearest 0.5 (exact: unrounded, for sums; F-16). */
const convert = (units: number, from: TermSystem, to: TermSystem, exact = false) => {
  const u = from === to ? units : from === 'semester' ? units * 1.5 : units / 1.5
  return exact || from === to ? u : half(u)
}

const INF = Number.POSITIVE_INFINITY
const EPS = 1e-6            // unit sums are unrounded conversions (5q = 3.333s): equal within EPS
const CONFIGS = 5_000       // ways to pass the tree (OR / N_OF choices) searched exactly
const shortName = new Map((institutions as Institution[]).map((i) => [i.id, i.short]))

/** Lexicographic order; numbers within EPS tie. */
const lex = (x: (number | string)[], y: (number | string)[]) => {
  for (let i = 0; i < x.length; i++) {
    const p = x[i], q = y[i]
    if (typeof p === 'number' && typeof q === 'number' ? Math.abs(p - q) > EPS : p !== q) return p < q ? -1 : 1
  }
  return 0
}
const stripH = (c: CourseId) => c.replace(/H$/, '')
const instOf = (c: CourseId) => Number(c.slice(0, c.indexOf(':')))
/** verify's rule: pieces at two colleges that are different courses (1BH here, 1B there is a duplicate). */
const code = (c: CourseId) => stripH(c.slice(c.indexOf(':') + 1))
const splitAt = (st: ReqStatus) => !st.satisfied && new Set(st.partials.map((p: Partial) => p.institutionId)).size > 1 &&
  new Set(st.partials.flatMap((p) => p.have.map(code))).size > 1

/**
 * Exact minimum-unit plan. The tree is passed by one of its "configs" (a set of requirements to complete, one per
 * combination of OR / N_OF choices); a config's requirements split into independent components (no shared course,
 * no split series between them), each solved by branch-and-bound over its requirements' groups. Objective, in order:
 * requirements left unmet, units, new split series, units away from home, honors courses, courses, course ids.
 * Falls back to the greedy set cover (optimal = false) past the search budget. Then quarter packing.
 */
export function solve(taken: Set<CourseId>, a: Agreement, opts: SolveOptions): Plan {
  const { allowed, home, termSystem = 'quarter', unitSystems = {}, maxTerms = 6, startTerm = { season: 'Fall', year: 2026 }, budget = 200_000 } = opts
  const unitCap = opts.unitCap ?? (termSystem === 'semester' ? 12 : 16)
  const unitsOf = (c: CourseId, exact = false) => {
    const k = a.catalog[c]
    return k ? convert(k.units, unitSystems[k.institutionId] ?? termSystem, termSystem, exact) : 0
  }

  /* ---- the tree under the transfer rules ---- */

  // Unique requirements (Berkeley ME lists its chemistry row twice; it is one requirement).
  const L: Requirement[] = [], ix = new Map<Requirement, number>(), seen = new Map<string, number>()
  const walk = (n: ReqNode | Requirement): void => {
    if (n.kind === 'node') return n.children.forEach(walk)
    const k = `${n.id}\u0000${JSON.stringify(n.groups)}`
    if (!seen.has(k)) seen.set(k, L.push(n) - 1)
    ix.set(n, seen.get(k)!)
  }
  walk(a.root)
  type Ok = (i: number) => boolean
  const kidsOf = (n: ReqNode) => n.children.filter((c) => c.kind === 'req' || c.required) // optional subtrees never fail a parent
  const freeM = new Map<ReqNode | Requirement, boolean>(), quotaM = new Map<ReqNode, { art: (ReqNode | Requirement)[]; k: number }>()
  /** Passes with no courses at all: every requirement in it is completed at the university (no groups). */
  const free = (n: ReqNode | Requirement): boolean => {
    let f = freeM.get(n)
    if (f === undefined) freeM.set(n, (f = pass(n, () => false)))
    return f
  }
  /** OR / N_OF: how many articulable children must pass. A deferred child fills a slot only if the articulable ones cannot reach n. */
  const quota = (n: ReqNode) => {
    let q = quotaM.get(n)
    if (!q) {
      const kids = kidsOf(n), art = kids.filter((c) => !free(c)), fixed = n.children.length - kids.length
      const need = n.type === 'OR' ? 1 : n.n ?? 1
      quotaM.set(n, (q = { art, k: need - fixed - Math.min(kids.length - art.length, Math.max(0, need - fixed - art.length)) }))
    }
    return q
  }
  /** Does the subtree pass, given which requirements are complete? A requirement no college articulates is deferred. */
  const pass = (n: ReqNode | Requirement, ok: Ok): boolean => {
    if (n.kind === 'req') return !n.groups.length || ok(ix.get(n)!)
    if (n.type === 'AND') return kidsOf(n).every((c) => pass(c, ok))
    const { art, k } = quota(n)
    return art.filter((c) => pass(c, ok)).length >= k
  }
  /** Requirements the agreement still needs: every failing required path from the root. */
  const needy = (ok: Ok) => {
    const out = new Set<number>()
    const go = (n: ReqNode | Requirement): void => {
      if (n.kind === 'req') out.add(ix.get(n)!)
      else kidsOf(n).forEach((c) => { if (!pass(c, ok)) go(c) })
    }
    if (a.root.required && !pass(a.root, ok)) go(a.root)
    return out
  }
  const statOf = (h: Set<CourseId>) => L.map((r) => reqStatus(r, h))
  const st0 = statOf(taken), sat0 = st0.map((s) => !!s.satisfied), split0 = st0.map(splitAt)
  const withTaken = (cs: Iterable<CourseId>) => new Set([...taken, ...cs])
  /** New split series in requirements the agreement still needs: the rules forbid the solver to create these. */
  const blocking = (h: Set<CourseId>) => {
    const st = statOf(h)
    return [...needy((i) => !!st[i].satisfied)].filter((i) => splitAt(st[i]) && !split0[i]).sort((x, y) => x - y)
  }
  const newSplits = (h: Set<CourseId>) => statOf(h).filter((s, i) => splitAt(s) && !split0[i]).length

  /** Per requirement, the course sets that complete one group at an allowed college, honors twins swapped in where it mixes. */
  const ways: CourseId[][][] = L.map((r, i) => {
    if (sat0[i]) return []
    const mix = honorsColleges(r), out = new Map<string, CourseId[]>()
    for (const g of r.groups) {
      if (!allowed.includes(g.institutionId)) continue
      let vs: CourseId[][] = [[]]
      for (const c of g.courses) {
        if (has(taken, c, mix)) continue
        // A course missing from the catalog has unknown units: not plannable.
        const alt = [c, ...(mix.has(g.institutionId) ? [c.endsWith('H') ? stripH(c) : `${c}H`] : [])].filter((x) => a.catalog[x])
        vs = vs.flatMap((v) => alt.map((x) => [...v, x]))
      }
      for (const v of vs) { const s = [...new Set(v)].sort(); out.set(s.join('+'), s) }
    }
    return [...out.values()]
  })
  const pool = ways.map((w) => new Set(w.flat()))
  /** Additive cost of one course: units, units away from home, honors, count. */
  const vec = new Map<CourseId, number[]>()
  pool.forEach((s) => s.forEach((c) => { const u = unitsOf(c, true); vec.set(c, [u, instOf(c) === home ? 0 : u, /H$/.test(c) ? 1 : 0, 1]) }))
  const sumV = (cs: CourseId[]) => cs.reduce((t, c) => t.map((x, j) => x + vec.get(c)![j]), [0, 0, 0, 0])

  /* ---- what cannot be met at `allowed`, named so the student can act on it ---- */

  const other = a.sendingIds.filter((i) => !allowed.includes(i)) // in-scope colleges the student could add
  const listed = (ids: number[]) => {
    const ns = ids.map((i) => shortName.get(i)).filter((s): s is string => !!s).sort()
    return ns.length ? ` — offered at ${ns.join(', ')}` : ''
  }
  /** Completable at the allowed colleges (plus college `x`), all else aside. */
  const can = (n: ReqNode | Requirement, x?: number) => pass(n, (i) => sat0[i] || ways[i].length > 0 || L[i].groups.some((g) => g.institutionId === x))
  const offered = (r: Requirement) => `${r.id}${listed(other.filter((x) => r.groups.some((g) => g.institutionId === x)))}`
  const names = (n: ReqNode | Requirement): string => {
    if (n.kind === 'req') return n.id
    const ks = kidsOf(n).filter((c) => !free(c))
    return ks.length === 1 ? names(ks[0]) : `(${ks.map(names).sort().join(' + ')})`
  }
  /** "1 of: (ECS 032B + ECS 036A), ECS 032A — offered at De Anza": colleges where one more alternative could be completed. */
  const shortfall = (n: ReqNode) => {
    const { art, k } = quota(n), ok = art.filter((c) => can(c)), rest = art.filter((c) => !ok.includes(c))
    const at = other.filter((x) => rest.some((c) => can(c, x)))
    return `${k - ok.length}${ok.length ? ' more' : ''} of: ${[...new Set(rest.map(names))].sort().join(', ')}${listed(at)}`
  }

  /* ---- configs: minimal sets of articulable requirements whose completion passes the tree ---- */

  const pseudo: string[] = [] // an N_OF with fewer articulable children than it needs: id L.length + k
  let overflow = false
  const norm = (cs: number[][]) => {
    const out: number[][] = []
    for (const c of [...new Map(cs.map((c) => [c.join(), c])).values()].sort((x, y) => x.length - y.length)) {
      const s = new Set(c)
      if (!out.some((o) => o.every((i) => s.has(i)))) out.push(c) // a superset config can never be cheaper
    }
    if (out.length > CONFIGS) overflow = true
    return overflow ? out.slice(0, 1) : out
  }
  const cross = (ls: number[][][]) => ls.reduce<number[][]>((acc, l) => norm(acc.flatMap((x) => l.map((y) => [...new Set([...x, ...y])].sort((p, q) => p - q)))), [[]])
  const cfgs = (n: ReqNode | Requirement): number[][] => {
    if (overflow) return [[]]
    if (n.kind === 'req') return [n.groups.length ? [ix.get(n)!] : []] // one with no way at `allowed` is given up
    if (n.type === 'AND') return cross(kidsOf(n).map(cfgs))
    const { art, k } = quota(n), ok = art.filter((c) => can(c))
    if (k <= 0) return [[]]
    // Fewer alternatives completable here than needed: plan those, report the rest as one shortfall. Part of an
    // alternative that cannot be completed earns nothing, so it is never planned.
    if (ok.length < k) return cross([...ok.map(cfgs), [[L.length + pseudo.push(shortfall(n)) - 1]]])
    const sub = ok.map(cfgs), out: number[][] = []
    const pick = (from: number, got: number[]): void => {
      if (got.length === k) { out.push(...cross(got.map((i) => sub[i]))); if (out.length > CONFIGS) overflow = true; return }
      for (let i = from; i <= ok.length - (k - got.length) && !overflow; i++) pick(i + 1, [...got, i])
    }
    pick(0, [])
    return norm(out)
  }
  const configs = a.root.required ? cfgs(a.root) : [[]]

  /* ---- branch-and-bound ---- */

  // v: requirements given up, units, new splits, units away from home, honors courses, courses. Then course ids,
  // requirements given up, the config: the order never depends on input order.
  type Sol = { v: number[]; cs: CourseId[]; skip: number[]; cfg: number[] }
  const idsOf = (is: number[]) => is.map((i) => (i < L.length ? L[i].id : pseudo[i - L.length])).sort()
  const flat = (x: Sol) => [...x.v, ...x.cs, ...idsOf(x.skip), x.cfg.length, ...idsOf(x.cfg)]
  const better = (x: Sol, y: Sol | null) => !y || lex(flat(x), flat(y)) < 0
  let nodes = 0
  const memo = new Map<string, Sol | null>()

  /** Cheapest way to complete requirements `ls` (independent of everything else). `ws`: other requirements their
   *  courses touch, where a new split is counted, or, if in `guard`, forbidden; with a guard a requirement may be skipped. */
  const component = (ls: number[], ws: number[], guard: Set<number> | null): Sol | null => {
    const order = [...ls].sort((x, y) => ways[x].length - ways[y].length || x - y)
    const P = new Set<CourseId>(), skip: number[] = []
    let best: Sol | null = null
    const done = (i: number) => ways[i].some((w) => w.every((c) => P.has(c)))
    /** Admissible bound: each remaining requirement's cheapest group, a course shared by m of them costing 1/m each. */
    const bound = (k: number) => {
      const rest = order.slice(k).filter((i) => !done(i)), share = new Map<CourseId, number>()
      for (const i of rest) for (const c of pool[i]) if (!P.has(c)) share.set(c, (share.get(c) ?? 0) + 1)
      const t = [skip.length, ...sumV([...P])]
      for (const i of rest) {
        let m: number[] | null = null
        for (const w of ways[i]) {
          const s = [0, 0, 0, 0]
          for (const c of w) if (!P.has(c)) vec.get(c)!.forEach((x, j) => (s[j] += x / share.get(c)!))
          if (!m || lex(s, m) < 0) m = s
        }
        m!.forEach((x, j) => (t[j + 1] += x))
      }
      return [t[0], t[1], 0, t[2], t[3], t[4]]
    }
    const finish = () => {
      const h = withTaken(P)
      let splits = 0
      for (const w of [...ws, ...skip]) {
        if (!splitAt(reqStatus(L[w], h)) || split0[w]) continue
        if (guard && (guard.has(w) || skip.includes(w))) return
        splits++
      }
      const cs = [...P].sort(), [u, away, hon, n] = sumV(cs)
      const s: Sol = { v: [skip.length, u, splits, away, hon, n], cs, skip: [...skip], cfg: [] }
      if (better(s, best)) best = s
    }
    const dfs = (k: number): void => {
      if (++nodes > budget) return
      while (k < order.length && done(order[k])) k++
      if (k === order.length) return finish()
      if (best && lex(bound(k), best.v) > 0) return
      const i = order[k]
      const adds = ways[i].map((w) => w.filter((c) => !P.has(c))).map((add) => ({ add, key: [...sumV(add), ...add] }))
      for (const { add } of adds.sort((x, y) => lex(x.key, y.key))) {
        add.forEach((c) => P.add(c)); dfs(k + 1); add.forEach((c) => P.delete(c))
      }
      if (guard) { skip.push(i); dfs(k + 1); skip.pop() }
    }
    dfs(0)
    return best
  }

  /** Every course a requirement's groups could match, honors twins included: where a new split can appear. */
  const touch = L.map((r) => new Set(r.groups.flatMap((g) => g.courses.flatMap((c) => [c, `${c}H`, stripH(c)]))))
  const solveConfig = (C: number[], guarded: boolean): Sol | null => {
    const F = C.filter((i) => i < L.length && !sat0[i] && ways[i].length), inF = new Set(F)
    const forced = C.filter((i) => i >= L.length || (!sat0[i] && !ways[i].length))
    const up = new Map(F.map((i) => [i, i]))
    const find = (i: number): number => (up.get(i) === i ? i : find(up.get(i)!))
    const join = (x: number, y: number) => { const p = find(x), q = find(y); if (p !== q) up.set(Math.max(p, q), Math.min(p, q)) }
    const owner = new Map<CourseId, number>()
    for (const i of F) for (const c of pool[i]) { if (owner.has(c)) join(owner.get(c)!, i); else owner.set(c, i) }
    const watch: [number, number][] = []
    for (let w = 0; w < L.length; w++) {
      if (!L[w].groups.length || sat0[w] || inF.has(w)) continue
      const hit = [...touch[w]].filter((c) => owner.has(c)).map((c) => owner.get(c)!)
      if (hit.length) { hit.forEach((i) => join(i, hit[0])); watch.push([w, hit[0]]) }
    }
    // Guarded (second pass): new splits are forbidden where the tree would still need the requirement.
    const guard = guarded ? needy((i) => sat0[i] || inF.has(i)) : null
    const comps = new Map<number, { ls: number[]; ws: number[] }>()
    const at = (i: number) => { const r = find(i); if (!comps.has(r)) comps.set(r, { ls: [], ws: [] }); return comps.get(r)! }
    F.forEach((i) => at(i).ls.push(i))
    watch.forEach(([w, i]) => at(i).ws.push(w))
    const cs: CourseId[] = [], skip = [...forced]
    let splits = 0
    for (const { ls, ws } of comps.values()) {
      const key = `${ls}|${ws}|${guard ? ws.filter((w) => guard.has(w)) : '-'}`
      if (!memo.has(key)) memo.set(key, component(ls, ws, guard))
      const s = memo.get(key)
      if (!s) return null
      cs.push(...s.cs); skip.push(...s.skip); splits += s.v[2]
    }
    cs.sort()
    const [u, away, hon, n] = sumV(cs)
    return { v: [skip.length, u, splits, away, hon, n], cs, skip: skip.sort((x, y) => x - y), cfg: C }
  }
  const search = (guarded: boolean) => {
    nodes = 0
    let best: Sol | null = null
    for (const C of configs) { const s = solveConfig(C, guarded); if (s && better(s, best)) best = s }
    return nodes > budget ? null : best
  }

  /* ---- greedy set cover: the fallback ---- */

  const uses = new Map<CourseId, Set<string>>() // course -> requirement ids it appears in
  L.forEach((r) => r.groups.forEach((g) => g.courses.forEach((c) => uses.set(c, (uses.get(c) ?? new Set()).add(r.id)))))
  const reach = (g: CourseGroup) => new Set(g.courses.flatMap((c) => [...uses.get(c)!])).size
  /**
   * README tie-break as a strict lexicographic key: cost, home college, fewer honors, fewer courses; then, so the
   * result never depends on input order, courses that serve more requirements, college id and course ids.
   */
  type Cand = { g: CourseGroup; cost: number }
  const rank = ({ g, cost }: Cand): (number | string)[] =>
    [cost, g.institutionId === home ? 0 : 1, g.courses.filter((c) => /H$/.test(c)).length, g.courses.length, -reach(g), g.institutionId, [...g.courses].sort().join('+'), g.courses.join('+')]
  const cmp = (x: (number | string)[], y: (number | string)[]) => {
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
    return 0
  }
  /** The best group the plan completes for a requirement (reported as `chosen`). */
  const completed = (r: Requirement, h: Set<CourseId>) => {
    const mix = honorsColleges(r)
    return r.groups.filter((g) => g.courses.every((c) => has(h, c, mix))).map((g) => ({ g, cost: 0 })).sort((x, y) => cmp(rank(x), rank(y)))[0]?.g
  }

  /** Greedy set cover over the tree; `banned` groups (they would open a blocking split) are never picked. */
  const greedy = (banned: Map<CourseGroup, string>) => {
    /** Courses still to plan for a group; where only the honors twin is in the catalog (and they mix), the twin. */
    const toPlan = (g: CourseGroup, h: Set<CourseId>, mix: ReadonlySet<number>) => g.courses.filter((c) => !has(h, c, mix))
      .map((c) => (a.catalog[c] || !mix.has(g.institutionId) ? c : c.endsWith('H') ? stripH(c) : `${c}H`))
    const planned = new Set<CourseId>()
    const have = () => withTaken(planned)
    const chosen: Record<string, CourseGroup> = {}
    const unsolvable = new Set<string>()
    const splitting = new Set<CourseGroup>() // groups that would open a new split series: last resort only
    const SPLIT = 1e6                         // their cost penalty, so any non-splitting route wins
    const forced = new Map<CourseGroup, string[]>() // last-resort group -> splits it opened

    const bestGroup = (req: Requirement, h: Set<CourseId>): Cand | null => {
      let best: Cand | null = null
      const mix = honorsColleges(req)
      for (const g of req.groups) {
        const need = toPlan(g, h, mix)
        // Only complete groups at colleges the student can attend, unless it is already complete.
        if (need.length && (!allowed.includes(g.institutionId) || banned.has(g))) continue
        // A course missing from the catalog has unknown units: not plannable.
        if (need.some((c) => !a.catalog[c])) continue
        // Marginal home-system units to complete the group given what is already taken or planned.
        const cand = { g, cost: need.reduce((s, c) => s + unitsOf(c), 0) + (splitting.has(g) ? SPLIT : 0) }
        if (!best || cmp(rank(cand), rank(best)) < 0) best = cand
      }
      return best
    }

    /** Estimated cost to satisfy a subtree from scratch (used to choose among OR / N_OF children). */
    const estimate = (n: ReqNode | Requirement, h: Set<CourseId>): number => {
      if (n.kind === 'req') return !n.groups.length || reqStatus(n, h).satisfied ? 0 : bestGroup(n, h)?.cost ?? INF
      if (n.type === 'AND') return kidsOf(n).reduce((s, c) => s + estimate(c, h), 0)
      const { art, k } = quota(n), costs = art.map((c) => estimate(c, h)).sort((x, y) => x - y)
      return k <= 0 ? 0 : k > costs.length ? INF : costs.slice(0, k).reduce((s, c) => s + c, 0)
    }

    /** Order-independent name of a subtree, to break cost ties among OR / N_OF children. */
    const keyOf = (n: ReqNode | Requirement): string => (n.kind === 'req' ? n.id : `(${n.children.map(keyOf).sort().join(',')})`)

    /**
     * Collect the requirements that still need a group, choosing cheapest branches at OR / N_OF. `alt` gets those
     * reached through such a choice, which may still change as courses are planned.
     */
    const needed = (n: ReqNode | Requirement, h: Set<CourseId>, ok: Ok, acc: Requirement[], alt: Set<Requirement>, inAlt = false): void => {
      if (n.kind === 'req') { if (n.groups.length && !ok(ix.get(n)!)) { acc.push(n); if (inAlt) alt.add(n) } return }
      if (!n.required) return
      if (n.type === 'AND') { kidsOf(n).forEach((c) => needed(c, h, ok, acc, alt, inAlt)); return }
      const { art, k } = quota(n)
      const ranked = art
        .map((c) => ({ c, done: pass(c, ok), cost: estimate(c, h), key: keyOf(c) }))
        .sort((x, y) => x.cost - y.cost || cmp([x.key], [y.key]))
      const done = ranked.filter((r) => r.done).length
      ranked.filter((r) => !r.done && r.cost < INF).slice(0, Math.max(0, k - done)).forEach((r) => needed(r.c, h, ok, acc, alt, true))
      if (ranked.filter((r) => r.cost < INF).length < k) unsolvable.add(shortfall(n))
    }

    const splitIds = (h: Set<CourseId>) => new Set(verifySchedule(h, a).splitSeriesViolations.map((v) => v.requirementId))
    const giveUp = (req: Requirement) => {
      const why = req.groups.filter((g) => banned.has(g)).map((g) => banned.get(g)!)
      unsolvable.add(why.length ? `${req.id} (only by splitting ${[...new Set(why)].sort().join(', ')})` : offered(req))
    }

    // One group per iteration so shared courses (De Anza MATH 1B serves MATH 51 and 52) get counted once.
    // Each round satisfies a leaf or penalizes a group, so this bound (from the tree size) is never hit on a sane tree.
    let rounds = L.reduce((s, r) => s + 1 + r.groups.length, 1)
    let before = splitIds(have())
    const pickedFor = new Map<string, Requirement>()
    for (;;) {
      const h = have(), st = statOf(h)
      const todo: Requirement[] = [], alt = new Set<Requirement>()
      needed(a.root, h, (i) => !!st[i].satisfied, todo, alt)
      if (!rounds--) { todo.forEach(giveUp); break }
      let pick: { req: Requirement; g: CourseGroup; cost: number } | null = null
      for (const req of todo) {
        const b = bestGroup(req, h)
        if (!b) { giveUp(req); continue }
        // Equal cost: commit forced requirements before OR / N_OF alternatives, whose ranking they can change.
        const key = (r: Requirement, c: Cand) => [c.cost, alt.has(r) ? 1 : 0, ...rank(c).slice(1), r.id]
        if (!pick || cmp(key(req, b), key(pick.req, pick)) < 0) pick = { req, ...b }
      }
      if (!pick) break
      const mix = honorsColleges(pick.req)
      const next = new Set(h)
      toPlan(pick.g, h, mix).forEach((c) => next.add(c))
      // Avoid opening a new split series elsewhere (e.g. an unused N_OF alternative) while another route exists.
      const after = splitIds(next), opened = [...after].filter((id) => !before.has(id)).sort()
      if (opened.length && !splitting.has(pick.g)) { splitting.add(pick.g); continue }
      if (opened.length) forced.set(pick.g, opened)
      before = after
      chosen[pick.req.id] = pick.g; pickedFor.set(pick.req.id, pick.req)
      next.forEach((c) => { if (!taken.has(c)) planned.add(c) })
    }

    // Drop planned courses a later pick made redundant: every satisfied requirement stays satisfied, no new split.
    const final = verifySchedule(have(), a)
    const splits = new Set(final.splitSeriesViolations.map((v) => v.requirementId))
    for (const c of [...planned].sort((x, y) => unitsOf(y) - unitsOf(x) || cmp([x], [y]))) {
      planned.delete(c)
      const r = verifySchedule(have(), a)
      if (Object.keys(final.satisfied).some((id) => !r.satisfied[id]) || r.splitSeriesViolations.some((v) => !splits.has(v.requirementId))) planned.add(c)
    }
    const hp = have()
    for (const id of Object.keys(chosen)) {
      // A pruned group is reported as the best group the kept courses still complete.
      const g = completed(pickedFor.get(id)!, hp)
      if (!chosen[id].courses.every((c) => has(hp, c, honorsColleges(pickedFor.get(id)!)))) { if (g) chosen[id] = g; else delete chosen[id] }
    }
    return { planned: [...planned].sort(), chosen, unsolvable: [...unsolvable], forced }
  }
  /** Greedy, re-run with every last-resort group whose split the final plan still needs banned. */
  const fallback = () => {
    const banned = new Map<CourseGroup, string>()
    for (;;) {
      const g = greedy(banned)
      const bad = new Set(blocking(withTaken(g.planned)).map((i) => L[i].id))
      const culprits = [...g.forced].filter(([grp, ids]) => !banned.has(grp) && ids.some((id) => bad.has(id)))
      if (!bad.size || !culprits.length) return g
      culprits.forEach(([grp, ids]) => banned.set(grp, ids.filter((id) => bad.has(id)).join(', ')))
    }
  }
  /** Comparable score of any plan: fewest requirements left unmet over all configs, then the search objective. */
  const score = (cs: CourseId[]): Sol => {
    const h = withTaken(cs), st = statOf(h)
    const give = Math.min(...configs.map((C) => C.filter((i) => i >= L.length || !st[i].satisfied).length))
    const [u, away, hon, n] = sumV(cs.filter((c) => vec.has(c)))
    return { v: [give, u, newSplits(h), away, hon, n], cs, skip: [], cfg: [] }
  }

  /* ---- choose ---- */

  // Pass 1 counts new splits but forbids none: if its optimum opens no split the plan still needs, it is optimal
  // outright (the constraint only removes plans). Otherwise pass 2 forbids them, and the result is not proven.
  let best = overflow ? null : search(false), optimal = !!best
  if (best && blocking(withTaken(best.cs)).length) {
    optimal = false
    best = search(true)
    if (best && blocking(withTaken(best.cs)).length) best = null
  }
  let planned: CourseId[], chosen: Record<string, CourseGroup> = {}, unsolvable: string[]
  const g = optimal ? null : fallback()
  if (best && (!g || lex(score(best.cs).v, score(g.planned).v) <= 0)) {
    planned = best.cs
    const h = withTaken(planned), st = statOf(h)
    for (const i of best.cfg) if (i < L.length && !sat0[i] && st[i].satisfied) chosen[L[i].id] = completed(L[i], h)!
    unsolvable = best.skip.filter((i) => i >= L.length || !st[i].satisfied).map((i) => {
      if (i >= L.length) return pseudo[i - L.length]
      if (!ways[i].length) return offered(L[i])
      // Given up only because every group would open a split the agreement still needs.
      const w = ways[i].map((x) => x.filter((c) => !h.has(c))).sort((x, y) => lex([...sumV(x), ...x], [...sumV(y), ...y]))[0]
      const ids = blocking(new Set([...h, ...w])).map((j) => L[j].id)
      return `${L[i].id} (only by splitting ${ids.length ? ids.join(', ') : 'a series'})`
    })
  } else ({ planned, chosen, unsolvable } = g!)
  const terms = pack([...planned], (c) => unitsOf(c, true), unitCap, maxTerms, startTerm, termSystem, (c) => a.catalog[c]?.title ?? '')
  const result = verifySchedule(withTaken(planned), a)
  return { terms, chosen, result, totalUnits: half(planned.reduce((s, c) => s + unitsOf(c, true), 0)), unsolvable, optimal }
}

/* ---- term packing ---- */

/** "113:PHYS 4B" -> { stem: "113:PHYS 4", seq: 1 }  (A=0, B=1 ...; plain number = -1). Honors "1BH" collapses to "1B",
 *  "7H" to "7". The stem keeps the college: series order never crosses campuses. */
const seqKey = (id: CourseId) => {
  const m = /^(\d+):(.+?)\s(\d+)(?:H|([A-Z])H?)?$/.exec(id)
  return m ? { stem: `${m[1]}:${m[2]} ${Number(m[3])}`, prev: `${m[1]}:${m[2]} ${Number(m[3]) - 1}`, seq: m[4] ? m[4].charCodeAt(0) - 65 : -1 } : null
}

/** "General Chemistry II" -> { base: "general chemistry #", n: 2 }: exactly one ordinal token (I-IV or 1-4). */
const ordinalTitle = (t: string) => {
  const toks = t.trim().toLowerCase().split(/\s+/)
  const at = toks.flatMap((w, i) => (/^(i{1,3}|iv|[1-4])$/.test(w) ? [i] : []))
  if (at.length !== 1) return null
  const w = toks[at[0]], n = /\d/.test(w) ? Number(w) : w === 'iv' ? 4 : w.length
  return { base: toks.map((x, i) => (i === at[0] ? '#' : x)).join(' '), n }
}

// ponytail: sequence order inferred from letter suffix (4A < 4B < 4C) within one college, and for plain numbers only
// when titles say so (CHEM 11 "General Chemistry I" < CHEM 12 "... II"); swap for real requisite data if ASSIST ever
// populates `requisites`. Plain PHYSCS 21/22/23 ("Mechanics", "Electricity and Magnetism", ...) stay unordered.
function pack(courses: CourseId[], unitsOf: (c: CourseId) => number, cap: number, maxTerms: number, start: NonNullable<SolveOptions['startTerm']>, system: TermSystem, titleOf: (c: CourseId) => string = () => ''): Term[] {
  if (!(cap > 0 && Number.isFinite(cap))) cap = system === 'semester' ? 12 : 16 // NaN / <=0 / Infinity -> default
  const keys = new Map(courses.map((c) => [c, seqKey(c)]))
  // pred: nearest lower letter planned in the same series (1A -> 1C when 1B is not needed); for the first course of a
  // series (2A), the last planned course of the numerically previous series at the same college (1C -> 2A); for a
  // plain number, the previous plain number whose title differs only by ordinal (CHEM 11 -> CHEM 12).
  const pred = (c: CourseId) => {
    const k = keys.get(c)
    if (!k) return undefined
    if (k.seq < 0) {
      const t = ordinalTitle(titleOf(c))
      return t ? courses.find((o) => { const ko = keys.get(o), to = ordinalTitle(titleOf(o)); return ko?.stem === k.prev && ko.seq < 0 && to?.base === t.base && to.n === t.n - 1 }) : undefined
    }
    if (k.seq > 0) return courses.filter((o) => { const ko = keys.get(o); return ko?.stem === k.stem && ko.seq >= 0 && ko.seq < k.seq }).sort((x, y) => keys.get(y)!.seq - keys.get(x)!.seq)[0]
    // ponytail: assume the third course (C) of the lower series is the gate, as with MATH 1C -> 2A; real requisites if ASSIST ever ships them
    const lowerCourses = courses.filter((o) => keys.get(o)?.stem === k.prev)
    return lowerCourses.find((o) => keys.get(o)!.seq === 2) ?? lowerCourses.sort((x, y) => keys.get(y)!.seq - keys.get(x)!.seq)[0]
  }
  const depth = (c: CourseId, d = 0): number => { const p = pred(c); return p && d < 10 ? depth(p, d + 1) : d }
  const ordered = [...courses].sort((x, y) => depth(x) - depth(y) || unitsOf(y) - unitsOf(x))

  const seasons: string[] = system === 'semester' ? ['Fall', 'Spring'] : ['Fall', 'Winter', 'Spring']
  const name = (i: number) => {
    // A season the system lacks (Winter on semesters) starts at the next one: Winter 2027 -> Spring 2027.
    let si = seasons.indexOf(start.season), year = start.year
    if (si < 0) si = start.season === 'Winter' ? seasons.indexOf('Spring') : 0
    for (let k = 0; k < i; k++) { si = (si + 1) % seasons.length; if (si === 1) year++ } // Fall 2026 -> Winter/Spring 2027 -> Fall 2027
    return `${seasons[si]} ${year}`
  }
  const EPS = 1e-9 // units are exact (unrounded) conversions, e.g. 5q = 3.333s
  const terms: Term[] = []
  const placed = new Map<CourseId, number>()
  for (const c of ordered) {
    const units = unitsOf(c)
    const p = pred(c)
    let i = p !== undefined && placed.has(p) ? placed.get(p)! + 1 : 0
    while (terms[i] && terms[i].units + units > cap + EPS) i++
    while (terms.length <= i) terms.push({ name: name(terms.length), courses: [], units: 0 })
    terms[i].courses.push(c); terms[i].units += units; placed.set(c, i)
  }
  // Only a single course larger than the cap can overflow a term; flag it rather than hide it.
  for (const t of terms) { if (t.units > cap + EPS) t.overCap = true; t.units = half(t.units) }
  return terms.slice(0, Math.max(maxTerms, terms.length)) // never silently drop courses; UI flags > maxTerms
}
