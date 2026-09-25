import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextOpenTerm as calendarOpenTerm } from './engine/calendar'
import { nextOpenTerm, nextTerm, pacificDate, parseTermKey, seasonsOf, termKey, termLabel, termsFrom } from './terms'

const at = (iso: string) => new Date(`${iso}T12:00:00Z`)

describe('nextOpenTerm', () => {
  it('on the tester date (2026-09-24): quarter Fall has closed -> Winter 2027; semester -> Spring 2027', () => {
    expect(nextOpenTerm(at('2026-09-24'), 'quarter')).toEqual({ season: 'Winter', year: 2027 })
    expect(nextOpenTerm(at('2026-09-24'), 'semester')).toEqual({ season: 'Spring', year: 2027 })
  })

  it('quarter cutoffs: Winter closes Jan 5, Spring Apr 1, Fall Sep 20', () => {
    const q = (d: string) => termLabel(nextOpenTerm(at(d), 'quarter')!)
    expect(q('2027-01-04')).toBe('Winter 2027')
    expect(q('2027-01-05')).toBe('Spring 2027')
    expect(q('2027-03-31')).toBe('Spring 2027')
    expect(q('2027-04-01')).toBe('Fall 2027')
    expect(q('2027-09-19')).toBe('Fall 2027')
    expect(q('2027-09-20')).toBe('Winter 2028')
    expect(q('2027-12-31')).toBe('Winter 2028')
  })

  it('semester cutoffs: Spring closes Jan 20, Fall Aug 20', () => {
    const s = (d: string) => termLabel(nextOpenTerm(at(d), 'semester')!)
    expect(s('2027-01-19')).toBe('Spring 2027')
    expect(s('2027-01-20')).toBe('Fall 2027')
    expect(s('2027-08-19')).toBe('Fall 2027')
    expect(s('2027-08-20')).toBe('Spring 2028')
    expect(s('2027-12-31')).toBe('Spring 2028')
  })

  it('reads the date in California, not UTC', () => {
    // 5 pm Sep 19 PDT is already Sep 20 UTC, but registration is still open in California
    expect(nextOpenTerm(new Date('2026-09-19T23:59:59Z'), 'quarter')).toEqual({ season: 'Fall', year: 2026 })
    expect(nextOpenTerm(new Date('2026-09-19T17:00:00-07:00'), 'quarter')).toEqual({ season: 'Fall', year: 2026 })
    expect(nextOpenTerm(new Date('2026-09-19T23:59:59-07:00'), 'quarter')).toEqual({ season: 'Fall', year: 2026 })
    expect(nextOpenTerm(new Date('2026-09-20T00:00:00-07:00'), 'quarter')).toEqual({ season: 'Winter', year: 2027 })
  })

  it('6 pm Aug 31 Pacific (already Sep 1 UTC) is still Aug 31', () => {
    expect(pacificDate(new Date('2026-09-01T01:00:00Z'))).toEqual({ year: 2026, month: 8, day: 31 })
    expect(pacificDate(new Date('2026-09-01T06:00:00Z'))).toEqual({ year: 2026, month: 8, day: 31 }) // 23:00 PDT
    expect(pacificDate(new Date('2026-09-01T07:00:00Z'))).toEqual({ year: 2026, month: 9, day: 1 }) // midnight PDT
    expect(pacificDate(new Date('2026-08-31T01:00:00Z'))).toEqual({ year: 2026, month: 8, day: 30 }) // 18:00 PDT Aug 30
  })

  it('semester Fall cutoff [8, 20] at the Pacific midnight', () => {
    // Aug 19 23:59:59 PDT = Aug 20 06:59:59 UTC: still open
    expect(nextOpenTerm(new Date('2026-08-20T06:59:59Z'), 'semester')).toEqual({ season: 'Fall', year: 2026 })
    expect(nextOpenTerm(new Date('2026-08-20T01:00:00Z'), 'semester')).toEqual({ season: 'Fall', year: 2026 })
    // Aug 20 00:00 PDT = 07:00 UTC: closed
    expect(nextOpenTerm(new Date('2026-08-20T07:00:00Z'), 'semester')).toEqual({ season: 'Spring', year: 2027 })
    // 2026-08-31T01:00Z is Aug 30 PDT; 2026-09-01T06:00Z is Aug 31 23:00 PDT: both past the Fall cutoff
    expect(nextOpenTerm(new Date('2026-08-31T01:00:00Z'), 'semester')).toEqual({ season: 'Spring', year: 2027 })
    expect(nextOpenTerm(new Date('2026-09-01T06:00:00Z'), 'semester')).toEqual({ season: 'Spring', year: 2027 })
  })

  it('quarter Fall cutoff [9, 20] at the Pacific midnight', () => {
    expect(nextOpenTerm(new Date('2026-08-31T01:00:00Z'), 'quarter')).toEqual({ season: 'Fall', year: 2026 })
    expect(nextOpenTerm(new Date('2026-09-01T06:00:00Z'), 'quarter')).toEqual({ season: 'Fall', year: 2026 })
    expect(nextOpenTerm(new Date('2026-09-20T06:59:59Z'), 'quarter')).toEqual({ season: 'Fall', year: 2026 })
    expect(nextOpenTerm(new Date('2026-09-20T07:00:00Z'), 'quarter')).toEqual({ season: 'Winter', year: 2027 })
  })

  it('year rollover: Jan 1 UTC is still Dec 31 in California (PST, UTC-8)', () => {
    expect(pacificDate(new Date('2027-01-01T07:59:59Z'))).toEqual({ year: 2026, month: 12, day: 31 })
    expect(pacificDate(new Date('2027-01-01T08:00:00Z'))).toEqual({ year: 2027, month: 1, day: 1 })
    // still Dec 31 2026: Winter 2027 is the next open quarter, Spring 2027 the next semester
    expect(nextOpenTerm(new Date('2027-01-01T03:00:00Z'), 'quarter')).toEqual({ season: 'Winter', year: 2027 })
    expect(nextOpenTerm(new Date('2027-01-01T03:00:00Z'), 'semester')).toEqual({ season: 'Spring', year: 2027 })
    // quarter Winter cutoff [1, 5] and semester Spring cutoff [1, 20] at midnight PST (08:00 UTC)
    expect(nextOpenTerm(new Date('2027-01-05T07:59:59Z'), 'quarter')).toEqual({ season: 'Winter', year: 2027 })
    expect(nextOpenTerm(new Date('2027-01-05T08:00:00Z'), 'quarter')).toEqual({ season: 'Spring', year: 2027 })
    expect(nextOpenTerm(new Date('2027-01-20T07:59:59Z'), 'semester')).toEqual({ season: 'Spring', year: 2027 })
    expect(nextOpenTerm(new Date('2027-01-20T08:00:00Z'), 'semester')).toEqual({ season: 'Fall', year: 2027 })
  })

  it('follows DST: the Pacific midnight moves between 08:00 UTC (PST) and 07:00 UTC (PDT)', () => {
    // spring forward: Sun 2027-03-14 02:00 PST -> 03:00 PDT
    expect(pacificDate(new Date('2027-03-14T07:59:59Z'))).toEqual({ year: 2027, month: 3, day: 13 })
    expect(pacificDate(new Date('2027-03-14T08:00:00Z'))).toEqual({ year: 2027, month: 3, day: 14 })
    expect(pacificDate(new Date('2027-03-15T06:59:59Z'))).toEqual({ year: 2027, month: 3, day: 14 })
    expect(pacificDate(new Date('2027-03-15T07:00:00Z'))).toEqual({ year: 2027, month: 3, day: 15 })
    // fall back: Sun 2026-11-01 02:00 PDT -> 01:00 PST
    expect(pacificDate(new Date('2026-11-01T06:59:59Z'))).toEqual({ year: 2026, month: 10, day: 31 })
    expect(pacificDate(new Date('2026-11-01T07:00:00Z'))).toEqual({ year: 2026, month: 11, day: 1 })
    expect(pacificDate(new Date('2026-11-02T07:59:59Z'))).toEqual({ year: 2026, month: 11, day: 1 })
    expect(pacificDate(new Date('2026-11-02T08:00:00Z'))).toEqual({ year: 2026, month: 11, day: 2 })
    // quarter Spring cutoff [4, 1] falls in PDT: closes at 07:00 UTC
    expect(nextOpenTerm(new Date('2027-04-01T06:59:59Z'), 'quarter')).toEqual({ season: 'Spring', year: 2027 })
    expect(nextOpenTerm(new Date('2027-04-01T07:00:00Z'), 'quarter')).toEqual({ season: 'Fall', year: 2027 })
  })

  it('is null for an invalid clock', () => {
    expect(nextOpenTerm(new Date(NaN), 'quarter')).toBeNull()
    expect(nextOpenTerm(new Date('not a date'), 'semester')).toBeNull()
    expect(pacificDate(new Date(NaN))).toBeNull()
  })
})

describe('term sequence', () => {
  it('follows the engine naming (Fall 2026 -> Winter 2027 -> Spring 2027 -> Fall 2027)', () => {
    expect(termsFrom({ season: 'Fall', year: 2026 }, 'quarter', 4).map(termLabel)).toEqual(['Fall 2026', 'Winter 2027', 'Spring 2027', 'Fall 2027'])
    expect(termsFrom({ season: 'Spring', year: 2027 }, 'semester', 3).map(termLabel)).toEqual(['Spring 2027', 'Fall 2027', 'Spring 2028'])
  })

  it('moves a Winter start on semesters to Spring', () => {
    expect(nextTerm({ season: 'Winter', year: 2027 }, 'semester')).toEqual({ season: 'Spring', year: 2027 })
    expect(seasonsOf('semester')).not.toContain('Winter')
  })

  it('round-trips keys', () => {
    const t = { season: 'Winter', year: 2027 } as const
    expect(parseTermKey(termKey(t))).toEqual(t)
    expect(parseTermKey('Summer-2027')).toBeNull()
  })
})

describe('pacificDate hardening', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules() })

  // pacificDate caches its formatter, so each stubbed runtime gets a fresh copy of the module.
  const fresh = async () => { vi.resetModules(); return await import('./terms') }
  const RealDTF = Intl.DateTimeFormat

  it('is null before 1 AD instead of dropping the era (L1)', () => {
    expect(pacificDate(new Date('-271821-04-20T00:00:00Z'))).toBeNull() // would read as year 271822
    expect(pacificDate(new Date('-000001-06-01T00:00:00Z'))).toBeNull() // would read as year 2
    expect(pacificDate(new Date('0000-06-01T00:00:00Z'))).toBeNull() // 1 BC, would read as year 1
    expect(pacificDate(new Date('0001-01-01T00:00:00Z'))).toBeNull() // Dec 31, 1 BC in California, would read as year 1
    expect(nextOpenTerm(new Date('-000001-06-01T00:00:00Z'), 'quarter')).toBeNull()
  })

  it('still reads the edges of the valid range', () => {
    expect(pacificDate(new Date('0002-01-01T12:00:00Z'))).toEqual({ year: 2, month: 1, day: 1 })
    expect(pacificDate(new Date('+275760-09-13T00:00:00Z'))).toEqual({ year: 275760, month: 9, day: 12 })
  })

  it('is null when the runtime silently ignores timeZone (L2)', async () => {
    vi.stubGlobal('Intl', { ...Intl, DateTimeFormat: function (l: string, o: Intl.DateTimeFormatOptions) { return new RealDTF(l, { ...o, timeZone: 'UTC' }) } })
    const t = await fresh()
    expect(t.pacificDate(new Date('2026-09-01T01:00:00Z'))).toBeNull() // UTC would say Sep 1; California is Aug 31
    expect(t.nextOpenTerm(new Date('2026-09-25T12:00:00Z'), 'quarter')).toBeNull()
  })

  it('is null when the formatter throws', async () => {
    vi.stubGlobal('Intl', { ...Intl, DateTimeFormat: function () { throw new RangeError('Invalid time zone specified: America/Los_Angeles') } })
    const t = await fresh()
    expect(t.pacificDate(new Date('2026-09-25T12:00:00Z'))).toBeNull()
    expect(t.nextOpenTerm(new Date('2026-09-25T12:00:00Z'), 'semester')).toBeNull()
  })

  it('is null when formatToParts throws', async () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts').mockImplementation(() => { throw new Error('no') })
    const t = await fresh()
    expect(t.pacificDate(new Date('2026-09-25T12:00:00Z'))).toBeNull()
  })

  it('works again with the real runtime', async () => {
    const t = await fresh()
    expect(t.pacificDate(new Date('2026-09-01T01:00:00Z'))).toEqual({ year: 2026, month: 8, day: 31 })
  })
})

describe('engine/calendar nextOpenTerm fallback (L3)', () => {
  it('follows src/terms.ts when the date is known', () => {
    expect(calendarOpenTerm(new Date('2026-09-24T12:00:00Z'), 'quarter')).toEqual({ season: 'Winter', year: 2027 })
  })

  it('falls back to next year\'s Fall, never a closed term', () => {
    const next = new Date().getUTCFullYear() + 1
    expect(calendarOpenTerm(new Date(NaN), 'quarter')).toEqual({ season: 'Fall', year: next })
    expect(calendarOpenTerm(new Date(NaN), 'semester')).toEqual({ season: 'Fall', year: next })
    // pre-1 AD date: pacificDate is null, fallback keys off that date's UTC year
    expect(calendarOpenTerm(new Date('-000001-12-31T12:00:00Z'), 'quarter')).toEqual({ season: 'Fall', year: 0 })
  })
})
