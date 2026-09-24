/* Academic year discovery. DATA_CONTRACT.md: the year in effect runs July 1 to June 30 (from 2026-07-01: "2026-2027"). */

export interface AcademicYear { id: number; code: string }

/** Fall year of the academic year in effect on `now` (UTC): July or later is this year's fall. */
export const fallYearInEffect = (now: Date) => (now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1)
export const codeFor = (fallYear: number) => `${fallYear}-${fallYear + 1}`
export const codeInEffect = (now: Date) => codeFor(fallYearInEffect(now))

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
 * The year in effect on `now`. `pinId` (ASSIST_ACADEMIC_YEAR_ID) forces a year; it must still exist in the list.
 * No silent fallback to an older year: data for the wrong year is untrusted by the app anyway (DATA_CONTRACT.md).
 */
export function pickAcademicYear(years: AcademicYear[], now: Date, pinId?: number): AcademicYear {
  if (pinId !== undefined) {
    const y = years.find((x) => x.id === pinId)
    if (!y) throw new Error(`AcademicYears: pinned id ${pinId} (ASSIST_ACADEMIC_YEAR_ID) is not listed by ASSIST`)
    return y
  }
  const want = codeInEffect(now)
  const y = years.find((x) => x.code === want)
  if (!y) {
    const known = years.map((x) => x.code).sort().slice(-3).join(', ')
    throw new Error(`AcademicYears: ASSIST does not list ${want}, the academic year in effect on ${now.toISOString().slice(0, 10)} (latest: ${known}). ` +
      'Keeping the last published data. Set ASSIST_ACADEMIC_YEAR_ID to fetch another year deliberately.')
  }
  return y
}
