import type { Agreement, CourseGroup, CourseId, Fallback, Institution, Partial, Plan, ReqNode, Requirement } from './types'
import { canRoute, capOf, has, honorsColleges, hypState, isDeferrable, reqStatus, rowUses, slotFill, slotted, treeStatus, ucOnly, unitsIn, verifySchedule, type ReqStatus } from './verify.ts'
import { rowToken, type Ways } from './slots.ts'
import institutions from '../../data/institutions.json' with { type: 'json' }
import { checkStartTerm, nextOpenTerm } from './calendar.ts'
import { pack } from './pack.ts'
import { prereqClosure, prereqGraph } from './prereq.ts'

export type TermSystem = 'quarter' | 'semester'

export interface SolveOptions {
  allowed: number[]       // institutions the student can enroll at
  home?: number           // the student's college: no college penalty there; also a tie-break
  unitCap?: number        // per term, in the home (termSystem) unit system; default 16 quarter / 12 semester
  maxTerms?: number       // unused by the solver: every course is packed (the UI flags plans past its limit)
  /** first term of the plan, read in the home calendar; default nextOpenTerm(today) (calendar.ts) */
  startTerm?: { season: 'Fall' | 'Winter' | 'Spring'; year: number }
  termSystem?: TermSystem                     // home college's system; Plan units are reported in it
  /** Plan summer sessions too (pack.ts: lighter load, never a longer plan). Default false: summer is never planned. */
  summer?: boolean
  unitSystems?: Record<number, TermSystem>    // institutionId -> native system; missing => assumed termSystem
  budget?: number                             // search nodes before falling back to greedy (optimal = false); default 200k
  timeLimitMs?: number                        // wall-clock search limit; past it, the best plan so far (optimal = false)
  /** Cost of each college other than `home` that planned courses use, in quarter units (5 = about one course),
   *  converted to termSystem. Default 5. 0 (with chainPenalty 0) is pure minimum units. */
  collegePenalty?: number
  /** Cost of each subject chain (see `solve`) planned across two or more colleges, in quarter units. Default 5. */
  chainPenalty?: number
  /** Prefer the home college (needs `home` in `allowed`): everything home can cover is planned at home (see
   *  preferHomeAgreement); another college only where home cannot, and then the usual cost decides among them.
   *  Each course planned away from home is named in `Plan.fallbacks`. Default false. */
  preferHome?: boolean
}

/** preferHome: one way to read the home-first rule; `solve` plans several and keeps the cheapest valid finished plan.
 *  noSeries: series groups not to keep (`${row id}|${college}`); force: rows home cannot cover planned only at that
 *  college; pricing 'home': a way away from home is priced without prerequisites a home course stands in for, 'full':
 *  with all of them. */
interface Candidate { noSeries: string[]; force: Record<string, number>; pricing: 'home' | 'full' }
/** What `solve` needs to compare candidates: series groups the plan keeps without meeting a pulling row at that college
 *  (`by`: those rows), and the finished plan's real cost (units + college and chain penalties). */
interface Meta { idle: { key: string; col: number; by: string[] }[]; cost: number }
const metaOf = new WeakMap<Plan, Meta>()
const MAX_CANDIDATES = 10
/** noSeries entry: keep no series group at all (the strict reading of home first). */
const ALL = '*'

/**
 * The plan (see solveOnce). With preferHome, candidates are planned within one shared timeLimitMs, up to
 * MAX_CANDIDATES: first the strict one (no series group kept, so it can never carry a false series note), then B3
 * pricing and full pricing; for plans that keep series groups without their pulling rows there ("idle"), one without
 * all of those groups, one with all their pulling rows forced to those colleges, then each one alone. Only plans with
 * no idle series group are returned (the strict plan always qualifies), scored on the finished plan (prerequisites
 * included): fewest requirements left unmet, then real cost.
 */
export function solve(taken: Set<CourseId>, a0: Agreement, opts: SolveOptions): Plan {
  const { allowed, home } = opts
  if (!opts.preferHome || home === undefined || !allowed.includes(home)) return solveOnce(taken, a0, opts)
  const t0 = Date.now(), limit = opts.timeLimitMs
  const left = () => (limit === undefined ? undefined : Math.max(0, limit - (Date.now() - t0)))
  const none = { noSeries: [], force: {} }
  const queue: Candidate[] = [{ ...none, noSeries: [ALL], pricing: 'home' }, { ...none, pricing: 'home' }, { ...none, pricing: 'full' }, { ...none, noSeries: [ALL], pricing: 'full' }]
  const seen = new Set<string>(), done: { plan: Plan; meta?: Meta }[] = []
  while (queue.length && done.length < MAX_CANDIDATES) {
    const c = queue.shift()!, k = JSON.stringify([[...c.noSeries].sort(), Object.entries(c.force).sort(), c.pricing])
    if (seen.has(k)) continue
    seen.add(k)
    if (done.length && left() === 0) break // the strict plan is in: out of time, return the best valid one so far
    const plan = solveOnce(taken, a0, { ...opts, timeLimitMs: left() }, c), meta = metaOf.get(plan)
    done.push({ plan, meta })
    const idle = meta?.idle ?? []
    if (!idle.length) continue
    queue.push({ ...c, noSeries: [...c.noSeries, ...idle.map((x) => x.key)] })
    queue.push({ ...c, force: { ...c.force, ...Object.fromEntries(idle.map((x) => [[...x.by].sort()[0], x.col])) } })
    for (const x of idle) {
      queue.push({ ...c, noSeries: [...c.noSeries, x.key] })
      for (const y of x.by) queue.push({ ...c, force: { ...c.force, [y]: x.col } })
    }
  }
  const valid = done.filter((d) => !d.meta?.idle.length)
  const key = (d: { plan: Plan; meta?: Meta }) => [d.plan.unsolvable.length, d.plan.result.missing.length, d.meta?.cost ?? d.plan.totalUnits]
  return (valid.length ? valid : done).reduce((b, d) => (lex(key(d), key(b)) < 0 ? d : b)).plan
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
// config id ranges (see `fams`): rows, then occurrences below PSEUDO; shortfalls below PAIR; pairs of occurrences
const PSEUDO = 2 ** 24, PAIR = 2 ** 40, SHIFT = 2 ** 20
const NONE: ReadonlySet<string> = new Set()
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
 * verify's fold (verify.treeStatus), given which rows are complete. `sat`: done with CC courses; `def`: passes only
 * because what is left is UC-only; `open`: needs more. In an OR / N_OF, UC-only alternatives fill slots only while no
 * articulable alternative (verify.canRoute) is open: the CC route is owed first. A row with no groups and no ASSIST
 * reason is neither articulable nor UC-only. `done(r)`: the ways the row is met (verify.rowUses), so a course fills
 * one slot of a "choose N" group (M-4); `true` for a row taken as done whose courses are not known yet (only the row
 * itself is spent), false or [] when not done.
 */
export function treeState(n: ReqNode | Requirement, done: (r: Requirement) => boolean | Ways): 'sat' | 'def' | 'open' {
  return treeStatus(n, done)
}

/** Can the subtree pass as `def` for some set of complete rows? Over-approximate: it only gates route enumeration. */
const mayDefM = new WeakMap<ReqNode | Requirement, boolean>()
const mayDef = (n: ReqNode | Requirement): boolean => {
  if (n.kind === 'req') return ucOnly(n)
  let v = mayDefM.get(n)
  if (v === undefined) {
    const ks = kidsOf(n), art = ks.filter(canRoute)
    v = n.type === 'AND' ? ks.length > 0 && ks.every(mayDef) : n.type === 'UNITS' ? art.some(mayDef) : needOf(n) > 0 && art.length >= needOf(n) && art.some(mayDef)
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
 * than home that planned courses use + chainPenalty × (k − 1) per subject chain whose courses sit at k colleges; then
 * new split series,
 * units away from home, honors courses, courses, course ids. Penalties are in quarter units, costed in termSystem.
 *
 * Subject chain: the rows of the agreement that share a UC subject (MATH 51/52/53/54, PHYSICS 7A/7B/7C), when at least
 * two such rows have CC groups. A course belongs to it when it (or its honors twin) appears in one of those rows'
 * groups. k counts the colleges of its planned courses and of those the student took; a chain with no planned course
 * costs nothing.
 *
 * The tree is passed by one of its "configs" (a minimal set of requirements to complete, under verify's rules); for a
 * set of colleges the student would attend, a config's requirements split into independent components (no shared
 * course, no split series and no subject chain between them), each solved by branch-and-bound over its requirements'
 * groups. An outer branch-and-bound over the colleges charges each one used. Falls back to the greedy set cover
 * (optimal = false) past the search budget. Then quarter packing.
 */
/** A tree the planner cannot walk (a row without a groups list, a node without a children list): verify fails closed
 *  on it (malformed); the planner returns no schedule instead of throwing (round 8 N-1). */
const unwalkable = (n: unknown): boolean => {
  if (!n || typeof n !== 'object') return true
  const x = n as { kind?: unknown; groups?: unknown; children?: unknown }
  if (x.kind === 'req') return !Array.isArray(x.groups) || x.groups.some((g) => !g || typeof g !== 'object' || !Array.isArray((g as CourseGroup).courses))
  return !Array.isArray(x.children) || x.children.some(unwalkable)
}

function solveOnce(taken: Set<CourseId>, a0: Agreement, opts: SolveOptions, cand: Candidate = { noSeries: [], force: {}, pricing: 'home' }): Plan {
  if (unwalkable(a0.root)) return { terms: [], chosen: {}, result: verifySchedule(taken, a0), totalUnits: 0,
    unsolvable: ['Agreement data is malformed; confirm with a counselor'] }
  const { allowed, home, termSystem = 'quarter', unitSystems = {}, budget = 200_000, timeLimitMs } = opts
  // N-3: a bad start term is the caller's error: say so instead of planning Summer as Spring or looping on a NaN year
  const startTerm = checkStartTerm(opts.startTerm ?? nextOpenTerm(new Date(), termSystem))
  // N-3: a course whose units are not a finite number >= 0 (NaN, missing, "5", negative) is not plannable, like a course
  // missing from the catalog; a requirement it alone could complete lands in `unsolvable`
  const { a: a1, badUnits } = withValidUnits(a0)
  const homeFirst = !!opts.preferHome && home !== undefined && allowed.includes(home)
  const hf: HomeFirst = homeFirst ? preferHomeAgreement(a1, taken, home!, allowed, cand.noSeries, cand.force) : { a: a1, started: new Set(), series: new Map() }
  const { a, started } = hf
  // preferHome: a way includes the prerequisites it needs at its college, so its cost is what the student really takes;
  // not one a home course stands in for (home's own rows plan it there, or the whole-plan closure finds it covered)
  const graph0 = homeFirst ? prereqGraph(a.catalog, taken) : null
  const homeCat = Object.keys(a.catalog).filter((c) => instOf(c) === home), byHome = new Map<CourseId, boolean>()
  const homeGives = (p: CourseId) => {
    let v = byHome.get(p)
    if (v === undefined) byHome.set(p, (v = instOf(p) === home || homeCat.some((q) => graph0!.equiv(p, q))))
    return v
  }
  const withPre = (v: CourseId[]) => (graph0 ? [...v, ...prereqClosure(graph0, v, taken, a.catalog).added.filter((p) => cand.pricing === 'full' || !homeGives(p))] : v)
  // past the deadline, nodes jumps to Infinity: every budget check fails and the search reports incomplete
  const deadline = timeLimitMs === undefined ? Infinity : Date.now() + timeLimitMs
  let nodes = 0
  const late = () => deadline !== Infinity && Date.now() > deadline && (nodes = Infinity) > 0
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
  type Ok = (i: number) => boolean | Ways
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
  /** The rows as `h` meets them, course by course (verify.rowUses): the exact reading, M-4 included. */
  const exact = (h: Set<CourseId>): Ok => {
    const memo = new Map<number, Ways>()
    return (i) => { let u = memo.get(i); if (!u) memo.set(i, (u = rowUses(L[i], h))); return u }
  }
  const rootPasses = (h: Set<CourseId>) => pass(a.root, exact(h))
  /** `ok` with every way that spends one of `ex` removed. */
  const without = (ok: Ok, ex: ReadonlySet<string>): Ok => (i) => { const u = ok(i); return typeof u === 'boolean' || !ex.size ? u : u.filter((w) => !w.some((x) => ex.has(x))) }
  const blocking = (h: Set<CourseId>) => {
    const st = statOf(h)
    return [...needy(exact(h))].filter((i) => splitAt(st[i]) && !split0[i]).sort((x, y) => x - y)
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
      for (const v of vs) { const s = [...new Set(withPre(v))].sort(); if (s.length) out.set(s.join('+'), s) }
    }
    return [...out.values()]
  })
  /**
   * A row in a slot of a "choose N" group (M-4) needs a way of its own: every group taken courses complete (nothing to
   * plan), or that can be completed at an allowed college, as the courses to plan. `spent` gives what the way spends:
   * the taken or planned course ids and the row's token (verify.rowUses reads a finished plan the same way).
   */
  const spent = new WeakMap<CourseId[], string[]>()
  const slotWays = (i: number): CourseId[][] => {
    const r = L[i], mix = honorsColleges(r), out = new Map<string, CourseId[]>(), t = rowToken(r.id)
    if (ucOnly(r)) { const none: CourseId[] = []; spent.set(none, [t]); return [none] } // nothing to plan; it spends itself
    for (const g of r.groups) {
      let vs: { add: CourseId[]; all: string[] }[] = [{ add: [], all: [] }]
      for (const c of g.courses) {
        if (has(taken, c, mix)) {
          const x = taken.has(c) ? c : taken.has(`${c}H`) ? `${c}H` : stripH(c)
          // met through its honors twin: or planned itself, so it spends an id of its own
          const own = x !== c && allowed.includes(g.institutionId) && a.catalog[c]
          vs = vs.flatMap((v) => [{ add: v.add, all: [...v.all, x] }, ...(own ? [{ add: [...v.add, c], all: [...v.all, c] }] : [])])
          continue
        }
        if (!allowed.includes(g.institutionId)) { vs = []; break }
        const alt = [c, ...(mix.has(g.institutionId) ? [c.endsWith('H') ? stripH(c) : `${c}H`] : [])].filter((x) => a.catalog[x])
        vs = vs.flatMap((v) => alt.map((x) => ({ add: [...v.add, x], all: [...v.all, x] })))
      }
      for (const v of vs) {
        const all = [...new Set([...v.all, t])].sort(), k = all.join('+')
        if (out.has(k)) continue
        const add = [...new Set(v.add)].sort()
        out.set(k, add); spent.set(add, all)
      }
    }
    return [...out.values()]
  }
  const poolOf = (w: CourseId[][][]) => w.map((x) => new Set(x.flat()))
  const pool = poolOf(ways)
  /** Additive cost of one course: units, units away from home, honors, count. */
  const vec = new Map<CourseId, number[]>()
  const addVec = (c: CourseId) => { const u = unitsOf(c, true); vec.set(c, [u, instOf(c) === home || started.has(c) ? 0 : u, /H$/.test(c) ? 1 : 0, 1]) }
  pool.forEach((s) => s.forEach(addVec))
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
  /** Chain splits of the planned courses `cs`: per subject chain with a planned course, the colleges its courses are
   *  planned or were taken at, minus one (so a chain across 3 colleges counts 2). Only grows as courses are added. */
  const chains = (cs: Iterable<CourseId>) => {
    const at = new Map<number, Set<number>>()
    for (const c of cs) for (const x of chainsOf.get(c) ?? []) at.set(x, (at.get(x) ?? new Set()).add(instOf(c)))
    let n = 0
    for (const [x, s] of at) n += new Set([...s, ...tookAt[x]]).size - 1
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
    // every alternative can pass, just not in different slots (their courses clash, or a UC-only row is listed twice):
    // the whole group is named, never a blank list
    const every = () => ks.map((c) => (c.kind === 'req' ? c.id : names(c))).sort().join(', ')
    if (n.type === 'UNITS') {
      const cc = [...new Set(ks.filter((c) => !isDeferrable(c)).map(names))].sort()
      return `${k} units of: ${cc.length ? cc.join(', ') : every()}${listed(at)}`
    }
    if (!rest.length) return `${k} of: ${every()}${listed(at)}`
    return `${more}${ok.length ? ' more' : ''} of: ${[...new Set(rest.map(names))].sort().join(', ')}${listed(at)}`
  }

  /* ---- configs: minimal sets of articulable requirements whose completion passes the tree ---- */

  // Ids in a config: a row (i < L.length); a place of a row in a slot of a "choose N" group (an occurrence, M-4): the
  // row with a way of its own, L.length + k; a shortfall (an OR / N_OF with fewer completable alternatives than it
  // needs), PSEUDO + k; a pair of occurrences in different slots of one group, whose ways must spend different courses.
  const pseudo: string[] = []
  const occRow: number[] = [], occAt = new Map<string, number>()
  const occ = (path: string, i: number) => { let o = occAt.get(path); if (o === undefined) occAt.set(path, (o = L.length + occRow.push(i) - 1)); return o }
  const isRow = (i: number) => i < L.length
  const isOcc = (i: number) => i >= L.length && i < PSEUDO
  const isPseudo = (i: number) => i >= PSEUDO && i < PAIR
  const isPair = (i: number) => i >= PAIR
  const rowOf = (i: number) => (isOcc(i) ? occRow[i - L.length] : i)
  const pairOf = (x: number, y: number) => PAIR + Math.min(x, y) * SHIFT + Math.max(x, y)
  const pairParts = (p: number): [number, number] => [Math.floor((p - PAIR) / SHIFT), (p - PAIR) % SHIFT]
  let overflow = false, heavyDepth = 0
  /** Minimal sets only. Shortest first, a set is kept unless a kept one is inside it, so `out` only grows and is the
   *  answer so far: past CONFIGS it overflows whatever the order (and stops early). A set with fewer pairs is easier,
   *  so the same rule holds with pairs in the sets. */
  const norm = (cs: number[][]) => {
    // past the cap only the first (shortest) set is kept: find it without the quadratic pass
    if (overflow) return cs.length ? [cs.reduce((x, y) => (y.length < x.length ? y : x))] : []
    const out: number[][] = [], rows: string[] = []
    // under a units group a config with more rows brings more units: only one with the same rows is dominated
    const rowsKey = (c: number[]) => (heavyDepth ? [...new Set(c.filter((i) => isRow(i) || isOcc(i)).map(rowOf))].sort((p, q) => p - q).join() : '')
    for (const c of [...new Map(cs.map((c) => [c.join(), c])).values()].sort((x, y) => x.length - y.length)) {
      const s = new Set(c), rk = rowsKey(c)
      if (!out.some((o, j) => rows[j] === rk && o.every((i) => s.has(i)))) { out.push(c); rows.push(rk) } // a superset config can never be cheaper
      if (out.length > CONFIGS) { overflow = true; break }
    }
    return overflow ? out.slice(0, 1) : out
  }
  /** A name for an id that does not depend on input order (indices follow tree order; requirement keys do not). */
  const idKey = (i: number): string => isRow(i) ? keyOfL[i] : isOcc(i) ? `\u0004${keyOfL[rowOf(i)]}` : isPseudo(i) ? `\u0001${pseudo[i - PSEUDO]}`
    : `\u0005${pairParts(i).map(idKey).sort().join('\u0006')}`
  const famKey = (f: number[][]) => f.map((c) => c.map(idKey).sort().join('\u0002')).sort().join('\u0003')
  /** Every union of one set per family, minimal sets only. The families are crossed in an order fixed by their size and
   *  content, not by the tree's order, so the work done, and whether it overflows on the way, is the same for any
   *  input order. */
  const cross = (ls: number[][][]) => ls.map((l) => ({ l, k: famKey(l) })).sort((x, y) => x.l.length - y.l.length || (x.k < y.k ? -1 : x.k > y.k ? 1 : 0))
    .reduce<number[][]>((acc, { l }) => norm(acc.flatMap((x) => l.map((y) => [...new Set([...x, ...y])].sort((p, q) => p - q)))), [[]])
  /** `cross` over the slots of one "choose N" group: each union also pairs every occurrence of one slot with every
   *  occurrence of each other slot (one course, one slot). */
  const slotCross = (ls: number[][][]): number[][] => {
    let acc: { s: number[]; by: number[][] }[] = [{ s: [], by: [] }]
    for (const l of ls) {
      acc = acc.flatMap((x) => l.map((y) => ({ s: [...x.s, ...y], by: [...x.by, y.filter(isOcc)] })))
      if (acc.length > CONFIGS) { overflow = true; return [[]] }
    }
    return norm(acc.map(({ s, by }) => {
      const out = new Set(s)
      by.forEach((p, x) => by.slice(x + 1).forEach((q) => p.forEach((o) => q.forEach((o2) => out.add(pairOf(o, o2))))))
      return [...out].sort((p, q) => p - q)
    }))
  }
  type Fam = number[][]
  /**
   * "N units from the following" (verify's fold): sets of alternatives, each met with courses of its own (slotCross),
   * whose rows add up to N units (unitsIn); smallest first. Through UC-only rows: the CC alternatives reach the units
   * they can (capOf) and the UC-only rows listed directly in the group make up the rest. None: a shortfall.
   */
  const unitFams = (n: ReqNode, ks: (ReqNode | Requirement)[], fs: { S: Fam; P: Fam }[]): { S: Fam; P: Fam } => {
    const need = needOf(n), units = unitsIn(n)
    const weight = (c: number[]) => [...new Set(c.filter((i) => isRow(i) || isOcc(i)).map(rowOf))].reduce((t, r) => t + (units.get(L[r].id) ?? 0), 0)
    const reach = (from: number[], want: number): Fam => {
      const out: number[][] = []
      let tried = 0
      for (let size = 1; size <= from.length && !overflow; size++) {
        const pick = (i0: number, got: number[]): void => {
          // every choice looked at counts, met or not: past CONFIGS (or the time limit) the search overflows
          if (++tried > CONFIGS || late()) { overflow = true; return }
          if (got.length === size) {
            // weighed before any config with more rows is dropped as a superset
            heavyDepth++
            try { out.push(...slotCross(got.map((j) => fs[j].S)).filter((c) => weight(c) >= want)) } finally { heavyDepth-- }
            if (out.length > CONFIGS) overflow = true
            return
          }
          for (let i = i0; i <= from.length - (size - got.length) && !overflow; i++) pick(i + 1, [...got, from[i]])
        }
        pick(0, [])
      }
      return norm(out)
    }
    const ok = ks.flatMap((c, j) => (canSat(c) ? [j] : []))
    let S = reach(ok, need)
    if (!S.length) S = cross([slotCross(ok.map((j) => fs[j].S)), [[PSEUDO + pseudo.push(shortfall(n)) - 1]]])
    // UC-only rows listed in the group count once each; every alternative that can only pass through UC-only rows passes
    const C = capOf(n), dU = [...new Set(ks.filter((c): c is Requirement => c.kind === 'req' && ucOnly(c)).map((r) => r.id))].reduce((t, id) => t + (units.get(id) ?? 0), 0)
    const hd = ks.flatMap((c, j) => (canRoute(c) && hypState(c) === 'def' ? [j] : []))
    if (C >= need || C + dU < need || !dU) return { S, P: S }
    const okH = ok.filter((j) => hypState(ks[j]) === 'sat'), R = C > 0 ? reach(okH, C) : [[]]
    // (UC-only rows listed in the group only add units: they spend nothing here, as verify reads it)
    const hdNodes = hd.filter((j) => ks[j].kind !== 'req')
    return { S, P: R.length ? norm([...S, ...cross([R, ...hdNodes.map((j) => fs[j].P)])]) : S }
  }
  /** Minimal requirement sets that make the subtree `sat` (S) or pass (P). A row with no way at `allowed` is given up.
   *  `path` names the place in the tree; `inSlot`: below a slot of a "choose N" group, where rows are occurrences. */
  // An occurrence is named by its row and the slots it sits in (every enclosing "choose N" group and which of its
  // alternatives): two places of one row in the same slots have the same partners, so one way serves both.
  const fams = (n: ReqNode | Requirement, path = '', inSlot = false, slotsAt = ''): { S: Fam; P: Fam } => {
    if (overflow) return { S: [[]], P: [[]] }
    if (n.kind === 'req') {
      // a UC-only row in a slot fills it once: it is a place of its own, spending the row (slotWays)
      if (ucOnly(n)) return { S: [], P: [inSlot ? [occ(`${slotsAt}#${ix.get(n)}`, ix.get(n)!)] : []] }
      const id = inSlot ? occ(`${slotsAt}#${ix.get(n)}`, ix.get(n)!) : ix.get(n)!
      return { S: [[id]], P: [[id]] }
    }
    const ks = kidsOf(n), slots = slotted(n) || n.type === 'UNITS'
    if (n.type === 'UNITS') heavyDepth++
    const fs = ks.map((c, j) => fams(c, `${path}/${j}`, inSlot || slots, slots ? `${slotsAt}/${path}:${j}` : slotsAt))
    if (n.type === 'UNITS') heavyDepth--
    if (n.type === 'AND') {
      const P = cross(fs.map((f) => f.P))
      // `sat` once all pass, unless every child can pass as UC-only: then one of them must be `sat`
      return { S: ks.length && ks.every(mayDef) ? norm(fs.flatMap((f) => cross([f.S, P]))) : P, P }
    }
    const k = needOf(n)
    if (k <= 0) return { S: [[]], P: [[]] }
    if (n.type === 'UNITS') return unitFams(n, ks, fs)
    const join = slots ? slotCross : cross
    // k alternatives `sat`. Fewer completable here than needed: plan those, report the rest as one shortfall. Part
    // of an alternative that cannot be completed earns nothing, so it is never planned.
    const ok = ks.flatMap((c, j) => (canSat(c) ? [j] : []))
    /** Every choice of `want` of `from`, each `sat` (their slots spending different courses). */
    const choose = (from: number[], want: number): Fam => {
      // each choice gives at least one set: more choices than CONFIGS overflow whatever they hold
      let c = 1
      for (let i = 0; i < want && c <= CONFIGS; i++) c = (c * (from.length - i)) / (i + 1)
      if (c > CONFIGS) { overflow = true; return [[]] }
      const out: number[][] = []
      const pick = (i0: number, got: number[]): void => {
        if (got.length === want) { out.push(...join(got.map((j) => fs[j].S))); if (out.length > CONFIGS) overflow = true; return }
        for (let i = i0; i <= from.length - (want - got.length) && !overflow; i++) pick(i + 1, [...got, from[i]])
      }
      pick(0, [])
      return norm(out)
    }
    const S: Fam = ok.length < k ? cross([join(ok.map((j) => fs[j].S)), [[PSEUDO + pseudo.push(shortfall(n)) - 1]]]) : choose(ok, k)
    if (!slots) {
      // Or every articulable alternative passes and UC-only ones fill the remaining slots.
      const art = ks.flatMap((c, j) => (canRoute(c) ? [j] : []))
      return { S, P: art.length >= k && art.some((j) => mayDef(ks[j])) ? norm([...S, ...cross(art.map((j) => fs[j].P))]) : S }
    }
    // "Choose N" (verify's fold): it passes through UC-only rows once the CC alternatives fill the C slots they can
    // (capOf) and every alternative that can only pass through UC-only rows passes, if those make up the rest.
    const C = capOf(n)
    const hs = ks.flatMap((c, j) => (hypState(c) === 'sat' ? [j] : [])), hd = ks.flatMap((c, j) => (canRoute(c) && hypState(c) === 'def' ? [j] : []))
    if (C >= k || C + hd.length < k || !hd.length) return { S, P: S }
    const okH = hs.filter((j) => ok.includes(j))
    if (okH.length < C) return { S, P: S } // the CC slots cannot all be filled here: the group stays open
    // C of them met and k - C of those only UC-only rows can pass, each slot spending its own; the others pass too
    const binom = (n: number, r: number) => { let c = 1; for (let i = 0; i < r && c <= CONFIGS; i++) c = (c * (n - i)) / (i + 1); return c }
    if (binom(okH.length, C) * binom(hd.length, k - C) > CONFIGS) { overflow = true; return { S, P: S } }
    const out: number[][] = []
    const picks = (from: number[], want: number): number[][] => want === 0 ? [[]] : from.flatMap((j, i) => picks(from.slice(i + 1), want - 1).map((r) => [j, ...r]))
    for (const a of picks(okH, C)) for (const b of picks(hd, k - C)) {
      if (overflow || out.length > CONFIGS || late()) { overflow = true; break }
      // (a UC-only row not taking a slot needs nothing and spends nothing)
      out.push(...cross([slotCross([...a.map((j) => fs[j].S), ...b.map((j) => fs[j].P)]), ...hd.filter((j) => !b.includes(j) && ks[j].kind !== 'req').map((j) => fs[j].P)]))
    }
    return { S, P: norm([...S, ...out]) }
  }
  const configs = a.root.required ? fams(a.root).P : [[]]
  // Occurrences get the ways of their row, each with what it spends (ways already taken included).
  for (const i of occRow) ways.push(slotWays(i))
  for (const w of ways.slice(L.length)) for (const v of w) for (const c of v) if (!vec.has(c)) addVec(c)

  /* ---- branch-and-bound ---- */

  // v: requirements given up, cost, new splits, units away from home, honors courses, courses. Then course ids,
  // requirements given up, the config: the order never depends on input order.
  type Sol = { v: number[]; cs: CourseId[]; skip: number[]; cfg: number[]; got?: [number, string[]][] }
  const nameOf = (i: number): string => isRow(i) ? L[i].id : isOcc(i) ? `${L[rowOf(i)].id}\u0004` : isPseudo(i) ? pseudo[i - PSEUDO]
    : pairParts(i).map(nameOf).sort().join('\u0005')
  const idsOf = (is: number[]) => is.map(nameOf).sort()
  // then which way each place in a "choose N" slot takes (M-4), so ties never follow input order
  const flat = (x: Sol) => [...x.v, ...x.cs, ...idsOf(x.skip), x.cfg.length, ...idsOf(x.cfg),
    ...(x.got ?? []).map(([i, all]) => `${nameOf(i)}=${all.join('+')}`).sort()]
  const better = (x: Sol, y: Sol | null) => !y || lex(flat(x), flat(y)) < 0
  const memo = new Map<string, { cols: number[]; used: number[]; sol: Sol | null }[]>()

  /** Cheapest way to complete requirements `ls` (independent of everything else) with ways `W`. Cost: units plus
   *  split subject chains. `ws`: other requirements their courses touch, where a new split is counted, or, if in
   *  `guard`, forbidden; with a guard a requirement may be skipped. `pairs`: occurrences whose ways must spend
   *  different courses (M-4); each is given a way of its own, and may be given up when none fits. */
  /** Most requirements a config may give up and still match the best config so far (solveAt): past it, stop. */
  let skipCap = INF
  /** With a config that is one component: the best config's cost vector (less what the config gives up outright). */
  let capV: number[] | null = null, bestV: number[] | null = null
  const branch = (ls: number[], ws: number[], guard: Set<number> | null, W0: CourseId[][][], PW0: Set<CourseId>[], pCh: number, pairs: [number, number][] = []): Sol | null => {
    const partners = new Map<number, number[]>()
    for (const [x, y] of pairs) { partners.set(x, [...(partners.get(x) ?? []), y]); partners.set(y, [...(partners.get(y) ?? []), x]) }
    const assigned = new Map<number, Set<string>>()
    // Ways whose courses no other requirement here (or watched row) can use, with equal cost vectors, differ only by
    // ids: keep the smallest, which also gives the smallest merged id list. Not with chains, which see colleges.
    let W = W0, PW = PW0
    if (!pCh) {
      const n = new Map<CourseId, number>()
      for (const i of ls) for (const c of PW0[i]) n.set(c, (n.get(c) ?? 0) + 1)
      for (const w of ws) for (const c of touch[w]) n.set(c, (n.get(c) ?? 0) + 2)
      W = [...W0]; PW = [...PW0]
      for (const i of ls) {
        if (partners.has(i)) continue // what each way spends matters, not only its cost
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
      // a place in a slot whose every way clashes with a partner's already will be given up too
      const clash = (i: number) => W[i].every((w) => { const all = spent.get(w)!; return partners.get(i)!.some((j) => { const o = assigned.get(j); return !!o && all.some((x) => o.has(x)) }) })
      const t = [skip.length + order.slice(k).filter((i) => partners.has(i) && !assigned.has(i) && clash(i)).length, ...sumV([...P])]
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
          if (w.length) byCol.set(instOf(w[0]), Math.min(byCol.get(instOf(w[0])) ?? INF, s[0]))
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
      const h = withTaken(P), sk = skip.map(rowOf)
      let splits = 0
      for (const w of [...ws, ...sk]) {
        if (!splitAt(reqStatus(L[w], h)) || split0[w]) continue
        if (guard && (guard.has(w) || sk.includes(w))) return
        splits++
      }
      const cs = [...P].sort(), [u, away, hon, n] = sumV(cs)
      const s: Sol = { v: [skip.length, u + (pCh ? pCh * chains(cs) : 0), splits, away, hon, n], cs, skip: [...skip], cfg: [],
        ...(assigned.size ? { got: [...assigned].map(([i, x]): [number, string[]] => [i, [...x]]) } : {}) }
      if (better(s, best)) best = s
    }
    const dfs = (k: number): void => {
      if (++nodes > budget || late()) return
      while (k < order.length && !partners.has(order[k]) && done(order[k])) k++
      if (k === order.length) return finish()
      const lb = bound(k)
      if ((best && lex(lb, best.v) > 0) || lb[0] > skipCap || (capV && lex(lb, capV) > 0)) return
      const i = order[k], mine = partners.get(i)
      const adds = W[i].map((w) => ({ w, add: w.filter((c) => !P.has(c)) })).map((x) => ({ ...x, key: [...sumV(x.add), ...x.add] }))
      for (const { w, add } of adds.sort((x, y) => lex(x.key, y.key))) {
        if (mine) {
          // one course, one slot: this way must spend nothing a partner's way already spends
          const all = spent.get(w)!
          if (mine.some((j) => { const o = assigned.get(j); return !!o && all.some((x) => o.has(x)) })) continue
          assigned.set(i, new Set(all))
        }
        add.forEach((c) => P.add(c)); dfs(k + 1); add.forEach((c) => P.delete(c))
        if (mine) assigned.delete(i)
      }
      if (guard || mine) { skip.push(i); dfs(k + 1); skip.pop() }
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
   * `branch` with subject chain splits charged. Every plan plans no course of a chain, keeps it at one college k (all
   * its planned courses there, where it was taken if anywhere) or splits it; so per assignment of the component's
   * chains (avoid, keep at k, free) the unit-only search runs on the ways that respect it, and each result is scored
   * with its real chains. Every plan of an assignment costs at least its result's units plus one penalty per free
   * chain (a split costs at least that); a result at that bound is the best of its assignment, tie-breaks included.
   * So the best result is exact unless some assignment's bound, missed by its result (a free chain at 3+ colleges),
   * is not above it: then, and with too many assignments, `branch` with the chain bound instead.
   */
  const component = (key: string, cols: number[], ls: number[], ws: number[], guard: Set<number> | null, W: CourseId[][][], PW: Set<CourseId>[], pCh: number, pairs: [number, number][]): Sol | null => {
    const plain = () => memoized(`${key}|0`, cols, () => branch(ls, ws, guard, W, PW, 0, pairs))
    if (!pCh) return plain()
    return memoized(`${key}|${pCh}`, cols, () => {
      const xs = subjects.map((_, x) => x).filter((x) => ls.some((i) => [...PW[i]].some((c) => chainsOf.get(c)?.includes(x))))
      const AVOID = -2, FREE = -1, opts = xs.map((x) => [AVOID, FREE, ...homesOf(x, ls, PW)])
      if (opts.reduce((n, o) => n * o.length, 1) > 64) return branch(ls, ws, guard, W, PW, pCh, pairs)
      let best: Sol | null = null
      const open: number[][] = [] // bounds of assignments whose result is above them
      const score = (r: Sol | null, free: number) => {
        if (!r) return
        const s: Sol = { ...r, v: [r.v[0], r.v[1] + pCh * chains(r.cs), ...r.v.slice(2)] }, lb = [r.v[0], r.v[1] + pCh * free]
        if (s.v[1] > lb[1] + EPS) open.push(lb)
        if (better(s, best)) best = s
      }
      const pick = (j: number, keep: [number, number][]): void => {
        if (j < xs.length) { for (const k of opts[j]) pick(j + 1, k === FREE ? keep : [...keep, [xs[j], k]]); return }
        const free = xs.length - keep.length
        if (!keep.length) return score(plain(), free)
        // a way is at one college: it respects "chain x stays at k" unless it holds a course of x elsewhere
        const V = W.map((ws, i) => (ls.includes(i) ? ws.filter((w) => keep.every(([x, k]) => !w.length || instOf(w[0]) === k || !w.some((c) => chainsOf.get(c)?.includes(x)))) : ws))
        if (!guard && ls.some((i) => !V[i].length && !pairs.some((p) => p.includes(i)))) return
        score(memoized(`${key}|${keep.map((p) => p.join(':'))}`, cols, () => branch(ls, ws, guard, V, poolOf(V), 0, pairs)), free)
      }
      pick(0, [])
      const b = best as Sol | null
      if (b && open.some((lb) => lex(b.v.slice(0, 2), lb) >= 0)) return branch(ls, ws, guard, W, PW, pCh, pairs)
      return best
    })
  }

  /** Best plan for config C using only the ways `W` (courses at home and the colleges being tried); the college
   *  penalty is not included. */
  const solveConfig = (C0: number[], guarded: boolean, W: CourseId[][][], PW: Set<CourseId>[], pCh: number): Sol | null => {
    // an occurrence in no pair is just its row
    const paired = new Set(C0.filter(isPair).flatMap(pairParts))
    // (a UC-only row in no pair needs nothing)
    const C = [...new Set(C0.map((i) => (isOcc(i) && !paired.has(i) ? rowOf(i) : i)))].filter((i) => !(isRow(i) && ucOnly(L[i])))
    const F =C.filter((i) => (isRow(i) && !sat0[i] && W[i].length) || (isOcc(i) && W[i].length)), inF = new Set(F)
    const forced = C.filter((i) => isPseudo(i) || (isRow(i) && !sat0[i] && !W[i].length) || (isOcc(i) && !W[i].length))
    // rows the config completes (an occurrence completes its row)
    const doneRows = new Set(F.map(rowOf))
    const pairs = C.filter(isPair).map(pairParts).filter(([x, y]) => inF.has(x) && inF.has(y))
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
    // partners in a pair can clash on a taken course too: one component
    for (const [x, y] of pairs) join(x, y)
    for (let w = 0; w < L.length; w++) {
      if (!L[w].groups.length || sat0[w] || doneRows.has(w)) continue
      const hit = [...touch[w]].filter((c) => owner.has(c)).map((c) => owner.get(c)!)
      if (hit.length) { hit.forEach((i) => join(i, hit[0])); watch.push([w, hit[0]]) }
    }
    // Guarded (second pass): new splits are forbidden where the tree would still need the requirement.
    const guard = guarded ? needy((i) => sat0[i] || doneRows.has(i)) : null
    const comps = new Map<number, { ls: number[]; ws: number[]; ps: [number, number][] }>()
    const at = (i: number) => { const r = find(i); if (!comps.has(r)) comps.set(r, { ls: [], ws: [], ps: [] }); return comps.get(r)! }
    F.forEach((i) => at(i).ls.push(i))
    watch.forEach(([w, i]) => at(i).ws.push(w))
    pairs.forEach((p) => at(p[0]).ps.push(p))
    const cs: CourseId[] = [], skip = [...forced], got: [number, string[]][] = []
    let splits = 0, cost = 0
    const cap = skipCap
    capV = comps.size === 1 && bestV ? [bestV[0] - forced.length, ...bestV.slice(1)] : null
    for (const { ls, ws, ps } of comps.values()) {
      skipCap = cap - skip.length // what this config has given up already counts against the cap
      // the colleges a component may use decide its ways
      const cols = [...new Set(ls.flatMap((i) => W[i].filter((w) => w.length).map((w) => instOf(w[0]))))].sort((x, y) => x - y)
      const s = component(`${ls}|${ws}|${guard ? ws.filter((w) => guard.has(w)) : '-'}|${ps.map((p) => p.join('~'))}|${skipCap}|${capV}`, cols, ls, ws, guard, W, PW, pCh, ps)
      if (!s) { skipCap = cap; capV = null; return null }
      cs.push(...s.cs); skip.push(...s.skip); splits += s.v[2]; cost += s.v[1]; got.push(...(s.got ?? []))
    }
    skipCap = cap; capV = null
    if (skip.length > cap) return null
    cs.sort()
    const [, away, hon, n] = sumV(cs)
    return { v: [skip.length, cost, splits, away, hon, n], cs, skip: skip.sort((x, y) => x - y), cfg: C0, ...(got.length ? { got } : {}) }
  }
  /** Every non-home college some requirement could use. */
  const reachable = [...new Set(ways.flatMap((w) => w.filter((v) => v.length).map((v) => instOf(v[0]))))].filter((i) => i !== home).sort((x, y) => x - y)
  /** Ways at home and the colleges `S` only. */
  const restrict = (S: number[]) => {
    const inS = new Set(S)
    // a way already taken plans nothing: it is at no college
    return ways.map((w) => w.filter((v) => { if (!v.length) return true; const i = instOf(v[0]); return i === home || inS.has(i) }))
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
   * college (where it was taken, if anywhere), or split at pChain (a free facility; a split costs at least that). The dual ascent of the LP gives
   * the bound (Erlenkotter).
   */
  const dualBound = (W: CourseId[][][], I: number[], D: number[], pCh: number) => {
    const SPLIT = -1, free = (k: number) => k === SPLIT || k === home || I.includes(k)
    let best: number[] = [INF, INF]
    for (const C of configs) {
      const skip = C.filter((i) => isPseudo(i) || (isRow(i) && !sat0[i] && !W[i].length) || (isOcc(i) && !W[i].length)).length
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
        // a config that must give up more than the best so far cannot win (what it gives up only grows)
        const lost = (C: number[]) => C.filter((i) => isPseudo(i) || (isRow(i) && !sat0[i] && !W[i].length) || (isOcc(i) && !W[i].length)).length
        // fewest given up, then fewest ids, then by content: a good incumbent early, in an order the input does not set
        const ck = new Map(configs.map((C) => [C, C.map(idKey).sort().join('\u0007')]))
        for (const C of [...configs].sort((x, y) => lost(x) - lost(y) || x.length - y.length || (ck.get(x)! < ck.get(y)! ? -1 : ck.get(x)! > ck.get(y)! ? 1 : 0))) {
          if (b && lost(C) > b.v[0]) break
          skipCap = b ? b.v[0] : INF; bestV = b ? b.v : null
          const r = solveConfig(C, guarded, W, PW, pCh); if (r && better(r, b)) b = r
        }
        skipCap = INF; bestV = null
        solved.set(key, b)
      }
      return solved.get(key)!
    }
    const worse = (v: number[]) => !!best && lex(v, best.v.slice(0, 2)) > 0
    // chain terms in the bounds assume every row is completed; the guarded pass may give rows up instead
    const pCh = guarded ? 0 : pChain
    const node = (I: number[], D: number[]): void => {
      if (++nodes > budget || late()) return
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
  type Cand = { g: CourseGroup; cost: number; need?: CourseId[] }
  const rank = ({ g, cost }: Cand): (number | string)[] =>
    [cost, g.institutionId === home ? 0 : 1, g.courses.filter((c) => /H$/.test(c)).length, g.courses.length, -reach(g), g.institutionId, [...g.courses].sort().join('+'), g.courses.join('+')]
  const cmp = (x: (number | string)[], y: (number | string)[]) => {
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
    return 0
  }
  /** The best group the plan completes for a requirement (reported as `chosen`): the listing closest to the courses
   *  actually taken or planned (fewest honors swaps, as verify reports `satisfied`), each course named as planned (N-4:
   *  CHEM 1AH + 1BH in the plan is reported as 1AH + 1BH, not as the agreement's CHEM 1A + 1B). */
  const completed = (r: Requirement, h: Set<CourseId>, only?: Set<string>): CourseGroup | undefined => {
    const mix = honorsColleges(r)
    const as = (c: CourseId) => (h.has(c) ? c : h.has(`${c}H`) ? `${c}H` : stripH(c)) // only called when has(h, c, mix)
    const swaps = (g: CourseGroup) => g.courses.filter((c) => !h.has(c)).length
    const g = r.groups.filter((g) => g.courses.every((c) => has(h, c, mix)) && (!only || g.courses.every((c) => only.has(as(c))))).map((g) => ({ g, cost: 0 }))
      .sort((x, y) => swaps(x.g) - swaps(y.g) || cmp(rank(x), rank(y)))[0]?.g
    return g && swaps(g) ? { ...g, courses: g.courses.map(as) } : g
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

    /** What completing group `g` spends (verify.rowUses): the taken ids standing for its courses, the ids it plans. */
    const spends = (g: CourseGroup, h: Set<CourseId>, mix: ReadonlySet<number>) => g.courses.map((c) => (has(h, c, mix)
      ? (h.has(c) ? c : h.has(`${c}H`) ? `${c}H` : stripH(c))
      : a.catalog[c] || !mix.has(g.institutionId) ? c : c.endsWith('H') ? stripH(c) : `${c}H`))
    /** `ex`: ids another slot of a "choose N" group above already spends (M-4); a group spending one is no way here. */
    const bestGroup = (req: Requirement, h: Set<CourseId>, ex: ReadonlySet<string> = NONE): Cand | null => {
      let best: Cand | null = null
      const mix = honorsColleges(req), at = new Set([...planned].map(instOf))
      if (ex.has(rowToken(req.id))) return null
      for (const g of req.groups) {
        let need = toPlan(g, h, mix)
        if (ex.size) {
          // a course met only through its honors twin, which another slot spends, can be planned itself
          const sp = spends(g, h, mix), own = g.courses.filter((c, j) => !h.has(c) && has(h, c, mix) && ex.has(sp[j]) && a.catalog[c])
          if (g.courses.some((c, j) => ex.has(own.includes(c) ? c : sp[j]))) continue
          need = [...need, ...own]
        }
        // Only complete groups at colleges the student can attend, unless it is already complete.
        if (need.length && (!allowed.includes(g.institutionId) || banned.has(g))) continue
        // A course missing from the catalog has unknown units: not plannable.
        if (need.some((c) => !a.catalog[c])) continue
        // Marginal home-system units to complete the group given what is already taken or planned; a new college costs.
        const fresh = need.length && g.institutionId !== home && !at.has(g.institutionId) ? pCollege : 0
        const cand = { g, need, cost: need.reduce((s, c) => s + unitsOf(c), 0) + fresh + (splitting.has(g) ? SPLIT : 0) }
        if (!best || cmp(rank(cand), rank(best)) < 0) best = cand
      }
      return best
    }

    type Want = 'sat' | 'pass'
    const meets = (n: ReqNode | Requirement, ok: Ok, want: Want) => { const s = state(n, ok); return s === 'sat' || (want === 'pass' && s === 'def') }
    const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0)
    /**
     * Passing through UC-only rows: every articulable alternative passing (UC-only ones fill the rest), available only
     * when one can be UC-only. In a "choose N" group (verify's fold): the CC alternatives fill the C slots they can
     * (capOf; `more` of them still to meet, from `rest` read as `ok2` / `ex2`) and every alternative that can only pass
     * through UC-only rows passes. `pass`: those to pass; `sat`: those to meet.
     */
    const viaDef = (n: ReqNode, k: number, rest: (ReqNode | Requirement)[], h: Set<CourseId>, ok2: Ok, ex2: ReadonlySet<string>) => {
      const ks = kidsOf(n), need = needOf(n)
      if (n.type === 'UNITS') return null // the fallback plans every course of a stuck group instead (flood)
      if (!slotted(n)) { const art = ks.filter(canRoute); return art.length >= need && art.some(mayDef) ? { pass: art, sat: [] } : null }
      const C = capOf(n), hd = ks.filter((c) => canRoute(c) && hypState(c) === 'def'), more = C - (need - k)
      if (C >= need || C + hd.length < need || !hd.length) return null
      const sat = rest.filter((c) => hypState(c) === 'sat').map((c) => ({ c, cost: estimate(c, h, ok2, 'sat', ex2), key: keyOf(c) }))
        .sort((x, y) => x.cost - y.cost || cmp([x.key], [y.key])).slice(0, Math.max(0, more)).filter((x) => x.cost < INF).map((x) => x.c)
      return sat.length < more ? null : { pass: hd, sat }
    }
    const costOf = (d: { pass: (ReqNode | Requirement)[]; sat: (ReqNode | Requirement)[] } | null, h: Set<CourseId>, ok: Ok, ex: ReadonlySet<string>, ok2: Ok, ex2: ReadonlySet<string>) =>
      !d ? INF : sum(d.pass.map((c) => estimate(c, h, ok, 'pass', ex))) + sum(d.sat.map((c) => estimate(c, h, ok2, 'sat', ex2)))
    /**
     * An OR / N_OF as the plan stands: `k` more alternatives to meet, from `rest`, with `ok2` / `ex2` the rows read
     * without the courses the alternatives already filling its slots spend (one course, one slot, M-4).
     */
    const slotsOf = (n: ReqNode, ok: Ok, ex: ReadonlySet<string>) => {
      const ks = kidsOf(n)
      if (!slotted(n) && n.type !== 'UNITS') { const sat = ks.filter((c) => state(c, ok) === 'sat'); return { k: needOf(n) - sat.length, rest: ks.filter((c) => !sat.includes(c)), ok2: ok, ex2: ex } }
      const fill = slotFill(n, (r) => ok(ix.get(r)!))
      const ex2 = new Set([...ex, ...fill.ways.flat()])
      // in a units group, an alternative whose rows have no known units adds nothing
      const u = n.type === 'UNITS' ? unitsIn(n) : null, rowsIn = (x: ReqNode | Requirement): string[] => (x.kind === 'req' ? [x.id] : x.children.flatMap(rowsIn))
      const rest = ks.filter((c) => !fill.kids.includes(c) && (!u || rowsIn(c).some((id) => (u.get(id) ?? 0) > 0)))
      return { k: fill.left, rest, ok2: without(ok, ex2), ex2 }
    }
    /** Estimated cost to make a subtree `sat` or pass from here (used to choose among OR / N_OF children). */
    const estimate = (n: ReqNode | Requirement, h: Set<CourseId>, ok: Ok, want: Want, ex: ReadonlySet<string> = NONE): number => {
      if (meets(n, ok, want)) return 0
      if (n.kind === 'req') return bestGroup(n, h, ex)?.cost ?? INF
      const ks = kidsOf(n)
      if (n.type === 'AND') {
        const p = ks.map((c) => estimate(c, h, ok, 'pass', ex)), tot = sum(p)
        return want === 'pass' || tot === INF ? tot : tot + Math.min(...ks.map((c, j) => estimate(c, h, ok, 'sat', ex) - p[j]))
      }
      const { k, rest, ok2, ex2 } = slotsOf(n, ok, ex)
      const s = rest.map((c) => estimate(c, h, ok2, 'sat', ex2)).sort((x, y) => x - y)
      const A = s.length < k ? INF : sum(s.slice(0, k)), d = want === 'pass' ? viaDef(n, k, rest, h, ok2, ex2) : null
      return Math.min(A, costOf(d, h, ok, ex, ok2, ex2))
    }

    /** Order-independent name of a subtree, to break cost ties among OR / N_OF children. */
    const keyOf = (n: ReqNode | Requirement): string => (n.kind === 'req' ? n.id : `(${n.children.map(keyOf).sort().join(',')})`)

    /**
     * Collect the requirements that still need a group, choosing cheapest branches at OR / N_OF. `alt` gets those
     * reached through such a choice, which may still change as courses are planned. Each comes with the ids its group
     * must not spend (`ex`, M-4).
     */
    type Todo = { req: Requirement; ex: ReadonlySet<string> }
    const needed = (n: ReqNode | Requirement, h: Set<CourseId>, ok: Ok, want: Want, acc: Todo[], alt: Set<Requirement>, inAlt = false, ex: ReadonlySet<string> = NONE): void => {
      if (meets(n, ok, want)) return
      if (n.kind === 'req') { if (!ucOnly(n)) { acc.push({ req: n, ex }); if (inAlt) alt.add(n) } return }
      if (!n.required) return
      const ks = kidsOf(n)
      if (n.type === 'AND') {
        ks.forEach((c) => needed(c, h, ok, 'pass', acc, alt, inAlt, ex))
        if (want === 'sat' && !ks.some((c) => state(c, ok) === 'sat')) {
          const d = ks.map((c) => ({ c, cost: estimate(c, h, ok, 'sat', ex) - estimate(c, h, ok, 'pass', ex), key: keyOf(c) }))
            .filter((x) => x.cost < INF).sort((x, y) => x.cost - y.cost || cmp([x.key], [y.key]))
          if (d.length) needed(d[0].c, h, ok, 'sat', acc, alt, inAlt, ex)
        }
        return
      }
      const { k, rest, ok2, ex2 } = slotsOf(n, ok, ex)
      const ranked = rest.map((c) => ({ c, cost: estimate(c, h, ok2, 'sat', ex2), key: keyOf(c) }))
        .sort((x, y) => x.cost - y.cost || cmp([x.key], [y.key]))
      const A = ranked.length < k ? INF : sum(ranked.slice(0, k).map((r) => r.cost))
      const d = want === 'pass' ? viaDef(n, k, rest, h, ok2, ex2) : null, B = costOf(d, h, ok, ex, ok2, ex2)
      if (A < INF && A <= B) ranked.slice(0, k).forEach((r) => needed(r.c, h, ok2, 'sat', acc, alt, true, ex2))
      else if (B < INF) { d!.pass.forEach((c) => needed(c, h, ok, 'pass', acc, alt, true, ex)); d!.sat.forEach((c) => needed(c, h, ok2, 'sat', acc, alt, true, ex2)) }
      else if ((slotted(n) || n.type === 'UNITS') && !flooded.has(n)) stuck.push(n)
      else {
        ranked.filter((r) => r.cost < INF).slice(0, k).forEach((r) => needed(r.c, h, ok2, 'sat', acc, alt, true, ex2))
        unsolvable.add(shortfall(n))
      }
    }
    /**
     * A "choose N" group the alternatives filling its slots now leave no way to complete: which course fills which slot
     * may have to change, which one group at a time cannot see. Plan every course its rows could use here instead
     * (once), and let the final pass drop what the plan does not need. If even that cannot meet it, it is reported.
     */
    const stuck: ReqNode[] = [], flooded = new Set<ReqNode>()
    const flood = (n: ReqNode, h: Set<CourseId>) => {
      flooded.add(n)
      const rows = new Set<Requirement>()
      const walk = (x: ReqNode | Requirement): void => { if (x.kind === 'req') rows.add(x); else kidsOf(x).forEach(walk) }
      walk(n)
      let added = false
      for (const r of rows) {
        const mix = honorsColleges(r)
        for (const g of r.groups) {
          if (!allowed.includes(g.institutionId) || banned.has(g)) continue
          // with every course it lists that the catalog has, honors twins met through the other twin included
          const need = [...toPlan(g, h, mix), ...g.courses.filter((c) => !h.has(c) && has(h, c, mix) && a.catalog[c])]
          if (need.some((c) => !a.catalog[c])) continue
          for (const c of need) if (!planned.has(c) && !taken.has(c)) { planned.add(c); added = true }
        }
      }
      return added
    }

    const splitIds = (h: Set<CourseId>) => new Set(verifySchedule(h, a).splitSeriesViolations.map((v) => v.requirementId))
    const giveUp = (req: Requirement) => {
      const why = req.groups.filter((g) => banned.has(g)).map((g) => banned.get(g)!)
      unsolvable.add(why.length ? `${req.id} (only by splitting ${[...new Set(why)].sort().join(', ')})` : offered(req))
    }

    // One group per iteration so shared courses (De Anza MATH 1B serves MATH 51 and 52) get counted once.
    // Each round satisfies a leaf or penalizes a group, so this bound (from the tree size) is never hit on a sane tree.
    const pickedFor = new Map<string, Requirement>()
    let rounds = 0, before = splitIds(have())
    const run = () => {
    rounds = L.reduce((s, r) => s + 1 + r.groups.length, 1)
    before = splitIds(have())
    for (let round = 0; ; round++) {
      // past the time limit: what is planned so far, after at least one pick (a plan the tree does not pass is reported)
      if (round && late()) break
      const h = have()
      const todo: Todo[] = [], alt = new Set<Requirement>()
      stuck.length = 0
      needed(a.root, h, exact(h), 'pass', todo, alt)
      if (stuck.length) {
        if (stuck.map((n) => flood(n, h)).some(Boolean)) continue
        for (const n of stuck) unsolvable.add(shortfall(n))
      }
      if (!rounds--) { todo.forEach((t) => giveUp(t.req)); break }
      let pick: { req: Requirement; g: CourseGroup; cost: number; need?: CourseId[] } | null = null
      for (const { req, ex } of todo) {
        const b = bestGroup(req, h, ex)
        if (!b) { giveUp(req); continue }
        // Equal cost: commit forced requirements before OR / N_OF alternatives, whose ranking they can change.
        const key = (r: Requirement, c: Cand) => [c.cost, alt.has(r) ? 1 : 0, ...rank(c).slice(1), r.id]
        if (!pick || cmp(key(req, b), key(pick.req, pick)) < 0) pick = { req, ...b }
      }
      if (!pick) break
      const mix = honorsColleges(pick.req)
      const next = new Set(h)
      ;(pick.need ?? toPlan(pick.g, h, mix)).forEach((c) => next.add(c))
      // Avoid opening a new split series elsewhere (e.g. an unused N_OF alternative) while another route exists.
      const after = splitIds(next), opened = [...after].filter((id) => !before.has(id)).sort()
      if (opened.length && !splitting.has(pick.g)) { splitting.add(pick.g); continue }
      if (opened.length) forced.set(pick.g, opened)
      before = after
      chosen[pick.req.id] = pick.g; pickedFor.set(pick.req.id, pick.req)
      next.forEach((c) => { if (!taken.has(c)) planned.add(c) })
    }
    }
    run()
    // Still short, one group at a time (which alternative fills which slot of a "choose N" or units group may have to
    // change): plan every course the tree could use, once, and start again; the pass below drops what is not needed.
    const every = withTaken(Object.keys(a.catalog).filter((c) => allowed.includes(instOf(c))))
    if (!late() && a.root.required && !rootPasses(have()) && rootPasses(every) && !flooded.has(a.root) && flood(a.root, have())) { unsolvable.clear(); run() }

    // Drop planned courses a later pick made redundant: every satisfied requirement stays satisfied, no new split,
    // and a tree that passes still passes (a course may be needed only so two slots use different courses, M-4).
    const final = verifySchedule(have(), a), passed = rootPasses(have())
    const splits = new Set(final.splitSeriesViolations.map((v) => v.requirementId))
    // after a flood only the rows picked one by one must stay satisfied; the tree passing covers the rest
    const keep = flooded.size ? Object.keys(chosen).filter((id) => final.satisfied[id]) : Object.keys(final.satisfied)
    for (const c of [...planned].sort((x, y) => unitsOf(y) - unitsOf(x) || cmp([x], [y]))) {
      planned.delete(c)
      const r = verifySchedule(have(), a)
      if (keep.some((id) => !r.satisfied[id]) || r.splitSeriesViolations.some((v) => !splits.has(v.requirementId))
        || (passed && !rootPasses(have()))) planned.add(c)
    }
    const hp = have()
    for (const id of Object.keys(chosen)) {
      // A pruned group is reported as the best group the kept courses still complete.
      const g = completed(pickedFor.get(id)!, hp)
      if (!chosen[id].courses.every((c) => has(hp, c, honorsColleges(pickedFor.get(id)!)))) { if (g) chosen[id] = g; else delete chosen[id] }
    }
    // a plan the tree passes leaves nothing unmet, whatever an earlier round found short
    return { planned: [...planned].sort(), chosen, unsolvable: rootPasses(hp) ? [] : [...unsolvable], forced }
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
  /** Comparable score of any plan: fewest requirements left unmet over all configs (at least one when the tree does not
   *  pass, e.g. a course counted for two slots of a "choose N" group), then the search objective. */
  const score = (cs: CourseId[]): Sol => {
    const h = withTaken(cs), st = statOf(h)
    let give = Math.min(...configs.map((C) => C.filter((i) => isPseudo(i) || (!isPair(i) && !ucOnly(L[rowOf(i)]) && !st[rowOf(i)].satisfied)).length))
    // a plan the tree passes leaves nothing unmet, whichever config it follows
    if (a.root.required) give = rootPasses(h) ? 0 : Math.max(give, 1)
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
    const h = withTaken(planned), st = statOf(h), ok = rootPasses(h)
    for (const i of best.cfg) if (!isPseudo(i) && !isPair(i) && !sat0[rowOf(i)] && st[rowOf(i)].satisfied) chosen[L[rowOf(i)].id] = completed(L[rowOf(i)], h)!
    // a plan the tree passes leaves nothing unmet, whatever its config gave up (a search cut short by the budget)
    unsolvable = best.skip.filter((i) => !ok && (isPseudo(i) || isOcc(i) || !st[i].satisfied)).map((i) => {
      if (isPseudo(i)) return pseudo[i - PSEUDO]
      if (isOcc(i)) return ways[i].length ? `${L[rowOf(i)].id} (its courses already count toward another choice of the same "choose N" group)` : offered(L[rowOf(i)])
      if (!ways[i].length) return offered(L[i])
      // Given up only because every group would open a split the agreement still needs.
      const w = ways[i].map((x) => x.filter((c) => !h.has(c))).sort((x, y) => lex([...sumV(x), ...x], [...sumV(y), ...y]))[0]
      const ids = blocking(new Set([...h, ...w])).map((j) => L[j].id).sort()
      return `${L[i].id} (only by splitting ${ids.length ? ids.join(', ') : 'a series'})`
    })
  } else ({ planned, chosen, unsolvable } = g!)
  let prereqOnly: CourseId[] = [], prereqWarnings: string[] = []
  if (homeFirst) {
    // preferHome priced each way with its prerequisites taken alone; with the whole plan some are already covered
    // (home Calculus I stands in for another college's). Drop every course no chosen group lists, if no satisfied row
    // needs it, and let withPrereqs add back the prerequisites the whole plan still needs.
    const listed = (c: CourseId) => Object.values(chosen).some((g) => g.courses.includes(c))
    const kept = planned.filter(listed), before = statOf(withTaken(planned)), after = statOf(withTaken(kept))
    if (kept.length < planned.length && before.every((s, i) => !s.satisfied || after[i].satisfied)) planned = kept
  }
  ;({ planned, chosen, prereqOnly, prereqWarnings, optimal } = withPrereqs(planned, chosen, optimal))
  const terms = pack([...planned], (c) => unitsOf(c, true), unitCap, startTerm, termSystem, (c) => a.catalog[c]?.title ?? '',
    (c) => (a.catalog[c] ? unitSystems[a.catalog[c].institutionId] : undefined) ?? termSystem, { summer: opts.summer === true })
  const result = verifySchedule(withTaken(planned), a0)
  // preferHome: prerequisites the search planned inside its ways are not in `added`; any planned course no chosen group
  // lists is one
  if (homeFirst) prereqOnly = [...new Set([...prereqOnly, ...planned.filter((c) => !Object.values(chosen).some((g) => g.courses.includes(c)))])].sort()
  let idle: Meta['idle'] = []
  if (homeFirst) {
    // a row home covers was planned at X only for the series of a row home cannot cover: if the plan does not meet
    // that row at X after all (it went to a third college), plan again with that row back at home
    idle = Object.keys(chosen).sort().map((id) => ({ key: `${id}|${chosen[id].institutionId}`, col: chosen[id].institutionId, by: hf.series.get(`${id}|${chosen[id].institutionId}`) ?? [] }))
      .filter((x) => x.by.length && !x.by.some((y) => chosen[y]?.institutionId === x.col))
  }
  const fallbacks = homeFirst ? fallbackNotes(a1, hf, chosen, planned, taken, home!) : []
  // Never report nothing unmet for a plan the checker does not pass (e.g. one course counted for two slots of a
  // "choose N" group that the fallback could not resolve): name what is missing instead.
  if (!unsolvable.length && a.root.required && !rootPasses(withTaken(planned))) unsolvable = result.missing.length ? [...result.missing] : ['The plan does not complete every requirement; confirm with a counselor']
  for (const c of badUnits) if (L.some((r) => r.groups.some((g) => allowed.includes(g.institutionId) && g.courses.includes(c))))
    prereqWarnings.push(`${c} has no valid unit count in the agreement data; it is not planned.`)
  // unsolvable in a fixed order (tree order would follow the input)
  const plan: Plan = {
    terms, chosen, result, totalUnits: half(planned.reduce((s, c) => s + unitsOf(c, true), 0)), unsolvable: [...unsolvable].sort(), optimal,
    ...(prereqOnly.length ? { prereqOnly } : {}), ...(prereqWarnings.length ? { prereqWarnings } : {}),
    ...(fallbacks.length ? { fallbacks } : {}),
  }
  if (homeFirst) metaOf.set(plan, { idle, cost: planned.reduce((s, c) => s + unitsOf(c, true), 0) + pCollege * colleges(planned) + pChain * chains(planned) })
  return plan

  /** Enrollment prerequisites (TESTER1 H-1, prereq.ts): each planned course's unmet prerequisites at its own college
   *  are added and counted. Then a searched course is dropped while the plan, prerequisites included, costs fewer units
   *  and still completes every chosen requirement without it (business calculus once Calculus I is in the plan for
   *  Calculus II). The search's optimum ignores prerequisites, so it is a lower bound: `optimal` survives only when the
   *  final plan scores no worse than the searched one (every added course priced by the search). */
  function withPrereqs(searched: CourseId[], chosen: Record<string, CourseGroup>, optimal: boolean) {
    const graph = prereqGraph(a.catalog, taken, a.root)
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

/* ---- input checks (N-3) ---- */

const validUnits = (u: unknown): u is number => typeof u === 'number' && Number.isFinite(u) && u >= 0

/** The agreement with every catalog course of invalid units removed (the same object when there are none, so
 *  per-catalog caches keep working), and the removed ids, sorted. */
function withValidUnits(a: Agreement): { a: Agreement; badUnits: CourseId[] } {
  const bad = Object.keys(a.catalog).filter((c) => !validUnits(a.catalog[c]?.units)).sort()
  if (!bad.length) return { a, badUnits: bad }
  const catalog = { ...a.catalog }
  for (const c of bad) delete catalog[c]
  return { a: { ...a, catalog }, badUnits: bad }
}

/* ---- prefer home ---- */

const reqsOf = (n: ReqNode | Requirement): Requirement[] => (n.kind === 'req' ? [n] : n.children.flatMap(reqsOf))
const codeOf = (c: CourseId) => c.slice(c.indexOf(':') + 1)
/** A group the planner could complete: every course taken or in the catalog. */
const plannable = (g: CourseGroup, r: Requirement, taken: Set<CourseId>, a: Agreement) =>
  g.courses.every((c) => has(taken, c, honorsColleges(r)) || !!a.catalog[c])
/** A group with a course the student already took: a series started (or finished) there. */
const startedAt = (g: CourseGroup, r: Requirement, taken: Set<CourseId>) => g.courses.some((c) => has(taken, c, honorsColleges(r)))
const homeCovers = (r: Requirement, home: number, taken: Set<CourseId>, a: Agreement) =>
  r.groups.some((g) => g.institutionId === home && plannable(g, r, taken, a))

export interface HomeFirst {
  /** The agreement the planner searches (verification still uses the original). */
  a: Agreement
  /** Courses of kept groups away from home that the student started: no retake at home for those. */
  started: Set<CourseId>
  /** `${row id}|${college}` -> the rows home cannot cover whose series (with its prerequisites) there includes it. */
  series: Map<string, string[]>
}

/**
 * preferHome: the agreement cut so that the home college covers everything it can.
 *
 * - A required OR / "choose N" keeps only the alternatives home can complete when there are enough of them; with fewer,
 *   those are required and the rest fill the remaining slots.
 * - Then a row home has a plannable group for keeps its home groups, every group the student already took a course of
 *   (at any college: a finished or started series is never retaken at home), and a group at an allowed college X that
 *   lies inside the series of a required row home cannot cover (after the cuts above; optional subtrees do not count):
 *   that row's group at X plus the prerequisites it needs there that no home course stands in for (De Anza PHYS 4D
 *   needs De Anza 4A-4C). Without that, home would take 4A-4C and X would take them again for 4D. `noSeries`
 *   (`${row id}|${college}`): series groups not to keep; `force`: rows home cannot cover kept to one college's groups
 *   (solve's candidates, when the plan keeps a series group without meeting its pulling row there).
 * Rows home cannot cover keep all their groups; the usual cost (units, extra colleges, split subjects) picks among them.
 */
export function preferHomeAgreement(a: Agreement, taken: Set<CourseId>, home: number, allowed: readonly number[], noSeries: readonly string[] = [], force: Readonly<Record<string, number>> = {}): HomeFirst {
  const graph = prereqGraph(a.catalog, taken)
  const started = new Set<CourseId>(), series = new Map<string, string[]>()
  const homeDone = (r: Requirement) => !!reqStatus(r, taken).satisfied || homeCovers(r, home, taken, a)
  const cutNodes = (n: ReqNode | Requirement): ReqNode | Requirement => {
    if (n.kind === 'req') return n
    const children = n.children.map(cutNodes)
    if (n.type === 'AND' || !n.required) return { ...n, children }
    const need = n.type === 'OR' ? 1 : n.n ?? 1
    const isKid = (c: ReqNode | Requirement) => c.kind === 'req' || c.required
    const atHome = children.filter((c) => isKid(c) && treeState(c, homeDone) === 'sat')
    if (!atHome.length || need <= 0) return { ...n, children }
    if (atHome.length >= need) return { ...n, children: children.filter((c) => !isKid(c) || atHome.includes(c)) }
    const rest = children.filter((c) => !atHome.includes(c)), left = need - atHome.length
    const pick: ReqNode = { kind: 'node', type: left === 1 ? 'OR' : 'N_OF', ...(left === 1 ? {} : { n: left }), ...(n.title ? { title: n.title } : {}), required: true, children: rest }
    return { kind: 'node', type: 'AND', ...(n.title ? { title: n.title } : {}), required: true, children: [...atHome, pick] }
  }
  const root = cutNodes(a.root) as ReqNode
  const required = (n: ReqNode | Requirement): Requirement[] => (n.kind === 'req' ? [n] : n.required ? n.children.flatMap(required) : [])
  // what each required row home cannot cover pulls in at each allowed away college: its group and that group's
  // prerequisites there that no home course stands in for (same course, same ladder level)
  const pulls: { id: string; inst: number; courses: Set<CourseId> }[] = []
  const atHome = Object.keys(a.catalog).filter((c) => instOf(c) === home)
  for (const r of required(root)) {
    if (homeCovers(r, home, taken, a) || reqStatus(r, taken).satisfied) continue
    for (const g of r.groups) {
      if (g.institutionId === home || !allowed.includes(g.institutionId) || !plannable(g, r, taken, a)) continue
      const todo = g.courses.filter((c) => !has(taken, c, honorsColleges(r)))
      const pre = prereqClosure(graph, todo, taken, a.catalog).added.filter((p) => !atHome.some((q) => graph.equiv(p, q)))
      pulls.push({ id: r.id, inst: g.institutionId, courses: new Set([...todo, ...pre]) })
    }
  }
  const cutRow = (r: Requirement): Requirement => {
    if (force[r.id] !== undefined && !homeCovers(r, home, taken, a)) {
      const groups = r.groups.filter((g) => g.institutionId === force[r.id])
      return groups.length ? { ...r, groups } : r
    }
    if (!homeCovers(r, home, taken, a)) return r
    const mix = honorsColleges(r)
    const groups = r.groups.filter((g) => {
      if (g.institutionId === home) return true
      if (startedAt(g, r, taken)) {
        g.courses.forEach((c) => [c, `${c}H`, stripH(c)].forEach((x) => started.add(x)))
        return true
      }
      const key = `${r.id}|${g.institutionId}`
      if (noSeries.includes(ALL) || noSeries.includes(key)) return false
      const by = pulls.filter((p) => p.inst === g.institutionId && g.courses.every((c) => has(taken, c, mix) || p.courses.has(c))).map((p) => p.id)
      if (by.length) series.set(key, [...new Set([...(series.get(key) ?? []), ...by])])
      return by.length > 0
    })
    return groups.length === r.groups.length ? r : { ...r, groups }
  }
  const cutRows = (n: ReqNode | Requirement): ReqNode | Requirement => (n.kind === 'req' ? cutRow(n) : { ...n, children: n.children.map(cutRows) })
  return { a: { ...a, root: cutRows(root) as ReqNode }, started, series }
}

/**
 * preferHome: one plain note per course planned away from home, grouped by the requirement it serves (a course that
 * serves two requirements is listed once, under both), then the prerequisites planned away from home. Reasons:
 * 'not-at-home' "Not offered at De Anza; take MATH 1C at Foothill.", 'no-data' (home articulates it but its course
 * data is missing), 'started' (finishing a series the student began there), 'series' (part of the series of a
 * requirement home cannot cover), 'prerequisite' (needed to enroll in a later course there).
 */
function fallbackNotes(a: Agreement, hf: HomeFirst, chosen: Record<string, CourseGroup>, planned: CourseId[], taken: Set<CourseId>, home: number): Fallback[] {
  const rows = reqsOf(a.root), name = (i: number) => shortName.get(i) ?? `college ${i}`, P = new Set(planned)
  type Entry = { f: Fallback; key: string; note: (what: string) => string; also: string[] }
  const out: Entry[] = [], listed = new Set<CourseId>()
  const render = (e: Entry) => {
    const { f } = e, codes = f.courses.map(codeOf).join(' + ')
    f.note = e.note(`take ${codes} at ${name(f.institutionId)}`) + (e.also.length ? ` ${codes} also ${f.courses.length > 1 ? 'count' : 'counts'} for ${e.also.join(', ')}.` : '')
  }
  /** Entries with the same `key` become one ("take PHYS 4A + PHYS 4B at De Anza"). A requirement whose courses are
   *  already listed joins that entry; under another reason it is named as "also counts for". */
  const add = (id: string | null, inst: number, courses: CourseId[], reason: Fallback['reason'], note: (what: string) => string, key: string) => {
    const fresh = courses.filter((c) => !listed.has(c))
    const into = fresh.length ? out.find((e) => e.key === key) : out.find((e) => e.f.courses.some((c) => courses.includes(c)))
    if (!into && !fresh.length) return
    const e = into ?? { f: { requirementIds: [], institutionId: inst, courses: [], reason, note: '' }, key, note, also: [] }
    if (!into) out.push(e)
    fresh.forEach((c) => { listed.add(c); e.f.courses.push(c) })
    if (id !== null && !e.f.requirementIds.includes(id)) {
      e.f.requirementIds.push(id)
      if (!fresh.length && e.f.reason !== reason) e.also.push(id)
    }
    render(e)
  }
  // requirements home cannot cover first, so a course they share with a home-coverable one is explained by them
  const away = Object.keys(chosen).sort().flatMap((id) => {
    const g = chosen[id], todo = g.courses.filter((c) => P.has(c)), r = rows.find((x) => x.id === id)
    return g.institutionId === home || !todo.length ? [] : [{ id, g, todo, r, home: !!r && homeCovers(r, home, taken, a) }]
  })
  for (const { id, g, todo, r } of away.filter((x) => !x.home)) {
    if (r && r.groups.some((x) => x.institutionId === home)) add(id, g.institutionId, todo, 'no-data', (w) => `Course details for ${name(home)} are missing; ${w}.`, `${id}`)
    else add(id, g.institutionId, todo, 'not-at-home', (w) => `Not offered at ${name(home)}; ${w}.`, `${id}`)
  }
  for (const { id, g, todo, r } of away.filter((x) => x.home)) {
    const at = name(g.institutionId), by = (hf.series.get(`${id}|${g.institutionId}`) ?? []).find((x) => chosen[x]?.institutionId === g.institutionId)
    if (r!.groups.some((x) => x.institutionId === g.institutionId && startedAt(x, r!, taken)))
      add(id, g.institutionId, todo, 'started', (w) => `Finish the series you started at ${at}: ${w}.`, `started|${id}`)
    else add(id, g.institutionId, todo, 'series', (w) => `${name(home)} cannot finish this series (it has no course for ${by ?? 'a later requirement'}); ${w}.`, `series|${g.institutionId}|${by}`)
  }
  const graph = prereqGraph(a.catalog, taken)
  for (const c of planned) {
    if (instOf(c) === home || listed.has(c)) continue
    const need = planned.filter((q) => q !== c && instOf(q) === instOf(c) && graph.reach(c, q)).sort()
    const q = need.find((x) => listed.has(x)) ?? need[0]
    add(null, instOf(c), [c], 'prerequisite', (w) => `Prerequisite for ${q ? codeOf(q) : 'a later course'} at ${name(instOf(c))}; ${w}.`, `pre|${c}`)
  }
  return out.map((e) => e.f)
}
