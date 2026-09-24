import type { Agreement, CourseGroup, CourseId, Partial, ReqNode, Requirement, ValidationResult } from './types'

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

/** Evaluate every requirement, then fold the boolean tree. */
export function verifySchedule(taken: Set<CourseId>, agreement: Agreement): ValidationResult {
  const out: ValidationResult = { isValid: true, satisfied: {}, missing: [], incomplete: {}, splitSeriesViolations: [], deferred: [] }
  const seen = new Set<string>()

  const leaf = (req: Requirement): boolean => {
    const st = reqStatus(req, taken)
    if (!seen.has(req.id)) {
      seen.add(req.id)
      if (st.satisfied) out.satisfied[req.id] = st.satisfied
      else if (isSplit(st.partials)) out.splitSeriesViolations.push({ requirementId: req.id, label: req.label, partials: st.partials, blocking: true })
      else if (st.partials.length) out.incomplete[req.id] = st.partials.sort((a, b) => b.have.length - a.have.length)[0]
    }
    return !!st.satisfied
  }

  /** Evaluates a subtree; `miss` says what it still needs: failed rows of an AND, one entry per OR / N_OF. */
  const node = (n: ReqNode): { ok: boolean; miss: string[] } => {
    // Optional (recommended) subtrees are evaluated for reporting but never fail their parent.
    const rs = n.children.map((c) => {
      if (c.kind === 'req') return { ok: leaf(c), miss: [c.id] }
      const r = node(c)
      return { ok: r.ok || !c.required, miss: r.miss }
    })
    const done = rs.filter((r) => r.ok).length
    const need = n.type === 'AND' ? rs.length : n.type === 'OR' ? 1 : (n.n ?? 1)
    const ok = done >= need
    const open = rs.filter((r) => !r.ok)
    // An alternative is named by what it still lacks, e.g. "(MATH 20B + MATH 20C)".
    const miss = ok ? [] : n.type === 'AND' ? open.flatMap((r) => r.miss)
      : [`${n.type === 'OR' ? 'One' : need - done} of: ${open.map((r) => (r.miss.length > 1 ? `(${r.miss.join(' + ')})` : r.miss[0])).join(', ')}`]
    return { ok, miss }
  }

  const root = node(agreement.root)
  if (!root.ok && agreement.root.required) out.missing = root.miss
  // Split-series is always fatal, even if the tree happens to be satisfiable another way.
  out.isValid = root.ok && out.splitSeriesViolations.length === 0
  return out
}
