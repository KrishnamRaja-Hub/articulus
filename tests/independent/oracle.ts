/**
 * Independent oracle for the transfer rules (README "Verification", FIXES.md Round 3). Written from the rules, not
 * from src/engine/verify.ts: it shares no code with the app, only the data types (`import type`). A test in
 * isolation.test.ts fails if this file (or any other oracle-side file) ever imports runtime code from src/.
 *
 * Rules:
 *  1. A row is satisfied by one complete group from one college. A course and its honors twin (one trailing H) are
 *     interchangeable only at a college that lists both a regular group and its honors twin for that row.
 *  2. A split series: an unsatisfied row with pieces at two or more colleges that are different courses
 *     (honors-stripped codes, so MATH 1BH here and MATH 1B there is a duplicate, not a split).
 *  3. UC-only: the row has no group anywhere AND ASSIST gives at least one explicit reason other than the importer's
 *     placeholder "No articulation listed". A row with no record is neither a route nor deferrable: it stays open.
 *  4. AND: every required child passes. OR / N_OF(n): with s satisfied, a open-but-routable, d UC-only children:
 *     s >= n satisfied; s + a + d < n cannot be met; a > 0 the CC alternatives are owed first (UC-only rows would fill
 *     only max(0, n - s - a) slots); otherwise it passes with the UC-only rows deferred.
 *  5. Optional (recommended) subtrees are reported but never fail, satisfy or defer anything for their parent.
 *  6. Blocking vs warning: top down from a failing root, an AND needs every failing required child, an OR / N_OF every
 *     failing child that has a CC route. A split in a needed row is blocking; any other split is a warning.
 *  7. isValid = the root passes and there is no blocking split.
 */
import type { Agreement, CourseGroup, CourseId, ReqNode, Requirement } from '../../src/engine/types'

export const PLACEHOLDER = 'No articulation listed'

type Node = ReqNode | Requirement

export const instOf = (c: CourseId) => Number(c.slice(0, c.indexOf(':')))
const dropH = (s: string) => (s.endsWith('H') ? s.slice(0, -1) : s)
/** Course code without college and without one trailing honors H: "113:MATH 1BH" -> "MATH 1B". */
export const codeOf = (c: CourseId) => dropH(c.slice(c.indexOf(':') + 1))

export const leaves = (n: Node, out: Requirement[] = []): Requirement[] => {
  if (n.kind === 'req') out.push(n)
  else for (const k of n.children) leaves(k, out)
  return out
}
/** First occurrence of each requirement id, in tree order. */
export const uniqueRows = (a: Agreement): Requirement[] => [...new Map(leaves(a.root).reverse().map((r) => [r.id, r])).values()].reverse()

export const isUcOnly = (r: Requirement) =>
  r.groups.length === 0 && Object.values(r.noArticulation ?? {}).some((why) => why !== PLACEHOLDER)
export const isNoRecord = (r: Requirement) => r.groups.length === 0 && !isUcOnly(r)

const twins = new WeakMap<Requirement, Set<number>>()
/** Colleges that list, for this row, a regular group and a different group equal to it up to honors H suffixes. */
export function twinColleges(r: Requirement): Set<number> {
  let out = twins.get(r)
  if (out) return out
  out = new Set()
  const byShape = new Map<string, Set<string>>()
  for (const g of r.groups) {
    const shape = `${g.institutionId}|${g.courses.map(dropH).sort().join('+')}`
    const raw = [...g.courses].sort().join('+')
    if (!byShape.has(shape)) byShape.set(shape, new Set())
    byShape.get(shape)!.add(raw)
  }
  for (const [shape, raws] of byShape) if (raws.size > 1) out.add(Number(shape.slice(0, shape.indexOf('|'))))
  twins.set(r, out)
  return out
}

/** Taken ids that stand for group course `c`: itself, or its twin (exactly one H apart) at a twin college. */
export function standsFor(c: CourseId, taken: ReadonlySet<CourseId>, tw: ReadonlySet<number>): CourseId[] {
  const out: CourseId[] = []
  if (taken.has(c)) out.push(c)
  if (tw.has(instOf(c))) {
    if (!c.endsWith('H') && taken.has(`${c}H`)) out.push(`${c}H`)
    if (c.endsWith('H') && taken.has(c.slice(0, -1))) out.push(c.slice(0, -1))
  }
  return out
}

export interface RowEval {
  req: Requirement
  sat: boolean
  satGroups: CourseGroup[]
  /** college -> every taken id that stands for some course of some group of this row at that college */
  have: Map<number, Set<CourseId>>
  split: boolean
  ucOnly: boolean
  noRecord: boolean
}

export function evalRow(r: Requirement, taken: ReadonlySet<CourseId>): RowEval {
  const tw = twinColleges(r)
  const satGroups = r.groups.filter((g) => g.courses.every((c) => standsFor(c, taken, tw).length > 0))
  const have = new Map<number, Set<CourseId>>()
  for (const g of r.groups) for (const c of g.courses) for (const t of standsFor(c, taken, tw)) {
    if (!have.has(g.institutionId)) have.set(g.institutionId, new Set())
    have.get(g.institutionId)!.add(t)
  }
  const sat = satGroups.length > 0
  const codes = new Set([...have.values()].flatMap((s) => [...s].map(codeOf)))
  return { req: r, sat, satGroups, have, split: !sat && have.size >= 2 && codes.size >= 2, ucOnly: isUcOnly(r), noRecord: isNoRecord(r) }
}

/**
 * COUNSELOR_REPORT LOW-6: the app keeps one partial per college (the one with most progress), so where one college
 * has two different partial groups it can miss a split the literal rule reports. True iff some choice of a
 * most-progress group per college leaves pieces at one college only, or one code only.
 */
export function splitHiddenByBestPartial(e: RowEval, taken: ReadonlySet<CourseId>): boolean {
  if (!e.split) return false
  const tw = twinColleges(e.req)
  const perCollege: Set<string>[][] = []
  for (const inst of e.have.keys()) {
    // progress is counted in group courses covered (a course and its twin both taken is one course)
    const partials = e.req.groups.filter((g) => g.institutionId === inst)
      .map((g) => g.courses.filter((c) => standsFor(c, taken, tw).length > 0))
      .filter((cs) => cs.length > 0)
    const best = Math.max(...partials.map((cs) => new Set(cs).size))
    perCollege.push(partials.filter((cs) => new Set(cs).size === best).map((cs) => new Set(cs.map(codeOf))))
  }
  const go = (i: number, codes: Set<string>): boolean =>
    i === perCollege.length ? codes.size <= 1 : perCollege[i].some((c) => go(i + 1, new Set([...codes, ...c])))
  return perCollege.length >= 2 && go(0, new Set())
}

/* ---- the fold ---- */

type State = 'S' | 'D' | 'O' // satisfied with CC courses / passes only with UC-only rows deferred / open
interface Fold { state: State; route: boolean; def: string[]; miss: string[]; kids: Fold[]; node: Node }

/**
 * `deferred` convention for choices with several UC-only alternatives (the rules name how many slots UC-only rows
 * fill, not which rows to list):
 *  - 'slots' (default, the rule): list exactly the UC-only alternatives that must fill a slot, first ones first.
 *  - 'app-low3': the app's current listing (COUNSELOR_REPORT LOW-3): none while a CC alternative is owed, every UC-only
 *    alternative once the choice passes by deferral. Used only to classify a known deviation.
 */
export type DeferConvention = 'slots' | 'app-low3'
export interface OracleOptions { defer?: DeferConvention }

const counted = (n: Node) => n.kind === 'req' || n.required

function fold(n: Node, leaf: (r: Requirement) => State, conv: DeferConvention): Fold {
  if (n.kind === 'req') {
    const state = leaf(n)
    return { state, route: n.groups.length > 0 || isUcOnly(n), def: state === 'D' ? [n.id] : [], miss: state === 'O' ? [n.id] : [], kids: [], node: n }
  }
  const kids = n.children.map((k) => fold(k, leaf, conv))
  const route = hasRoute(n)
  const cnt = kids.filter((k) => counted(k.node))
  if (n.type === 'AND') {
    const open = cnt.filter((k) => k.state === 'O')
    // an AND with no required children imposes nothing (COUNSELOR_REPORT LOW-2 documents this shape)
    const state: State = open.length ? 'O' : cnt.some((k) => k.state === 'S') || cnt.length === 0 ? 'S' : 'D'
    return { state, route, def: cnt.flatMap((k) => k.def), miss: open.flatMap((k) => k.miss), kids, node: n }
  }
  const need = n.type === 'OR' ? 1 : n.n ?? 1
  const S = cnt.filter((k) => k.state === 'S'), A = cnt.filter((k) => k.state === 'O' && k.route), D = cnt.filter((k) => k.state === 'D')
  if (S.length >= need) {
    // rely on the satisfied alternatives that leave the least for the university (stable)
    const pick = S.map((k, i) => ({ k, i })).sort((x, y) => x.k.def.length - y.k.def.length || x.i - y.i).slice(0, need).map((x) => x.k)
    const chosen = new Set(pick)
    return { state: 'S', route, def: S.filter((k) => chosen.has(k)).flatMap((k) => k.def), miss: [], kids, node: n }
  }
  if (S.length + A.length + D.length < need) {
    return { state: 'O', route, def: S.flatMap((k) => k.def), miss: cnt.filter((k) => k.state !== 'S').flatMap((k) => k.miss), kids, node: n }
  }
  const slots = Math.min(D.length, Math.max(0, need - S.length - A.length))
  if (A.length) {
    const fill = conv === 'slots' ? D.slice(0, slots) : []
    return { state: 'O', route, def: [...S, ...fill].flatMap((k) => k.def), miss: A.flatMap((k) => k.miss), kids, node: n }
  }
  const fill = conv === 'slots' ? D.slice(0, need - S.length) : D
  return { state: 'D', route, def: [...S, ...fill].flatMap((k) => k.def), miss: [], kids, node: n }
}

const routeMemo = new WeakMap<ReqNode, boolean>()
/** Would the subtree pass if every row with a CC group were done (UC-only rows deferred, no-record rows open)? */
export function hasRoute(n: Node): boolean {
  if (n.kind === 'req') return n.groups.length > 0 || isUcOnly(n)
  let v = routeMemo.get(n)
  if (v === undefined) {
    const kids = n.children.filter(counted).map((k): { state: State; route: boolean } => {
      if (k.kind === 'req') return { state: k.groups.length ? 'S' : isUcOnly(k) ? 'D' : 'O', route: hasRoute(k) }
      const r = hasRoute(k)
      return { state: r ? (allDeferred(k) ? 'D' : 'S') : 'O', route: r }
    })
    if (n.type === 'AND') v = kids.every((k) => k.state !== 'O')
    else {
      const need = n.type === 'OR' ? 1 : n.n ?? 1
      const s = kids.filter((k) => k.state === 'S').length, d = kids.filter((k) => k.state === 'D').length
      // hypothetically every routable child is done, so a = 0
      v = s + d >= need
    }
    routeMemo.set(n, v)
  }
  return v
}
/** In the all-CC-done hypothesis, does the (routable) subtree pass only through deferral? */
function allDeferred(n: ReqNode): boolean {
  return fold(n, (r) => (r.groups.length ? 'S' : isUcOnly(r) ? 'D' : 'O'), 'slots').state === 'D'
}

export interface OracleResult {
  isValid: boolean
  rootPass: boolean
  rows: Map<string, RowEval>
  satisfied: Set<string>
  splits: Set<string>
  blocking: Set<string>
  needed: Set<string>
  deferred: Set<string>
  /** requirement ids the root still needs (the rows the app's `missing` strings should name) */
  missing: Set<string>
}

export function oracle(a: Agreement, taken: ReadonlySet<CourseId>, opts: OracleOptions = {}): OracleResult {
  const rows = new Map<string, RowEval>()
  const rowOf = (r: Requirement) => {
    let e = rows.get(r.id)
    if (!e || e.req !== r) {
      const fresh = evalRow(r, taken)
      if (!e) rows.set(r.id, fresh) // report the first occurrence of an id
      e = fresh
    }
    return e
  }
  const root = fold(a.root, (r) => { const e = rowOf(r); return e.sat ? 'S' : e.ucOnly ? 'D' : 'O' }, opts.defer ?? 'slots')
  const rootPass = root.state !== 'O'
  const needed = new Set<string>()
  const mark = (f: Fold) => {
    if (f.node.kind === 'req') return void needed.add(f.node.id)
    const and = f.node.type === 'AND'
    for (const k of f.kids) if (counted(k.node) && k.state === 'O' && (and || k.route)) mark(k)
  }
  if (!rootPass) mark(root)
  const splits = new Set([...rows.values()].filter((e) => e.split).map((e) => e.req.id))
  const blocking = new Set([...splits].filter((id) => needed.has(id)))
  return {
    isValid: rootPass && blocking.size === 0,
    rootPass, rows, needed, splits, blocking,
    satisfied: new Set([...rows.values()].filter((e) => e.sat).map((e) => e.req.id)),
    deferred: new Set(root.def),
    missing: new Set(rootPass || !a.root.required ? [] : root.miss),
  }
}

/** Requirement ids named in one of the app's `missing` strings ("One of: A, (B + C)"). Ids may contain ", ". */
export function idsIn(s: string, ids: readonly string[]): Set<string> {
  if (ids.includes(s)) return new Set([s])
  const out = new Set<string>()
  let text = ` ${s} `
  for (const [id, re] of matchers(ids)) if (text.includes(id) && re.test(text)) { out.add(id); text = text.split(id).join('#') }
  return out
}
const matcherMemo = new WeakMap<readonly string[], [string, RegExp][]>()
/** Longest id first, so "PHYS 4A" never matches inside "PHYS 4AL"; an id must stand between separators. */
const matchers = (ids: readonly string[]) => {
  let m = matcherMemo.get(ids)
  if (!m) {
    m = [...new Set(ids)].sort((x, y) => y.length - x.length)
      .map((id) => [id, new RegExp(`(^|[\\s(,:+])${id.replace(/[.*+?^${}()|[\]\\&]/g, '\\$&')}(?=$|[\\s),+])`)])
    matcherMemo.set(ids, m)
  }
  return m
}
