import type { Course, CourseId } from './types'
import { prereqs, topic, type Rule } from './sequence.ts'

/* Enrollment prerequisites a plan must include (TESTER1 H-1). ASSIST ships no requisites, so they are the lower courses
 * of a chain that sequence.ts infers (letters, ordinals, titles, the math / physics / chemistry / CS ladders), taken
 * from the agreement's catalog at the SAME college as the course that needs them. A prerequisite is met by a course
 * taken or planned at any college that covers it: the same course or its honors twin, the same ladder level
 * ("Calculus I" anywhere), or, for a taken course, anything after it. One the catalog lists only at other colleges is
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
  spans: (p: CourseId, qs: CourseId[]) => boolean
  titleOf: (c: CourseId) => string
}

const cache = new WeakMap<Record<CourseId, Course>, Map<string, PrereqGraph>>()

/** The inferred edges among every catalog and taken course; cached per catalog object and transcript. */
export function prereqGraph(catalog: Record<CourseId, Course>, taken: Iterable<CourseId>): PrereqGraph {
  const key = [...new Set(taken)].sort().join('\n')
  let byTaken = cache.get(catalog)
  if (!byTaken) cache.set(catalog, (byTaken = new Map()))
  let g = byTaken.get(key)
  if (!g) { if (byTaken.size > 64) byTaken.clear(); byTaken.set(key, (g = buildGraph(catalog, key ? key.split('\n') : []))) }
  return g
}

function buildGraph(catalog: Record<CourseId, Course>, taken: CourseId[]): PrereqGraph {
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
  const equiv = (p: CourseId, q: CourseId) => {
    if (stripH(p) === stripH(q)) return true
    const a = tops.get(p), b = tops.get(q)
    if (a && b && a.ladder === b.ladder && a.kind === b.kind) {
      if (a.ladder === 'physics' || a.ladder === 'cs') return true
      if (a.lvl && b.lvl && a.lvl.lo === b.lvl.lo && a.lvl.hi === b.lvl.hi) return true
    }
    const tp = normOf(p)
    return !!tp && tp === normOf(q)
  }
  /** A leveled course ("Calculus 1 and 2") whose every level some of `qs` covers (Calculus I + Calculus II). */
  const spans = (p: CourseId, qs: CourseId[]) => {
    const a = tops.get(p)
    if (!a?.lvl) return false
    const lv = qs.map((q) => tops.get(q)).filter((b) => b?.lvl && b.ladder === a.ladder && b.kind === a.kind).map((b) => b!.lvl!)
    for (let l = a.lvl.lo; l <= a.lvl.hi; l++) if (!lv.some((x) => x.lo <= l && l <= x.hi)) return false
    return true
  }
  return { preds, reach, equiv, spans, titleOf }
}

export interface Closure { added: CourseId[]; warnings: string[] }

/** The prerequisites `planned` still needs, added at each course's own college, transitively; warnings for the rest. */
export function prereqClosure(g: PrereqGraph, planned: CourseId[], taken: Set<CourseId>, catalog: Record<CourseId, Course>, collegeName: (c: CourseId) => string = inst): Closure {
  const S = new Set([...taken, ...planned]), added: CourseId[] = [], warnings: string[] = []
  const covered = (p: CourseId, c: CourseId) => {
    if (S.has(p)) return true
    const qs = [...S].filter((q) => q !== c)
    return qs.some((q) => g.equiv(p, q) || (taken.has(q) && g.reach(p, q))) || g.spans(p, qs)
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
