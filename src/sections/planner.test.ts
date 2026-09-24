import { describe, expect, it } from 'vitest'
import type { Plan, ValidationResult, Violation } from '../engine/types'
import { badgeStatus, deferredOf, optimalNote, splitUnsolvable } from './plannerStatus'

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
    expect(badgeStatus(result(), plan(), 'UC Berkeley')).toEqual({ ok: true, title: 'Every requirement covered', details: [] })
  })

  it('stays green with deferred requirements and non-blocking splits, and names them', () => {
    const current = result({ splitSeriesViolations: [split('PHYSICS 7C', false)], deferred: ['ENGIN 26'] })
    const p = plan({}, { splitSeriesViolations: [split('PHYSICS 7C', false)], deferred: ['ENGIN 26', 'ENGIN 29'] })
    expect(badgeStatus(current, p, 'UC Berkeley'))
      .toEqual({ ok: true, title: 'Every requirement covered', details: ['2 to complete at UC Berkeley after transfer', '1 warning'] })
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
