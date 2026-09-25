/* Academic calendars on one shared timeline (H-3).
 *
 * The timeline is counted in quarter periods: slot 3Y = Fall Y, 3Y+1 = Winter Y+1, 3Y+2 = Spring Y+1
 * (Y = the calendar year the academic year starts in). Quarter terms cover one slot. Semester terms cover:
 * Fall Y -> [3Y, 3Y] (Aug-Dec, alongside Fall quarter), Spring Y+1 -> [3Y+1, 3Y+2] (Jan-May, alongside Winter
 * and Spring quarter). Summer is not planned. */

import { nextOpenTerm as openTerm, type Season, type StartTerm, type TermSystem } from '../terms.ts'
export type { Season, StartTerm, TermSystem }

export interface CalendarTerm { system: TermSystem; season: Season; year: number; start: number; end: number }

/** The next term open for registration (src/terms.ts holds the cutoffs); Fall of this year for an invalid date. */
export function nextOpenTerm(now: Date = new Date(), system: TermSystem = 'quarter'): StartTerm {
  return openTerm(now, system) ?? { season: 'Fall', year: new Date().getUTCFullYear() }
}

const SEASONS: Record<string, Season> = { fall: 'Fall', winter: 'Winter', spring: 'Spring' }

/** A start term as the planner reads it (N-3): the season in any letter case ('fall' -> 'Fall'), an integer year.
 *  Throws a RangeError for anything else, Summer included (Summer is not planned, and must not become Spring). */
export function checkStartTerm(start: StartTerm): StartTerm {
  const raw = (start as { season?: unknown } | null | undefined)?.season, year = (start as { year?: unknown } | null | undefined)?.year
  const season = typeof raw === 'string' ? SEASONS[raw.trim().toLowerCase()] : undefined
  if (!season) throw new RangeError(`Unknown start term season ${JSON.stringify(raw)}: expected Fall, Winter or Spring.`)
  if (typeof year !== 'number' || !Number.isInteger(year)) throw new RangeError(`Start term year must be a whole number, got ${typeof year === 'number' || year === undefined ? String(year) : JSON.stringify(year)}.`)
  return season === start.season ? start : { season, year }
}

/** First timeline slot of a start term, read in the home calendar (semester Winter/Spring = the January term). */
export function startSlot(start0: StartTerm, home: TermSystem): number {
  const start = checkStartTerm(start0)
  if (start.season === 'Fall') return 3 * start.year
  if (home === 'semester' || start.season === 'Winter') return 3 * (start.year - 1) + 1
  return 3 * (start.year - 1) + 2
}

/** The j-th term (j >= 0) of `system` that starts at or after `slot`. */
export function nthTerm(system: TermSystem, slot: number, j: number): CalendarTerm {
  if (system === 'quarter') {
    const k = slot + j, Y = Math.floor(k / 3), r = k - 3 * Y
    return { system, season: (['Fall', 'Winter', 'Spring'] as const)[r], year: r ? Y + 1 : Y, start: k, end: k }
  }
  // semester starts: 3Y (Fall), 3Y+1 (Spring); first one >= slot
  const Y0 = Math.floor(slot / 3), r0 = slot - 3 * Y0
  const first = r0 === 0 ? 0 : r0 === 1 ? 1 : 2 // index in the sequence Fall Y0, Spring Y0+1, Fall Y0+1, ...
  const n = first + j, Y = Y0 + Math.floor(n / 2)
  return n % 2 ? { system, season: 'Spring', year: Y + 1, start: 3 * Y + 1, end: 3 * Y + 2 }
    : { system, season: 'Fall', year: Y, start: 3 * Y, end: 3 * Y }
}
