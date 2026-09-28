import type { Course, CourseId, ReqNode } from './types'
import { offLadder, prereqs, topic, type Rule, type Topic } from './sequence.ts'

/* Enrollment prerequisites a plan must include (TESTER1 H-1). ASSIST ships no requisites, so they are the lower courses
 * of a chain that sequence.ts infers (letters, ordinals, titles, the math / physics / chemistry / CS ladders), taken
 * from the agreement's catalog at the SAME college as the course that needs them. A prerequisite is met by a course
 * taken or planned at any college that covers it: the same course or its honors twin, the same ladder level
 * ("Calculus I" anywhere), the same title only when that title names one course at each college (never Foothill's four
 * "Calculus" courses, told apart by letter), a cross-listed course (same number and title), or, for a taken course,
 * anything after it or after a course ASSIST lists beside it for one UC row. One the catalog lists only at other colleges is
 * not added (it would add a college to the plan): the plan carries a warning instead.
 * Not added: precalculus (placement decides it), labs to lectures ('co'), and 'series' guesses (1C < 2A). */

const RULES = new Set<Rule>(['letter', 'ordinal', 'title', 'math', 'physics', 'chem', 'cs'])
const inst = (c: CourseId) => c.slice(0, c.indexOf(':'))
const stripH = (c: CourseId) => c.replace(/H$/, '')
const norm = (t: string) => t.toLowerCase().replace(/\bhonors\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim()

export interface PrereqGraph {
  /** Every course that must come before the key (the key's direct prerequisites under RULES). */
  preds: Map<CourseId, CourseId[]>
  reach: (from: CourseId, to: CourseId) => boolean
  equiv: (p: CourseId, q: CourseId) => boolean
  /** ASSIST lists both as single-course alternatives for one UC row and their topics agree. Counted only for a TAKEN
   *  course (pack order does not know it, so a planned one could land after the course that needs it). */
  articulated: (p: CourseId, q: CourseId) => boolean
  spans: (p: CourseId, qs: CourseId[]) => boolean
  titleOf: (c: CourseId) => string
}

const NO_ROOT: ReqNode = { kind: 'node', type: 'AND', required: true, children: [] }
const cache = new WeakMap<Record<CourseId, Course>, WeakMap<ReqNode, Map<string, PrereqGraph>>>()

/** The inferred edges among every catalog and taken course; cached per catalog object, tree and transcript. `root`
 *  (the agreement's tree) supplies articulation-backed equivalence: see `equiv`. */
export function prereqGraph(catalog: Record<CourseId, Course>, taken: Iterable<CourseId>, root: ReqNode = NO_ROOT): PrereqGraph {
  const key = [...new Set(taken)].sort().join('\n')
  let byRoot = cache.get(catalog)
  if (!byRoot) cache.set(catalog, (byRoot = new WeakMap()))
  let byTaken = byRoot.get(root)
  if (!byTaken) byRoot.set(root, (byTaken = new Map()))
  let g = byTaken.get(key)
  if (!g) { if (byTaken.size > 64) byTaken.clear(); byTaken.set(key, (g = buildGraph(catalog, key ? key.split('\n') : [], root))) }
  return g
}

/** Pairs "a|b" of courses that ASSIST lists as single-course alternatives for the same UC row (any colleges). */
function articulatedPairs(root: ReqNode): Set<string> {
  const out = new Set<string>()
  const walk = (n: ReqNode['children'][number]) => {
    if (n.kind === 'node') { n.children.forEach(walk); return }
    const singles = [...new Set(n.groups.filter((g) => g.courses.length === 1).map((g) => g.courses[0]))]
    for (const a of singles) for (const b of singles) if (a !== b) out.add(`${a}|${b}`)
  }
  walk(root)
  return out
}

function buildGraph(catalog: Record<CourseId, Course>, taken: CourseId[], root: ReqNode): PrereqGraph {
  const titleOf = (c: CourseId) => catalog[c]?.title ?? ''
  const all = [...new Set([...Object.keys(catalog), ...taken])].sort()
  const tops = new Map(all.map((c) => [c, topic(c, titleOf(c))]))
  const normed = new Map<CourseId, string>()
  const normOf = (c: CourseId) => { let t = normed.get(c); if (t === undefined) normed.set(c, (t = norm(titleOf(c)))); return t }
  const precalc = (c: CourseId) => { const t = tops.get(c); return t?.ladder === 'math' && t.lvl?.hi === 0 }
  const preds = new Map<CourseId, CourseId[]>(), out = new Map<CourseId, CourseId[]>()
  for (const e of prereqs(all, titleOf).edges) {
    if (!RULES.has(e.rule) || precalc(e.from)) continue
    preds.set(e.to, [...(preds.get(e.to) ?? []), e.from])
    out.set(e.from, [...(out.get(e.from) ?? []), e.to])
  }
  const reach = (s: CourseId, t: CourseId) => {
    const st = [s], vis = new Set(st)
    while (st.length) { const x = st.pop()!; if (x === t) return true; for (const y of out.get(x) ?? []) if (!vis.has(y)) { vis.add(y); st.push(y) } }
    return false
  }
  // A title is not a course's identity (round 10): Foothill MATH 1A-1D are all "Calculus" and PHYS 4A-4D all "General
  // Physics (Calculus)". A title counts as naming one course only when no other course at its college carries it; a
  // shared title never makes two different courses equivalent. A course and its honors twin, and cross-listed courses
  // (same number and title, another prefix: Irvine Valley CS 6A / MATH 6A), are one course here.
  const num = (c: CourseId) => `${inst(c)}|${stripH(c).slice(stripH(c).lastIndexOf(' ') + 1)}`
  const holders = new Map<string, Set<string>>()
  for (const c of all) { const k = `${inst(c)}|${normOf(c)}`; if (!holders.has(k)) holders.set(k, new Set()); holders.get(k)!.add(num(c)) }
  const distinctive = (c: CourseId) => !!normOf(c) && holders.get(`${inst(c)}|${normOf(c)}`)?.size === 1
  const crossListed = (p: CourseId, q: CourseId) => num(p) === num(q) && !!normOf(p) && normOf(p) === normOf(q)
  // Articulation-backed (round 10): ASSIST lists both as single-course alternatives for one UC row (De Anza PHYS 4B and
  // Saddleback PHYS 4B "General Physics" for UCSD PHYS 2B), unless the topics say they differ: a different ladder, kind
  // or level, or an off-ladder course (business calculus next to Calculus I for UCI MATH 2A).
  const pairs = articulatedPairs(root)
  const compatible = (a?: Topic, b?: Topic, p?: CourseId, q?: CourseId) => {
    if (a && b) return a.ladder === b.ladder && a.kind === b.kind && !a.lvl === !b.lvl && (!a.lvl || (a.lvl.lo === b.lvl!.lo && a.lvl.hi === b.lvl!.hi))
    return !(a && offLadder(q!, titleOf(q!))) && !(b && offLadder(p!, titleOf(p!)))
  }
  const articulated = (p: CourseId, q: CourseId) =>
    (pairs.has(`${p}|${q}`) || pairs.has(`${stripH(p)}|${stripH(q)}`)) && compatible(tops.get(p), tops.get(q), p, q)
  const equiv = (p: CourseId, q: CourseId) => {
    if (stripH(p) === stripH(q) || crossListed(p, q)) return true
    const a = tops.get(p), b = tops.get(q)
    if (a && b && a.ladder === b.ladder && a.kind === b.kind) {
      if (a.ladder === 'physics' || a.ladder === 'cs') return true
      // a leveled topic is decided by its level; a shared generic title ("Calculus", level from the letter) never overrides it
      if (a.lvl && b.lvl) return a.lvl.lo === b.lvl.lo && a.lvl.hi === b.lvl.hi
    }
    // same title: only when each title is distinctive at its college and the topics read the same (none, or one without levels)
    const sameTopic = a && b ? a.ladder === b.ladder && a.kind === b.kind && !a.lvl && !b.lvl : !a && !b
    return sameTopic && distinctive(p) && distinctive(q) && normOf(p) === normOf(q)
  }
  /** A leveled course ("Calculus 1 and 2") whose every level some of `qs` covers (Calculus I + Calculus II). */
  const spans = (p: CourseId, qs: CourseId[]) => {
    const a = tops.get(p)
    if (!a?.lvl) return false
    const lv = qs.map((q) => tops.get(q)).filter((b) => b?.lvl && b.ladder === a.ladder && b.kind === a.kind).map((b) => b!.lvl!)
    for (let l = a.lvl.lo; l <= a.lvl.hi; l++) if (!lv.some((x) => x.lo <= l && l <= x.hi)) return false
    return true
  }
  return { preds, reach, equiv, articulated, spans, titleOf }
}

export interface Closure { added: CourseId[]; warnings: string[] }

/** The prerequisites `planned` still needs, added at each course's own college, transitively; warnings for the rest. */
export function prereqClosure(g: PrereqGraph, planned: CourseId[], taken: Set<CourseId>, catalog: Record<CourseId, Course>, collegeName: (c: CourseId) => string = inst): Closure {
  const S = new Set([...taken, ...planned]), added: CourseId[] = [], warnings: string[] = []
  // a taken course also stands for the courses ASSIST articulates beside it (De Anza PHYS 4B for Saddleback PHYS 4B)
  const twins = new Map([...taken].map((q) => [q, Object.keys(catalog).filter((r) => r !== q && g.articulated(r, q))]))
  const covered = (p: CourseId, c: CourseId) => {
    if (S.has(p)) return true
    const qs = [...S].filter((q) => q !== c)
    return qs.some((q) => g.equiv(p, q) || (taken.has(q) && (g.reach(p, q) || twins.get(q)!.some((r) => r === p || g.reach(p, r))))) || g.spans(p, qs)
  }
  const rank = (x: CourseId) => [/H$/.test(x) ? 1 : 0, catalog[x]?.units ?? 0] as const
  const queue = [...planned].filter((c) => !taken.has(c)).sort()
  while (queue.length) {
    const c = queue.shift()!
    const unmet = (g.preds.get(c) ?? []).filter((p) => !covered(p, c))
    const local = unmet.filter((p) => inst(p) === inst(c) && catalog[p])
      .sort((x, y) => rank(x)[0] - rank(y)[0] || rank(x)[1] - rank(y)[1] || (x < y ? -1 : x > y ? 1 : 0))
    for (const p of local) if (!covered(p, c)) { S.add(p); added.push(p); queue.push(p) }
  }
  // Warnings once the closure is complete: a need met by a course added later is not reported.
  for (const c of [...S].filter((x) => !taken.has(x)).sort()) {
    const miss = (g.preds.get(c) ?? []).filter((p) => inst(p) !== inst(c) && !covered(p, c))
    if (!miss.length) continue
    const eg = [...miss].sort()[0], t = g.titleOf(eg).trim()
    warnings.push(`${code(c)} (${collegeName(c)}): a prerequisite is listed in this agreement only at other colleges `
      + `(e.g. ${collegeName(eg)} ${code(eg)}${t ? ` "${t}"` : ''}); take it first, or check ${collegeName(c)}'s catalog for its own.`)
  }
  return { added: added.sort(), warnings: [...new Set(warnings)].sort() }
}

const code = (c: CourseId) => c.slice(c.indexOf(':') + 1)
