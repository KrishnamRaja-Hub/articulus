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
 *  4b. One course, one slot (FIXES round 10, M-4), for N_OF(n) with n >= 2: each satisfied child fills one slot and
 *     spends what meets it (per row: the taken ids of one complete group, and the row itself), and no two slots spend
 *     the same thing. s is then the most satisfied children that can fill slots together (the first such set, children
 *     taken in order of fewest deferred rows). The CC route is counted from the agreement: C = the most children that
 *     could fill slots together if every row with a CC group were done. Cannot be met: max(s, C) + a' + d < n, with a'
 *     the open routable children that could never be satisfied with CC courses alone. Owed first (open): s < C, or
 *     a' > 0; the missing rows are the open routable children's, plus every satisfied child's while one of them is
 *     left out. Otherwise it passes, UC-only rows filling the rest. With no course shared this is exactly rule 4.
 *  4c. "N units from the following" (UNITS, FIXES round 10): rule 4b counted in units, each child worth the units of
 *     the rows it spends (a row's units: a positive number, else 0). It is met at N units.
 *  5. Optional (recommended) subtrees are reported but never fail, satisfy or defer anything for their parent.
 *  6. Blocking vs warning: top down from a failing root, an AND needs every failing required child, an OR / N_OF every
 *     failing child that has a CC route. A split in a needed row is blocking; any other split is a warning.
 *  7. isValid = the root passes and there is no blocking split.
 *  8. Fail closed on a degenerate tree (TESTER2 M-3): if, following only required children from a required root, there
 *     is no row at all, or an AND with no required child, or an N_OF asking for fewer than 1, nothing is valid.
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
/**
 * `spend`: inside a slot of a "choose N" group (rule 4b), every way the subtree can be met, as the ids it spends (taken
 * course ids, one "row:" token per row); [[]] elsewhere, [] when it does not pass. `loose`: in an open choice, the
 * satisfied alternatives that could still take another group (rule 4b); their rows are named as missing.
 */
interface Fold { state: State; def: string[]; miss: string[]; kids: Fold[]; node: Node; spend: string[][]; loose: Fold[] }

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
const token = (id: string) => `row:${id}`
/** A leaf's reading: its state, and the ways it spends when met (only asked for inside a slot). */
type Leaf = (r: Requirement) => { state: State; spend: string[][] }

/** Keep the smallest ways only (a way spending more is never needed), without duplicates. */
function smallest(ways: string[][]): string[][] {
  const sets = [...new Map(ways.map((w) => { const s = [...new Set(w)].sort(); return [s.join('|'), s] as const })).values()]
  return sets.filter((s) => !sets.some((o) => o !== s && o.length < s.length && o.every((x) => s.includes(x))))
}
/** All ways to pick exactly k of `fams`, one way each, no id spent twice (their unions), in pick order. */
function packings(fams: string[][][], k: number): { pick: number[]; spend: string[] }[] {
  const out: { pick: number[]; spend: string[] }[] = []
  const go = (i: number, pick: number[], spent: string[]) => {
    if (pick.length === k) return void out.push({ pick, spend: spent })
    for (let j = i; j < fams.length; j++) for (const w of fams[j]) if (!w.some((x) => spent.includes(x))) go(j + 1, [...pick, j], [...spent, ...w])
  }
  go(0, [], [])
  return out
}
/** The most of `fams` (at most `cap`) that can be picked together. */
function mostTogether(fams: string[][][], cap: number): number {
  let m = 0
  while (m < cap && packings(fams, m + 1).length) m++
  return m
}

function fold(n: Node, leaf: Leaf, conv: DeferConvention, inSlot = false): Fold {
  if (n.kind === 'req') {
    const l = leaf(n)
    return { state: l.state, def: l.state === 'D' ? [n.id] : [], miss: l.state === 'O' ? [n.id] : [], kids: [], node: n,
      spend: l.state === 'O' ? [] : inSlot && l.state === 'S' ? l.spend : [[]], loose: [] }
  }
  const need = n.type === 'OR' ? 1 : n.n ?? 1
  const slots = (n.type === 'N_OF' && need >= 2) || n.type === 'UNITS'
  const kids = n.children.map((k) => fold(k, leaf, conv, inSlot || slots))
  const cnt = kids.filter((k) => counted(k.node))
  const out = (state: State, def: string[], miss: string[], spend: string[][] = [[]], loose: Fold[] = []): Fold =>
    ({ state, def, miss, kids, node: n, spend: state === 'O' ? [] : spend, loose })
  if (n.type === 'AND') {
    const open = cnt.filter((k) => k.state === 'O')
    // an AND with no required children imposes nothing (COUNSELOR_REPORT LOW-2 documents this shape)
    const state: State = open.length ? 'O' : cnt.some((k) => k.state === 'S') || cnt.length === 0 ? 'S' : 'D'
    const spend = inSlot ? smallest(cnt.reduce<string[][]>((acc, k) => acc.flatMap((a) => k.spend.map((w) => [...a, ...w])), [[]])) : [[]]
    return out(state, cnt.flatMap((k) => k.def), open.flatMap((k) => k.miss), spend)
  }
  // rely on the satisfied alternatives that leave the least for the university (stable)
  const S = cnt.filter((k) => k.state === 'S').map((k, i) => ({ k, i })).sort((x, y) => x.k.def.length - y.k.def.length || x.i - y.i).map((x) => x.k)
  const A = cnt.filter((k) => k.state === 'O' && hasRoute(k.node)), D = cnt.filter((k) => k.state === 'D')
  if (!slots) {
    if (S.length >= need) {
      const chosen = new Set(S.slice(0, need))
      return out('S', cnt.filter((k) => chosen.has(k)).flatMap((k) => k.def), [], inSlot ? smallest(S.flatMap((k) => k.spend)) : [[]])
    }
    if (S.length + A.length + D.length < need) return out('O', S.flatMap((k) => k.def), cnt.filter((k) => k.state !== 'S').flatMap((k) => k.miss))
    const uc = Math.min(D.length, Math.max(0, need - S.length - A.length))
    if (A.length) return out('O', [...S, ...(conv === 'slots' ? D.slice(0, uc) : [])].flatMap((k) => k.def), A.flatMap((k) => k.miss))
    return out('D', [...S, ...(conv === 'slots' ? D.slice(0, need - S.length) : D)].flatMap((k) => k.def), [])
  }
  if (n.type === 'UNITS') return unitsFold(n, need, S, A, D, cnt, out, conv, inSlot)
  // rule 4b: which satisfied alternatives fill slots together (the first such set, in the order above)
  const fams = S.map((k) => k.spend)
  const m = mostTogether(fams, need)
  // the first set in that order: the smallest indices, compared one by one
  const first = packings(fams, m).sort((x, y) => { const i = x.pick.findIndex((v, j) => v !== y.pick[j]); return i < 0 ? 0 : x.pick[i] - y.pick[i] })[0]
  const chosen = new Set(first.pick.map((j) => S[j]))
  const defOf = (xs: Fold[]) => cnt.filter((k) => xs.includes(k)).flatMap((k) => k.def)
  if (m >= need) return out('S', defOf([...chosen]), [], inSlot ? smallest(packings(fams, need).map((p) => p.spend)) : [[]])
  // C: the most slots the alternatives that CC courses can meet could fill together, from the agreement alone
  const hyp = cnt.filter((k) => hypState(k.node) === 'S')
  const C = Math.max(m, mostTogether(hyp.map((k) => hypSpend(k.node)), need))
  const late = A.filter((k) => hypState(k.node) !== 'S')
  if (C + late.length + D.length < need) return out('O', defOf([...chosen]), cnt.filter((k) => k.state !== 'S').flatMap((k) => k.miss))
  const uc = Math.min(D.length, Math.max(0, need - C - late.length))
  const loose = S.length > chosen.size ? S : []
  if (m < C || late.length) {
    return out('O', [...defOf([...chosen]), ...(conv === 'slots' ? D.slice(0, uc) : []).flatMap((k) => k.def)],
      [...A.flatMap((k) => k.miss), ...loose.flatMap((k) => rowsWithGroups(k.node))], [], loose)
  }
  return out('D', [...defOf([...chosen]), ...(conv === 'slots' ? D.slice(0, need - m) : D).flatMap((k) => k.def)], [],
    inSlot ? smallest(packings(fams, m).map((p) => p.spend)) : [[]])
}

/** Units of the rows under a subtree: a positive number, else 0 (unknown: never counts); a repeated id counts its smallest. */
function unitsOf(n: Node): Map<string, number> {
  const m = new Map<string, number>()
  const walk = (x: Node): void => {
    if (x.kind !== 'req') return x.children.forEach(walk)
    const u = Number.isFinite(x.units) && x.units > 0 ? x.units : 0
    m.set(x.id, Math.min(m.get(x.id) ?? Infinity, u))
  }
  walk(n)
  return m
}

/**
 * Rule 4c, "N units from the following" (UNITS): rule 4b counted in units. The satisfied children taken (the first way,
 * in the order above, each child's heaviest ways first, to reach the most units up to N) must spend different ids;
 * their units are the units of the rows they spend. C: the most units the children CC courses can meet could reach.
 */
function unitsFold(n: ReqNode, need: number, S: Fold[], A: Fold[], D: Fold[], cnt: Fold[], out: (state: State, def: string[], miss: string[], spend?: string[][], loose?: Fold[]) => Fold, conv: DeferConvention, inSlot: boolean): Fold {
  const units = unitsOf(n)
  const weight = (w: string[]) => w.reduce((t, x) => t + (x.startsWith('row:') ? units.get(x.slice(4)) ?? 0 : 0), 0)
  /** Every assignment: which children, one way each, nothing spent twice, and their units. */
  const assignments = (fams: string[][][]) => {
    const out: { pick: number[]; spend: string[]; total: number }[] = []
    const go = (i: number, pick: number[], spend: string[], total: number): void => {
      if (i === fams.length) return void out.push({ pick, spend, total })
      for (const w of fams[i]) if (weight(w) > 0 && !w.some((x) => spend.includes(x))) go(i + 1, [...pick, i], [...spend, ...w], total + weight(w))
      go(i + 1, pick, spend, total)
    }
    go(0, [], [], 0)
    return out
  }
  const fams = S.map((k) => k.spend), every = assignments(fams)
  const top = Math.min(need, Math.max(0, ...every.map((x) => x.total)))
  // the children taken: in order, each that can still be in an assignment reaching `top`, until those taken reach it
  const taken: number[] = []
  const reaches = (must: number[], may: number[]) => every.some((x) => x.total >= top && must.every((j) => x.pick.includes(j)) && x.pick.every((j) => must.includes(j) || may.includes(j)))
  if (top > 0) for (let j = 0; j < fams.length; j++) {
    if (reaches(taken, [])) break
    if (reaches([...taken, j], fams.map((_, k) => k).filter((k) => k > j))) taken.push(j)
  }
  const m = top
  const chosen = taken.map((j) => S[j])
  const spend = inSlot ? smallest(every.filter((x) => x.total >= top && x.pick.length === taken.length && taken.every((j) => x.pick.includes(j))).map((x) => x.spend)) : [[]]
  const defOf = (xs: Fold[]) => cnt.filter((k) => xs.includes(k)).flatMap((k) => k.def)
  if (m >= need) {
    // for a slot above: every set reaching N that needs all its members (one way each, nothing spent twice)
    const all: string[][] = []
    const each = (i: number, picked: string[][], total: number): void => {
      if (total >= need) return void (picked.every((w) => total - weight(w) < need) && all.push(picked.flat()))
      if (i === fams.length) return
      for (const w of fams[i]) if (!w.some((x) => picked.flat().includes(x))) each(i + 1, [...picked, w], total + weight(w))
      each(i + 1, picked, total)
    }
    if (inSlot) each(0, [], 0)
    return out('S', defOf(chosen), [], inSlot ? smallest(all) : [[]])
  }
  const C = Math.max(m, Math.min(need, Math.max(0, ...assignments(cnt.filter((k) => hypState(k.node) === 'S').map((k) => hypSpend(k.node))).map((x) => x.total))))
  const late = A.filter((k) => hypState(k.node) !== 'S')
  // UC-only rows of the group itself make up the rest, each row once; a subtree passing through UC-only rows adds none
  const ucRows = [...new Set(D.flatMap((k) => (k.node.kind === 'req' ? [k.node.id] : [])))]
  const dU = ucRows.reduce((t, id) => t + (units.get(id) ?? 0), 0)
  if (C + dU < need) return out('O', defOf(chosen), cnt.filter((k) => k.state !== 'S').flatMap((k) => k.miss))
  // a satisfied child may still bring more units through another group: every one is named, and may be re-routed
  if (m < C || late.length) return out('O', defOf(chosen), [...A.flatMap((k) => k.miss), ...S.flatMap((k) => rowsWithGroups(k.node))], [], S)
  // UC-only children make up the rest ('slots': the first ones that do)
  const fill: Fold[] = []
  let u = m
  for (const k of D) {
    if (conv !== 'slots' || u >= need) break
    fill.push(k)
    if (k.node.kind === 'req') u += units.get(k.node.id) ?? 0
  }
  return out('D', [...defOf(chosen), ...(conv === 'slots' ? fill : D).flatMap((k) => k.def)], [], spend)
}

/** Rows with a CC group in a subtree (required paths only). */
const rowsWithGroups = (n: Node): string[] => n.kind === 'req' ? (n.groups.length ? [n.id] : [])
  : [...new Set(n.children.filter(counted).flatMap(rowsWithGroups))]

/** Every row with a CC group done (any group, any college), UC-only rows deferred, unrecorded rows open. */
const hypLeaf: Leaf = (r) => r.groups.length ? { state: 'S', spend: r.groups.map((g) => [...g.courses, token(r.id)]) }
  : { state: isUcOnly(r) ? 'D' : 'O', spend: [[]] }
const hypMemo = [new WeakMap<Node, Fold>(), new WeakMap<Node, Fold>()]
/** The fold with every CC row done; `spend` only when asked (it multiplies out every way of an AND). */
const hypFold = (n: Node, spend = false): Fold => {
  const memo = hypMemo[spend ? 1 : 0]
  let f = memo.get(n)
  if (!f) memo.set(n, (f = fold(n, hypLeaf, 'slots', spend)))
  return f
}
const hypState = (n: Node) => hypFold(n).state
const hypSpend = (n: Node) => hypFold(n, true).spend
/** Would the subtree pass if every row with a CC group were done (UC-only rows deferred, no-record rows open)? */
export function hasRoute(n: Node): boolean {
  return hypState(n) !== 'O'
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
  /** rows of satisfied alternatives, in a choice the root still needs, that could take another group so the choice's
   *  slots use different courses (rule 4b); a plan may have to complete one of them again */
  reroute: Set<string>
}

/** Rule 8. */
export function degenerate(root: ReqNode): boolean {
  if (!root.required) return false
  const req = (n: ReqNode) => n.children.filter((c) => c.kind === 'req' || c.required)
  const bad = (n: Node): boolean => n.kind !== 'req' && (
    (n.type === 'AND' && req(n).length === 0) || (n.type === 'N_OF' && !((n.n ?? 0) >= 1)) || req(n).some(bad))
  const anyRow = (n: Node): boolean => n.kind === 'req' || req(n).some(anyRow)
  return bad(root) || !anyRow(root)
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
  // rule 4b: a satisfied row spends, per complete group, the taken ids standing for its courses (the course itself
  // when taken, else its honors twin), and the row itself
  const root = fold(a.root, (r) => {
    const e = rowOf(r)
    if (!e.sat) return { state: e.ucOnly ? 'D' : 'O', spend: [[]] }
    const tw = twinColleges(r)
    return { state: 'S', spend: e.satGroups.map((g) => [...g.courses.map((c) => standsFor(c, taken, tw)[0]), token(r.id)]) }
  }, opts.defer ?? 'slots')
  const rootPass = root.state !== 'O'
  const needed = new Set<string>(), reroute = new Set<string>()
  const mark = (f: Fold) => {
    if (f.node.kind === 'req') return void needed.add(f.node.id)
    const and = f.node.type === 'AND'
    for (const k of f.loose) for (const id of rowsWithGroups(k.node)) reroute.add(id)
    for (const k of f.kids) if (counted(k.node) && k.state === 'O' && (and || hasRoute(k.node))) mark(k)
  }
  if (!rootPass) mark(root)
  const splits = new Set([...rows.values()].filter((e) => e.split).map((e) => e.req.id))
  const blocking = new Set([...splits].filter((id) => needed.has(id)))
  return {
    isValid: rootPass && blocking.size === 0 && !degenerate(a.root),
    rootPass, rows, needed, splits, blocking,
    satisfied: new Set([...rows.values()].filter((e) => e.sat).map((e) => e.req.id)),
    deferred: new Set(root.def),
    missing: new Set(rootPass || !a.root.required ? [] : root.miss),
    reroute,
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
