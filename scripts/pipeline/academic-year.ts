/* Academic year discovery. DATA_CONTRACT.md: the year in effect runs July 1 to June 30 (from 2026-07-01: "2026-2027").
   The date is the calendar date in California (America/Los_Angeles, src/terms.ts pacificDate), the same rule the app
   uses (src/data-trust.ts academicYearOn), so the pipeline and the app always agree on the year in effect.
   Until ASSIST publishes the new year's agreements, the prior year is carried over and marked as such. */

import { pacificDate } from '../../src/terms.ts'

export interface AcademicYear { id: number; code: string }

/** Fall year of the academic year in effect on `now` (the California date): July or later is this year's fall.
 *  NaN when the date can't be worked out (codeInEffect then throws). */
export const fallYearInEffect = (now: Date) => {
  const d = pacificDate(now)
  return d ? (d.month >= 7 ? d.year : d.year - 1) : NaN
}
export const codeFor = (fallYear: number) => `${fallYear}-${fallYear + 1}`
/** Throws when the California date can't be worked out (invalid date, or a runtime without that time zone), so a run
 *  stops with a clear message instead of looking for a "NaN-NaN" year. */
export const codeInEffect = (now: Date) => {
  const fall = fallYearInEffect(now)
  if (Number.isNaN(fall)) throw new Error(`Can't work out today's date in California from ${String(now)}; refusing to guess the academic year`)
  return codeFor(fall)
}

/**
 * Parse /api/AcademicYears. Known shape: [{ "Id": 76, "FallYear": 2025 }, ...]. Accepts camelCase and a code field
 * ("2025-2026") too; anything else throws with the offending sample, so a changed endpoint fails loudly instead
 * of silently fetching the wrong year.
 */
export function parseAcademicYears(body: unknown): AcademicYear[] {
  const list = Array.isArray(body) ? body : (body as { academicYears?: unknown })?.academicYears
  if (!Array.isArray(list) || !list.length) throw new Error(`AcademicYears: expected a non-empty array, got ${JSON.stringify(body)?.slice(0, 200)}`)
  return list.map((y: Record<string, unknown>) => {
    const id = y?.Id ?? y?.id
    const fall = y?.FallYear ?? y?.fallYear
    const code = y?.Code ?? y?.code
    if (typeof id !== 'number' || !Number.isInteger(id)) throw new Error(`AcademicYears: entry without integer id: ${JSON.stringify(y)?.slice(0, 200)}`)
    if (typeof fall === 'number' && Number.isInteger(fall)) return { id, code: codeFor(fall) }
    if (typeof code === 'string' && /^\d{4}-\d{4}$/.test(code) && Number(code.slice(5)) === Number(code.slice(0, 4)) + 1) return { id, code }
    throw new Error(`AcademicYears: entry ${id} has no FallYear or YYYY-YYYY code: ${JSON.stringify(y)?.slice(0, 200)}`)
  })
}

/**
 * The academic years to try, newest first (TESTER1_REPORT M-6). ASSIST often publishes a new year's agreements weeks
 * after July 1, so the year in effect is tried first and the year before it is the explicit carry-over: the fetcher
 * uses the first one with published agreements and records `carriedOver: true` in meta.json when that is not the year
 * in effect. Nothing older is tried: data two or more years back is untrusted by the app (DATA_CONTRACT.md), so the
 * run fails and the last published data stays. `pinId` (ASSIST_ACADEMIC_YEAR_ID) forces one year; it must be listed.
 */
export function candidateYears(years: AcademicYear[], now: Date, pinId?: number): AcademicYear[] {
  if (pinId !== undefined) {
    const y = years.find((x) => x.id === pinId)
    if (!y) throw new Error(`AcademicYears: pinned id ${pinId} (ASSIST_ACADEMIC_YEAR_ID) is not listed by ASSIST`)
    return [y]
  }
  const fall = fallYearInEffect(now)
  const out = [codeFor(fall), codeFor(fall - 1)].map((c) => years.find((x) => x.code === c)).filter((y): y is AcademicYear => !!y)
  if (!out.length) {
    const known = years.map((x) => x.code).sort().slice(-3).join(', ')
    throw new Error(`AcademicYears: ASSIST lists neither ${codeFor(fall)} (in effect on ${now.toISOString().slice(0, 10)}) nor the carry-over year ${codeFor(fall - 1)} (latest: ${known}). ` +
      'Keeping the last published data. Set ASSIST_ACADEMIC_YEAR_ID to fetch another year deliberately.')
  }
  return out
}
