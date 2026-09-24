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
export interface HonorsHint { requirementId: string; institutionId: number; group: CourseGroup; swaps: HonorsSwap[] }

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
    const prev = best.get(g.institutionId)
    if (!prev || swaps.length < prev.swaps.length) best.set(g.institutionId, { requirementId: req.id, institutionId: g.institutionId, group: g, swaps })
  }
  return [...best.values()]
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
  const listed = list(h.swaps.map((s) => code(s.listed)))
  const took = list(h.swaps.map((s) => code(s.taken)))
  const tookHonors = h.swaps.every((s) => s.taken.endsWith('H'))
  const tookRegular = h.swaps.every((s) => !s.taken.endsWith('H'))
  const why = tookHonors ? 'Honors versions are usually accepted'
    : tookRegular ? 'Regular and honors versions usually count the same, but only the honors version is listed'
    : 'Regular and honors versions usually count the same'
  return `ASSIST lists ${listed}, not ${took}, for this row. ${why} — confirm with a counselor before retaking.`
}
