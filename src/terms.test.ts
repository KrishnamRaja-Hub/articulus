import { describe, expect, it } from 'vitest'
import { nextOpenTerm, nextTerm, parseTermKey, seasonsOf, termKey, termLabel, termsFrom } from './terms'

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

  it('reads the date in UTC', () => {
    expect(nextOpenTerm(new Date('2026-09-19T23:59:59Z'), 'quarter')).toEqual({ season: 'Fall', year: 2026 })
    expect(nextOpenTerm(new Date('2026-09-19T17:00:00-07:00'), 'quarter')).toEqual({ season: 'Winter', year: 2027 })
  })

  it('is null for an invalid clock', () => {
    expect(nextOpenTerm(new Date(NaN), 'quarter')).toBeNull()
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
