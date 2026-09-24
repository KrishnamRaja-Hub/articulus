import { describe, expect, it } from 'vitest'
import type { Plan, ValidationResult, Violation } from '../engine/types'
import { badgeStatus, CAVEAT, deferredOf, nothingLeftNote, optimalNote, splitUnsolvable, UNCONFIRMED_TITLE } from './plannerStatus'
import type { TrustLevel } from '../data-trust'
import { dataTrust } from '../data-trust'
import { verifySchedule } from '../engine/verify'
import { solve } from '../engine/solve'
import type { Agreement, Institution } from '../engine/types'
import bundledMeta from '../../data/meta.json'
import institutionsJson from '../../data/institutions.json'
import uclaMe from '../../data/agreements/117-mechanical-engineering-b-s.json'

const result = (over: Partial<ValidationResult> = {}): ValidationResult =>
  ({ isValid: true, satisfied: {}, missing: [], incomplete: {}, splitSeriesViolations: [], deferred: [], ...over })
const plan = (over: Partial<Plan> = {}, res: Partial<ValidationResult> = {}): Plan =>
  ({ terms: [], chosen: {}, result: result(res), totalUnits: 0, unsolvable: [], ...over })
const split = (requirementId: string, blocking: boolean): Violation => ({
  requirementId, label: requirementId, blocking,
  partials: [{ institutionId: 113, have: ['113:PHYS 4B'], missing: ['113:PHYS 4C'] }, { institutionId: 51, have: ['51:PHYS 4C'], missing: ['51:PHYS 4B'] }],
})

describe('badgeStatus', () => {
  it('is green with no details when everything is covered', () => {
    expect(badgeStatus(result(), plan(), 'UC Berkeley')).toEqual({ ok: true, tone: 'ok', title: 'Every requirement covered', details: [] })
  })

  it('stays green with deferred requirements and non-blocking splits, and names them', () => {
    const current = result({ splitSeriesViolations: [split('PHYSICS 7C', false)], deferred: ['ENGIN 26'] })
    const p = plan({}, { splitSeriesViolations: [split('PHYSICS 7C', false)], deferred: ['ENGIN 26', 'ENGIN 29'] })
    expect(badgeStatus(current, p, 'UC Berkeley'))
      .toEqual({ ok: true, tone: 'ok', title: 'Every requirement covered', details: ['2 to complete at UC Berkeley after transfer', '1 warning'] })
  })

  it('is red for a blocking split in the completed courses, even if other splits are warnings', () => {
    const current = result({ isValid: false, splitSeriesViolations: [split('PHYSICS 7B', true), split('PHYSICS 7C', false), split('MATH 53', false)] })
    const s = badgeStatus(current, plan(), 'UCLA')
    expect(s.ok).toBe(false)
    expect(s.title).toBe('1 split-series violation in your completed courses')
    expect(s.details).toEqual(['2 warnings'])
  })

  it('treats a violation without the blocking flag as blocking (older engine)', () => {
    const v = { ...split('PHYSICS 7B', true) } as Partial<Violation>
    delete v.blocking
    expect(badgeStatus(result({ splitSeriesViolations: [v as Violation] }), plan(), 'UCLA').ok).toBe(false)
  })

  it('is red for unsolvable requirements, blocking planned splits, or an invalid plan', () => {
    expect(badgeStatus(result(), plan({ unsolvable: ['CHEM 1A — offered at Foothill'] }), 'UCLA'))
      .toMatchObject({ ok: false, title: 'Some requirements cannot be met at the selected colleges' })
    expect(badgeStatus(result(), plan({}, { splitSeriesViolations: [split('MATH 52', true)] }), 'UCLA'))
      .toMatchObject({ ok: false, title: 'The planned schedule still splits MATH 52 across colleges' })
    expect(badgeStatus(result(), plan({}, { isValid: false }), 'UCLA'))
      .toMatchObject({ ok: false, title: 'The plan does not complete every requirement' })
  })

  it('ignores non-blocking splits in the plan and never lets deferred items turn it red', () => {
    const p = plan({}, { splitSeriesViolations: [split('PHYSICS 7C', false)], deferred: ['ENGIN 26'] })
    expect(badgeStatus(result(), p, 'UCLA').ok).toBe(true)
  })
})

describe('badgeStatus with data trust', () => {
  const LEVELS: TrustLevel[] = ['trusted', 'aging', 'untrusted']
  const green = () => [result(), plan()] as const
  const reds = {
    'blocking split': [result({ isValid: false, splitSeriesViolations: [split('PHYSICS 7B', true)] }), plan()],
    unsolvable: [result(), plan({ unsolvable: ['CHEM 1A — offered at Foothill'] })],
    'planned split': [result(), plan({}, { splitSeriesViolations: [split('MATH 52', true)] })],
    'invalid plan': [result(), plan({}, { isValid: false })],
  } as const

  it('defaults to trusted, so existing callers are unchanged', () => {
    expect(badgeStatus(...green(), 'UCLA')).toEqual(badgeStatus(...green(), 'UCLA', 'trusted'))
  })

  it('green stays green when trusted, gains a caveat when aging, and is never green when untrusted', () => {
    expect(badgeStatus(...green(), 'UCLA', 'trusted')).toEqual({ ok: true, tone: 'ok', title: 'Every requirement covered', details: [] })
    expect(badgeStatus(...green(), 'UCLA', 'aging')).toEqual({ ok: true, tone: 'ok', title: 'Every requirement covered', details: [], caveat: CAVEAT.aging })
    const s = badgeStatus(...green(), 'UCLA', 'untrusted')
    expect(s).toEqual({ ok: false, tone: 'unconfirmed', title: "Can't confirm — data needs refresh", details: [], caveat: CAVEAT.unconfirmed })
    expect(s.title).toBe(UNCONFIRMED_TITLE)
    expect(s.title).not.toMatch(/covered/i)
  })

  it('keeps deferred and warning details in every trust level', () => {
    const current = result({ splitSeriesViolations: [split('PHYSICS 7C', false)], deferred: ['ENGIN 26'] })
    for (const t of LEVELS) expect(badgeStatus(current, plan(), 'UCLA', t).details).toEqual(['1 to complete at UCLA after transfer', '1 warning'])
  })

  for (const [name, [cur, p]] of Object.entries(reds)) {
    it(`red (${name}) stays red in every trust level; untrusted adds the caveat`, () => {
      const base = badgeStatus(cur, p, 'UCLA')
      expect(base.tone).toBe('problem')
      for (const t of LEVELS) {
        const s = badgeStatus(cur, p, 'UCLA', t)
        expect(s).toMatchObject({ ok: false, tone: 'problem', title: base.title, details: base.details })
        expect(s.caveat).toBe(t === 'untrusted' ? CAVEAT.problem : undefined)
      }
    })
  }

  it('ok is true only for tone ok, in every combination', () => {
    for (const t of LEVELS) for (const [cur, p] of [green(), ...Object.values(reds)]) {
      const s = badgeStatus(cur, p, 'UCLA', t)
      expect(s.ok).toBe(s.tone === 'ok')
      if (t === 'untrusted') expect(s.ok).toBe(false)
    }
  })

  it('never says "Everything required is already complete" on untrusted data', () => {
    expect(nothingLeftNote()).toBe('Everything required is already complete. Nothing left to schedule.')
    expect(nothingLeftNote('aging')).toBe('Everything required is already complete. Nothing left to schedule.')
    expect(nothingLeftNote('untrusted')).not.toMatch(/complete\./)
  })
})

describe('CRITICAL-1: UCLA ME with no calculus on the bundled data', () => {
  const a = uclaMe as unknown as Agreement
  const institutions = institutionsJson as Institution[]
  const unitSystems = Object.fromEntries(institutions.map((i) => [i.id, i.terms]))
  const all = institutions.filter((i) => i.isCC).map((i) => i.id)
  const taken = new Set(['113:CHEM 1A', '113:CHEM 1B', '113:CHEM 1C', '113:ENGL C1000', '113:CIS 22B', '51:ENGR 11', '51:ENGR 37L',
    '51:ENGR 47', '114:ENGIN 230', '114:ENGIN 257', '114:ENGIN 240', '113:PHYS 4A', '113:PHYS 4B', '113:PHYS 4C'])

  // the legacy file as committed before the refresh (DATA_CONTRACT.md); the literal keeps this test meaningful after one
  const legacyMeta = { schema: 1, normalizeVersion: 1, fetchedAt: null, academicYear: { id: 76, code: '2025-2026' }, validation: null, agreements: 22 }

  // only while the bundled fixtures are the legacy ones: a refresh fixes the tree and this repro no longer applies
  it.runIf(bundledMeta.normalizeVersion === 1)('the stale fixture still lets the engine say valid (the data bug this guard exists for)', () => {
    expect(verifySchedule(taken, a).isValid).toBe(true)
  })

  it('is not green, and does not claim coverage, under the legacy meta.json', () => {
    const trust = dataTrust(legacyMeta, new Date())
    expect(trust.level).toBe('untrusted')
    const current = verifySchedule(taken, a)
    const p = solve(taken, a, { allowed: all, home: 113, unitCap: 16, maxTerms: 6, termSystem: 'quarter', unitSystems })
    const s = badgeStatus(current, p, 'UCLA', trust.level)
    expect(s.ok).toBe(false)
    expect(s.tone).toBe('unconfirmed')
    expect(s.title).not.toMatch(/covered/i)
    // with nothing taken and every college allowed, the report saw a green 59-unit plan with no math
    const empty = solve(new Set(), a, { allowed: all, home: 113, unitCap: 16, maxTerms: 6, termSystem: 'quarter', unitSystems })
    expect(badgeStatus(verifySchedule(new Set(), a), empty, 'UCLA', trust.level).ok).toBe(false)
  })
})

describe('helpers', () => {
  it('merges deferred ids from the plan and the completed courses without duplicates', () => {
    expect(deferredOf(result({ deferred: ['A', 'B'] }), plan({}, { deferred: ['B', 'C'] }))).toEqual(['B', 'C', 'A'])
  })

  it('only claims minimum units when proven', () => {
    expect(optimalNote(plan({ optimal: true }))).toBe('minimum units')
    expect(optimalNote(plan({ optimal: false }))).toBe('near-minimum')
    expect(optimalNote(plan())).toBeNull()
  })

  it('splits the "offered at" suffix off unsolvable entries', () => {
    expect(splitUnsolvable('CHEM 1A — offered at Foothill, De Anza')).toEqual({ what: 'CHEM 1A', offeredAt: 'Foothill, De Anza' })
    expect(splitUnsolvable('2 of: MATH 1A, MATH 1B')).toEqual({ what: '2 of: MATH 1A, MATH 1B' })
  })
})
