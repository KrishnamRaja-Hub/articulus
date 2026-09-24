import type { Agreement, CourseGroup, CourseId, Partial, ReqNode, Requirement, ValidationResult, Violation } from './types'
import { NOT_LISTED } from './normalize.ts'

export interface ReqStatus { satisfied?: CourseGroup; partials: Partial[] }

const stripH = (id: CourseId) => id.replace(/H$/, '')

/**
 * ASSIST marks series where "Regular and honors courses may be combined": the same college lists a regular
 * group and an honors twin (MATH 1B+1C and MATH 1BH+1CH). Detect that shape instead of parsing the note.
 * Returns the colleges where the row has such a twin; only there are a course and its honors twin interchangeable.
 */
export const honorsColleges = (req: Requirement): ReadonlySet<number> => {
  const keys = req.groups.map((g) => `${g.institutionId}|${g.courses.map(stripH).sort().join('+')}`)
  return new Set(req.groups.filter((_, i) => keys.indexOf(keys[i]) !== i).map((g) => g.institutionId))
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

/** How a single requirement stands against the taken set. */
export function reqStatus(req: Requirement, taken: Set<CourseId>): ReqStatus {
  const best = new Map<number, Partial>() // one partial per college: its regular and honors groups overlap
  const mix = honorsColleges(req)
  for (const g of req.groups) {
    // Report the courses the student actually took, not the honors twin that matched them.
    const have = [...new Set(g.courses.map((c) => takenAs(taken, c, mix)).filter((c): c is CourseId => !!c))]
    if (g.courses.every((c) => has(taken, c, mix))) return { satisfied: g, partials: [] }
    const prev = best.get(g.institutionId)
    const missing = g.courses.filter((c) => !has(taken, c, mix))
    const honors = (m: CourseId[]) => m.filter((c) => c.endsWith('H')).length
    // most progress wins; on a tie, prefer asking for the regular course over its honors twin
    if (have.length && (!prev || have.length > prev.have.length || (have.length === prev.have.length && honors(missing) < honors(prev.missing))))
      best.set(g.institutionId, { institutionId: g.institutionId, have, missing })
  }
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
/** art: canRoute — CC courses (plus UC-only rows) could make it pass. miss: what it still needs. def: UC-only rows it relies on. */
interface Res { st: St; art: boolean; miss: string[]; def: string[]; kids: Res[]; node: ReqNode | Requirement }

const passes = (r: Res) => r.st !== 'open'
/** Required children only: optional (recommended) subtrees never fail, satisfy, or defer anything for their parent. */
const counted = (r: Res) => r.node.kind === 'req' || r.node.required
const uniq = (ids: string[]) => [...new Set(ids)]
// "(B + C)" names an alternative by what it still lacks; a UC-only one (listed only when a node cannot be met) by its rows
const alt = (rs: Res[]) => rs.map((r) => {
  const m = r.miss.length ? r.miss : r.def
  return m.length > 1 ? `(${m.join(' + ')})` : m[0]
}).join(', ')

/**
 * Fold one subtree; `leafSt` decides each row. Children are all evaluated, so optional rows are still reported.
 */
function fold(n: ReqNode | Requirement, leafSt: (r: Requirement) => St): Res {
  if (n.kind === 'req') {
    const st = leafSt(n)
    return { st, art: canRoute(n), miss: st === 'open' ? [n.id] : [], def: st === 'def' ? [n.id] : [], kids: [], node: n }
  }
  const kids = n.children.map((c) => fold(c, leafSt))
  const req = kids.filter(counted)
  const sat = req.filter((r) => r.st === 'sat')
  // among satisfied alternatives, rely on the ones that leave the least for the university (stable)
  const fewest = (k: number) => new Set([...sat].sort((x, y) => x.def.length - y.def.length).slice(0, k))
  const inOrder = (s: Set<Res>) => req.filter((r) => s.has(r)).flatMap((r) => r.def)
  const res = (st: St, miss: string[], def: string[]): Res =>
    ({ st, art: canRoute(n), miss, def, kids, node: n })

  if (n.type === 'AND') {
    const open = req.filter((r) => !passes(r))
    const def = req.flatMap((r) => r.def) // an open child still commits its own deferrals
    return res(open.length ? 'open' : sat.length || !req.length ? 'sat' : 'def', open.flatMap((r) => r.miss), def)
  }
  const need = n.type === 'OR' ? 1 : (n.n ?? 1)
  // a: still open but reachable with CC courses; d: passes only as UC-only. A row ASSIST never mentions is neither.
  const a = req.filter((r) => r.st === 'open' && r.art), d = req.filter((r) => r.st === 'def')
  if (sat.length >= need) return res('sat', [], inOrder(fewest(need)))
  const pick = (rs: Res[], left: number) => (left === rs.length ? rs.flatMap((r) => r.miss) : [`${n.type === 'OR' ? 'One' : left} of: ${alt(rs)}`])
  // UC-only rows fill only the slots CC routes cannot: while any CC alternative is open, it is owed first.
  const rest = req.filter((r) => r.st !== 'sat')
  if (sat.length + a.length + d.length < need) return res('open', pick(rest, need - sat.length), inOrder(new Set(sat))) // cannot be met
  const slots = Math.min(d.length, Math.max(0, need - sat.length - a.length))
  if (a.length) return res('open', pick(a, need - sat.length - slots), inOrder(new Set(sat)))
  return res('def', [], inOrder(new Set([...sat, ...d])))
}

/**
 * UC-only: no CC group anywhere in the agreement AND ASSIST itself says so for at least one college. A row that is
 * merely absent from the payloads (NOT_LISTED) is not proof; it stays open so the student is sent to a counselor
 * rather than told to take it at the university.
 */
export const ucOnly = (r: Requirement) =>
  r.groups.length === 0 && Object.values(r.noArticulation ?? {}).some((why) => why !== NOT_LISTED)

const routable = new WeakMap<ReqNode | Requirement, boolean>()
/** True iff taking the CC courses the agreement lists (leaving UC-only rows for the university) would make it pass. */
export function canRoute(n: ReqNode | Requirement): boolean {
  if (n.kind === 'req') return n.groups.length > 0 || ucOnly(n)
  let v = routable.get(n)
  if (v === undefined) {
    routable.set(n, false) // the fold asks for n's own art, which this pass discards; guard the recursion
    routable.set(n, (v = passes(fold(n, (r) => (r.groups.length ? 'sat' : ucOnly(r) ? 'def' : 'open')))))
  }
  return v
}

const deferrable = new WeakMap<ReqNode | Requirement, boolean>()
/**
 * True iff no CC route exists for this subtree: it passes with nothing taken, so every row it still needs is one
 * no sending college articulates. Optional children are ignored; the node's own `required` flag is not consulted.
 */
export function isDeferrable(n: ReqNode | Requirement): boolean {
  if (n.kind === 'req') return ucOnly(n)
  let v = deferrable.get(n)
  if (v === undefined) deferrable.set(n, (v = passes(fold(n, (r) => (ucOnly(r) ? 'def' : 'open')))))
  return v
}

/** Splits the plan depends on; the others are warnings (those courses earn no credit toward that row). */
export function blockingSplits(r: ValidationResult): Violation[] {
  return r.splitSeriesViolations.filter((v) => v.blocking)
}

/** Evaluate every requirement, then fold the tree. */
export function verifySchedule(taken: Set<CourseId>, agreement: Agreement): ValidationResult {
  const out: ValidationResult = { isValid: true, satisfied: {}, missing: [], incomplete: {}, splitSeriesViolations: [], deferred: [] }
  const seen = new Set<string>()

  const leafSt = (req: Requirement): St => {
    const st = reqStatus(req, taken)
    if (!seen.has(req.id)) {
      seen.add(req.id)
      if (st.satisfied) out.satisfied[req.id] = st.satisfied
      else if (isSplit(st.partials)) out.splitSeriesViolations.push({ requirementId: req.id, label: req.label, partials: st.partials, blocking: false })
      else if (st.partials.length) out.incomplete[req.id] = st.partials.sort((a, b) => b.have.length - a.have.length)[0]
    }
    return st.satisfied ? 'sat' : ucOnly(req) ? 'def' : 'open'
  }
  const root = fold(agreement.root, leafSt)

  // Needed rows, top down from a failing root: AND needs every failing child, OR / N_OF every failing CC alternative.
  const needed = new Set<string>()
  const mark = (r: Res) => {
    if (r.node.kind === 'req') return void needed.add(r.node.id)
    const and = r.node.type === 'AND'
    for (const k of r.kids) if (counted(k) && !passes(k) && (and || k.art)) mark(k)
  }
  if (!passes(root)) mark(root)
  for (const v of out.splitSeriesViolations) v.blocking = needed.has(v.requirementId)

  if (!passes(root) && agreement.root.required) out.missing = root.miss
  out.deferred = uniq(root.def)
  out.isValid = passes(root) && !out.splitSeriesViolations.some((v) => v.blocking)
  return out
}
