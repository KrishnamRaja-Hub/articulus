/* Academic calendars on one shared timeline (H-3).
 *
 * The timeline is counted in quarter periods: slot 3Y = Fall Y, 3Y+1 = Winter Y+1, 3Y+2 = Spring Y+1
 * (Y = the calendar year the academic year starts in). Quarter terms cover one slot. Semester terms cover:
 * Fall Y -> [3Y, 3Y] (Aug-Dec, alongside Fall quarter), Spring Y+1 -> [3Y+1, 3Y+2] (Jan-May, alongside Winter
 * and Spring quarter). Summer is not planned. */

export type TermSystem = 'quarter' | 'semester'
export type Season = 'Fall' | 'Winter' | 'Spring'
export interface StartTerm { season: Season; year: number }

export interface CalendarTerm { system: TermSystem; season: Season; year: number; start: number; end: number }

/** The term open for registration next: Fall (this year) before about April 1, otherwise the next
 *  Winter (quarter) or Spring (semester) term. */
export function nextOpenTerm(now: Date = new Date(), system: TermSystem = 'quarter'): StartTerm {
  const y = now.getFullYear()
  if (now.getMonth() < 3) return { season: 'Fall', year: y }
  return { season: system === 'semester' ? 'Spring' : 'Winter', year: y + 1 }
}

/** First timeline slot of a start term, read in the home calendar (semester Winter/Spring = the January term). */
export function startSlot(start: StartTerm, home: TermSystem): number {
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
