/**
 * Which term a new plan can realistically start in. The planner used to start every plan in "Fall 2026", even after
 * registration for it had closed (TESTER1_REPORT M-5).
 *
 * Registration cutoffs are conservative approximations, the same for every college in a system: most California
 * community colleges close open registration a week or two into the term. A date on or after a cutoff moves the
 * default to the next term. Dates are read as the calendar date in California (America/Los_Angeles, see pacificDate),
 * whatever the viewer's own zone, so every viewer and test sees the same answer and 6 pm Pacific on Aug 31 is still
 * Aug 31 (in UTC it is already Sep 1).
 *
 * | System   | Term   | Registration treated as closed from |
 * |----------|--------|-------------------------------------|
 * | quarter  | Fall   | Sep 20                              |
 * | quarter  | Winter | Jan 5                               |
 * | quarter  | Spring | Apr 1                               |
 * | semester | Fall   | Aug 20                              |
 * | semester | Spring | Jan 20                              |
 *
 * Summer is not planned. `year` is the calendar year the term starts in (Winter 2027 starts in January 2027), the same
 * convention as SolveOptions.startTerm in src/engine/solve.ts.
 */

export type TermSystem = 'quarter' | 'semester'
export type Season = 'Fall' | 'Winter' | 'Spring'
export interface StartTerm { season: Season; year: number }

export const seasonsOf = (system: TermSystem): Season[] => (system === 'semester' ? ['Fall', 'Spring'] : ['Fall', 'Winter', 'Spring'])

/** [month (1-12), day] from which registration for the term is treated as closed. */
export const REGISTRATION_CLOSES: Record<TermSystem, Partial<Record<Season, [number, number]>>> = {
  quarter: { Winter: [1, 5], Spring: [4, 1], Fall: [9, 20] },
  semester: { Spring: [1, 20], Fall: [8, 20] },
}

/** The time zone of the California colleges: every calendar-date decision (registration cutoffs, the July 1
 *  academic-year rollover) is made on the date there. */
export const COLLEGE_TIME_ZONE = 'America/Los_Angeles'

export interface CalendarDate { year: number; month: number; day: number }

/** The cached formatter: undefined until first built, false when this runtime does not honour the zone. */
let pacificFormat: Intl.DateTimeFormat | false | undefined

function pacificFormatter(): Intl.DateTimeFormat | null {
  if (pacificFormat === undefined) {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: COLLEGE_TIME_ZONE, year: 'numeric', month: 'numeric', day: 'numeric' })
    // A runtime without time-zone data may ignore timeZone and format in UTC (or the host zone): refuse rather than guess.
    pacificFormat = f.resolvedOptions().timeZone === COLLEGE_TIME_ZONE ? f : false
  }
  return pacificFormat || null
}

/** The calendar date (month 1-12) in California at the instant `now`, DST included. null for an invalid date, a date
 *  outside years 1-275760 AD (the formatter drops the era, so 1 BC would read as year 1), or when this runtime cannot
 *  resolve the zone (the formatter throws, or silently ignores timeZone), so the caller asks instead of guessing. The
 *  one shared helper for calendar-date decisions (src/data-trust.ts, src/engine/calendar.ts,
 *  scripts/pipeline/academic-year.ts). */
export function pacificDate(now: Date): CalendarDate | null {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return null
  const utcYear = now.getUTCFullYear()
  if (utcYear < 2) return null // the formatter drops the era: Dec 31, 1 BC in California would read as year 1
  try {
    const fmt = pacificFormatter()
    if (!fmt) return null
    const parts = fmt.formatToParts(now)
    const num = (t: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === t)?.value)
    const year = num('year'), month = num('month'), day = num('day')
    if (![year, month, day].every(Number.isInteger) || month < 1 || month > 12 || day < 1 || day > 31) return null
    // California is at most a day behind UTC, so the years differ by at most 1; anything else is a misread (lost era).
    if (Math.abs(year - utcYear) > 1) return null
    return { year, month, day }
  } catch {
    return null
  }
}

/** The next term, in `system`, whose registration has not closed on `now` (the California date). null for an invalid date, so the caller
 *  asks the student instead of guessing. */
export function nextOpenTerm(now: Date, system: TermSystem): StartTerm | null {
  const today = pacificDate(now)
  if (!today) return null
  const y = today.year
  const md = today.month * 100 + today.day
  const before = (s: Season) => { const [m, d] = REGISTRATION_CLOSES[system][s]!; return md < m * 100 + d }
  if (system === 'semester') {
    if (before('Spring')) return { season: 'Spring', year: y }
    if (before('Fall')) return { season: 'Fall', year: y }
    return { season: 'Spring', year: y + 1 }
  }
  if (before('Winter')) return { season: 'Winter', year: y }
  if (before('Spring')) return { season: 'Spring', year: y }
  if (before('Fall')) return { season: 'Fall', year: y }
  return { season: 'Winter', year: y + 1 }
}

/** The term after `t` in `system` (Fall 2026 -> Winter 2027 -> Spring 2027 -> Fall 2027). */
export function nextTerm(t: StartTerm, system: TermSystem): StartTerm {
  const seasons = seasonsOf(system)
  const i = seasons.indexOf(t.season)
  if (i < 0) return { season: 'Spring', year: t.year } // Winter on semesters: the next semester term is Spring
  const n = (i + 1) % seasons.length
  return { season: seasons[n], year: n === 1 ? t.year + 1 : t.year }
}

/** `count` consecutive terms starting at `from`. */
export function termsFrom(from: StartTerm, system: TermSystem, count: number): StartTerm[] {
  const out: StartTerm[] = []
  let t = from
  for (let i = 0; i < count; i++) { out.push(t); t = nextTerm(t, system) }
  return out
}

export const termLabel = (t: StartTerm) => `${t.season} ${t.year}`
export const termKey = (t: StartTerm) => `${t.season}-${t.year}`
export function parseTermKey(k: string): StartTerm | null {
  const m = /^(Fall|Winter|Spring)-(\d{4})$/.exec(k)
  return m ? { season: m[1] as Season, year: Number(m[2]) } : null
}
