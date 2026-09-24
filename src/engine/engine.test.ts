import { describe, expect, it } from 'vitest'
import me from '../../data/agreements/79-mechanical-engineering-b-s.json'
import institutions from '../../data/institutions.json'
import type { Agreement, Institution } from './types'
import { verifySchedule } from './verify'
import { solve } from './solve'
import { normalize, templateMismatches, type RawPayload } from './normalize'

const A = me as unknown as Agreement
const DA = 113, FH = 51, SM = 137
const unitSystems = Object.fromEntries((institutions as Institution[]).map((i) => [i.id, i.terms]))

describe('verifySchedule', () => {
  it('flags Scenario 2: PHYS 4B at De Anza + PHYS 4C at Foothill is a split series', () => {
    const r = verifySchedule(new Set([`${DA}:PHYS 4B`, `${FH}:PHYS 4C`]), A)
    const v = r.splitSeriesViolations.find((v) => v.requirementId === 'PHYSICS 7B')
    expect(v).toBeDefined()
    expect(new Set(v!.partials.map((p) => p.institutionId))).toEqual(new Set([DA, FH]))
    expect(r.isValid).toBe(false)
  })
  it('same series at one college satisfies PHYSICS 7B with no violation', () => {
    const r = verifySchedule(new Set([`${DA}:PHYS 4B`, `${DA}:PHYS 4C`]), A)
    expect(r.satisfied['PHYSICS 7B']?.institutionId).toBe(DA)
    expect(r.splitSeriesViolations).toHaveLength(0)
  })
  it('regular and honors may be combined within one college, per the ASSIST note', () => {
    const r = verifySchedule(new Set([`${DA}:MATH 1B`, `${DA}:MATH 1CH`]), A)
    expect(r.satisfied['MATH 52']?.institutionId).toBe(DA)
    expect(r.splitSeriesViolations).toHaveLength(0)
  })
  it('different UC requirements may be satisfied at different colleges', () => {
    const r = verifySchedule(new Set([`${FH}:PHYS 4A`, `${DA}:PHYS 4B`, `${DA}:PHYS 4C`]), A)
    expect(r.satisfied['PHYSICS 7A']?.institutionId).toBe(FH)
    expect(r.satisfied['PHYSICS 7B']?.institutionId).toBe(DA)
    expect(r.splitSeriesViolations).toHaveLength(0)
  })
  it('split partials name only courses actually taken, one partial per college', () => {
    const r = verifySchedule(new Set([`${DA}:MATH 1B`, `${FH}:MATH 1C`]), A)
    const v = r.splitSeriesViolations.find((v) => v.requirementId === 'MATH 52')!
    expect(v.partials.map((p) => p.institutionId).sort()).toEqual([FH, DA].sort())
    expect(v.partials.flatMap((p) => p.have).sort()).toEqual([`${DA}:MATH 1B`, `${FH}:MATH 1C`].sort())
    expect(v.partials.find((p) => p.institutionId === DA)!.missing).toEqual([`${DA}:MATH 1C`])
  })
  it('one De Anza course can serve two UC requirements', () => {
    const r = verifySchedule(new Set([`${DA}:MATH 1A`, `${DA}:MATH 1B`, `${DA}:MATH 1C`]), A)
    expect(r.satisfied['MATH 51']).toBeDefined()
    expect(r.satisfied['MATH 52']).toBeDefined()
  })
})

describe('solve', () => {
  const plan = solve(new Set([`${DA}:PHYS 4A`]), A, { allowed: [DA, FH], home: DA })
  it('respects the unit cap and sequence order', () => {
    for (const t of plan.terms) expect(t.units).toBeLessThanOrEqual(16)
    const termOf = (c: string) => plan.terms.findIndex((t) => t.courses.includes(c))
    expect(termOf(`${DA}:PHYS 4B`)).toBeLessThan(termOf(`${DA}:PHYS 4C`))
    const inst = plan.chosen['MATH 52'].institutionId
    expect(termOf(`${inst}:MATH 1B`)).toBeLessThan(termOf(`${inst}:MATH 1C`))
  })
  it('produces a plan that verifies clean and never splits a series', () => {
    expect(plan.result.splitSeriesViolations).toHaveLength(0)
    expect(plan.result.missing).toHaveLength(0)
    expect(plan.unsolvable).toHaveLength(0)
    expect(plan.result.isValid).toBe(true)
  })
  it('repairs Scenario 2 by completing the series at one college', () => {
    const p = solve(new Set([`${DA}:PHYS 4A`, `${DA}:PHYS 4B`, `${FH}:PHYS 4C`]), A, { allowed: [DA, FH], home: DA })
    expect(p.chosen['PHYSICS 7B'].institutionId).toBe(DA)
    expect(p.result.isValid).toBe(true)
  })
})

describe('term systems', () => {
  it('semester home: cap 12, Fall/Spring alternating', () => {
    const p = solve(new Set(), A, { allowed: [SM], home: SM, termSystem: 'semester', unitSystems, startTerm: { season: 'Fall', year: 2026 } })
    expect(p.terms.length).toBeGreaterThan(1)
    p.terms.forEach((t, i) => {
      expect(t.units).toBeLessThanOrEqual(12)
      expect(t.name).toBe(`${i % 2 ? 'Spring' : 'Fall'} ${2026 + Math.ceil(i / 2)}`)
    })
  })
  it('mixed: semester home + quarter De Anza plans clean', () => {
    const p = solve(new Set(), A, { allowed: [SM, DA], home: SM, termSystem: 'semester', unitSystems })
    expect(p.result.isValid).toBe(true)
    expect(p.result.splitSeriesViolations).toHaveLength(0)
    for (const t of p.terms) expect(t.units).toBeLessThanOrEqual(12)
  })
  it('a 4-unit semester course counts 6 units in a quarter plan', () => {
    // One with no inferred enrollment prerequisite at SMC (those are planned and counted too, prereq.ts).
    const p = Object.entries(A.catalog).filter(([, c]) => c.institutionId === SM && c.units === 4)
      .map(([id, c]) => solve(new Set(), { ...A, root: { kind: 'node', type: 'AND', required: true, children: [{ kind: 'req', id: 'X', label: 'X', units: 4, groups: [{ institutionId: c.institutionId, courses: [id] }] }] } }, { allowed: [SM], termSystem: 'quarter', unitSystems }))
      .find((q) => !q.prereqOnly)!
    expect(p.totalUnits).toBe(6)
  })
})

describe('normalize', () => {
  const cell = (n: string) => ({ type: 'Course', id: n, course: { prefix: 'MATH', courseNumber: n, courseTitle: n, minUnits: 4, maxUnits: 4 } })
  const payload = (inst: number, rows: string[]): RawPayload => ({ result: {
    name: 'Test', articulations: '[]', academicYear: '{"code":"2025-2026"}', receivingInstitution: '{"id":79}',
    sendingInstitution: JSON.stringify({ id: inst }),
    templateAssets: JSON.stringify([
      { type: 'RequirementTitle', position: 0, content: 'Required' },
      { type: 'RequirementGroup', position: 1, sections: [{ type: 'Section', position: 0, rows: rows.map((n) => ({ cells: [cell(n)] })) }] },
    ]),
  } })
  it('flags colleges whose requirement template differs from the first', () => {
    expect(templateMismatches([payload(DA, ['1A', '1B']), payload(FH, ['1A', '1B'])])).toEqual([])
    expect(templateMismatches([payload(DA, ['1A', '1B']), payload(FH, ['1A', '1B']), payload(SM, ['1A'])])).toEqual([SM])
    expect(normalize([payload(DA, ['1A']), payload(FH, ['1A'])]).root.children).toHaveLength(1)
  })
})
