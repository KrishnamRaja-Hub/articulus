import { describe, expect, it } from 'vitest'
import { candidateYears, codeInEffect, parseAcademicYears } from './academic-year.ts'

describe('academic year (July-1 rule, DATA_CONTRACT.md)', () => {
  it('switches on July 1 UTC', () => {
    expect(codeInEffect(new Date('2026-06-30T23:59:59Z'))).toBe('2025-2026')
    expect(codeInEffect(new Date('2026-07-01T00:00:00Z'))).toBe('2026-2027')
    expect(codeInEffect(new Date('2027-01-15T00:00:00Z'))).toBe('2026-2027')
  })
  it('parses the ASSIST shape and camelCase / code variants', () => {
    expect(parseAcademicYears([{ Id: 76, FallYear: 2025 }])).toEqual([{ id: 76, code: '2025-2026' }])
    expect(parseAcademicYears([{ id: 77, fallYear: 2026 }])).toEqual([{ id: 77, code: '2026-2027' }])
    expect(parseAcademicYears({ academicYears: [{ id: 5, code: '2001-2002' }] })).toEqual([{ id: 5, code: '2001-2002' }])
  })
  it('fails loudly when the endpoint shape changes', () => {
    expect(() => parseAcademicYears({})).toThrow(/non-empty array/)
    expect(() => parseAcademicYears([{ Id: '76', FallYear: 2025 }])).toThrow(/integer id/)
    expect(() => parseAcademicYears([{ Id: 76, Year: '2025' }])).toThrow(/FallYear/)
    expect(() => parseAcademicYears([{ Id: 76, code: '2025-2027' }])).toThrow(/FallYear/)
  })
  const years = [{ id: 75, code: '2024-2025' }, { id: 76, code: '2025-2026' }, { id: 77, code: '2026-2027' }]
  it('tries the year in effect first, then the prior year as the explicit carry-over (M-6)', () => {
    expect(candidateYears(years, new Date('2026-09-24Z')).map((y) => y.id)).toEqual([77, 76])
    expect(candidateYears(years, new Date('2026-03-01Z')).map((y) => y.id)).toEqual([76, 75])
    // the rollover boundary, in UTC
    expect(candidateYears(years, new Date('2026-06-30T23:59:59Z'))[0].code).toBe('2025-2026')
    expect(candidateYears(years, new Date('2026-07-01T00:00:00Z'))[0].code).toBe('2026-2027')
  })
  it('carries over the prior year when ASSIST does not list the year in effect yet', () => {
    expect(candidateYears(years.slice(0, 2), new Date('2026-07-01T00:00:00Z'))).toEqual([{ id: 76, code: '2025-2026' }])
  })
  it('never falls back two or more years', () => {
    expect(() => candidateYears(years.slice(0, 1), new Date('2026-09-24Z'))).toThrow(/neither 2026-2027 .* nor the carry-over year 2025-2026/)
  })
  it('a pinned id is the only candidate, and must be listed', () => {
    expect(candidateYears(years, new Date('2026-09-24Z'), 75)).toEqual([{ id: 75, code: '2024-2025' }])
    expect(() => candidateYears(years, new Date('2026-09-24Z'), 99)).toThrow(/pinned id 99/)
  })
})
