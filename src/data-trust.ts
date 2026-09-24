import { NORMALIZE_VERSION } from './engine/normalize.ts'

/**
 * How far the bundled ASSIST data (data/meta.json) can be trusted, per the policy in DATA_CONTRACT.md.
 * Pure: the caller passes the current time, so the app evaluates it in the browser at run time, never at build time.
 * All dates are UTC.
 */

export type TrustLevel = 'trusted' | 'aging' | 'untrusted'
export interface DataTrust { level: TrustLevel; reasons: string[]; fetchedAt: Date | null; academicYear: string | null }

export const META_SCHEMA = 1
const DAY = 86_400_000
export const AGING_DAYS = 7
export const MAX_AGE_DAYS = 30

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
// a date, or a date-time with an explicit zone: a zone-less date-time would be read in the viewer's local time
const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/
const YEAR = /^(\d{4})-(\d{4})$/

function parseDate(x: unknown): Date | null {
  if (typeof x !== 'string' || !ISO.test(x)) return null
  const d = new Date(x)
  return Number.isNaN(d.getTime()) ? null : d
}

/** The academic year in effect on `now`: July 1 through June 30, in UTC. 2026-07-01 -> "2026-2027". */
export function academicYearOn(now: Date): string {
  const y = now.getUTCFullYear()
  const start = now.getUTCMonth() >= 6 ? y : y - 1
  return `${start}-${start + 1}`
}

/** Whole days between two instants (floored). */
export const ageInDays = (fetchedAt: Date, now: Date) => Math.floor((now.getTime() - fetchedAt.getTime()) / DAY)

/** "12 days"; just past a threshold the floor equals it, so say "more than 30 days" rather than "30 days". */
const daysOld = (fetchedAt: Date, now: Date, limit: number) => {
  const d = ageInDays(fetchedAt, now)
  return d <= limit ? `more than ${limit} days` : `${d} days`
}

/**
 * `agreementCount`: how many agreements the app actually bundles (data/index.json). When given, meta.json must record
 * the same number; a mismatch means the data files and their description come from different downloads.
 */
export function dataTrust(meta: unknown, now: Date, normalizeVersion: number = NORMALIZE_VERSION, agreementCount?: number): DataTrust {
  const reasons: string[] = []
  const m = isObj(meta) ? meta : {}
  if (!isObj(meta)) reasons.push('The data description file is missing or unreadable')
  else if (m.schema !== META_SCHEMA) reasons.push('The data description file is in a format this version of the app does not recognize')

  const nv = m.normalizeVersion
  if (nv === undefined || nv === null) reasons.push('It is not recorded which version of Articulus prepared the data')
  else if (typeof nv === 'number' && Number.isInteger(nv) && nv < normalizeVersion) reasons.push('The data was prepared by an older version of Articulus')
  else if (nv !== normalizeVersion) reasons.push('The data was prepared by a different version of Articulus than this page')

  const v = m.validation
  if (!isObj(v)) reasons.push('The data has not been checked for errors')
  else if (v.passed === false) reasons.push('The data failed its error check')
  else if (v.passed === undefined || v.passed === null) reasons.push('The result of the data error check is not recorded')
  // strictly boolean: "true" (a string) or 1 is a pipeline bug, not a pass, and says so instead of "failed"
  else if (v.passed !== true) reasons.push('The result of the data error check is not a plain yes or no, so it cannot be read')

  if (agreementCount !== undefined) {
    const n = m.agreements
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) reasons.push('The number of agreements in the data is not recorded')
    else if (n !== agreementCount) reasons.push(`The data description lists ${n} agreements, but ${agreementCount} are included`)
  }

  const clockOk = !Number.isNaN(now.getTime())
  if (!clockOk) reasons.push("This device's date is not valid")

  const fetchedAt = parseDate(m.fetchedAt)
  let age: number | null = null
  if (m.fetchedAt === null || m.fetchedAt === undefined) reasons.push('The date the data was downloaded from ASSIST is not recorded')
  else if (!fetchedAt) reasons.push('The date the data was downloaded from ASSIST is not readable')
  else if (clockOk) {
    const ms = now.getTime() - fetchedAt.getTime()
    // a download date after today means a wrong clock or a corrupted file: nothing about its age can be trusted
    if (ms < 0) reasons.push("The data's download date is in the future, so its age cannot be checked")
    else {
      age = ms
      if (ms > MAX_AGE_DAYS * DAY) reasons.push(`Data is ${daysOld(fetchedAt, now, MAX_AGE_DAYS)} old (it must be refreshed at least every ${MAX_AGE_DAYS} days)`)
    }
  }

  const ay = isObj(m.academicYear) ? m.academicYear.code : undefined
  const ym = typeof ay === 'string' ? YEAR.exec(ay) : null
  const academicYear = ym && Number(ym[2]) === Number(ym[1]) + 1 ? ay as string : null
  if (!academicYear) reasons.push('The academic year of the data is not recorded')
  else if (clockOk) {
    const expected = academicYearOn(now)
    if (academicYear !== expected) reasons.push(`Data is for ${academicYear} but ${expected} agreements are in effect`)
  }

  if (reasons.length) return { level: 'untrusted', reasons, fetchedAt, academicYear }
  if (age !== null && age > AGING_DAYS * DAY) {
    return { level: 'aging', reasons: [`Data is ${daysOld(fetchedAt!, now, AGING_DAYS)} old`], fetchedAt, academicYear }
  }
  return { level: 'trusted', reasons: [], fetchedAt, academicYear }
}

/** "Sep 24, 2026", in UTC so every viewer sees the same date the pipeline wrote. */
export const formatDataDate = (d: Date) =>
  d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' })

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1)

export interface TrustBanner { tone: 'alert' | 'warn' | 'quiet'; headline: string; detail: string }

/** The site-wide data-status text for each trust level. Plain language: problems found are still shown when
 *  untrusted, only "complete" is withheld, so the headline must not say verdicts are paused. */
export function trustBanner(t: DataTrust): TrustBanner {
  const date = t.fetchedAt ? formatDataDate(t.fetchedAt) : null
  const year = t.academicYear ? `${t.academicYear} agreements` : 'academic year unknown'
  if (t.level === 'untrusted') return {
    tone: 'alert',
    headline: `We can't confirm a plan is complete right now: ${t.reasons.map(lower).join('; ')}. Confirm with a counselor.`,
    detail: `ASSIST data: ${year}${date ? `, downloaded ${date}` : ''}. Split series and courses you still need are still flagged, but no plan is marked complete until the data is refreshed.`,
  }
  if (t.level === 'aging') return {
    tone: 'warn',
    headline: `ASSIST data from ${date} (${year}).`,
    detail: `${t.reasons.join('. ')}. Agreements can change, so confirm with a counselor before enrolling.`,
  }
  return { tone: 'quiet', headline: `ASSIST data updated ${date} (${year}).`, detail: '' }
}

/** Where the figure's example comes from, from the live trust state (TESTER1_REPORT L-1): never "real, current data"
 *  when it needs a refresh. */
export function heroDataNote(t: DataTrust): string {
  const year = t.academicYear ? `${t.academicYear} ` : ''
  if (t.level === 'untrusted') return `From the bundled ${year}ASSIST data, which needs a refresh.`
  return `From ${year}ASSIST data${t.fetchedAt ? ` downloaded ${formatDataDate(t.fetchedAt)}` : ''}.`
}

/** One-line version for the fixed header. */
export function trustChip(t: DataTrust): string | null {
  if (t.level === 'untrusted') return "Can't confirm plans: data needs a refresh"
  if (t.level === 'aging') return `ASSIST data from ${formatDataDate(t.fetchedAt!)}`
  return null
}

/** Same level and reasons: lets a periodic re-check skip re-rendering when nothing changed. */
export const sameTrust = (a: DataTrust, b: DataTrust) =>
  a.level === b.level && a.academicYear === b.academicYear && a.fetchedAt?.getTime() === b.fetchedAt?.getTime()
  && a.reasons.length === b.reasons.length && a.reasons.every((r, i) => r === b.reasons[i])

/** Tone of a pass/fail demo verdict (TESTER1_REPORT L-5): a pass on untrusted data is an illustration, never green. */
export const demoTone = (ok: boolean, level: TrustLevel): 'ok' | 'illustration' | 'split' =>
  !ok ? 'split' : level === 'untrusted' ? 'illustration' : 'ok'
