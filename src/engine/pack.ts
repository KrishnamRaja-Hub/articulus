import type { CourseId, Term } from './types'
import { prereqs } from './sequence.ts'
import { nthTerm, startSlot, type CalendarTerm, type StartTerm, type TermSystem } from './calendar.ts'

/* ---- term packing ----
 *
 * Courses go into terms one at a time, each in the earliest term of its own college's calendar that comes after every
 * prerequisite (a lab: the same term as its lecture or later) and has room under the per-term cap. Quarter and semester
 * terms share one timeline (calendar.ts); the cap applies to the combined load of every term running in each period.
 *
 * Which course goes first matters: a course placed early takes the room a later one could have used. Two orders:
 *
 *   legacy    the Round 4 order: shallowest first (fewest prerequisites above it), then larger courses first.
 *   critical  critical path first (Round 10): the course at the head of the longest chain of courses still waiting on it
 *             goes first. A chain is measured in time, in terms of each course's own calendar: a quarter is one period
 *             of the timeline, a semester one and a half on average (two semesters span three quarters), so a semester
 *             chain of 3 outranks a quarter chain of 4. Among equal chains, the course whose own prerequisites finish
 *             latest goes first (it has the least room); remaining ties keep the legacy order.
 *
 * pack runs critical, and legacy as well, and keeps critical unless legacy finishes strictly earlier (earlier last term
 * on the timeline, then fewer terms). Greedy critical-path scheduling is a heuristic, not an optimum: with the cap
 * shared by overlapping quarter and semester terms it is sometimes worse, so this fallback is what guarantees a plan is
 * never longer than the Round 4 one (FIXES.md Round 10 has the counts). The result is deterministic: both orders are
 * total (stable sorts over the input order).
 */

export type PackOrder = 'best' | 'critical' | 'legacy'
export interface PackOptions {
  /** 'best' (default): critical, unless legacy finishes strictly earlier. 'critical', 'legacy': that order alone (tests). */
  order?: PackOrder
}

const half = (u: number) => Math.round(u * 2) / 2
const EPS = 1e-9 // units are exact (unrounded) conversions, e.g. 5q = 3.333s
/** Length of one term on the timeline, in quarter periods: a semester spans 1 or 2 (Fall, Spring), 1.5 on average. */
const TERM_LENGTH: Record<TermSystem, number> = { quarter: 1, semester: 1.5 }

type Slot = { cal: CalendarTerm; courses: CourseId[]; units: number }

// ponytail: prerequisite order is inferred from ids and titles (sequence.ts); swap for real requisite data if ASSIST
// ever populates `requisites`.
export function pack(courses: CourseId[], unitsOf: (c: CourseId) => number, cap: number, start: StartTerm, system: TermSystem,
  titleOf: (c: CourseId) => string = () => '', systemOf: (c: CourseId) => TermSystem = () => system, opts: PackOptions = {}): Term[] {
  if (!(cap > 0 && Number.isFinite(cap))) cap = system === 'semester' ? 12 : 16 // NaN / <=0 / Infinity -> default
  // preds: [course, gap]: gap 1 = strictly later term, 0 = same term or later (a lab after its lecture)
  const preds = new Map<CourseId, [CourseId, number][]>(courses.map((c) => [c, []]))
  const succs = new Map<CourseId, [CourseId, number][]>(courses.map((c) => [c, []]))
  for (const e of prereqs(courses, titleOf).edges) {
    const gap = e.rule === 'co' ? 0 : 1
    preds.get(e.to)!.push([e.from, gap]); succs.get(e.from)!.push([e.to, gap])
  }
  // depth: longest prerequisite chain above a course (the edges are acyclic); a lab sorts just after its lecture
  const memo = new Map<CourseId, number>()
  const depth = (c: CourseId): number => memo.get(c) ?? (memo.set(c, Math.max(0, ...preds.get(c)!.map(([p, g]) => depth(p) + (g || 0.5)))), memo.get(c)!)
  // tail: time from the start of a course's term to the end of the longest chain waiting on it (its own term included);
  // a lab shares its lecture's term, so it adds nothing
  const tails = new Map<CourseId, number>()
  const tail = (c: CourseId): number => {
    let v = tails.get(c)
    if (v === undefined) {
      const len = TERM_LENGTH[systemOf(c)] ?? 1
      v = Math.max(len, ...succs.get(c)!.map(([s, g]) => (g ? len : 0) + tail(s)))
      tails.set(c, v)
    }
    return v
  }
  const legacyCmp = (x: CourseId, y: CourseId) => depth(x) - depth(y) || unitsOf(y) - unitsOf(x)
  const legacy = [...courses].sort(legacyCmp)
  // release: the earliest a course can start, on the same scale (the longest chain of prerequisites above it)
  const rels = new Map<CourseId, number>()
  const release = (c: CourseId): number => {
    let v = rels.get(c)
    if (v === undefined) rels.set(c, (v = Math.max(0, ...preds.get(c)!.map(([p, g]) => release(p) + (g ? TERM_LENGTH[systemOf(p)] ?? 1 : 0)))))
    return v
  }
  // Longest tail first; among equal tails the course that can start latest first (it has the least room left); then
  // the legacy order. Topological: a prerequisite's tail is longer than its successor's, and a lecture ties its lab on
  // tail and release but is shallower.
  const critical = [...courses].sort((x, y) => tail(y) - tail(x) || release(y) - release(x) || legacyCmp(x, y))

  const layout = (ordered: CourseId[]) => place(ordered, preds, unitsOf, cap, start, system, systemOf)
  let used = layout(opts.order === 'legacy' ? legacy : critical)
  if ((opts.order ?? 'best') === 'best') {
    const alt = layout(legacy)
    if (shorter(alt, used)) used = alt
  }
  const loadOf = periodLoad(used)
  const mixed = new Set(used.map((t) => t.cal.system)).size > 1
  const terms: Term[] = used.map(({ cal, courses: cs, units }) => {
    const l = loadOf(cal)
    const t: Term = { name: `${cal.season} ${cal.year}${mixed ? ` (${cal.system})` : ''}`, courses: cs, units: half(units), system: cal.system, season: cal.season, year: cal.year, span: [cal.start, cal.end], load: half(l) }
    // Only a single course larger than the cap can overflow; flag it rather than hide it.
    if (l > cap + EPS) t.overCap = true
    return t
  })
  if (mixed) for (const t of terms) t.concurrent = terms.filter((o) => o !== t && o.span![0] <= t.span![1] && t.span![0] <= o.span![1]).map((o) => o.name)
  return terms // never drop courses (maxTerms NaN once returned []); UI flags > maxTerms
}

/** Plan length: when the last term ends on the timeline, then how many terms. */
const lengthOf = (used: Slot[]) => [Math.max(-Infinity, ...used.map((t) => t.cal.end)), used.length]
const shorter = (x: Slot[], y: Slot[]) => { const a = lengthOf(x), b = lengthOf(y); return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]) }

/** Combined units of every term running in each period a term covers (the busiest period). */
function periodLoad(used: Slot[]) {
  const load = new Map<number, number>()
  for (const t of used) for (let k = t.cal.start; k <= t.cal.end; k++) load.set(k, (load.get(k) ?? 0) + t.units)
  return (t: CalendarTerm) => { let m = 0; for (let k = t.start; k <= t.end; k++) m = Math.max(m, load.get(k) ?? 0); return m }
}

/** Earliest-fit placement of `ordered` (a topological order), returning the used terms in timeline order. */
function place(ordered: CourseId[], preds: Map<CourseId, [CourseId, number][]>, unitsOf: (c: CourseId) => number, cap: number,
  start: StartTerm, system: TermSystem, systemOf: (c: CourseId) => TermSystem): Slot[] {
  // H-3: each course goes in a term of its own college's calendar; quarter and semester terms share one timeline
  // (calendar.ts) and the cap applies to the combined load of every term running in each quarter period.
  const slot0 = startSlot(start, system)
  const bySys: Record<TermSystem, Slot[]> = { quarter: [], semester: [] }
  const termAt = (s: TermSystem, j: number) => {
    while (bySys[s].length <= j) bySys[s].push({ cal: nthTerm(s, slot0, bySys[s].length), courses: [], units: 0 })
    return bySys[s][j]
  }
  // order on the timeline: start, then end, then home calendar first (Fall quarter and Fall semester share a span)
  const key = (t: CalendarTerm) => [t.start, t.end, t.system === system ? 0 : 1]
  const geq = (x: number[], y: number[]) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
  const load = new Map<number, number>() // quarter period -> combined units
  const loadOf = (t: CalendarTerm) => { let m = 0; for (let k = t.start; k <= t.end; k++) m = Math.max(m, load.get(k) ?? 0); return m }
  const placed = new Map<CourseId, CalendarTerm>()
  const labs = new Map<CourseId, CourseId[]>()
  for (const [l, ps] of preds) for (const [p, g] of ps) if (!g && systemOf(l) === systemOf(p)) labs.set(p, [...(labs.get(p) ?? []), l])
  const ok = (t: CalendarTerm, x: CourseId, skip?: CourseId) => preds.get(x)!.every(([p, g]) => {
    if (p === skip) return true
    const q = placed.get(p)!
    return g ? t.start > q.end : geq(key(t), key(q)) >= 0
  })
  for (const c of ordered) {
    if (placed.has(c)) continue
    const sys = systemOf(c)
    // A lecture takes its labs into the same term when they fit and nothing else holds them back.
    let go = (labs.get(c) ?? []).filter((l) => preds.get(l)!.every(([p]) => p === c || placed.has(p)))
    if (go.reduce((s, l) => s + unitsOf(l), unitsOf(c)) > cap + EPS) go = []
    const units = go.reduce((s, l) => s + unitsOf(l), unitsOf(c))
    // earliest term after every prerequisite with room in every period it covers; a course bigger than the cap
    // alone goes to a term with nothing running alongside it
    let j = 0
    for (;; j++) {
      // N-3: with finite units and cap a course always fits within a few terms of its last prerequisite; never spin
      if (j > 4 * (ordered.length + 4)) throw new Error(`Could not place ${c} in any term (units ${unitsOf(c)}, cap ${cap}).`)
      const t = termAt(sys, j).cal
      if (!ok(t, c) || !go.every((l) => ok(t, l, c))) continue
      if (units > cap + EPS ? loadOf(t) === 0 : loadOf(t) + units <= cap + EPS) break
    }
    const t = termAt(sys, j)
    for (const x of [c, ...go]) { t.courses.push(x); placed.set(x, t.cal) }
    t.units += units
    for (let k = t.cal.start; k <= t.cal.end; k++) load.set(k, (load.get(k) ?? 0) + units)
  }
  return [...bySys.quarter, ...bySys.semester].filter((t) => t.courses.length).sort((x, y) => geq(key(x.cal), key(y.cal)))
}
