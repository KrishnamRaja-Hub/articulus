import type { Agreement, CourseGroup, CourseId, Partial, ReqNode, Requirement, ValidationResult, Violation } from './types'
import { isUcOnlyProof } from './normalize.ts'
import { assignSlots, crossWays, minimal, NOTHING, rowToken, unionsOf, type Way, type Ways } from './slots.ts'

export interface ReqStatus { satisfied?: CourseGroup; partials: Partial[] }

const stripH = (id: CourseId) => id.replace(/H$/, '')

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
/** A group some set of courses can complete: at least one course id. An empty `courses` is satisfied by nothing (M-2). */
const usable = (g: unknown): g is CourseGroup =>
  isObj(g) && Array.isArray(g.courses) && g.courses.length > 0 && g.courses.every((c) => typeof c === 'string')
/** The row's usable groups; a malformed row (no `groups` array, M-2) has none, so it never passes on CC courses. */
const groupsOf = (r: Requirement): CourseGroup[] => (Array.isArray(r.groups) ? r.groups.filter(usable) : [])

/**
 * ASSIST marks series where "Regular and honors courses may be combined": the same college lists a regular
 * group and an honors twin (MATH 1B+1C and MATH 1BH+1CH). Detect that shape instead of parsing the note.
 * Returns the colleges where the row has such a twin; only there are a course and its honors twin interchangeable.
 */
export const honorsColleges = (req: Requirement): ReadonlySet<number> => {
  const groups = groupsOf(req)
  const keys = groups.map((g) => `${g.institutionId}|${g.courses.map(stripH).sort().join('+')}`)
  return new Set(groups.filter((_, i) => keys.indexOf(keys[i]) !== i).map((g) => g.institutionId))
}

/** True if any college in the row has an honors twin. Pass `honorsColleges(req)` to `has` for the per-college rule. */
export const honorsMix = (req: Requirement) => honorsColleges(req).size > 0

/** `true`: honors swaps at every college; a set: only at those colleges; `false`: none. */
export type Mix = boolean | ReadonlySet<number>
const swaps = (c: CourseId, mix: Mix) => typeof mix === 'boolean' ? mix : mix.has(Number(c.slice(0, c.indexOf(':'))))

/** Membership check; under `mix`, a course and its honors twin at the same college are interchangeable. */
export const has = (taken: Set<CourseId>, c: CourseId, mix: Mix) =>
  taken.has(c) || (swaps(c, mix) && (taken.has(`${c}H`) || (c.endsWith('H') && taken.has(stripH(c)))))

/** The id actually in `taken` that stands for `c` (itself, or its honors twin under `mix`). */
const takenAs = (taken: Set<CourseId>, c: CourseId, mix: Mix) =>
  taken.has(c) ? c : !swaps(c, mix) ? undefined : taken.has(`${c}H`) ? `${c}H` : c.endsWith('H') && taken.has(stripH(c)) ? stripH(c) : undefined

/**
 * How a single requirement stands against the taken set.
 * `satisfied`: of the groups the taken set completes, the one closest to what the student took: fewest honors swaps,
 * then most courses taken exactly as listed, then ASSIST order. Always one of the row's own groups. So a student who took
 * MATH 1B + 1C is shown that group, not the honors twin ASSIST lists first (TESTER1 M-2). Whether the row is satisfied
 * does not depend on this choice.
 */
export function reqStatus(req: Requirement, taken: Set<CourseId>): ReqStatus {
  const best = new Map<number, Partial>() // one partial per college: its regular and honors groups overlap
  const mix = honorsColleges(req)
  let done: { g: CourseGroup; exact: number; swapped: number } | undefined
  for (const g of groupsOf(req)) {
    if (g.courses.every((c) => has(taken, c, mix))) {
      // fewest honors swaps first (groups can differ in length), then most courses taken as listed; ties keep ASSIST order
      const exact = g.courses.filter((c) => taken.has(c)).length, swapped = g.courses.length - exact
      if (!done || swapped < done.swapped || (swapped === done.swapped && exact > done.exact)) done = { g, exact, swapped }
      continue
    }
    if (done) continue // partials are reported only for an unsatisfied row
    // Report the courses the student actually took, not the honors twin that matched them.
    const have = [...new Set(g.courses.map((c) => takenAs(taken, c, mix)).filter((c): c is CourseId => !!c))]
    const prev = best.get(g.institutionId)
    const missing = g.courses.filter((c) => !has(taken, c, mix))
    const honors = (m: CourseId[]) => m.filter((c) => c.endsWith('H')).length
    // most progress wins; on a tie, prefer asking for the regular course over its honors twin
    if (have.length && (!prev || have.length > prev.have.length || (have.length === prev.have.length && honors(missing) < honors(prev.missing))))
      best.set(g.institutionId, { institutionId: g.institutionId, have, missing })
  }
  if (done) return { satisfied: done.g, partials: [] }
  return { partials: [...best.values()] }
}

/**
 * Split = pieces of the series at two colleges. The same course repeated at two colleges is a duplicate, not a split;
 * MATH 1BH at one and MATH 1B at another is the same course too.
 */
const code = (id: CourseId) => stripH(id.slice(id.indexOf(':') + 1))
const isSplit = (p: Partial[]) =>
  new Set(p.map((x) => x.institutionId)).size > 1 && new Set(p.flatMap((x) => x.have.map(code))).size > 1

/**
 * Leaf and node states. `sat`: done with CC courses (possibly with some rows left for the university). `def`: passes
 * only because no sending college articulates what is left (ASSIST "no course articulated": taken at the UC after
 * transfer). `open`: the student still needs CC courses.
 */
type St = 'sat' | 'def' | 'open'
/** A row's state and, when `track` asks for them, the ways it is met (slots.ts): what filling a slot with it spends. */
interface Leaf { st: St; uses: Ways }
type LeafFn = (r: Requirement, track: boolean) => Leaf
/**
 * Inside a slot of a "choose several" group: the ids worth keeping in a way, those that can clash with another slot
 * (they belong to another alternative of an enclosing group). Dropping the rest changes no assignment and keeps the
 * number of ways small. null: not in a slot.
 */
type Keep = ((x: string) => boolean) | null
const uniMemo = new WeakMap<object, Set<string>>()
/** Every id a subtree could ever spend: its courses with their honors twins, and its rows' tokens. */
const universe = (n: ReqNode | Requirement): Set<string> => {
  if (!isObj(n)) return new Set()
  let u = uniMemo.get(n)
  if (!u) {
    u = new Set()
    uniMemo.set(n, u)
    if (n.kind === 'req') {
      u.add(rowToken(n.id))
      for (const g of groupsOf(n)) for (const c of g.courses) u.add(c).add(`${c}H`).add(stripH(c))
    } else for (const c of Array.isArray(n.children) ? n.children : []) for (const x of universe(c)) u.add(x)
  }
  return u
}
/** For each child of a "choose several" group: keep what the parent keeps and whatever another child could spend. */
const keepsFor = (kids: (ReqNode | Requirement)[], keep: Keep): ((x: string) => boolean)[] => {
  const us = kids.map(universe), count = new Map<string, number>()
  for (const u of us) for (const x of u) count.set(x, (count.get(x) ?? 0) + 1)
  return us.map((u) => (x: string) => (count.get(x) ?? 0) - (u.has(x) ? 1 : 0) > 0 || (!!keep && keep(x)))
}
const keepOnly = (ways: Ways, keep: (x: string) => boolean) => minimal(ways.map((w) => w.filter(keep)))
/** art: canRoute — CC courses (plus UC-only rows) could make it pass. miss: what it still needs. def: UC-only rows it
 *  relies on. uses: the ways it passes (tracked subtrees only; NOTHING elsewhere; [] when it does not pass). */
interface Res { st: St; art: boolean; miss: string[]; def: string[]; kids: Res[]; node: ReqNode | Requirement; uses: Ways }

const passes = (r: Res) => r.st !== 'open'
/** Required children only: optional (recommended) subtrees never fail, satisfy, or defer anything for their parent. */
// A `required` that is not `false` counts (M-2: fail closed; malformed() reports the non-boolean).
const counted = (r: Res) => !isObj(r.node) || r.node.kind === 'req' || r.node.required !== false
const countedNode = (c: unknown) => isObj(c) && (c.kind === 'req' || c.required !== false)
const uniq = (ids: string[]) => [...new Set(ids)]
/** The rows with CC groups under a subtree: how a satisfied alternative whose courses already fill another slot is named. */
const rowsOf = (n: ReqNode | Requirement): string[] => !isObj(n) ? []
  : n.kind === 'req' ? (groupsOf(n).length ? [n.id] : [])
  : uniq((Array.isArray(n.children) ? n.children : []).filter(countedNode).flatMap(rowsOf))
/** What an alternative still lacks, by row. */
const lacks = (r: Res) => (r.st === 'sat' ? rowsOf(r.node) : r.miss)
// "(B + C)" names an alternative by what it still lacks; a UC-only one (listed only when a node cannot be met) by its rows
const alt = (rs: Res[]) => rs.map((r) => {
  const m = r.st === 'sat' ? rowsOf(r.node) : r.miss.length ? r.miss : r.def
  return m.length > 1 ? `(${m.join(' + ')})` : m[0]
}).join(', ')
const needOf = (n: ReqNode) => (n.type === 'OR' ? 1 : (n.n ?? 1))
/** A "choose N" group whose slots must use different courses: N_OF with N of 2 or more (M-4). */
export const slotted = (n: ReqNode) => n.type === 'N_OF' && needOf(n) >= 2

/**
 * Fold one subtree; `leaf` decides each row. Children are all evaluated, so optional rows are still reported. `keep`:
 * the subtree fills a slot of a "choose several" group above it, so the ways it passes are kept (slots.ts), with only
 * the ids that can clash.
 *
 * OR / N_OF(n), with S the satisfied alternatives, A the open ones with a CC route and D the UC-only ones:
 * - One course, one slot (M-4): the slots S can fill together, m, is an exact assignment (assignSlots), preferring the
 *   alternatives that leave least for the university. m >= n: satisfied.
 * - The CC route is owed first: UC-only rows fill only the slots CC courses cannot. For n >= 2 those are counted from
 *   the agreement alone: C, the most slots its CC alternatives can fill together (capOf). While m < C, or an open
 *   alternative can only ever pass through UC-only rows (it is owed like any other), the group stays open; otherwise it
 *   passes with UC-only rows deferred, if there are enough of them. With no course shared between alternatives this is
 *   exactly the earlier count rule (s >= n satisfied; s + a + d < n cannot be met; a > 0 owed first).
 */
function fold(n: ReqNode | Requirement, leaf: LeafFn, keep: Keep = null): Res {
  const track = !!keep
  // not a node or row at all (M-2): never passes; malformed() reports it
  if (!isObj(n)) return { st: 'open', art: false, miss: [], def: [], kids: [], node: n, uses: [] }
  if (n.kind === 'req') {
    const l = leaf(n, track)
    return { st: l.st, art: canRoute(n), miss: l.st === 'open' ? [n.id] : [], def: l.st === 'def' ? [n.id] : [], kids: [], node: n,
      uses: l.st === 'open' ? [] : keep && l.st === 'sat' ? keepOnly(l.uses, keep) : NOTHING }
  }
  const slots = slotted(n)
  const all = Array.isArray(n.children) ? n.children : [], keeps = slots ? keepsFor(all, keep) : null
  const kids = all.map((c, j) => fold(c, leaf, keeps ? keeps[j] : keep))
  const req = kids.filter(counted)
  const sat = req.filter((r) => r.st === 'sat')
  const inOrder = (s: Set<Res>) => req.filter((r) => s.has(r)).flatMap((r) => r.def)
  const res = (st: St, miss: string[], def: string[], uses: Ways = NOTHING): Res =>
    ({ st, art: canRoute(n), miss, def, kids, node: n, uses: st === 'open' ? [] : uses })

  if (n.type === 'AND') {
    const open = req.filter((r) => !passes(r))
    const def = req.flatMap((r) => r.def) // an open child still commits its own deferrals
    const st: St = open.length ? 'open' : sat.length || !req.length ? 'sat' : 'def'
    return res(st, open.flatMap((r) => r.miss), def, track && st !== 'open' ? crossWays(req.map((r) => r.uses)) : NOTHING)
  }
  // an unknown type ('and', undefined, ...) is not read as choose-1 (M-2): it never passes; malformed() reports it
  if (n.type !== 'OR' && n.type !== 'N_OF') return res('open', req.flatMap((r) => r.miss), [])
  const need = needOf(n)
  // a: still open but reachable with CC courses; d: passes only as UC-only. A row ASSIST never mentions is neither.
  const a = req.filter((r) => r.st === 'open' && r.art), d = req.filter((r) => r.st === 'def')
  // among satisfied alternatives, rely on the ones that leave the least for the university (stable)
  const S = [...sat].sort((x, y) => x.def.length - y.def.length)
  const pick = (rs: Res[], left: number) => (left === rs.length ? rs.flatMap(lacks) : [`${n.type === 'OR' ? 'One' : left} of: ${alt(rs)}`])
  const rest = req.filter((r) => r.st !== 'sat')
  if (!slots) {
    // one slot (or a malformed count): any satisfied alternative fills it, nothing to share
    if (sat.length >= need) return res('sat', [], inOrder(new Set(S.slice(0, Math.max(0, need)))), track ? minimal(S.flatMap((r) => r.uses)) : NOTHING)
    if (sat.length + a.length + d.length < need) return res('open', pick(rest, need - sat.length), inOrder(new Set(sat))) // cannot be met
    // UC-only rows fill only the slots CC routes cannot: while any CC alternative is open, it is owed first.
    const uc = Math.min(d.length, Math.max(0, need - sat.length - a.length))
    if (a.length) return res('open', pick(a, need - sat.length - uc), inOrder(new Set(sat)))
    return res('def', [], inOrder(new Set([...sat, ...d])))
  }
  const fit = assignSlots(S.map((r) => r.uses), need)
  const chosen = new Set(fit.pick.map((i) => S[i])), m = chosen.size
  if (m >= need) return res('sat', [], inOrder(chosen), keep ? keepOnly(unionsOf(S.map((r) => r.uses), need), keep) : NOTHING)
  const C = Math.max(m, capOf(n))
  // open alternatives that can only ever pass through UC-only rows: owed like any other CC alternative
  const late = a.filter((r) => hypState(r.node) !== 'sat')
  if (C + late.length + d.length < need) return res('open', pick(rest, need - m), inOrder(chosen)) // cannot be met
  const uc = Math.min(d.length, Math.max(0, need - C - late.length))
  // Satisfied alternatives left out share courses with the chosen ones; while any is, another group of any satisfied
  // alternative may free a slot, so all of them are named ("1 of: A, B").
  const loose = S.some((r) => !chosen.has(r))
  const owed = req.filter((r) => a.includes(r) || (loose && r.st === 'sat'))
  if (m < C || late.length) return res('open', pick(owed, need - m - uc), inOrder(chosen))
  return res('def', [], inOrder(new Set([...chosen, ...d])), keep ? keepOnly(unionsOf(S.map((r) => r.uses), m), keep) : NOTHING)
}

/**
 * UC-only: no CC group anywhere in the agreement AND ASSIST itself says so for at least one college, in one of the
 * allowlisted reasons (isUcOnlyProof, round 7 M-1). A row merely absent from the payloads (NOT_LISTED), or with any
 * other stored value ("Course(s) Denied", "Pending", blank, null, a new wording), is not proof: it stays open so the
 * student is sent to a counselor rather than told to take it at the university.
 */
export const ucOnly = (r: Requirement) =>
  Array.isArray(r.groups) && r.groups.length === 0 && isObj(r.noArticulation) && Object.values(r.noArticulation).some(isUcOnlyProof)

/** Every CC row done (any group at any college), UC-only rows left for the university. */
const hypLeaf: LeafFn = (r) => {
  const gs = groupsOf(r)
  if (gs.length) return { st: 'sat', uses: minimal(gs.map((g) => [...g.courses, rowToken(r.id)])) }
  return ucOnly(r) ? { st: 'def', uses: NOTHING } : { st: 'open', uses: [] }
}
const hypMemo = new WeakMap<object, St>()
/** How a subtree stands once every CC row is done: 'sat' it can be met with CC courses, 'def' only through UC-only rows. */
export function hypState(n: ReqNode | Requirement): St {
  if (!isObj(n)) return 'open'
  if (n.kind === 'req') return hypLeaf(n, false).st
  let v = hypMemo.get(n)
  if (v === undefined) {
    hypMemo.set(n, 'open') // the fold asks for n's own art, which this pass discards; guard the recursion
    hypMemo.set(n, (v = fold(n, hypLeaf).st))
  }
  return v
}
/** The ways a subtree can be met once every CC row is done (its groups as listed), keeping only `keep`'s ids. */
const hypUses = (n: ReqNode | Requirement, keep: (x: string) => boolean): Ways => fold(n, hypLeaf, keep).uses
const capMemo = new WeakMap<ReqNode, number>()
/**
 * C of a "choose several" group (M-4): the most slots its required alternatives that CC courses can meet can fill
 * together, each with courses of its own (at most N). It depends only on the agreement.
 */
export function capOf(n: ReqNode): number {
  let v = capMemo.get(n)
  if (v === undefined) {
    const all = Array.isArray(n.children) ? n.children : [], keeps = keepsFor(all, null)
    const hs = all.flatMap((c, j) => (countedNode(c) && hypState(c) === 'sat' ? [hypUses(c, keeps[j])] : []))
    capMemo.set(n, (v = assignSlots(hs, needOf(n)).pick.length))
  }
  return v
}

/** True iff taking the CC courses the agreement lists (leaving UC-only rows for the university) would make it pass. */
export function canRoute(n: ReqNode | Requirement): boolean {
  if (!isObj(n)) return false
  if (n.kind === 'req') return groupsOf(n).length > 0 || ucOnly(n)
  return hypState(n) !== 'open'
}

const deferrable = new WeakMap<ReqNode | Requirement, boolean>()
/**
 * True iff no CC route exists for this subtree: it passes with nothing taken, so every row it still needs is one
 * no sending college articulates. Optional children are ignored; the node's own `required` flag is not consulted.
 */
export function isDeferrable(n: ReqNode | Requirement): boolean {
  if (!isObj(n)) return false
  if (n.kind === 'req') return ucOnly(n)
  let v = deferrable.get(n)
  if (v === undefined) deferrable.set(n, (v = passes(fold(n, (r) => (ucOnly(r) ? { st: 'def', uses: NOTHING } : { st: 'open', uses: [] })))))
  return v
}

/**
 * The ways `taken` meets a row: per satisfied group, the taken ids standing for its courses (an honors twin where the
 * row mixes) and the row's token. Empty when the row is not satisfied.
 */
export function rowUses(req: Requirement, taken: Set<CourseId>): string[][] {
  const mix = honorsColleges(req), t = rowToken(req.id)
  return minimal(groupsOf(req).filter((g) => g.courses.every((c) => has(taken, c, mix))).map((g) => [...g.courses.map((c) => takenAs(taken, c, mix)!), t]))
}

const doneLeaf = (done: (r: Requirement) => boolean | Ways): LeafFn => (r) => {
  const u = done(r)
  if (u === true) return { st: 'sat', uses: [[rowToken(r.id)]] }
  if (u && u.length) return { st: 'sat', uses: u }
  return ucOnly(r) ? { st: 'def', uses: NOTHING } : { st: 'open', uses: [] }
}
/**
 * The tree's state under verify's rules (M-4 included), for the planner. `done(r)`: the row's ways (rowUses), `true`
 * for a row taken as done with nothing known of its courses (only its row token is spent), false or [] when not done.
 */
export function treeStatus(n: ReqNode | Requirement, done: (r: Requirement) => boolean | Ways): St {
  return fold(n, doneLeaf(done)).st
}

/** For the planner's fallback: the required alternatives of an OR / N_OF that fill its slots now, and the ways they spend. */
export function slotFill(n: ReqNode, done: (r: Requirement) => boolean | Ways): { kids: (ReqNode | Requirement)[]; ways: Way[] } {
  const all = Array.isArray(n.children) ? n.children : [], keeps = keepsFor(all, null)
  const S = all.flatMap((c, j) => (countedNode(c) ? [{ c, r: fold(c, doneLeaf(done), keeps[j]) }] : []))
    .filter((x) => x.r.st === 'sat').sort((x, y) => x.r.def.length - y.r.def.length)
  const fit = assignSlots(S.map((x) => x.r.uses), Math.max(0, needOf(n)))
  return { kids: fit.pick.map((i) => S[i].c), ways: fit.ways }
}

/** Splits the plan depends on; the others are warnings (those courses earn no credit toward that row). */
export function blockingSplits(r: ValidationResult): Violation[] {
  return r.splitSeriesViolations.filter((v) => v.blocking)
}

/**
 * Why the tree is malformed or degenerate, or null. verifySchedule fails closed on every one of these, so a data-gate
 * bypass can never show green; the gate rejects them too (tree.schema, group.schema, tree.empty, tree.empty-node,
 * tree.n-of, tree.no-required, tree.no-required-children).
 * - Schema (round 7 M-2), anywhere in the tree, optional subtrees included: a node that is not { kind: "node", type:
 *   AND|OR|N_OF, required: boolean, children: [] } (the fold would otherwise read an unknown type as choose-1 and a
 *   missing `required` as optional), or a row with no `groups` array or a group with no course ids (an empty group is
 *   satisfied by nothing). The fold itself never throws on these and reads them as unmet.
 * - Degenerate (TESTER2 M-3), only through required nodes (optional subtrees never decide a verdict): the fold reads a
 *   required AND with no required child, and an N_OF asking for fewer than 1, as met with nothing taken; a tree with no
 *   required row at all is met the same way. (An OR or N_OF with no required child already stays open.)
 */
export function malformed(root: ReqNode): string | null {
  let rows = 0, schema: string | null = null, why: string | null = null
  const seen = new Set<unknown>()
  const check = (n: unknown, path: string): void => {
    if (!isObj(n)) return void (schema ??= `${path} is not a node or requirement`)
    if (seen.has(n)) return
    seen.add(n)
    if (n.kind === 'req') {
      const id = typeof n.id === 'string' && n.id ? n.id : path
      if (typeof n.id !== 'string' || !n.id) schema ??= `${path}: requirement has no id`
      if (!Array.isArray(n.groups)) schema ??= `${id} has no course groups`
      else if (!n.groups.every(usable)) schema ??= `${id} has a course group with no courses`
      return
    }
    const name = typeof n.title === 'string' && n.title ? `"${n.title}"` : path
    if (n.kind !== 'node') schema ??= `${name} is neither a node nor a requirement (kind ${JSON.stringify(n.kind)})`
    if (n.type !== 'AND' && n.type !== 'OR' && n.type !== 'N_OF') schema ??= `${name} has unknown type ${JSON.stringify(n.type)}`
    if (typeof n.required !== 'boolean') schema ??= `${name} has no required flag`
    if (!Array.isArray(n.children)) return void (schema ??= `${name} has no children`)
    n.children.forEach((c, i) => check(c, `${path}/${i}`))
  }
  check(root, 'root')
  if (schema) return schema
  const walk = (n: ReqNode | Requirement) => {
    if (n.kind === 'req') return void rows++
    const req = n.children.filter((c) => c.kind === 'req' || c.required)
    const name = n.title ? `"${n.title}"` : `${n.type} group`
    if (n.type === 'AND' && !req.length) why ??= `${name} has no required rows`
    if (n.type === 'N_OF' && !(Number.isInteger(n.n) && n.n! >= 1)) why ??= `${name} asks for ${n.n} of ${req.length}`
    req.forEach(walk)
  }
  if (root.required) walk(root)
  return why ?? (rows ? null : 'the requirement tree has no required rows')
}

/** Evaluate every requirement, then fold the tree. */
export function verifySchedule(taken: Set<CourseId>, agreement: Agreement): ValidationResult {
  const out: ValidationResult = { isValid: true, satisfied: {}, missing: [], incomplete: {}, splitSeriesViolations: [], deferred: [] }
  const seen = new Set<string>()

  const leaf: LeafFn = (req, track) => {
    const st = reqStatus(req, taken)
    if (!seen.has(req.id)) {
      seen.add(req.id)
      if (st.satisfied) out.satisfied[req.id] = st.satisfied
      else if (isSplit(st.partials)) out.splitSeriesViolations.push({ requirementId: req.id, label: req.label, partials: st.partials, blocking: false })
      else if (st.partials.length) out.incomplete[req.id] = st.partials.sort((a, b) => b.have.length - a.have.length)[0]
    }
    if (st.satisfied) return { st: 'sat', uses: track ? rowUses(req, taken) : NOTHING }
    return ucOnly(req) ? { st: 'def', uses: NOTHING } : { st: 'open', uses: [] }
  }
  const root = fold(agreement.root, leaf)

  // Needed rows, top down from a failing root: AND needs every failing child, OR / N_OF every failing CC alternative.
  const needed = new Set<string>()
  const mark = (r: Res) => {
    if (!isObj(r.node)) return
    if (r.node.kind === 'req') return void needed.add(r.node.id)
    const and = r.node.type === 'AND'
    for (const k of r.kids) if (counted(k) && !passes(k) && (and || k.art)) mark(k)
  }
  if (!passes(root)) mark(root)
  for (const v of out.splitSeriesViolations) v.blocking = needed.has(v.requirementId)

  if (!passes(root) && agreement.root?.required !== false) out.missing = root.miss
  out.deferred = uniq(root.def)
  out.isValid = passes(root) && !out.splitSeriesViolations.some((v) => v.blocking)
  const bad = malformed(agreement.root)
  if (bad) { out.isValid = false; out.missing = [...out.missing, `Agreement data is malformed (${bad}); check ASSIST`] }
  return out
}