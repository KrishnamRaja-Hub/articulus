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

export function dataTrust(meta: unknown, now: Date, normalizeVersion: number = NORMALIZE_VERSION): DataTrust {
  const reasons: string[] = []
  const m = isObj(meta) ? meta : {}
  if (!isObj(meta)) reasons.push('The data description file is missing or unreadable')
  else if (m.schema !== META_SCHEMA) reasons.push('The data description file is in a format this version of the app does not recognize')

  const nv = m.normalizeVersion
  if (nv === undefined || nv === null) reasons.push('The importer version that built the data is not recorded')
  else if (typeof nv === 'number' && Number.isInteger(nv) && nv < normalizeVersion) reasons.push('Agreement data was built by an older version of the importer')
  else if (nv !== normalizeVersion) reasons.push('Agreement data was built by an importer version this app does not match')

  const v = m.validation
  if (!isObj(v)) reasons.push('Data has not passed validation')
  else if (v.passed !== true) reasons.push('Data failed validation')

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

/** The site-wide data-status text for each trust level. */
export function trustBanner(t: DataTrust): TrustBanner {
  const date = t.fetchedAt ? formatDataDate(t.fetchedAt) : null
  const year = t.academicYear ? `${t.academicYear} agreements` : 'academic year unknown'
  if (t.level === 'untrusted') return {
    tone: 'alert',
    headline: `Verdicts are paused: ${t.reasons.map(lower).join('; ')}. Confirm with a counselor.`,
    detail: `ASSIST data: ${year}${date ? `, downloaded ${date}` : ''}. Split-series and missing-course warnings still show; no plan is marked complete until the data is refreshed.`,
  }
  if (t.level === 'aging') return {
    tone: 'warn',
    headline: `ASSIST data from ${date} (${year}).`,
    detail: `${t.reasons.join('. ')}. Agreements can change, so confirm with a counselor before enrolling.`,
  }
  return { tone: 'quiet', headline: `ASSIST data updated ${date} (${year}).`, detail: '' }
}

/** One-line version for the fixed header. */
export function trustChip(t: DataTrust): string | null {
  if (t.level === 'untrusted') return "Verdicts paused: data needs a refresh"
  if (t.level === 'aging') return `ASSIST data from ${formatDataDate(t.fetchedAt!)}`
  return null
}
