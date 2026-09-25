import type { CourseGroup, CourseId, Requirement } from './types'
import { honorsColleges, reqStatus } from './verify'

/**
 * Informational hints only: nothing here changes a verdict. The engine follows ASSIST strictly, so a regular course
 * and its honors twin are interchangeable only at colleges that list both versions for the row (`honorsColleges`).
 * In practice a university usually accepts the honors version even where ASSIST lists only the regular one
 * (COUNSELOR_REPORT HIGH-5: De Anza MATH 1CH + 1D for UCSD MATH 20E, where ASSIST lists 1C + 1D). These hints tell the
 * student to ask a counselor before retaking a course they already have in another version.
 */

/** One course the student took in the other version: `listed` is on ASSIST, `taken` is what they have. */
export interface HonorsSwap { listed: CourseId; taken: CourseId }
/** `companions` (only when set): ASSIST lists the course the student took for this row, but only together with these
 *  courses, which the student has not taken (Foothill MATH 1AH + the MATH 1AHP seminar for UC Davis MAT 021A). `group`
 *  is then that listed group and `swaps` is empty: the honors course alone is not what ASSIST accepts. */
export interface HonorsHint { requirementId: string; institutionId: number; group: CourseGroup; swaps: HonorsSwap[]; companions?: CourseId[] }

const stripH = (id: CourseId) => id.replace(/H$/, '')
const code = (id: CourseId) => id.slice(id.indexOf(':') + 1)

/** The taken course that is `c`'s regular or honors twin (same college), if any. */
function twinTaken(c: CourseId, taken: ReadonlySet<CourseId>): CourseId | undefined {
  if (c.endsWith('H')) return taken.has(stripH(c)) ? stripH(c) : undefined
  return taken.has(`${c}H`) ? `${c}H` : undefined
}

/**
 * For a requirement the strict rule leaves unsatisfied: a group at a college with no honors twin in this row that the
 * taken courses would complete if each course and its honors twin were interchangeable. At most one hint per college
 * (the one needing the fewest swaps, then the first listed); colleges in order of first appearance.
 */
export function honorsHint(req: Requirement, taken: ReadonlySet<CourseId>): HonorsHint[] {
  const set = taken as Set<CourseId>
  if (reqStatus(req, set).satisfied) return []
  const mixing = honorsColleges(req) // there the engine already swaps, so a hint would never apply
  const best = new Map<number, HonorsHint>()
  const companion = new Map<number, HonorsHint>()
  for (const g of req.groups) {
    if (mixing.has(g.institutionId) || g.courses.length === 0) continue
    const swaps: HonorsSwap[] = []
    let complete = true
    for (const c of g.courses) {
      if (taken.has(c)) continue
      const t = twinTaken(c, taken)
      if (!t) { complete = false; break }
      swaps.push({ listed: c, taken: t })
    }
    if (!complete || swaps.length === 0) continue
    // ASSIST already lists a taken course for this row in another group at the same college, with courses the student
    // lacks: that group is what ASSIST accepts for it, so "usually accepted" would contradict it. Name the companions.
    const listedWith = req.groups.filter((o) => o !== g && o.institutionId === g.institutionId && swaps.some((s) => o.courses.includes(s.taken)))
    if (listedWith.length) {
      for (const o of listedWith) {
        const companions = o.courses.filter((c) => !taken.has(c))
        const prev = companion.get(g.institutionId)
        if (companions.length && (!prev || companions.length < prev.companions!.length))
          companion.set(g.institutionId, { requirementId: req.id, institutionId: g.institutionId, group: o, swaps: [], companions })
      }
      continue
    }
    const prev = best.get(g.institutionId)
    if (!prev || swaps.length < prev.swaps.length) best.set(g.institutionId, { requirementId: req.id, institutionId: g.institutionId, group: g, swaps })
  }
  // a clean swap hint wins for its college; otherwise the companion note; colleges in order of first appearance
  const order = [...new Set(req.groups.map((g) => g.institutionId))]
  return order.flatMap((i) => best.get(i) ?? companion.get(i) ?? [])
}

/** Hints for every requirement in `reqs` (deduplicated by id). */
export function honorsHints(reqs: Iterable<Requirement>, taken: ReadonlySet<CourseId>): Record<string, HonorsHint[]> {
  const out: Record<string, HonorsHint[]> = {}
  for (const r of reqs) {
    if (r.id in out) continue
    const h = honorsHint(r, taken)
    if (h.length) out[r.id] = h
  }
  return out
}

const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)

/** Student-facing note, e.g. "ASSIST lists MATH 1C, not MATH 1CH, for this row. Honors versions are usually accepted — ..." */
export function honorsNote(h: HonorsHint): string {
  if (h.companions?.length) {
    const have = list(h.group.courses.filter((c) => !h.companions!.includes(c)).map(code))
    const need = list(h.companions.map(code))
    return `ASSIST accepts ${have} for this row only together with ${need}, which you have not taken. ${have} alone may not count — confirm with a counselor, or add ${need}.`
  }
  const listed = list(h.swaps.map((s) => code(s.listed)))
  const took = list(h.swaps.map((s) => code(s.taken)))
  const tookHonors = h.swaps.every((s) => s.taken.endsWith('H'))
  const tookRegular = h.swaps.every((s) => !s.taken.endsWith('H'))
  const why = tookHonors ? 'Honors versions are usually accepted'
    : tookRegular ? 'Regular and honors versions usually count the same, but only the honors version is listed'
    : 'Regular and honors versions usually count the same'
  return `ASSIST lists ${listed}, not ${took}, for this row. ${why} — confirm with a counselor before retaking.`
}

export const CALCULUS_PLACEMENT_NOTE = 'Honors/combined calculus may need a placement or instructor approval — check with a counselor.'

/**
 * Whether a planned course is an honors or combined/accelerated calculus course, which can need a placement or
 * instructor approval. Conservative: the title must name calculus (not calculus-based physics or the like), and the
 * course must be marked honors (course number ending in H, or "Honors" in the title) or combined/accelerated.
 * Informational only: it never changes a verdict.
 */
export function isHonorsCalculus(id: CourseId, title: string | undefined): boolean {
  const t = title ?? ''
  if (!/\bcalculus\b/i.test(t) || /physics|\bbased\b/i.test(t)) return false
  return /H$/.test(code(id).trim()) || /\b(honors|combined|accelerated)\b/i.test(t)
}
