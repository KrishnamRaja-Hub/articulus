/**
 * Which term a new plan can realistically start in. The planner used to start every plan in "Fall 2026", even after
 * registration for it had closed (TESTER1_REPORT M-5).
 *
 * Registration cutoffs are conservative approximations, the same for every college in a system: most California
 * community colleges close open registration a week or two into the term. A date on or after a cutoff moves the
 * default to the next term. Dates are read in UTC so every viewer and test sees the same answer.
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

/** The next term, in `system`, whose registration has not closed on `now`. null for an invalid date, so the caller
 *  asks the student instead of guessing. */
export function nextOpenTerm(now: Date, system: TermSystem): StartTerm | null {
  if (Number.isNaN(now.getTime())) return null
  const y = now.getUTCFullYear()
  const md = (now.getUTCMonth() + 1) * 100 + now.getUTCDate()
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
