import type { Agreement, CourseGroup, CourseId, Plan, ReqNode, Requirement, Term } from './types'
import { has, honorsMix, reqStatus, verifySchedule } from './verify.ts'

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
  const groupCost = (g: CourseGroup, h: Set<CourseId>, mix = false) => g.courses.reduce((s, c) => s + (has(h, c, mix) ? 0 : unitsOf(c)), 0)
  const planned = new Set<CourseId>()
  const have = () => new Set([...taken, ...planned])
  const chosen: Record<string, CourseGroup> = {}
  const unsolvable = new Set<string>()

  const bestGroup = (req: Requirement, h: Set<CourseId>): { g: CourseGroup; cost: number } | null => {
    let best: { g: CourseGroup; cost: number } | null = null
    const mix = honorsMix(req)
    for (const g of req.groups) {
      // Only complete groups at colleges the student can attend, unless it is already complete.
      if (!allowed.includes(g.institutionId) && g.courses.some((c) => !has(h, c, mix))) continue
      const cost = groupCost(g, h, mix)
      const honors = (x: CourseGroup) => x.courses.filter((c) => /H$/.test(c)).length
      const better = !best || cost < best.cost
        || (cost === best.cost && g.institutionId === home && best.g.institutionId !== home)
        || (cost === best.cost && g.institutionId === best.g.institutionId && (honors(g) < honors(best.g) || g.courses.length < best.g.courses.length))
      if (better) best = { g, cost }
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

  /** Collect the requirements that still need a group, choosing cheapest branches at OR / N_OF. */
  const needed = (n: ReqNode | Requirement, h: Set<CourseId>, acc: Requirement[]): void => {
    if (n.kind === 'req') { if (!reqStatus(n, h).satisfied) acc.push(n); return }
    if (!n.required) return
    if (n.type === 'AND') { n.children.forEach((c) => needed(c, h, acc)); return }
    const want = n.type === 'OR' ? 1 : (n.n ?? 1)
    const ranked = n.children
      .map((c) => ({ c, done: c.kind === 'req' ? !!reqStatus(c, h).satisfied : estimate(c, h) === 0, cost: estimate(c, h) }))
      .sort((x, y) => x.cost - y.cost)
    const done = ranked.filter((r) => r.done).length
    ranked.filter((r) => !r.done && r.cost < INF).slice(0, Math.max(0, want - done)).forEach((r) => needed(r.c, h, acc))
    if (ranked.filter((r) => r.cost < INF).length < want) unsolvable.add(`${want} of: ${n.children.map((c) => (c.kind === 'req' ? c.id : 'group')).join(', ')}`)
  }

  // One group per iteration so shared courses (De Anza MATH 1B serves MATH 51 and 52) get counted once.
  for (let guard = 0; guard < 200; guard++) {
    const h = have()
    const todo: Requirement[] = []
    needed(a.root, h, todo)
    let pick: { req: Requirement; g: CourseGroup; cost: number } | null = null
    for (const req of todo) {
      const b = bestGroup(req, h)
      if (!b) { unsolvable.add(req.id); continue }
      if (!pick || b.cost < pick.cost) pick = { req, ...b }
    }
    if (!pick) break
    chosen[pick.req.id] = pick.g
    pick.g.courses.forEach((c) => { if (!has(have(), c, honorsMix(pick!.req))) planned.add(c) })
  }

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
