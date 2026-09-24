import type { Agreement, CourseGroup, CourseId, Plan, ReqNode, Requirement, Term } from './types'
import { has, honorsColleges, reqStatus, verifySchedule, type Mix } from './verify.ts'

export type TermSystem = 'quarter' | 'semester'

export interface SolveOptions {
  allowed: number[]       // institutions the student can enroll at
  home?: number           // tie-break preference
  unitCap?: number        // per term, in the home (termSystem) unit system; default 16 quarter / 12 semester
  maxTerms?: number
  startTerm?: { season: 'Fall' | 'Winter' | 'Spring'; year: number }
  termSystem?: TermSystem                     // home college's system; Plan units are reported in it
  unitSystems?: Record<number, TermSystem>    // institutionId -> native system; missing => assumed termSystem
}

const half = (u: number) => Math.round(u * 2) / 2

/** Native course units -> home-system units, nearest 0.5 (exact: unrounded, for sums; F-16). */
const convert = (units: number, from: TermSystem, to: TermSystem, exact = false) => {
  const u = from === to ? units : from === 'semester' ? units * 1.5 : units / 1.5
  return exact || from === to ? u : half(u)
}

const INF = Number.POSITIVE_INFINITY

/** Greedy set cover over the AND/OR/N_OF tree, then quarter packing. */
export function solve(taken: Set<CourseId>, a: Agreement, opts: SolveOptions): Plan {
  const { allowed, home, termSystem = 'quarter', unitSystems = {}, maxTerms = 6, startTerm = { season: 'Fall', year: 2026 } } = opts
  const unitCap = opts.unitCap ?? (termSystem === 'semester' ? 12 : 16)
  const unitsOf = (c: CourseId, exact = false) => {
    const k = a.catalog[c]
    return k ? convert(k.units, unitSystems[k.institutionId] ?? termSystem, termSystem, exact) : 0
  }
  /** Marginal home-system units to complete a group given what is already taken or planned. */
  const groupCost = (g: CourseGroup, h: Set<CourseId>, mix: Mix = false) => g.courses.reduce((s, c) => s + (has(h, c, mix) ? 0 : unitsOf(c)), 0)
  const planned = new Set<CourseId>()
  const have = () => new Set([...taken, ...planned])
  const chosen: Record<string, CourseGroup> = {}
  const unsolvable = new Set<string>()
  const splitting = new Set<CourseGroup>() // groups that would open a new split series: last resort only
  const SPLIT = 1e6                         // their cost penalty, so any non-splitting route wins
  const forced = new Map<string, string[]>() // requirement id -> splits its last-resort group opened

  const leaves: Requirement[] = []
  const walk = (n: ReqNode | Requirement): void => { if (n.kind === 'req') leaves.push(n); else n.children.forEach(walk) }
  walk(a.root)
  const uses = new Map<CourseId, Set<string>>() // course -> requirement ids it appears in
  leaves.forEach((r) => r.groups.forEach((g) => g.courses.forEach((c) => uses.set(c, (uses.get(c) ?? new Set()).add(r.id)))))
  const reach = (g: CourseGroup) => new Set(g.courses.flatMap((c) => [...uses.get(c)!])).size

  /**
   * README tie-break as a strict lexicographic key: cost, home college, fewer honors, fewer courses; then, so the
   * result never depends on input order, courses that serve more requirements, college id and course ids.
   */
  type Cand = { g: CourseGroup; cost: number }
  const rank = ({ g, cost }: Cand): (number | string)[] =>
    [cost, g.institutionId === home ? 0 : 1, g.courses.filter((c) => /H$/.test(c)).length, g.courses.length, -reach(g), g.institutionId, [...g.courses].sort().join('+')]
  const cmp = (x: (number | string)[], y: (number | string)[]) => {
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
    return 0
  }

  const bestGroup = (req: Requirement, h: Set<CourseId>): Cand | null => {
    let best: Cand | null = null
    const mix = honorsColleges(req)
    for (const g of req.groups) {
      const need = g.courses.filter((c) => !has(h, c, mix))
      // Only complete groups at colleges the student can attend, unless it is already complete.
      if (need.length && !allowed.includes(g.institutionId)) continue
      // A course missing from the catalog has unknown units: not plannable.
      if (need.some((c) => !a.catalog[c])) continue
      const cand = { g, cost: groupCost(g, h, mix) + (splitting.has(g) ? SPLIT : 0) }
      if (!best || cmp(rank(cand), rank(best)) < 0) best = cand
    }
    return best
  }

  /** Estimated cost to satisfy a subtree from scratch (used to choose among OR / N_OF children). */
  const estimate = (n: ReqNode | Requirement, h: Set<CourseId>): number => {
    if (n.kind === 'req') return reqStatus(n, h).satisfied ? 0 : bestGroup(n, h)?.cost ?? INF
    const costs = n.children.map((c) => estimate(c, h))
    if (n.type === 'AND') return costs.reduce((s, c) => s + c, 0)
    const sorted = [...costs].sort((x, y) => x - y)
    return n.type === 'OR' ? sorted[0] : sorted.slice(0, n.n ?? 1).reduce((s, c) => s + c, 0)
  }

  /** Order-independent name of a subtree, to break cost ties among OR / N_OF children. */
  const keyOf = (n: ReqNode | Requirement): string => (n.kind === 'req' ? n.id : `(${n.children.map(keyOf).sort().join(',')})`)

  /**
   * Collect the requirements that still need a group, choosing cheapest branches at OR / N_OF. `alt` gets those
   * reached through such a choice, which may still change as courses are planned.
   */
  const needed = (n: ReqNode | Requirement, h: Set<CourseId>, acc: Requirement[], alt: Set<Requirement>, inAlt = false): void => {
    if (n.kind === 'req') { if (!reqStatus(n, h).satisfied) { acc.push(n); if (inAlt) alt.add(n) } return }
    if (!n.required) return
    if (n.type === 'AND') { n.children.forEach((c) => needed(c, h, acc, alt, inAlt)); return }
    const want = n.type === 'OR' ? 1 : (n.n ?? 1)
    const ranked = n.children
      .map((c) => ({ c, done: c.kind === 'req' ? !!reqStatus(c, h).satisfied : estimate(c, h) === 0, cost: estimate(c, h), key: keyOf(c) }))
      .sort((x, y) => x.cost - y.cost || cmp([x.key], [y.key]))
    const done = ranked.filter((r) => r.done).length
    ranked.filter((r) => !r.done && r.cost < INF).slice(0, Math.max(0, want - done)).forEach((r) => needed(r.c, h, acc, alt, true))
    if (ranked.filter((r) => r.cost < INF).length < want) unsolvable.add(`${want} of: ${n.children.map((c) => (c.kind === 'req' ? c.id : 'group')).join(', ')}`)
  }

  const splitIds = (h: Set<CourseId>) => new Set(verifySchedule(h, a).splitSeriesViolations.map((v) => v.requirementId))

  // One group per iteration so shared courses (De Anza MATH 1B serves MATH 51 and 52) get counted once.
  // Each round satisfies a leaf or penalizes a group, so this bound (from the tree size) is never hit on a sane tree.
  let rounds = leaves.reduce((s, r) => s + 1 + r.groups.length, 1)
  let before = splitIds(have())
  const pickedFor = new Map<string, Requirement>()
  for (;;) {
    const h = have()
    const todo: Requirement[] = [], alt = new Set<Requirement>()
    needed(a.root, h, todo, alt)
    if (!rounds--) { todo.forEach((r) => unsolvable.add(r.id)); break }
    let pick: { req: Requirement; g: CourseGroup; cost: number } | null = null
    for (const req of todo) {
      const b = bestGroup(req, h)
      if (!b) { unsolvable.add(req.id); continue }
      // Equal cost: commit forced requirements before OR / N_OF alternatives, whose ranking they can change.
      const key = (r: Requirement, c: Cand) => [c.cost, alt.has(r) ? 1 : 0, ...rank(c).slice(1), r.id]
      if (!pick || cmp(key(req, b), key(pick.req, pick)) < 0) pick = { req, ...b }
    }
    if (!pick) break
    const mix = honorsColleges(pick.req)
    const next = new Set(h)
    pick.g.courses.forEach((c) => { if (!has(h, c, mix)) next.add(c) })
    // Never open a new split series elsewhere (e.g. an unused N_OF alternative) while another route exists.
    const after = splitIds(next), opened = [...after].filter((id) => !before.has(id)).sort()
    if (opened.length && !splitting.has(pick.g)) { splitting.add(pick.g); continue }
    if (opened.length) forced.set(pick.req.id, opened)
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
    const req = pickedFor.get(id)!, mix = honorsColleges(req), full = (g: CourseGroup) => g.courses.every((c) => has(hp, c, mix))
    if (full(chosen[id])) continue
    const done = req.groups.filter(full).map((g) => ({ g, cost: 0 }))
    if (done.length) chosen[id] = done.sort((x, y) => cmp(rank(x), rank(y)))[0].g; else delete chosen[id]
  }
  // A last-resort pick whose split is still open is reported, so the plan never claims to be clean.
  const open = new Set(verifySchedule(hp, a).splitSeriesViolations.map((v) => v.requirementId))
  forced.forEach((ids, id) => { if (ids.some((x) => open.has(x))) unsolvable.add(`${id} (only by splitting ${ids.filter((x) => open.has(x)).join(', ')})`) })
  const order = [...planned].sort(); planned.clear(); order.forEach((c) => planned.add(c)) // input order no longer leaks into pack

  const terms = pack([...planned], (c) => unitsOf(c, true), unitCap, maxTerms, startTerm, termSystem, (c) => a.catalog[c]?.title ?? '')
  const result = verifySchedule(have(), a)
  return { terms, chosen, result, totalUnits: half([...planned].reduce((s, c) => s + unitsOf(c, true), 0)), unsolvable: [...unsolvable] }
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
