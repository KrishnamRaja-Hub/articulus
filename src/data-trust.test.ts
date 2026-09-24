import { describe, expect, it } from 'vitest'
import { academicYearOn, dataTrust, formatDataDate, trustBanner, trustChip } from './data-trust'
import { NORMALIZE_VERSION } from './engine/normalize'

// data/meta.json as committed before the normalize fixes were re-fetched (DATA_CONTRACT.md "legacy file")
const legacyMeta = { schema: 1, normalizeVersion: 1, fetchedAt: null, academicYear: { id: 76, code: '2025-2026' }, validation: null, agreements: 22 }

const DAY = 86_400_000
const NOW = new Date('2026-09-24T12:00:00Z')
const ago = (ms: number, now = NOW) => new Date(now.getTime() - ms).toISOString()
const good = (over: Record<string, unknown> = {}) => ({
  schema: 1,
  normalizeVersion: NORMALIZE_VERSION,
  fetchedAt: '2026-09-24T08:00:00Z',
  academicYear: { id: 77, code: '2026-2027' },
  validation: { passed: true, at: '2026-09-24T08:05:00Z', checks: 1234, report: 'data/validation-report.json' },
  agreements: 22,
  ...over,
})

describe('dataTrust: the legacy data file', () => {
  it('is untrusted, with every reason in plain language', () => {
    const t = dataTrust(legacyMeta, NOW)
    expect(t.level).toBe('untrusted')
    expect(t.fetchedAt).toBeNull()
    expect(t.academicYear).toBe('2025-2026')
    expect(t.reasons).toEqual([
      'Agreement data was built by an older version of the importer',
      'Data has not passed validation',
      'The date the data was downloaded from ASSIST is not recorded',
      'Data is for 2025-2026 but 2026-2027 agreements are in effect',
    ])
  })

  it('stays untrusted on any date, including inside its own academic year', () => {
    for (const d of ['2025-07-01T00:00:00Z', '2026-01-15T00:00:00Z', '2026-06-30T23:59:59Z', '2030-01-01T00:00:00Z'])
      expect(dataTrust(legacyMeta, new Date(d)).level).toBe('untrusted')
  })
})

describe('dataTrust: levels', () => {
  it('trusts a fresh, validated file built by the current importer', () => {
    expect(dataTrust(good(), NOW)).toEqual({ level: 'trusted', reasons: [], fetchedAt: new Date('2026-09-24T08:00:00Z'), academicYear: '2026-2027' })
  })

  it('is trusted at exactly 7 days and aging 1 ms later', () => {
    expect(dataTrust(good({ fetchedAt: ago(7 * DAY) }), NOW).level).toBe('trusted')
    const t = dataTrust(good({ fetchedAt: ago(7 * DAY + 1) }), NOW)
    expect(t).toMatchObject({ level: 'aging', reasons: ['Data is more than 7 days old'] })
  })

  it('names the age in whole days while aging', () => {
    expect(dataTrust(good({ fetchedAt: ago(12 * DAY + 5 * 3600_000) }), NOW).reasons).toEqual(['Data is 12 days old'])
    expect(dataTrust(good({ fetchedAt: ago(8 * DAY) }), NOW).reasons).toEqual(['Data is 8 days old'])
  })

  it('is aging at exactly 30 days and untrusted 1 ms later', () => {
    expect(dataTrust(good({ fetchedAt: ago(30 * DAY) }), NOW)).toMatchObject({ level: 'aging', reasons: ['Data is 30 days old'] })
    expect(dataTrust(good({ fetchedAt: ago(30 * DAY + 1) }), NOW))
      .toMatchObject({ level: 'untrusted', reasons: ['Data is more than 30 days old (it must be refreshed at least every 30 days)'] })
    expect(dataTrust(good({ fetchedAt: ago(45 * DAY) }), new Date('2026-09-24T12:00:00Z')).reasons[0]).toMatch(/^Data is 45 days old/)
  })

  it('treats a download date in the future as untrusted (clock skew or corruption), even by 1 ms', () => {
    expect(dataTrust(good({ fetchedAt: NOW.toISOString() }), NOW).level).toBe('trusted') // exactly now is fine
    const t = dataTrust(good({ fetchedAt: new Date(NOW.getTime() + 1).toISOString() }), NOW)
    expect(t.level).toBe('untrusted')
    expect(t.reasons).toEqual(["The data's download date is in the future, so its age cannot be checked"])
    expect(t.fetchedAt).toEqual(new Date(NOW.getTime() + 1))
    expect(dataTrust(good({ fetchedAt: '2027-01-01T00:00:00Z' }), NOW).level).toBe('untrusted')
  })

  it('evaluates the untrusted rules before aging: a stale importer version wins over fresh data', () => {
    expect(dataTrust(good({ normalizeVersion: NORMALIZE_VERSION - 1, fetchedAt: ago(10 * DAY) }), NOW))
      .toMatchObject({ level: 'untrusted', reasons: ['Agreement data was built by an older version of the importer'] })
  })
})

describe('dataTrust: importer version and schema', () => {
  it('rejects an older, newer, missing or malformed normalizeVersion', () => {
    expect(dataTrust(good({ normalizeVersion: 1 }), NOW, 2).reasons).toEqual(['Agreement data was built by an older version of the importer'])
    expect(dataTrust(good({ normalizeVersion: 3 }), NOW, 2).reasons).toEqual(['Agreement data was built by an importer version this app does not match'])
    expect(dataTrust(good({ normalizeVersion: '2' }), NOW, 2).reasons).toEqual(['Agreement data was built by an importer version this app does not match'])
    expect(dataTrust(good({ normalizeVersion: 1.5 }), NOW, 2).reasons).toEqual(['Agreement data was built by an importer version this app does not match'])
    expect(dataTrust(good({ normalizeVersion: undefined }), NOW, 2).reasons).toEqual(['The importer version that built the data is not recorded'])
    expect(dataTrust(good({ normalizeVersion: null }), NOW, 2).reasons).toEqual(['The importer version that built the data is not recorded'])
  })

  it('compares against the version passed in, defaulting to NORMALIZE_VERSION', () => {
    expect(dataTrust(good({ normalizeVersion: 7 }), NOW, 7).level).toBe('trusted')
    expect(dataTrust(good({ normalizeVersion: NORMALIZE_VERSION }), NOW).level).toBe('trusted')
  })

  it('rejects an unknown schema', () => {
    for (const schema of [2, 0, '1', undefined, null])
      expect(dataTrust(good({ schema }), NOW).reasons).toEqual(['The data description file is in a format this version of the app does not recognize'])
  })

  it('rejects a missing or non-object meta file outright', () => {
    for (const meta of [null, undefined, 'meta', 42, [], true]) {
      const t = dataTrust(meta, NOW)
      expect(t.level).toBe('untrusted')
      expect(t.reasons[0]).toBe('The data description file is missing or unreadable')
      expect(t.fetchedAt).toBeNull()
      expect(t.academicYear).toBeNull()
    }
  })
})

describe('dataTrust: validation', () => {
  it('requires a validation record that passed', () => {
    expect(dataTrust(good({ validation: null }), NOW).reasons).toEqual(['Data has not passed validation'])
    expect(dataTrust(good({ validation: undefined }), NOW).reasons).toEqual(['Data has not passed validation'])
    expect(dataTrust(good({ validation: true }), NOW).reasons).toEqual(['Data has not passed validation'])
    expect(dataTrust(good({ validation: { passed: false, at: '2026-09-24T08:05:00Z' } }), NOW).reasons).toEqual(['Data failed validation'])
    expect(dataTrust(good({ validation: { passed: 'true' } }), NOW).reasons).toEqual(['Data failed validation'])
    expect(dataTrust(good({ validation: {} }), NOW).reasons).toEqual(['Data failed validation'])
  })
})

describe('dataTrust: fetchedAt parsing', () => {
  it('accepts a date or a zoned date-time', () => {
    for (const f of ['2026-09-24', '2026-09-24T08:00Z', '2026-09-24T08:00:00.123Z', '2026-09-24T01:00:00-07:00'])
      expect(dataTrust(good({ fetchedAt: f }), NOW).level).toBe('trusted')
  })

  it('rejects a missing, zone-less, or garbage date', () => {
    expect(dataTrust(good({ fetchedAt: null }), NOW).reasons).toEqual(['The date the data was downloaded from ASSIST is not recorded'])
    expect(dataTrust(good({ fetchedAt: undefined }), NOW).reasons).toEqual(['The date the data was downloaded from ASSIST is not recorded'])
    for (const f of ['2026-09-24T08:00:00', 'yesterday', '', '2026-13-40T00:00:00Z', 1790000000000, {}, '24/09/2026']) {
      const t = dataTrust(good({ fetchedAt: f }), NOW)
      expect(t.reasons).toEqual(['The date the data was downloaded from ASSIST is not readable'])
      expect(t.fetchedAt).toBeNull()
    }
  })

  it('handles zone offsets exactly: 7 days measured in UTC', () => {
    // 2026-09-17T05:00:00-07:00 is 2026-09-17T12:00:00Z, exactly 7 days before NOW
    expect(dataTrust(good({ fetchedAt: '2026-09-17T05:00:00-07:00' }), NOW).level).toBe('trusted')
    expect(dataTrust(good({ fetchedAt: '2026-09-17T04:59:59-07:00' }), NOW).level).toBe('aging')
  })

  it('flags an invalid current date instead of trusting', () => {
    expect(dataTrust(good(), new Date(NaN))).toMatchObject({ level: 'untrusted', reasons: ["This device's date is not valid"] })
  })
})

describe('dataTrust: academic year', () => {
  it('switches on July 1 UTC', () => {
    expect(academicYearOn(new Date('2026-06-30T23:59:59.999Z'))).toBe('2025-2026')
    expect(academicYearOn(new Date('2026-07-01T00:00:00Z'))).toBe('2026-2027')
    expect(academicYearOn(new Date('2026-12-31T23:59:59Z'))).toBe('2026-2027')
    expect(academicYearOn(new Date('2027-01-01T00:00:00Z'))).toBe('2026-2027')
  })

  it('uses UTC, not the local zone: 5 pm June 30 in California is already July 1', () => {
    expect(academicYearOn(new Date('2026-06-30T17:00:00-07:00'))).toBe('2026-2027')
    expect(academicYearOn(new Date('2026-06-30T16:59:59-07:00'))).toBe('2025-2026')
  })

  it('is untrusted the moment the new year starts, even for data fetched the day before', () => {
    const meta = good({ fetchedAt: '2026-06-30T12:00:00Z', academicYear: { id: 76, code: '2025-2026' } })
    expect(dataTrust(meta, new Date('2026-06-30T23:59:59Z')).level).toBe('trusted')
    expect(dataTrust(meta, new Date('2026-07-01T00:00:00Z')))
      .toMatchObject({ level: 'untrusted', reasons: ['Data is for 2025-2026 but 2026-2027 agreements are in effect'] })
  })

  it('rejects data for a future year', () => {
    expect(dataTrust(good({ academicYear: { id: 78, code: '2027-2028' } }), NOW).reasons)
      .toEqual(['Data is for 2027-2028 but 2026-2027 agreements are in effect'])
  })

  it('rejects a missing or malformed academic year', () => {
    for (const academicYear of [null, undefined, '2026-2027', { id: 77 }, { code: 2026 }, { code: '2026-27' }, { code: '2026-2028' }, { code: ' 2026-2027' }]) {
      const t = dataTrust(good({ academicYear }), NOW)
      expect(t.reasons).toEqual(['The academic year of the data is not recorded'])
      expect(t.academicYear).toBeNull()
    }
  })
})

describe('banner text', () => {
  it('pauses verdicts and lists every reason when untrusted', () => {
    const b = trustBanner(dataTrust(legacyMeta, NOW))
    expect(b.tone).toBe('alert')
    expect(b.headline).toBe('Verdicts are paused: agreement data was built by an older version of the importer; data has not passed validation; '
      + 'the date the data was downloaded from ASSIST is not recorded; data is for 2025-2026 but 2026-2027 agreements are in effect. Confirm with a counselor.')
    expect(b.detail).toBe('ASSIST data: 2025-2026 agreements. Split-series and missing-course warnings still show; no plan is marked complete until the data is refreshed.')
    expect(trustChip(dataTrust(legacyMeta, NOW))).toBe('Verdicts paused: data needs a refresh')
  })

  it('names the download date when an untrusted file has one', () => {
    const b = trustBanner(dataTrust(good({ fetchedAt: '2026-07-01T08:00:00Z', academicYear: { code: '2026-2027' } }), NOW))
    expect(b.detail).toMatch(/^ASSIST data: 2026-2027 agreements, downloaded Jul 1, 2026\./)
  })

  it('is amber with the date and age when aging', () => {
    const t = dataTrust(good({ fetchedAt: '2026-09-12T08:00:00Z' }), NOW)
    expect(trustBanner(t)).toEqual({
      tone: 'warn',
      headline: 'ASSIST data from Sep 12, 2026 (2026-2027 agreements).',
      detail: 'Data is 12 days old. Agreements can change, so confirm with a counselor before enrolling.',
    })
    expect(trustChip(t)).toBe('ASSIST data from Sep 12, 2026')
  })

  it('is quiet when trusted', () => {
    const t = dataTrust(good(), NOW)
    expect(trustBanner(t)).toEqual({ tone: 'quiet', headline: 'ASSIST data updated Sep 24, 2026 (2026-2027 agreements).', detail: '' })
    expect(trustChip(t)).toBeNull()
  })

  it('formats dates in UTC', () => {
    expect(formatDataDate(new Date('2026-09-24T23:30:00Z'))).toBe('Sep 24, 2026')
    expect(formatDataDate(new Date('2026-09-25T00:30:00Z'))).toBe('Sep 25, 2026')
  })
})
