import type { CourseId } from './types'

/* Prerequisite order for term packing, inferred from course ids and titles (ASSIST ships empty `requisites`).
 *
 * Within one college (course numbers mean different things at different colleges):
 *   letter   PHYS 4A < 4B < 4C: each course waits for the nearest lower letter planned in its series
 *   ordinal  plain numbers whose titles differ only by ordinal: CHEM 11 "General Chemistry I" < CHEM 12 "... II"
 *   series   first course of a series waits for the C (else last) course of the numerically lower one: 1C < 2A
 *            (not when its own title reads as a first course: "Introduction to ...", "... I")
 * Across colleges too (a topic is knowledge, not articulation: Calculus I at De Anza still comes before Calculus II
 * at Foothill):
 *   title    identical titles but for one ordinal: "Computer Discrete Mathematics I" < "... II"
 *   math     Precalculus < Calculus I < II < III / Multivariable < IV; Linear Algebra, Differential Equations after II
 *   physics  Mechanics < Electricity & Magnetism < Optics / Modern; Waves / Fluids / Thermo / Heat after Mechanics.
 *            Calculus-based only (not "College Physics", "Algebra-based ..."): Calculus I < Mechanics, Calculus II < E&M.
 *            A generic PHYS 4A "General Physics [(Calculus)]" is Mechanics; 4B is E&M only when the title says Calculus.
 *   Linear Algebra and Differential Equations never order each other, by letter (De Anza MATH 2A DiffEq, 2B LinAlg)
 *   or by the series guess (1C < 2A): the math ladder puts both after Calculus II.
 *   chem     General Chemistry I < II < III < Organic Chemistry (any) ; Organic I < II < III
 *   cs       Intro Programming < Data Structures, Intro Programming < Assembly / Architecture
 * Generic titles ("Calculus", "General Chemistry", "Organic Chemistry") take their level from the letter (1A = I).
 * Same level never orders: a lecture and its lab ("Circuit Analysis" + "... Lab", PHYC 4A + 4AL) may share a term.
 *   co       a lab is never earlier than its lecture at the same college (ENGN 20L with ENGN 20, CHEM 24 "Organic
 *            Chemistry II Laboratory" with CHEM 22 "Organic Chemistry II"); pack puts it in the lecture's term when it fits.
 * Cycles: edges are added strongest rule first; one that would close a cycle is dropped and reported. */

export type Rule = 'letter' | 'co' | 'ordinal' | 'title' | 'math' | 'physics' | 'chem' | 'cs' | 'series'
/** Strongest first. `series` is last: it is a guess about the college's numbering, not read from any title. */
export const RULES: Rule[] = ['letter', 'co', 'ordinal', 'title', 'math', 'physics', 'chem', 'cs', 'series']
/** `from` strictly before `to`; for rule 'co', `to` (the lab) is in the same term as `from` or later. */
export interface Edge { from: CourseId; to: CourseId; rule: Rule }

/** "113:PHYS 4B" -> { stem: "113:PHYS 4", seq: 1 }  (A=0, B=1 ...; plain number = -1). Honors "1BH" collapses to "1B",
 *  "7H" to "7". The stem keeps the college: series order never crosses campuses. */
export const seqKey = (id: CourseId) => {
  const m = /^(\d+):(.+?)\s(\d+)(?:H|([A-Z])H?)?$/.exec(id)
  return m ? { stem: `${m[1]}:${m[2]} ${Number(m[3])}`, prev: `${m[1]}:${m[2]} ${Number(m[3]) - 1}`, seq: m[4] ? m[4].charCodeAt(0) - 65 : -1 } : null
}

/** "General Chemistry II" -> { base: "general chemistry #", n: 2 }: exactly one ordinal token (I-IV or 1-4). */
export const ordinalTitle = (t: string) => {
  const toks = t.trim().toLowerCase().split(/\s+/)
  const at = toks.flatMap((w, i) => (/^(i{1,3}|iv|[1-4])$/.test(w) ? [i] : []))
  if (at.length !== 1) return null
  const w = toks[at[0]], n = /\d/.test(w) ? Number(w) : w === 'iv' ? 4 : w.length
  return { base: toks.map((x, i) => (i === at[0] ? '#' : x)).join(' '), n }
}

/** Lower-case words, honors / embedded-support noise removed: "Calculus II - HONORS" -> ["calculus", "ii"]. */
const words = (t: string) => t.toLowerCase().replace(/&/g, ' and ').replace(/\bhonors\b|\bwith embedded support\b/g, ' ')
  .split(/[^a-z0-9+#]+/).filter(Boolean)
const ORD: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, 1: 1, 2: 2, 3: 3, 4: 4 }
/** Ordinal levels in a title: I-IV, 1-4, or a final lone A-D ("General Chemistry B"). */
const ordinals = (w: string[]) => {
  const n = w.flatMap((x) => (ORD[x] ? [ORD[x]] : []))
  const last = w[w.length - 1]
  return n.length ? n : w.length > 1 && /^[a-d]$/.test(last) ? [last.charCodeAt(0) - 96] : []
}
const isLab = (t: string) => /\blab(oratory)?\b/i.test(t) && !/\bwith lab/i.test(t)

type Lvl = { lo: number; hi: number }
type Topic = { ladder: 'math' | 'physics' | 'chem' | 'cs'; kind: string; lvl?: Lvl; calc?: boolean }

/** Level from the title's ordinals; for a generic title, from the course letter (MATH 1C "Calculus" -> 3). */
const level = (id: CourseId, w: string[], generic: boolean): Lvl | undefined => {
  const n = ordinals(w)
  if (n.length) return { lo: Math.min(...n), hi: Math.max(...n) }
  const k = seqKey(id)
  return generic && k && k.seq >= 0 && k.seq < 4 ? { lo: k.seq + 1, hi: k.seq + 1 } : undefined
}

const PREFIX = (id: CourseId) => /^\d+:(.+?)\s[A-Z]?\d/.exec(id)?.[1] ?? ''

/** Topic-ladder position of a course, or undefined when the title is not unambiguous. */
export const topic = (id: CourseId, title: string): Topic | undefined => {
  const p = PREFIX(id), t = words(title).join(' '), w = words(title)
  if (/^MATH?$|^MTH$/.test(p)) {
    if (/\b(for|business|life|social|management|biolog\w*|short|seminar|intermediate)\b/.test(t)) return undefined
    if (/\bpre ?calculus\b/.test(t)) return { ladder: 'math', kind: 'calc', lvl: { lo: 0, hi: 0 } }
    if (/\b(linear algebra|differential equations)\b/.test(t)) return { ladder: 'math', kind: 'post' }
    if (/\b(multi ?variable|multivariate|vector) calculus\b/.test(t)) return { ladder: 'math', kind: 'calc', lvl: { lo: 3, hi: 3 } }
    if (!/\bcalculus\b/.test(t)) return undefined
    // "Calculus", "Analytic Geometry and Calculus", "Single Variable Calculus I", "Calculus I with Analytic Geometry"
    const rest = w.filter((x) => !['calculus', 'and', 'with', 'analytic', 'analytical', 'geometry', 'single', 'variable'].includes(x) && !ORD[x])
    if (rest.length) return undefined
    const lvl = level(id, w, true)
    return lvl && { ladder: 'math', kind: 'calc', lvl }
  }
  if (/^PHY/.test(p) && !/physiolog/.test(t)) {
    // generic calculus-series title: Foothill PHYS 4A "General Physics (Calculus)", Orange Coast PHYS 4A "General Physics"
    const k = seqKey(id), four = !!k && /\s4$/.test(k.stem), gen = /^general physics( with)?( calculus)?$/.test(t)
    const kind = /mechanic/.test(t) ? 'M' : /electr|magnet/.test(t) ? 'E' : /\b(optics|modern|atomic|light)\b/.test(t) ? 'O'
      : /\b(waves?|fluids?|thermodynamics|heat|sound)\b/.test(t) ? 'W'
      : gen && four && k!.seq === 0 ? 'M' : gen && four && k!.seq === 1 && /\bcalculus\b/.test(t) ? 'E' : undefined
    const calc = !/\b(algebra|trigonometry|non ?calculus|conceptual|college physics)\b/.test(t)
    return kind && { ladder: 'physics', kind, calc }
  }
  if (/^CH/.test(p) && /\bchemistry\b/.test(t) && !/\b(introduct\w*|preparat\w*|fundamentals?|survey|biochemistry)\b/.test(t)) {
    const org = /\borganic\b/.test(t), gen = /\bgeneral\b/.test(t)
    if (org === gen) return undefined
    // generic: nothing beyond "general [college] chemistry [and ...]" / "organic chemistry [laboratory]"
    const generic = org ? /^organic chemistry( laboratory| lab)?$/.test(t) : /^general (college )?chemistry\b/.test(t)
    return { ladder: 'chem', kind: org ? 'O' : 'G', lvl: level(id, w, generic) }
  }
  if (/^(CS|C S|CIS|CIST|COMSC|CSCI)$/.test(p)) {
    if (/\bdata structures?\b/.test(t)) return { ladder: 'cs', kind: 'ds' }
    if (/\b(assembl\w*|computer architecture|computer organization|machine language)\b/.test(t)) return { ladder: 'cs', kind: 'asm' }
    if (/^(introduction to (computer )?programming|introduction to computers and programming|beginning programming)\b/.test(t)
      || /\bprogramming( language)? (i|1)\b/.test(t)) return { ladder: 'cs', kind: 'intro' }
  }
  return undefined
}

const below = (a?: Lvl, b?: Lvl) => !!a && !!b && a.hi < b.lo
/** true when topic a must come strictly before topic b. */
const before = (a: Topic, b: Topic): boolean => {
  // Calculus I (and Precalculus) < calculus-based Mechanics; Calculus II (and below) < calculus-based E&M
  if (a.ladder === 'math' && b.ladder === 'physics')
    return a.kind === 'calc' && !!b.calc && (b.kind === 'M' ? a.lvl!.hi <= 1 : b.kind === 'E' && a.lvl!.hi <= 2)
  if (a.ladder !== b.ladder) return false
  switch (a.ladder) {
    case 'math': return a.kind === 'calc' && (b.kind === 'calc' ? below(a.lvl, b.lvl) : a.lvl!.hi <= 2)
    case 'physics': return a.kind === 'M' ? b.kind !== 'M' : a.kind === 'E' && b.kind === 'O'
    case 'chem': return a.kind === 'G' ? b.kind === 'O' || below(a.lvl, b.lvl) : b.kind === 'O' && below(a.lvl, b.lvl)
    case 'cs': return a.kind === 'intro' && b.kind !== 'intro'
  }
}

/** Every inferred prerequisite edge among `courses`, cycle-free. `dropped` lists edges removed to break a cycle. */
export function prereqs(courses: CourseId[], titleOf: (c: CourseId) => string = () => ''): { edges: Edge[]; dropped: Edge[] } {
  const keys = new Map(courses.map((c) => [c, seqKey(c)]))
  const posts = new Set(courses.filter((c) => topic(c, titleOf(c))?.kind === 'post')), post = (c: CourseId) => posts.has(c) // LinAlg / DiffEq
  const all: Edge[] = []
  const add = (from: CourseId | undefined, to: CourseId, rule: Rule) => { if (from && from !== to) all.push({ from, to, rule }) }
  for (const c of courses) {
    const k = keys.get(c)
    if (!k) continue
    if (k.seq < 0) {
      // plain number: the previous plain number whose title differs only by ordinal (CHEM 11 -> CHEM 12)
      const t = ordinalTitle(titleOf(c))
      if (t) add(courses.find((o) => { const ko = keys.get(o), to = ordinalTitle(titleOf(o)); return ko?.stem === k.prev && ko.seq < 0 && to?.base === t.base && to.n === t.n - 1 }), c, 'ordinal')
    } else if (k.seq > 0) {
      // nearest lower letter in the same series (1A -> 1C when 1B is not needed); a lab "37L" is not letter L
      // Linear Algebra and Differential Equations are siblings: neither waits for the other's letter
      if (!(k.seq === 11 && isLab(titleOf(c))))
        add(courses.filter((o) => { const ko = keys.get(o); return ko?.stem === k.stem && ko.seq >= 0 && ko.seq < k.seq && !(post(c) && post(o)) }).sort((x, y) => keys.get(y)!.seq - keys.get(x)!.seq)[0], c, 'letter')
    } else {
      // ponytail: assume the third course (C) of the lower series is the gate, as with MATH 1C -> 2A; real requisites if ASSIST ever ships them.
      // Not for a course whose title says it starts something ("Introduction to Python", "Calculus for Life Sciences I").
      const w = words(titleOf(c)), n = ordinals(w)
      // Nor for Linear Algebra / Differential Equations: the math ladder already puts them after Calculus II (not III).
      if (/^(introduct\w*|beginning)$/.test(w[0] ?? '') || (n.length === 1 && n[0] === 1) || post(c)) continue
      const lower = courses.filter((o) => keys.get(o)?.stem === k.prev)
      add(lower.find((o) => keys.get(o)!.seq === 2) ?? lower.sort((x, y) => keys.get(y)!.seq - keys.get(x)!.seq)[0], c, 'series')
    }
  }
  // co: a lab and its lecture: same id without the L (PHYC 4AL -> 4A), else the one lecture titled like it
  const inst = (c: CourseId) => c.slice(0, c.indexOf(':'))
  const bare = (c: CourseId) => words(titleOf(c)).filter((x) => x !== 'lab' && x !== 'laboratory').join(' ')
  for (const l of courses) {
    if (!isLab(titleOf(l))) continue
    const lec = courses.filter((c) => c !== l && inst(c) === inst(l) && !isLab(titleOf(c)))
    const byTitle = lec.filter((c) => words(titleOf(c)).join(' ') === bare(l))
    add(lec.find((c) => /L$/.test(l) && c === l.slice(0, -1)) ?? (byTitle.length === 1 ? byTitle[0] : undefined), l, 'co')
  }
  // title: same words but one ordinal, any college ("Java Programming Language I" < "... II")
  const tit = new Map(courses.map((c) => {
    const w = words(titleOf(c)), at = w.flatMap((x, i) => (ORD[x] ? [i] : []))
    return [c, at.length === 1 && w.length > 1 ? { base: w.map((x, i) => (i === at[0] ? '#' : x)).join(' '), n: ORD[w[at[0]]] } : null]
  }))
  const tops = new Map(courses.map((c) => [c, topic(c, titleOf(c))]))
  for (const a of courses) for (const b of courses) {
    const ta = tit.get(a), tb = tit.get(b)
    if (ta && tb && ta.base === tb.base && ta.n < tb.n) add(a, b, 'title')
    const pa = tops.get(a), pb = tops.get(b)
    if (pa && pb && before(pa, pb)) add(a, b, pa.ladder)
  }
  // Strongest rule first, then ids: an edge that would close a cycle is dropped (deterministic).
  all.sort((x, y) => RULES.indexOf(x.rule) - RULES.indexOf(y.rule) || (x.from < y.from ? -1 : x.from > y.from ? 1 : x.to < y.to ? -1 : x.to > y.to ? 1 : 0))
  const out = new Map<CourseId, Set<CourseId>>(), edges: Edge[] = [], dropped: Edge[] = [], seen = new Set<string>()
  const reach = (s: CourseId, t: CourseId): boolean => {
    const st = [s], vis = new Set([s])
    while (st.length) { const x = st.pop()!; if (x === t) return true; for (const y of out.get(x) ?? []) if (!vis.has(y)) { vis.add(y); st.push(y) } }
    return false
  }
  for (const e of all) {
    const key = `${e.from}>${e.to}`
    if (seen.has(key)) continue // same pair from a weaker rule
    seen.add(key)
    if (reach(e.to, e.from)) { dropped.push(e); continue }
    if (!out.has(e.from)) out.set(e.from, new Set())
    out.get(e.from)!.add(e.to); edges.push(e)
  }
  return { edges, dropped }
}
