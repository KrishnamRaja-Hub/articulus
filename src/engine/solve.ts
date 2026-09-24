import type { Agreement, CourseGroup, CourseId, Institution, Partial, Plan, ReqNode, Requirement, Term } from './types'
import { canRoute, has, honorsColleges, isDeferrable, reqStatus, ucOnly, verifySchedule, type ReqStatus } from './verify.ts'
import institutions from '../../data/institutions.json' with { type: 'json' }
import { prereqs } from './sequence.ts'
import { prereqClosure, prereqGraph } from './prereq.ts'

export type TermSystem = 'quarter' | 'semester'

export interface SolveOptions {
  allowed: number[]       // institutions the student can enroll at
  home?: number           // the student's college: no college penalty there; also a tie-break
  unitCap?: number        // per term, in the home (termSystem) unit system; default 16 quarter / 12 semester
  maxTerms?: number
  startTerm?: { season: 'Fall' | 'Winter' | 'Spring'; year: number }
  termSystem?: TermSystem                     // home college's system; Plan units are reported in it
  unitSystems?: Record<number, TermSystem>    // institutionId -> native system; missing => assumed termSystem
  budget?: number                             // search nodes before falling back to greedy (optimal = false); default 200k
  /** Cost of each college other than `home` that planned courses use, in quarter units (5 = about one course),
   *  converted to termSystem. Default 5. 0 (with chainPenalty 0) is pure minimum units. */
  collegePenalty?: number
  /** Cost of each subject chain (see `solve`) planned across two or more colleges, in quarter units. Default 5. */
  chainPenalty?: number
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
const colleges0 = new Map<CourseId, number>()
const instOf = (c: CourseId) => {
  let k = colleges0.get(c)
  if (k === undefined) colleges0.set(c, (k = Number(c.slice(0, c.indexOf(':')))))
  return k
}
/** verify's rule: pieces at two colleges that are different courses (1BH here, 1B there is a duplicate). */
const code = (c: CourseId) => stripH(c.slice(c.indexOf(':') + 1))
const splitAt = (st: ReqStatus) => !st.satisfied && new Set(st.partials.map((p: Partial) => p.institutionId)).size > 1 &&
  new Set(st.partials.flatMap((p) => p.have.map(code))).size > 1

/** Required children only: optional (recommended) subtrees never fail, satisfy or defer anything for their parent. */
const kidsOf = (n: ReqNode) => n.children.filter((c) => c.kind === 'req' || c.required)
const needOf = (n: ReqNode) => (n.type === 'OR' ? 1 : n.n ?? 1)

/**
 * verify's fold, given which rows are complete. `sat`: done with CC courses; `def`: passes only because what is left
 * is UC-only; `open`: needs more. In an OR / N_OF, UC-only alternatives fill slots only while no articulable
 * alternative (verify.canRoute) is open: the CC route is owed first. A row with no groups and no ASSIST reason is
 * neither articulable nor UC-only.
 */
export function treeState(n: ReqNode | Requirement, done: (r: Requirement) => boolean): 'sat' | 'def' | 'open' {
  if (n.kind === 'req') return done(n) ? 'sat' : ucOnly(n) ? 'def' : 'open'
  const ks = kidsOf(n), sts = ks.map((c) => treeState(c, done))
  const sat = sts.filter((s) => s === 'sat').length
  if (n.type === 'AND') return sts.includes('open') ? 'open' : sat || !ks.length ? 'sat' : 'def'
  const need = needOf(n)
  if (sat >= need) return 'sat'
  const open = ks.filter((c, j) => sts[j] === 'open' && canRoute(c)).length, def = sts.filter((s) => s === 'def').length
  return open || sat + def < need ? 'open' : 'def'
}

/** Can the subtree pass as `def` for some set of complete rows? Over-approximate: it only gates route enumeration. */
const mayDefM = new WeakMap<ReqNode | Requirement, boolean>()
const mayDef = (n: ReqNode | Requirement): boolean => {
  if (n.kind === 'req') return ucOnly(n)
  let v = mayDefM.get(n)
  if (v === undefined) {
    const ks = kidsOf(n), art = ks.filter(canRoute)
    v = n.type === 'AND' ? ks.length > 0 && ks.every(mayDef) : needOf(n) > 0 && art.length >= needOf(n) && art.some(mayDef)
    mayDefM.set(n, v)
  }
  return v
}

/** "MATH 51" -> "MATH", "COM SCI M51A" -> "COM SCI", "CHEM 1A, CHEM 1AL" -> "CHEM": the UC subject of a row. */
const subjectOf = (id: string) => {
  const t = id.split(',')[0].trim().split(/\s+/), k = t.findIndex((w) => /\d/.test(w))
  return t.slice(0, k < 0 ? t.length : k).join(' ')
}

/**
 * Exact minimum-cost plan. Cost, in order: requirements left unmet; then units + collegePenalty per college other
 * than home that planned courses use + chainPenalty per subject chain split across colleges; then new split series,
 * units away from home, honors courses, courses, course ids. Penalties are in quarter units, costed in termSystem.
 *
 * Subject chain: the rows of the agreement that share a UC subject (MATH 51/52/53/54, PHYSICS 7A/7B/7C), when at least
 * two such rows have CC groups. A course belongs to it when it (or its honors twin) appears in one of those rows'
 * groups. The chain is split when its planned courses sit at two or more colleges, or at a college other than one
 * where the student took courses of it. Taken courses alone cost nothing.
 *
 * The tree is passed by one of its "configs" (a minimal set of requirements to complete, under verify's rules); for a
 * set of colleges the student would attend, a config's requirements split into independent components (no shared
 * course, no split series and no subject chain between them), each solved by branch-and-bound over its requirements'
 * groups. An outer branch-and-bound over the colleges charges each one used. Falls back to the greedy set cover
 * (optimal = false) past the search budget. Then quarter packing.
 */
export function solve(taken: Set<CourseId>, a: Agreement, opts: SolveOptions): Plan {
  const { allowed, home, termSystem = 'quarter', unitSystems = {}, maxTerms = 6, startTerm = { season: 'Fall', year: 2026 }, budget = 200_000 } = opts
  const unitCap = opts.unitCap ?? (termSystem === 'semester' ? 12 : 16)
  const unitsOf = (c: CourseId, exact = false) => {
    const k = a.catalog[c]
    return k ? convert(k.units, unitSystems[k.institutionId] ?? termSystem, termSystem, exact) : 0
  }
  const penalty = (q = 5) => (Number.isFinite(q) && q > 0 ? convert(q, 'quarter', termSystem, true) : 0)
  const pCollege = penalty(opts.collegePenalty), pChain = penalty(opts.chainPenalty)

  /* ---- the tree under the transfer rules ---- */

  // Unique requirements (Berkeley ME lists its chemistry row twice; it is one requirement). The key ignores the order
  // of groups and of their courses: two listings that differ only in order are the same requirement.
  const L: Requirement[] = [], keyOfL: string[] = [], ix = new Map<Requirement, number>(), seen = new Map<string, number>()
  const walk = (n: ReqNode | Requirement): void => {
    if (n.kind === 'node') return n.children.forEach(walk)
    const k = `${n.id}\u0000${n.groups.map((g) => `${g.institutionId}:${[...g.courses].sort().join('+')}`).sort().join('|')}`
    if (!seen.has(k)) { seen.set(k, L.push(n) - 1); keyOfL.push(k) }
    ix.set(n, seen.get(k)!)
  }
  walk(a.root)
  type Ok = (i: number) => boolean
  const state = (n: ReqNode | Requirement, ok: Ok) => treeState(n, (r) => ok(ix.get(r)!))
  const pass = (n: ReqNode | Requirement, ok: Ok) => state(n, ok) !== 'open'
  /** Requirements the agreement still needs (verify's rule): every failing child of a failing AND, every failing
   *  articulable alternative of a failing OR / N_OF. */
  const needy = (ok: Ok) => {
    const out = new Set<number>()
    const go = (n: ReqNode | Requirement): void => {
      if (n.kind === 'req') return void out.add(ix.get(n)!)
      for (const c of kidsOf(n)) if (!pass(c, ok) && (n.type === 'AND' || canRoute(c))) go(c)
    }
    if (!pass(a.root, ok)) go(a.root)
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
      for (const v of vs) { const s = [...new Set(v)].sort(); if (s.length) out.set(s.join('+'), s) }
    }
    return [...out.values()]
  })
  const poolOf = (w: CourseId[][][]) => w.map((x) => new Set(x.flat()))
  const pool = poolOf(ways)
  /** Additive cost of one course: units, units away from home, honors, count. */
  const vec = new Map<CourseId, number[]>()
  pool.forEach((s) => s.forEach((c) => { const u = unitsOf(c, true); vec.set(c, [u, instOf(c) === home ? 0 : u, /H$/.test(c) ? 1 : 0, 1]) }))
  const sumV = (cs: Iterable<CourseId>) => {
    let u = 0, away = 0, hon = 0, n = 0
    for (const c of cs) { const v = vec.get(c)!; u += v[0]; away += v[1]; hon += v[2]; n += v[3] }
    return [u, away, hon, n]
  }

  /* ---- colleges and subject chains: the penalties ---- */

  /** Every course a requirement's groups could match, honors twins included: where a new split can appear. */
  const touch = L.map((r) => new Set(r.groups.flatMap((g) => g.courses.flatMap((c) => [c, `${c}H`, stripH(c)]))))
  const bySubject = new Map<string, Set<string>>() // subject -> ids of its rows with CC groups
  L.forEach((r) => { const s = subjectOf(r.id); if (s && r.groups.length) bySubject.set(s, (bySubject.get(s) ?? new Set()).add(r.id)) })
  const subjects = [...bySubject].filter(([, ids]) => ids.size > 1).map(([s]) => s).sort()
  const chainsOf = new Map<CourseId, number[]>() // course -> chains it belongs to
  L.forEach((r, i) => {
    const x = subjects.indexOf(subjectOf(r.id))
    if (x >= 0) touch[i].forEach((c) => { const xs = chainsOf.get(c) ?? []; if (!xs.includes(x)) chainsOf.set(c, [...xs, x]) })
  })
  const chainOfRow = L.map((r) => subjects.indexOf(subjectOf(r.id)))
  const tookAt = subjects.map((_, x) => new Set([...taken].filter((c) => chainsOf.get(c)?.includes(x)).map(instOf)))
  /** Subject chains whose planned courses `cs` sit at 2+ colleges, counting where earlier parts were taken. */
  const chains = (cs: Iterable<CourseId>) => {
    const at = new Map<number, Set<number>>()
    for (const c of cs) for (const x of chainsOf.get(c) ?? []) at.set(x, (at.get(x) ?? new Set()).add(instOf(c)))
    let n = 0
    for (const [x, s] of at) if (s.size > 1 || [...tookAt[x]].some((i) => !s.has(i))) n++
    return n
  }
  /** Colleges other than home that `cs` uses. */
  const colleges = (cs: Iterable<CourseId>) => new Set([...cs].map(instOf).filter((i) => i !== home)).size

  /* ---- what cannot be met at `allowed`, named so the student can act on it ---- */

  const other = a.sendingIds.filter((i) => !allowed.includes(i)) // in-scope colleges the student could add
  const listed = (ids: number[]) => {
    const ns = ids.map((i) => shortName.get(i)).filter((s): s is string => !!s).sort()
    return ns.length ? ` — offered at ${ns.join(', ')}` : ''
  }
  /** Rows completable at the allowed colleges (plus college `x`), all else aside. */
  const okAt = (x?: number): Ok => (i) => sat0[i] || ways[i].length > 0 || L[i].groups.some((g) => g.institutionId === x)
  const canSat = (n: ReqNode | Requirement, x?: number) => state(n, okAt(x)) === 'sat'
  const canPass = (n: ReqNode | Requirement) => pass(n, okAt())
  // a row with no CC group and no ASSIST reason: nothing to take anywhere, and not provably UC-only
  const offered = (r: Requirement) => !r.groups.length ? `${r.id} — no ASSIST articulation record; confirm with a counselor`
    : `${r.id}${listed(other.filter((x) => r.groups.some((g) => g.institutionId === x)))}`
  const names = (n: ReqNode | Requirement): string => {
    if (n.kind === 'req') return n.id
    const ks = kidsOf(n).filter((c) => !isDeferrable(c))
    return ks.length === 1 ? names(ks[0]) : `(${ks.map(names).sort().join(' + ')})`
  }
  /** "1 of: (ECS 032B + ECS 036A), ECS 032A — offered at De Anza": colleges where one more alternative could be completed. */
  const shortfall = (n: ReqNode) => {
    const ks = kidsOf(n), k = needOf(n), ok = ks.filter((c) => canSat(c)), rest = ks.filter((c) => !ok.includes(c) && !isDeferrable(c))
    // with UC-only alternatives, passing every articulable one may need fewer
    const art = ks.filter(canRoute), viaDef = art.length >= k && art.some(mayDef) ? art.filter((c) => !canPass(c)).length : INF
    const more = Math.min(k - ok.length, viaDef)
    const at = other.filter((x) => rest.some((c) => canSat(c, x)))
    return `${more}${ok.length ? ' more' : ''} of: ${[...new Set(rest.map(names))].sort().join(', ')}${listed(at)}`
  }

  /* ---- configs: minimal sets of articulable requirements whose completion passes the tree ---- */

  const pseudo: string[] = [] // an OR / N_OF with fewer completable alternatives than it needs: id L.length + k
  let overflow = false
  /** Minimal sets only. Shortest first, a set is kept unless a kept one is inside it, so `out` only grows and is the
   *  answer so far: past CONFIGS it overflows whatever the order (and stops early). */
  const norm = (cs: number[][]) => {
    const out: number[][] = []
    for (const c of [...new Map(cs.map((c) => [c.join(), c])).values()].sort((x, y) => x.length - y.length)) {
      const s = new Set(c)
      if (!out.some((o) => o.every((i) => s.has(i)))) out.push(c) // a superset config can never be cheaper
      if (out.length > CONFIGS) { overflow = true; break }
    }
    return overflow ? out.slice(0, 1) : out
  }
  /** A name for a family that does not depend on input order (indices follow tree order; requirement keys do not). */
  const famKey = (f: number[][]) => f.map((c) => c.map((i) => (i < L.length ? keyOfL[i] : `\u0001${pseudo[i - L.length]}`)).sort().join('\u0002')).sort().join('\u0003')
  /** Every union of one set per family, minimal sets only. The families are crossed in an order fixed by their size and
   *  content, not by the tree's order, so the work done, and whether it overflows on the way, is the same for any
   *  input order. */
  const cross = (ls: number[][][]) => ls.map((l) => ({ l, k: famKey(l) })).sort((x, y) => x.l.length - y.l.length || (x.k < y.k ? -1 : x.k > y.k ? 1 : 0))
    .reduce<number[][]>((acc, { l }) => norm(acc.flatMap((x) => l.map((y) => [...new Set([...x, ...y])].sort((p, q) => p - q)))), [[]])
  type Fam = number[][]
  /** Minimal requirement sets that make the subtree `sat` (S) or pass (P). A row with no way at `allowed` is given up. */
  const fams = (n: ReqNode | Requirement): { S: Fam; P: Fam } => {
    if (overflow) return { S: [[]], P: [[]] }
    if (n.kind === 'req') return ucOnly(n) ? { S: [], P: [[]] } : { S: [[ix.get(n)!]], P: [[ix.get(n)!]] }
    const ks = kidsOf(n), fs = ks.map(fams)
    if (n.type === 'AND') {
      const P = cross(fs.map((f) => f.P))
      // `sat` once all pass, unless every child can pass as UC-only: then one of them must be `sat`
      return { S: ks.length && ks.every(mayDef) ? norm(fs.flatMap((f) => cross([f.S, P]))) : P, P }
    }
    const k = needOf(n)
    if (k <= 0) return { S: [[]], P: [[]] }
    // k alternatives `sat`. Fewer completable here than needed: plan those, report the rest as one shortfall. Part
    // of an alternative that cannot be completed earns nothing, so it is never planned.
    const ok = ks.flatMap((c, j) => (canSat(c) ? [j] : []))
    let S: Fam
    if (ok.length < k) S = cross([...ok.map((j) => fs[j].S), [[L.length + pseudo.push(shortfall(n)) - 1]]])
    else {
      const out: number[][] = []
      const pick = (from: number, got: number[]): void => {
        if (got.length === k) { out.push(...cross(got.map((j) => fs[j].S))); if (out.length > CONFIGS) overflow = true; return }
        for (let i = from; i <= ok.length - (k - got.length) && !overflow; i++) pick(i + 1, [...got, ok[i]])
      }
      pick(0, [])
      S = norm(out)
    }
    // Or every articulable alternative passes and UC-only ones fill the remaining slots.
    const art = ks.flatMap((c, j) => (canRoute(c) ? [j] : []))
    return { S, P: art.length >= k && art.some((j) => mayDef(ks[j])) ? norm([...S, ...cross(art.map((j) => fs[j].P))]) : S }
  }
  const configs = a.root.required ? fams(a.root).P : [[]]

  /* ---- branch-and-bound ---- */

  // v: requirements given up, cost, new splits, units away from home, honors courses, courses. Then course ids,
  // requirements given up, the config: the order never depends on input order.
  type Sol = { v: number[]; cs: CourseId[]; skip: number[]; cfg: number[] }
  const idsOf = (is: number[]) => is.map((i) => (i < L.length ? L[i].id : pseudo[i - L.length])).sort()
  const flat = (x: Sol) => [...x.v, ...x.cs, ...idsOf(x.skip), x.cfg.length, ...idsOf(x.cfg)]
  const better = (x: Sol, y: Sol | null) => !y || lex(flat(x), flat(y)) < 0
  let nodes = 0
  const memo = new Map<string, { cols: number[]; used: number[]; sol: Sol | null }[]>()

  /** Cheapest way to complete requirements `ls` (independent of everything else) with ways `W`. Cost: units plus
   *  split subject chains. `ws`: other requirements their courses touch, where a new split is counted, or, if in
   *  `guard`, forbidden; with a guard a requirement may be skipped. */
  const branch = (ls: number[], ws: number[], guard: Set<number> | null, W0: CourseId[][][], PW0: Set<CourseId>[], pCh: number): Sol | null => {
    // Ways whose courses no other requirement here (or watched row) can use, with equal cost vectors, differ only by
    // ids: keep the smallest, which also gives the smallest merged id list. Not with chains, which see colleges.
    let W = W0, PW = PW0
    if (!pCh) {
      const n = new Map<CourseId, number>()
      for (const i of ls) for (const c of PW0[i]) n.set(c, (n.get(c) ?? 0) + 1)
      for (const w of ws) for (const c of touch[w]) n.set(c, (n.get(c) ?? 0) + 2)
      W = [...W0]; PW = [...PW0]
      for (const i of ls) {
        const keep = new Map<string, CourseId[]>(), out: CourseId[][] = []
        for (const w of W0[i]) {
          if (w.some((c) => n.get(c) !== 1)) { out.push(w); continue }
          const k = `${sumV(w)}|${w.length}`, o = keep.get(k)
          if (!o || lex(w, o) < 0) keep.set(k, w)
        }
        W[i] = [...out, ...keep.values()]
        PW[i] = new Set(W[i].flat())
      }
    }
    const order = [...ls].sort((x, y) => W[x].length - W[y].length || x - y)
    const P = new Set<CourseId>(), skip: number[] = []
    let best: Sol | null = null
    const done = (i: number) => W[i].some((w) => w.every((c) => P.has(c)))
    /** Admissible bound: each remaining requirement's cheapest group, a course shared by m of them costing 1/m each;
     *  chains already split stay split, and a chain whose remaining rows cannot all go where it is (or to one
     *  college) costs the cheaper of its penalty and the units to keep it there. */
    const bound = (k: number) => {
      const rest = order.slice(k).filter((i) => !done(i)), share = new Map<CourseId, number>()
      for (const i of rest) for (const c of PW[i]) if (!P.has(c)) share.set(c, (share.get(c) ?? 0) + 1)
      const t = [skip.length, ...sumV([...P])]
      if (!pCh) {
        for (const i of rest) {
          let m0 = INF, m1 = 0, m2 = 0, m3 = 0
          for (const w of W[i]) {
            let s0 = 0, s1 = 0, s2 = 0, s3 = 0
            for (const c of w) {
              if (P.has(c)) continue
              const v = vec.get(c)!, d = share.get(c)!
              s0 += v[0] / d; s1 += v[1] / d; s2 += v[2] / d; s3 += v[3] / d
            }
            const d0 = s0 - m0, d1 = s1 - m1, d2 = s2 - m2
            if (d0 < -EPS || (d0 <= EPS && (d1 < -EPS || (d1 <= EPS && (d2 < -EPS || (d2 <= EPS && s3 < m3 - EPS)))))) { m0 = s0; m1 = s1; m2 = s2; m3 = s3 }
          }
          t[1] += m0; t[2] += m1; t[3] += m2; t[4] += m3
        }
        return [t[0], t[1], 0, t[2], t[3], t[4]]
      }
      const lo = [...t], at = new Map<number, Map<number, number>>()
      for (const i of rest) {
        let m: number[] | null = null
        const byCol = new Map<number, number>(), each = [INF, INF, INF, INF]
        for (const w of W[i]) {
          const s = [0, 0, 0, 0]
          for (const c of w) if (!P.has(c)) vec.get(c)!.forEach((x, j) => (s[j] += x / share.get(c)!))
          if (!m || lex(s, m) < 0) m = s
          s.forEach((x, j) => (each[j] = Math.min(each[j], x)))
          const col = instOf(w[0])
          byCol.set(col, Math.min(byCol.get(col) ?? INF, s[0]))
        }
        m!.forEach((x, j) => (t[j + 1] += x))
        each.forEach((x, j) => (lo[j + 1] += x))
        at.set(i, new Map([...byCol].map(([col, u]) => [col, u - m![0]])))
      }
      let extra = 0
      subjects.forEach((_, x) => {
        const rs = rest.filter((i) => chainOfRow[i] === x)
        if (!rs.length) return
        const K = new Set([...tookAt[x], ...[...P].filter((c) => chainsOf.get(c)?.includes(x)).map(instOf)])
        if (K.size > 1) return // already split, counted below
        const cols = K.size ? [...K] : [...at.get(rs[0])!.keys()]
        extra += Math.min(pCh, ...cols.map((col) => rs.reduce((u, i) => u + (at.get(i)!.get(col) ?? INF), 0)))
      })
      // with the chain term, cost ties no longer pin the ways: tie-breaks bounded row by row
      return extra > EPS ? [t[0], t[1] + pCh * chains(P) + extra, 0, lo[2], lo[3], lo[4]] : [t[0], t[1] + pCh * chains(P), 0, t[2], t[3], t[4]]
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
      const s: Sol = { v: [skip.length, u + (pCh ? pCh * chains(cs) : 0), splits, away, hon, n], cs, skip: [...skip], cfg: [] }
      if (better(s, best)) best = s
    }
    const dfs = (k: number): void => {
      if (++nodes > budget) return
      while (k < order.length && done(order[k])) k++
      if (k === order.length) return finish()
      if (best && lex(bound(k), best.v) > 0) return
      const i = order[k]
      const adds = W[i].map((w) => w.filter((c) => !P.has(c))).map((add) => ({ add, key: [...sumV(add), ...add] }))
      for (const { add } of adds.sort((x, y) => lex(x.key, y.key))) {
        add.forEach((c) => P.add(c)); dfs(k + 1); add.forEach((c) => P.delete(c))
      }
      if (guard) { skip.push(i); dfs(k + 1); skip.pop() }
    }
    dfs(0)
    return best
  }
  /** An exact component result for colleges `cols` also holds for fewer colleges, as long as it uses none of those
   *  left out (the search space only shrinks); no plan with more colleges means none with fewer. */
  const memoized = (key: string, cols: number[], run: () => Sol | null) => {
    const seen = memo.get(key) ?? [], sub = (xs: number[], ys: number[]) => xs.every((x) => ys.includes(x))
    const hit = seen.find((e) => sub(cols, e.cols) && sub(e.used, cols))
    if (hit) return hit.sol
    const sol = run()
    memo.set(key, [...seen, { cols, used: sol ? [...new Set(sol.cs.map(instOf))] : [], sol }])
    return sol
  }
  /** Colleges where chain x may stay whole: those of its courses in the pools, and where it was taken if anywhere. */
  const homesOf = (x: number, ls: number[], PW: Set<CourseId>[]) =>
    [...new Set(ls.flatMap((i) => [...PW[i]].filter((c) => chainsOf.get(c)?.includes(x)).map(instOf)))]
      .filter((k) => [...tookAt[x]].every((t) => t === k)).sort((p, q) => p - q)
  /**
   * `branch` with split subject chains charged. Every plan plans no course of a chain, keeps it at one college k (all
   * its planned courses there, where it was taken if anywhere) or splits it; so per assignment of the component's
   * chains (avoid, keep at k, free) the unit-only search runs on the ways that respect it, and each result is scored
   * with its real chains, which the assignment's free chains bound: the best is exact, tie-breaks included. Too many
   * assignments: `branch` with the chain bound instead.
   */
  const component = (key: string, cols: number[], ls: number[], ws: number[], guard: Set<number> | null, W: CourseId[][][], PW: Set<CourseId>[], pCh: number): Sol | null => {
    const plain = () => memoized(`${key}|0`, cols, () => branch(ls, ws, guard, W, PW, 0))
    if (!pCh) return plain()
    return memoized(`${key}|${pCh}`, cols, () => {
      const xs = subjects.map((_, x) => x).filter((x) => ls.some((i) => [...PW[i]].some((c) => chainsOf.get(c)?.includes(x))))
      const AVOID = -2, FREE = -1, opts = xs.map((x) => [AVOID, FREE, ...homesOf(x, ls, PW)])
      if (opts.reduce((n, o) => n * o.length, 1) > 64) return branch(ls, ws, guard, W, PW, pCh)
      let best: Sol | null = null
      const score = (r: Sol | null) => {
        if (!r) return
        const s: Sol = { ...r, v: [r.v[0], r.v[1] + pCh * chains(r.cs), ...r.v.slice(2)] }
        if (better(s, best)) best = s
      }
      const pick = (j: number, keep: [number, number][]): void => {
        if (j < xs.length) { for (const k of opts[j]) pick(j + 1, k === FREE ? keep : [...keep, [xs[j], k]]); return }
        if (!keep.length) return score(plain())
        // a way is at one college: it respects "chain x stays at k" unless it holds a course of x elsewhere
        const V = W.map((ws, i) => (ls.includes(i) ? ws.filter((w) => keep.every(([x, k]) => instOf(w[0]) === k || !w.some((c) => chainsOf.get(c)?.includes(x)))) : ws))
        if (!guard && ls.some((i) => !V[i].length)) return
        score(memoized(`${key}|${keep.map((p) => p.join(':'))}`, cols, () => branch(ls, ws, guard, V, poolOf(V), 0)))
      }
      pick(0, [])
      return best
    })
  }

  /** Best plan for config C using only the ways `W` (courses at home and the colleges being tried); the college
   *  penalty is not included. */
  const solveConfig = (C: number[], guarded: boolean, W: CourseId[][][], PW: Set<CourseId>[], pCh: number): Sol | null => {
    const F = C.filter((i) => i < L.length && !sat0[i] && W[i].length), inF = new Set(F)
    const forced = C.filter((i) => i >= L.length || (!sat0[i] && !W[i].length))
    const up = new Map(F.map((i) => [i, i]))
    const find = (i: number): number => (up.get(i) === i ? i : find(up.get(i)!))
    const join = (x: number, y: number) => { const p = find(x), q = find(y); if (p !== q) up.set(Math.max(p, q), Math.min(p, q)) }
    const owner = new Map<CourseId, number>(), chainOwner = new Map<number, number>()
    for (const i of F) for (const c of PW[i]) {
      if (owner.has(c)) join(owner.get(c)!, i); else owner.set(c, i)
      // a subject chain's penalty depends on all its courses: one component per chain
      if (pCh) for (const x of chainsOf.get(c) ?? []) { if (chainOwner.has(x)) join(chainOwner.get(x)!, i); else chainOwner.set(x, i) }
    }
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
    let splits = 0, cost = 0
    for (const { ls, ws } of comps.values()) {
      // the colleges a component may use decide its ways
      const cols = [...new Set(ls.flatMap((i) => W[i].map((w) => instOf(w[0]))))].sort((x, y) => x - y)
      const s = component(`${ls}|${ws}|${guard ? ws.filter((w) => guard.has(w)) : '-'}`, cols, ls, ws, guard, W, PW, pCh)
      if (!s) return null
      cs.push(...s.cs); skip.push(...s.skip); splits += s.v[2]; cost += s.v[1]
    }
    cs.sort()
    const [, away, hon, n] = sumV(cs)
    return { v: [skip.length, cost, splits, away, hon, n], cs, skip: skip.sort((x, y) => x - y), cfg: C }
  }
  /** Every non-home college some requirement could use. */
  const reachable = [...new Set(ways.flatMap((w) => w.map((v) => instOf(v[0]))))].filter((i) => i !== home).sort((x, y) => x - y)
  /** Ways at home and the colleges `S` only. */
  const restrict = (S: number[]) => {
    const inS = new Set(S)
    return ways.map((w) => w.filter((v) => { const i = instOf(v[0]); return i === home || inS.has(i) }))
  }
  const chainRows = subjects.map((x) => L.flatMap((r, i) => (subjectOf(r.id) === x ? [i] : [])))
  /** Chains split in every plan that completes config C with ways `W`: no single college can finish the chain's rows
   *  (and be the only one where the student took courses of it). */
  const forcedChains = (C: number[], W: CourseId[][][]) => {
    const inF = new Set(C.filter((i) => i < L.length && !sat0[i] && W[i].length))
    return chainRows.filter((rows, x) => {
      const rs = rows.filter((i) => inF.has(i)), took = [...tookAt[x]]
      const at = (k: number) => took.every((t) => t === k) && rs.every((i) => W[i].some((w) => instOf(w[0]) === k))
      return rs.length > 0 && ![...new Set(W[rs[0]].map((w) => instOf(w[0])))].some(at)
    }).length
  }
  /**
   * Admissible [unmet, cost] of the plans with ways `W` that use every college of I and maybe some of D (whose
   * penalty is not yet counted). Per config: a row with no way left is unmet. The rest is a facility-location problem
   * whose facilities are colleges (home and I open, D at pCollege) and whose clients are rows: a row costs its
   * cheapest way at a college, a course shared by m rows 1/m each. A subject chain is one client: all its rows at one
   * college (where it was taken, if anywhere), or split at pChain (a free facility). The dual ascent of the LP gives
   * the bound (Erlenkotter).
   */
  const dualBound = (W: CourseId[][][], I: number[], D: number[], pCh: number) => {
    const SPLIT = -1, free = (k: number) => k === SPLIT || k === home || I.includes(k)
    let best: number[] = [INF, INF]
    for (const C of configs) {
      const skip = C.filter((i) => i >= L.length || (!sat0[i] && !W[i].length)).length
      if (skip > best[0]) continue
      const F = C.filter((i) => i < L.length && !sat0[i] && W[i].length), share = new Map<CourseId, number>()
      for (const i of F) for (const c of new Set(W[i].flat())) share.set(c, (share.get(c) ?? 0) + 1)
      const rowCost = (i: number) => {
        const m = new Map<number, number>()
        for (const w of W[i]) { const k = instOf(w[0]), u = w.reduce((t, c) => t + vec.get(c)![0] / share.get(c)!, 0); m.set(k, Math.min(m.get(k) ?? INF, u)) }
        return m
      }
      const costs = new Map(F.map((i) => [i, rowCost(i)])), clients: Map<number, number>[] = []
      const grouped = new Set<number>()
      if (pCh) chainRows.forEach((rows, x) => {
        const rs = rows.filter((i) => costs.has(i))
        if (rs.length < 2) return
        rs.forEach((i) => grouped.add(i))
        const took = [...tookAt[x]], m = new Map<number, number>()
        for (const k of costs.get(rs[0])!.keys()) {
          if (took.some((t) => t !== k) || rs.some((i) => !costs.get(i)!.has(k))) continue
          m.set(k, rs.reduce((t, i) => t + costs.get(i)!.get(k)!, 0))
        }
        m.set(SPLIT, rs.reduce((t, i) => t + Math.min(...costs.get(i)!.values()), 0) + pCh)
        clients.push(m)
      })
      for (const i of F) if (!grouped.has(i)) clients.push(costs.get(i)!)
      // the forced chains of a lone row (split by where it was taken) are counted outside the clients
      const lone = pCh ? chainRows.filter((rows, x) => {
        const rs = rows.filter((i) => costs.has(i))
        return rs.length === 1 && ![...costs.get(rs[0])!.keys()].some((k) => [...tookAt[x]].every((t) => t === k))
      }).length : 0
      // clients as [college, cost] lists; ascent: raise each dual to its next cost level while every paid college it
      // reaches has slack left
      const cl = clients.map((m) => [...m])
      const cap = cl.map((m) => { let x = INF; for (const [k, u] of m) if (free(k) && u < x) x = u; return x })
      const v = cl.map((m, j) => { let x = cap[j]; for (const [k, u] of m) if (!free(k) && u < x) x = u; return x })
      const slack = new Map(D.map((k) => [k, pCollege]))
      const order = cl.map((_, j) => j).sort((x, y) => cl[x].length - cl[y].length || x - y)
      for (let again = true; again;) {
        again = false
        for (const j of order) {
          if (v[j] >= cap[j] - EPS) continue
          let d = cap[j] - v[j]
          for (const [k, u] of cl[j]) {
            if (free(k)) continue
            d = Math.min(d, u > v[j] + EPS ? u - v[j] : slack.get(k)!)
          }
          if (d <= EPS) continue
          for (const [k, u] of cl[j]) if (!free(k) && u <= v[j] + EPS) slack.set(k, slack.get(k)! - d)
          v[j] += d; again = true
        }
      }
      const lb = v.reduce((t, x) => t + x, 0)
      const out = [skip, lb + pCh * lone]
      if (lex(out, best) < 0) best = out
    }
    return [best[0], best[1] + pCollege * I.length]
  }
  /**
   * Outer branch-and-bound over the colleges other than home. A node (I, D) holds the plans that use every college
   * in I and maybe some in D; `dualBound` prunes it first. Then the exact minimum-unit plan with home, I and D
   * (chains and colleges not charged) is a candidate, and it plus the penalties for I and the forced chains bounds
   * the node. If that plan uses no college of D, the chain-aware plan there is solved too (a candidate and a tighter
   * bound); a relaxed plan using no college of D solves the node. Otherwise branch on the first college of D it uses:
   * without it, then with it. A plan using U lives in leaf U, so the best candidate is optimal; ties are kept (only a
   * strictly worse bound prunes), and within a node the relaxation is lexicographically first, tie-breaks included.
   */
  const search = (guarded: boolean) => {
    nodes = 0
    let best: Sol | null = null
    const real = (r: Sol): Sol => ({ ...r, v: [r.v[0], sumV(r.cs)[0] + pCollege * colleges(r.cs) + pChain * chains(r.cs), ...r.v.slice(2)] })
    const offer = (r: Sol) => { const t = real(r); if (better(t, best)) best = t }
    const solved = new Map<string, Sol | null>()
    const solveAt = (S: number[], W: CourseId[][][], pCh: number) => {
      const key = `${S}|${pCh}`
      if (!solved.has(key)) {
        const PW = poolOf(W)
        let b: Sol | null = null
        for (const C of configs) { const r = solveConfig(C, guarded, W, PW, pCh); if (r && better(r, b)) b = r }
        solved.set(key, b)
      }
      return solved.get(key)!
    }
    const worse = (v: number[]) => !!best && lex(v, best.v.slice(0, 2)) > 0
    // chain terms in the bounds assume every row is completed; the guarded pass may give rows up instead
    const pCh = guarded ? 0 : pChain
    const node = (I: number[], D: number[]): void => {
      if (++nodes > budget) return
      const S = [...I, ...D].sort((p, q) => p - q), W = restrict(S)
      if (worse(dualBound(W, I, D, pCh))) return
      let r = solveAt(S, W, 0)
      if (!r) return
      offer(r)
      const forced = pCh ? Math.min(...configs.map((C) => forcedChains(C, W))) : 0
      if (worse([r.v[0], r.v[1] + pCollege * I.length + pCh * forced])) return
      let x = D.find((k) => r!.cs.some((c) => instOf(c) === k))
      if (x === undefined) {
        if (chains(r.cs) <= forced) return // the relaxation is optimal here
        if (!(r = solveAt(S, W, pChain))) return
        offer(r)
        if (worse([r.v[0], r.v[1] + pCollege * I.length])) return
        if ((x = D.find((k) => r!.cs.some((c) => instOf(c) === k))) === undefined) return // optimal here
      }
      const rest = D.filter((k) => k !== x)
      node(I, rest)
      node([...I, x], rest)
    }
    if (pCollege) {
      // Incumbent first, from small college sets (cheap to solve): home alone, then greedily add the college that helps
      // most (unit-only plans, scored with their real penalties), then the chain-aware plan at the colleges it uses.
      const at = (S: number[], pCh = 0) => { const r = solveAt(S, restrict(S), pCh); if (r) offer(r) }
      let S: number[] = [], cur: Sol | null = null
      at(S)
      for (;;) {
        cur = best
        let pick: number | undefined
        for (const k of reachable.filter((x) => !S.includes(x))) {
          const b: Sol | null = best
          at([...S, k].sort((p, q) => p - q))
          if (best !== b) pick = k
        }
        if (pick === undefined || best === cur || nodes > budget) break
        S = [...S, pick].sort((p, q) => p - q)
      }
      if (pChain && best) at([...new Set((best as Sol).cs.map(instOf))].filter((k) => k !== home).sort((p, q) => p - q), pChain)
      node([], reachable)
    }
    else { const e = solveAt(reachable, ways, pChain); if (e) offer(e) } // no college penalty: every college at once
    return { best: best as Sol | null, complete: nodes <= budget }
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
      const mix = honorsColleges(req), at = new Set([...planned].map(instOf))
      for (const g of req.groups) {
        const need = toPlan(g, h, mix)
        // Only complete groups at colleges the student can attend, unless it is already complete.
        if (need.length && (!allowed.includes(g.institutionId) || banned.has(g))) continue
        // A course missing from the catalog has unknown units: not plannable.
        if (need.some((c) => !a.catalog[c])) continue
        // Marginal home-system units to complete the group given what is already taken or planned; a new college costs.
        const fresh = need.length && g.institutionId !== home && !at.has(g.institutionId) ? pCollege : 0
        const cand = { g, cost: need.reduce((s, c) => s + unitsOf(c), 0) + fresh + (splitting.has(g) ? SPLIT : 0) }
        if (!best || cmp(rank(cand), rank(best)) < 0) best = cand
      }
      return best
    }

    type Want = 'sat' | 'pass'
    const meets = (n: ReqNode | Requirement, ok: Ok, want: Want) => { const s = state(n, ok); return s === 'sat' || (want === 'pass' && s === 'def') }
    const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0)
    /** Every articulable alternative passing (UC-only ones fill the rest): available only when one can be UC-only. */
    const viaDef = (n: ReqNode) => { const art = kidsOf(n).filter(canRoute); return art.length >= needOf(n) && art.some(mayDef) ? art : null }
    /** Estimated cost to make a subtree `sat` or pass from here (used to choose among OR / N_OF children). */
    const estimate = (n: ReqNode | Requirement, h: Set<CourseId>, ok: Ok, want: Want): number => {
      if (meets(n, ok, want)) return 0
      if (n.kind === 'req') return bestGroup(n, h)?.cost ?? INF
      const ks = kidsOf(n)
      if (n.type === 'AND') {
        const p = ks.map((c) => estimate(c, h, ok, 'pass')), tot = sum(p)
        return want === 'pass' || tot === INF ? tot : tot + Math.min(...ks.map((c, j) => estimate(c, h, ok, 'sat') - p[j]))
      }
      const k = needOf(n) - ks.filter((c) => state(c, ok) === 'sat').length
      const s = ks.filter((c) => state(c, ok) !== 'sat').map((c) => estimate(c, h, ok, 'sat')).sort((x, y) => x - y)
      const A = s.length < k ? INF : sum(s.slice(0, k)), art = want === 'pass' ? viaDef(n) : null
      return Math.min(A, art ? sum(art.map((c) => estimate(c, h, ok, 'pass'))) : INF)
    }

    /** Order-independent name of a subtree, to break cost ties among OR / N_OF children. */
    const keyOf = (n: ReqNode | Requirement): string => (n.kind === 'req' ? n.id : `(${n.children.map(keyOf).sort().join(',')})`)

    /**
     * Collect the requirements that still need a group, choosing cheapest branches at OR / N_OF. `alt` gets those
     * reached through such a choice, which may still change as courses are planned.
     */
    const needed = (n: ReqNode | Requirement, h: Set<CourseId>, ok: Ok, want: Want, acc: Requirement[], alt: Set<Requirement>, inAlt = false): void => {
      if (meets(n, ok, want)) return
      if (n.kind === 'req') { if (!ucOnly(n)) { acc.push(n); if (inAlt) alt.add(n) } return }
      if (!n.required) return
      const ks = kidsOf(n)
      if (n.type === 'AND') {
        ks.forEach((c) => needed(c, h, ok, 'pass', acc, alt, inAlt))
        if (want === 'sat' && !ks.some((c) => state(c, ok) === 'sat')) {
          const d = ks.map((c) => ({ c, cost: estimate(c, h, ok, 'sat') - estimate(c, h, ok, 'pass'), key: keyOf(c) }))
            .filter((x) => x.cost < INF).sort((x, y) => x.cost - y.cost || cmp([x.key], [y.key]))
          if (d.length) needed(d[0].c, h, ok, 'sat', acc, alt, inAlt)
        }
        return
      }
      const k = needOf(n) - ks.filter((c) => state(c, ok) === 'sat').length
      const ranked = ks.filter((c) => state(c, ok) !== 'sat')
        .map((c) => ({ c, cost: estimate(c, h, ok, 'sat'), key: keyOf(c) }))
        .sort((x, y) => x.cost - y.cost || cmp([x.key], [y.key]))
      const A = ranked.length < k ? INF : sum(ranked.slice(0, k).map((r) => r.cost))
      const art = want === 'pass' ? viaDef(n) : null, B = art ? sum(art.map((c) => estimate(c, h, ok, 'pass'))) : INF
      if (A < INF && A <= B) ranked.slice(0, k).forEach((r) => needed(r.c, h, ok, 'sat', acc, alt, true))
      else if (B < INF) art!.forEach((c) => needed(c, h, ok, 'pass', acc, alt, true))
      else {
        ranked.filter((r) => r.cost < INF).slice(0, k).forEach((r) => needed(r.c, h, ok, 'sat', acc, alt, true))
        unsolvable.add(shortfall(n))
      }
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
      needed(a.root, h, (i) => !!st[i].satisfied, 'pass', todo, alt)
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
    return { v: [give, u + pCollege * colleges(cs) + pChain * chains(cs), newSplits(h), away, hon, n], cs, skip: [], cfg: [] }
  }

  /* ---- choose ---- */

  // Pass 1 counts new splits but forbids none: if its optimum opens no split the plan still needs, it is optimal
  // outright (the constraint only removes plans). Otherwise pass 2 forbids them, and the result is not proven.
  // Out of budget, a pass keeps the best plan it found, unproven.
  const first = overflow ? null : search(false)
  let best = first?.best ?? null, optimal = !!best && first!.complete
  if (best && blocking(withTaken(best.cs)).length) {
    optimal = false
    best = search(true).best
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
      const ids = blocking(new Set([...h, ...w])).map((j) => L[j].id).sort()
      return `${L[i].id} (only by splitting ${ids.length ? ids.join(', ') : 'a series'})`
    })
  } else ({ planned, chosen, unsolvable } = g!)
  let prereqOnly: CourseId[] = [], prereqWarnings: string[] = []
  ;({ planned, chosen, prereqOnly, prereqWarnings, optimal } = withPrereqs(planned, chosen, optimal))
  const terms = pack([...planned], (c) => unitsOf(c, true), unitCap, maxTerms, startTerm, termSystem, (c) => a.catalog[c]?.title ?? '')
  const result = verifySchedule(withTaken(planned), a)
  // unsolvable in a fixed order (tree order would follow the input)
  return {
    terms, chosen, result, totalUnits: half(planned.reduce((s, c) => s + unitsOf(c, true), 0)), unsolvable: [...unsolvable].sort(), optimal,
    ...(prereqOnly.length ? { prereqOnly } : {}), ...(prereqWarnings.length ? { prereqWarnings } : {}),
  }

  /** Enrollment prerequisites (TESTER1 H-1, prereq.ts): each planned course's unmet prerequisites at its own college
   *  are added and counted. Then a searched course is dropped while the plan, prerequisites included, costs fewer units
   *  and still completes every chosen requirement without it (business calculus once Calculus I is in the plan for
   *  Calculus II). The search's optimum ignores prerequisites, so it is a lower bound: `optimal` survives only when the
   *  final plan scores no worse than the searched one (every added course priced by the search). */
  function withPrereqs(searched: CourseId[], chosen: Record<string, CourseGroup>, optimal: boolean) {
    const graph = prereqGraph(a.catalog, taken)
    const nameOf = (c: CourseId) => shortName.get(instOf(c)) ?? String(instOf(c))
    const close = (cs: CourseId[]) => { const k = prereqClosure(graph, cs, taken, a.catalog, nameOf); return { cs: [...cs, ...k.added], ...k } }
    const units = (cs: CourseId[]) => cs.reduce((s, c) => s + unitsOf(c, true), 0)
    const keeps = (cs: CourseId[]) => { const h = withTaken(cs); return Object.keys(chosen).every((id) => L.some((r) => r.id === id && completed(r, h))) }
    const give0 = score(searched).v[0], block0 = blocking(withTaken(searched)).length
    let base = searched, cur = close(base)
    for (let changed = cur.added.length > 0; changed;) {
      changed = false
      // Only a course sharing a requirement with an added prerequisite can become redundant.
      const rows = L.filter((r) => r.groups.some((g) => g.courses.some((x) => cur.added.includes(x) || cur.added.includes(`${x}H`) || cur.added.includes(stripH(x)))))
      const may = (c: CourseId) => rows.some((r) => r.groups.some((g) => g.courses.some((x) => x === c || `${x}H` === c || stripH(x) === c)))
      for (const c of base.filter(may).sort((x, y) => unitsOf(y, true) - unitsOf(x, true) || (x < y ? -1 : 1))) {
        const nx = close(base.filter((x) => x !== c))
        if (units(nx.cs) < units(cur.cs) - EPS && keeps(nx.cs) && score(nx.cs).v[0] <= give0 && blocking(withTaken(nx.cs)).length <= block0) {
          base = base.filter((x) => x !== c); cur = nx; changed = true; break
        }
      }
    }
    const h = withTaken(cur.cs), out: Record<string, CourseGroup> = {}
    for (const id of Object.keys(chosen)) out[id] = L.map((r) => (r.id === id ? completed(r, h) : undefined)).find(Boolean) ?? chosen[id]
    const same = cur.cs.length === searched.length && cur.cs.every((c) => searched.includes(c))
    const proven = optimal && (same || (cur.cs.every((c) => vec.has(c)) && lex(score(cur.cs).v, score(searched).v) <= 0))
    return { planned: same ? searched : [...cur.cs].sort(), chosen: same ? chosen : out, prereqOnly: cur.added.filter((c) => !Object.values(out).some((g) => g.courses.includes(c))), prereqWarnings: cur.warnings, optimal: proven }
  }
}

/* ---- term packing ---- */

// ponytail: prerequisite order is inferred from ids and titles (sequence.ts); swap for real requisite data if ASSIST
// ever populates `requisites`.
function pack(courses: CourseId[], unitsOf: (c: CourseId) => number, cap: number, maxTerms: number, start: NonNullable<SolveOptions['startTerm']>, system: TermSystem, titleOf: (c: CourseId) => string = () => ''): Term[] {
  if (!(cap > 0 && Number.isFinite(cap))) cap = system === 'semester' ? 12 : 16 // NaN / <=0 / Infinity -> default
  // preds: [course, gap]: gap 1 = strictly later term, 0 = same term or later (a lab after its lecture)
  const preds = new Map<CourseId, [CourseId, number][]>(courses.map((c) => [c, []]))
  for (const e of prereqs(courses, titleOf).edges) preds.get(e.to)!.push([e.from, e.rule === 'co' ? 0 : 1])
  // depth: longest prerequisite chain below a course (the edges are acyclic); a lab sorts just after its lecture
  const memo = new Map<CourseId, number>()
  const depth = (c: CourseId): number => memo.get(c) ?? (memo.set(c, Math.max(0, ...preds.get(c)!.map(([p, g]) => depth(p) + (g || 0.5)))), memo.get(c)!)
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
  const labs = new Map<CourseId, CourseId[]>()
  for (const [l, ps] of preds) for (const [p, g] of ps) if (!g) labs.set(p, [...(labs.get(p) ?? []), l])
  const after = (x: CourseId, skip?: CourseId) => Math.max(0, ...preds.get(x)!.filter(([p]) => p !== skip).map(([p, g]) => placed.get(p)! + g))
  for (const c of ordered) {
    if (placed.has(c)) continue
    // A lecture takes its labs into the same term when they fit and nothing else holds them back.
    let go = (labs.get(c) ?? []).filter((l) => preds.get(l)!.every(([p]) => p === c || placed.has(p)))
    if (go.reduce((s, l) => s + unitsOf(l), unitsOf(c)) > cap + EPS) go = []
    const units = go.reduce((s, l) => s + unitsOf(l), unitsOf(c))
    let i = Math.max(after(c), ...go.map((l) => after(l, c))) // after every prerequisite
    while (terms[i] && terms[i].units + units > cap + EPS) i++
    while (terms.length <= i) terms.push({ name: name(terms.length), courses: [], units: 0 })
    for (const x of [c, ...go]) { terms[i].courses.push(x); placed.set(x, i) }
    terms[i].units += units
  }
  // Only a single course larger than the cap can overflow a term; flag it rather than hide it.
  for (const t of terms) { if (t.units > cap + EPS) t.overCap = true; t.units = half(t.units) }
  return terms.slice(0, Math.max(maxTerms, terms.length)) // never silently drop courses; UI flags > maxTerms
}
