import { describe, expect, it } from 'vitest'
import { academicYearOn, agreementYearLabel, dataTrust, formatDataDate, heroDataNote, demoTone, sameTrust, trustBanner, trustChip } from './data-trust'
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
      'The data was prepared by an older version of Articulus',
      'The data has not been checked for errors',
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
    expect(dataTrust(good(), NOW)).toEqual({ level: 'trusted', reasons: [], fetchedAt: new Date('2026-09-24T08:00:00Z'), academicYear: '2026-2027', yearNote: null })
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
      .toMatchObject({ level: 'untrusted', reasons: ['The data was prepared by an older version of Articulus'] })
  })
})

describe('dataTrust: importer version and schema', () => {
  it('rejects an older, newer, missing or malformed normalizeVersion', () => {
    expect(dataTrust(good({ normalizeVersion: 1 }), NOW, 2).reasons).toEqual(['The data was prepared by an older version of Articulus'])
    expect(dataTrust(good({ normalizeVersion: 3 }), NOW, 2).reasons).toEqual(['The data was prepared by a different version of Articulus than this page'])
    expect(dataTrust(good({ normalizeVersion: '2' }), NOW, 2).reasons).toEqual(['The data was prepared by a different version of Articulus than this page'])
    expect(dataTrust(good({ normalizeVersion: 1.5 }), NOW, 2).reasons).toEqual(['The data was prepared by a different version of Articulus than this page'])
    expect(dataTrust(good({ normalizeVersion: undefined }), NOW, 2).reasons).toEqual(['It is not recorded which version of Articulus prepared the data'])
    expect(dataTrust(good({ normalizeVersion: null }), NOW, 2).reasons).toEqual(['It is not recorded which version of Articulus prepared the data'])
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
    expect(dataTrust(good({ validation: null }), NOW).reasons).toEqual(['The data has not been checked for errors'])
    expect(dataTrust(good({ validation: undefined }), NOW).reasons).toEqual(['The data has not been checked for errors'])
    expect(dataTrust(good({ validation: true }), NOW).reasons).toEqual(['The data has not been checked for errors'])
    expect(dataTrust(good({ validation: { passed: false, at: '2026-09-24T08:05:00Z' } }), NOW).reasons).toEqual(['The data failed its error check'])
    expect(dataTrust(good({ validation: {} }), NOW).reasons).toEqual(['The result of the data error check is not recorded'])
    expect(dataTrust(good({ validation: { passed: null } }), NOW).reasons).toEqual(['The result of the data error check is not recorded'])
  })

  it('treats passed strictly as a boolean, and says a wrong type is unreadable rather than "failed" (L-3)', () => {
    for (const passed of ['true', 1, 'yes', {}, []]) {
      const t = dataTrust(good({ validation: { passed } }), NOW)
      expect(t.level).toBe('untrusted')
      expect(t.reasons).toEqual(['The result of the data error check is not a plain yes or no, so it cannot be read'])
    }
  })
})

describe('dataTrust: agreement count (L-3)', () => {
  it('matches meta.agreements against the bundled index when a count is given', () => {
    expect(dataTrust(good(), NOW, NORMALIZE_VERSION, 22).level).toBe('trusted')
    expect(dataTrust(good({ agreements: 21 }), NOW, NORMALIZE_VERSION, 22))
      .toMatchObject({ level: 'untrusted', reasons: ['The data description lists 21 agreements, but 22 are included'] })
    for (const agreements of [undefined, null, '22', 2.5, -1])
      expect(dataTrust(good({ agreements }), NOW, NORMALIZE_VERSION, 22).reasons).toEqual(['The number of agreements in the data is not recorded'])
  })

  it('skips the check when no count is given (older callers)', () => {
    expect(dataTrust(good({ agreements: 3 }), NOW).level).toBe('trusted')
  })

  it('the legacy file still lists the right count', () => {
    expect(dataTrust(legacyMeta, NOW, NORMALIZE_VERSION, 22).reasons.some((r) => /agreements in|agreements, but/.test(r))).toBe(false)
  })
})

describe('sameTrust (periodic re-check)', () => {
  it('is true only when level, reasons and dates match', () => {
    const t = dataTrust(good(), NOW)
    expect(sameTrust(t, dataTrust(good(), NOW))).toBe(true)
    expect(sameTrust(t, dataTrust(good(), new Date(NOW.getTime() + 60_000)))).toBe(true)
    // a tab left open for 8 days downgrades
    expect(sameTrust(t, dataTrust(good(), new Date(NOW.getTime() + 8 * DAY)))).toBe(false)
    expect(sameTrust(dataTrust(good(), new Date(NOW.getTime() + 9 * DAY)), dataTrust(good(), new Date(NOW.getTime() + 10 * DAY)))).toBe(false)
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

  it('rolls over on July 1 UTC: data fetched the day before is aging with a year caveat, for a short grace period (M-6)', () => {
    const meta = good({ fetchedAt: '2026-06-30T12:00:00Z', academicYear: { id: 76, code: '2025-2026' } })
    expect(dataTrust(meta, new Date('2026-06-30T23:59:59Z'))).toMatchObject({ level: 'trusted', yearNote: null })
    expect(dataTrust(meta, new Date('2026-07-01T00:00:00Z'))).toMatchObject({
      level: 'aging', yearNote: '2026-27 agreements are now in effect but not downloaded yet',
      reasons: ['2026-27 agreements are now in effect but not downloaded yet; showing 2025-26. Articulation can change between years'],
    })
    // the pipeline has had a week to refresh or carry over explicitly; an unmarked prior year is now the wrong year
    expect(dataTrust(meta, new Date('2026-07-08T00:00:00Z')).level).toBe('aging')
    expect(dataTrust(meta, new Date('2026-07-08T00:00:00.001Z')))
      .toMatchObject({ level: 'untrusted', reasons: ['Data is for 2025-2026 but 2026-2027 agreements are in effect'], yearNote: null })
  })

  it('an unmarked prior year fetched after July 1 is the wrong year', () => {
    expect(dataTrust(good({ fetchedAt: '2026-07-02T00:00:00Z', academicYear: { id: 76, code: '2025-2026' } }), new Date('2026-07-03T00:00:00Z')))
      .toMatchObject({ level: 'untrusted', reasons: ['Data is for 2025-2026 but 2026-2027 agreements are in effect'] })
  })

  it('rejects data for a future year', () => {
    expect(dataTrust(good({ academicYear: { id: 78, code: '2027-2028' } }), NOW).reasons)
      .toEqual(['Data is for 2027-2028 but 2026-2027 agreements are in effect'])
  })
})

describe('dataTrust: carried-over prior year (M-6)', () => {
  const carried = (over: Record<string, unknown> = {}) =>
    good({ academicYear: { id: 76, code: '2025-2026' }, yearInEffect: '2026-2027', carriedOver: true, ...over })

  it('is aging, not untrusted, with a plain caveat naming both years', () => {
    const t = dataTrust(carried(), NOW)
    expect(t).toMatchObject({
      level: 'aging', academicYear: '2025-2026', yearNote: "2026-27 agreements aren't published on ASSIST yet",
      reasons: ["2026-27 agreements aren't published on ASSIST yet; showing 2025-26. Articulation can change between years"],
    })
    expect(trustBanner(t)).toMatchObject({ tone: 'warn', headline: 'ASSIST data from Sep 24, 2026 (2025-2026 agreements).' })
    expect(trustChip(t)).toBe('Using 2025-26 agreements')
    expect(agreementYearLabel('2025-2026', t)).toBe("2025-26 agreement (2026-27 agreements aren't published on ASSIST yet)")
  })

  it('stays aging for as long as the pipeline keeps re-checking, from July 1 UTC on', () => {
    expect(dataTrust(carried({ fetchedAt: '2026-07-01T00:00:00Z' }), new Date('2026-07-01T00:00:00Z')).level).toBe('aging')
    expect(dataTrust(carried({ fetchedAt: '2026-11-20T00:00:00Z' }), new Date('2026-11-21T00:00:00Z')).level).toBe('aging')
  })

  it('adds the age caveat when the carried-over data is also more than 7 days old, and is untrusted past 30', () => {
    expect(dataTrust(carried({ fetchedAt: '2026-09-12T08:00:00Z' }), NOW).reasons).toEqual([
      "2026-27 agreements aren't published on ASSIST yet; showing 2025-26. Articulation can change between years", 'Data is 12 days old'])
    expect(dataTrust(carried({ fetchedAt: '2026-08-01T08:00:00Z' }), NOW).level).toBe('untrusted')
  })

  it('keeps data two or more years back untrusted, carried over or not', () => {
    for (const over of [{}, { carriedOver: false }]) {
      const t = dataTrust(carried({ academicYear: { id: 75, code: '2024-2025' }, ...over }), NOW)
      expect(t).toMatchObject({ level: 'untrusted', reasons: ['Data is for 2024-2025 but 2026-2027 agreements are in effect'], yearNote: null })
      expect(agreementYearLabel('2024-2025', t)).toBe('2024-25 agreement')
    }
    // a carry-over mark from last year does not stretch into the next rollover
    expect(dataTrust(carried({ fetchedAt: '2027-06-30T00:00:00Z' }), new Date('2027-06-30T23:59:59Z')).level).toBe('aging')
    expect(dataTrust(carried({ fetchedAt: '2027-06-30T00:00:00Z' }), new Date('2027-07-01T00:00:00Z')))
      .toMatchObject({ level: 'untrusted', reasons: ['Data is for 2025-2026 but 2027-2028 agreements are in effect'] })
  })

  it('the plan label shows the year used, with no note when the data is current', () => {
    expect(agreementYearLabel('2026-2027', dataTrust(good(), NOW))).toBe('2026-27 agreement')
  })
})

describe('dataTrust: academic year (malformed)', () => {
  it('rejects a missing or malformed academic year', () => {
    for (const academicYear of [null, undefined, '2026-2027', { id: 77 }, { code: 2026 }, { code: '2026-27' }, { code: '2026-2028' }, { code: ' 2026-2027' }]) {
      const t = dataTrust(good({ academicYear }), NOW)
      expect(t.reasons).toEqual(['The academic year of the data is not recorded'])
      expect(t.academicYear).toBeNull()
    }
  })
})

describe('banner text', () => {
  it('says plainly that completion cannot be confirmed, and lists every reason, when untrusted (L-2)', () => {
    const b = trustBanner(dataTrust(legacyMeta, NOW))
    expect(b.tone).toBe('alert')
    expect(b.headline).toBe("We can't confirm a plan is complete right now: the data was prepared by an older version of Articulus; the data has not been checked for errors; "
      + 'the date the data was downloaded from ASSIST is not recorded; data is for 2025-2026 but 2026-2027 agreements are in effect. Confirm with a counselor.')
    expect(b.detail).toBe('ASSIST data: 2025-2026 agreements. Split series and courses you still need are still flagged, but no plan is marked complete until the data is refreshed.')
    expect(trustChip(dataTrust(legacyMeta, NOW))).toBe("Can't confirm plans: data needs a refresh")
    for (const text of [b.headline, b.detail, trustChip(dataTrust(legacyMeta, NOW))!]) expect(text).not.toMatch(/paused|importer|validation|schema/i)
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

  it('describes the hero example source from the trust state (L-1)', () => {
    expect(heroDataNote(dataTrust(legacyMeta, NOW))).toBe('From the bundled 2025-2026 ASSIST data, which needs a refresh.')
    expect(heroDataNote(dataTrust(good(), NOW))).toBe('From 2026-2027 ASSIST data downloaded Sep 24, 2026.')
    expect(heroDataNote(dataTrust(good({ fetchedAt: '2026-09-12T08:00:00Z' }), NOW))).toBe('From 2026-2027 ASSIST data downloaded Sep 12, 2026.')
  })

  it('formats dates in UTC', () => {
    expect(formatDataDate(new Date('2026-09-24T23:30:00Z'))).toBe('Sep 24, 2026')
    expect(formatDataDate(new Date('2026-09-25T00:30:00Z'))).toBe('Sep 25, 2026')
  })
})

describe('demoTone (L-5)', () => {
  it('never shows a green pass on untrusted data', () => {
    expect(demoTone(true, 'untrusted')).toBe('illustration')
    expect(demoTone(true, 'aging')).toBe('ok')
    expect(demoTone(true, 'trusted')).toBe('ok')
    expect(demoTone(false, 'trusted')).toBe('split')
  })
})
