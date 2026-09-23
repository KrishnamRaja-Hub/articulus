import type { Agreement, CourseGroup, CourseId, Partial, ReqNode, Requirement, ValidationResult } from './types'

export interface ReqStatus { satisfied?: CourseGroup; partials: Partial[] }

const stripH = (id: CourseId) => id.replace(/H$/, '')

/**
 * ASSIST marks series where "Regular and honors courses may be combined": the same college lists a regular
 * group and an honors twin (MATH 1B+1C and MATH 1BH+1CH). Detect that shape instead of parsing the note.
 */
export const honorsMix = (req: Requirement) => {
  const keys = req.groups.map((g) => `${g.institutionId}|${g.courses.map(stripH).sort().join('+')}`)
  return keys.some((k, i) => keys.indexOf(k) !== i)
}

/** Membership check; with honorsMix, a course and its honors twin at the same college are interchangeable. */
export const has = (taken: Set<CourseId>, c: CourseId, mix: boolean) =>
  taken.has(c) || (mix && (taken.has(`${c}H`) || (c.endsWith('H') && taken.has(stripH(c)))))

/** How a single requirement stands against the taken set. */
export function reqStatus(req: Requirement, taken: Set<CourseId>): ReqStatus {
  const partials: Partial[] = []
  const mix = honorsMix(req)
  for (const g of req.groups) {
    const have = g.courses.filter((c) => has(taken, c, mix))
    if (have.length === g.courses.length) return { satisfied: g, partials: [] }
    if (have.length) partials.push({ institutionId: g.institutionId, have, missing: g.courses.filter((c) => !has(taken, c, mix)) })
  }
  return { partials }
}

/** Split = pieces of the series at two colleges. The same course repeated at two colleges is a duplicate, not a split. */
const code = (id: CourseId) => id.slice(id.indexOf(':') + 1)
const isSplit = (p: Partial[]) =>
  new Set(p.map((x) => x.institutionId)).size > 1 && new Set(p.flatMap((x) => x.have.map(code))).size > 1

/** Evaluate every requirement, then fold the boolean tree. */
export function verifySchedule(taken: Set<CourseId>, agreement: Agreement): ValidationResult {
  const out: ValidationResult = { isValid: true, satisfied: {}, missing: [], incomplete: {}, splitSeriesViolations: [] }
  const seen = new Set<string>()

  const leaf = (req: Requirement): boolean => {
    const st = reqStatus(req, taken)
    if (!seen.has(req.id)) {
      seen.add(req.id)
      if (st.satisfied) out.satisfied[req.id] = st.satisfied
      else if (isSplit(st.partials)) out.splitSeriesViolations.push({ requirementId: req.id, label: req.label, partials: st.partials })
      else if (st.partials.length) out.incomplete[req.id] = st.partials.sort((a, b) => b.have.length - a.have.length)[0]
    }
    return !!st.satisfied
  }

  const node = (n: ReqNode): boolean => {
    // Optional (recommended) subtrees are evaluated for reporting but never fail their parent.
    const results = n.children.map((c) => (c.kind === 'req' ? leaf(c) : node(c) || !c.required))
    const ok = n.type === 'AND' ? results.every(Boolean)
      : n.type === 'OR' ? results.some(Boolean)
      : results.filter(Boolean).length >= (n.n ?? 1)
    if (!ok && n.required) {
      if (n.type === 'AND') n.children.forEach((c, i) => { if (!results[i] && c.kind === 'req') out.missing.push(c.id) })
      else out.missing.push(`${n.type === 'OR' ? 'One' : n.n} of: ${n.children.map((c) => (c.kind === 'req' ? c.id : '(group)')).join(', ')}`)
    }
    return ok
  }

  const rootOk = node(agreement.root)
  // Split-series is always fatal, even if the tree happens to be satisfiable another way.
  out.isValid = rootOk && out.splitSeriesViolations.length === 0
  return out
}
