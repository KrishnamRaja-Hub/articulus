import { describe, expect, it } from 'vitest'
import me from '../../data/agreements/79-mechanical-engineering-b-s.json'
import mae from '../../data/agreements/7-mae-mechanical-engineering-b-s.json'
import mcs from '../../data/agreements/7-mathematics-computer-science-b-s.json'
import type { Agreement, ReqNode, Requirement } from './types'
import { has, honorsColleges, honorsMix, reqStatus, verifySchedule } from './verify'

const ME = me as unknown as Agreement, MAE = mae as unknown as Agreement, MCS = mcs as unknown as Agreement
const DA = 113, FH = 51
const reqs = (n: ReqNode | Requirement): Requirement[] => (n.kind === 'req' ? [n] : n.children.flatMap(reqs))
const req = (a: Agreement, id: string) => reqs(a.root).find((r) => r.id === id)!

describe('honors mix is per college (F-04)', () => {
  it('De Anza MATH 1CH + 1D does not satisfy UCSD MATH 20E: De Anza lists no honors twin there', () => {
    const r = verifySchedule(new Set([`${DA}:MATH 1CH`, `${DA}:MATH 1D`]), MAE)
    expect(r.satisfied['MATH 20E']).toBeUndefined()
  })
  it('Foothill MATH 1B + 1CH does not satisfy Berkeley MATH 52: only De Anza has the honors twin', () => {
    const r = verifySchedule(new Set([`${FH}:MATH 1B`, `${FH}:MATH 1CH`]), ME)
    expect(r.satisfied['MATH 52']).toBeUndefined()
  })
  it('De Anza, which has the twin, still mixes regular and honors', () => {
    expect(reqStatus(req(ME, 'MATH 52'), new Set([`${DA}:MATH 1BH`, `${DA}:MATH 1C`])).satisfied?.institutionId).toBe(DA)
  })
  it('honorsColleges names the colleges with a twin; has honours a set, and a boolean as before', () => {
    const m = req(ME, 'MATH 52')
    expect(honorsColleges(m).has(DA)).toBe(true)
    expect(honorsColleges(m).has(FH)).toBe(false)
    expect(honorsMix(m)).toBe(true)
    const t = new Set([`${DA}:MATH 1CH`, `${FH}:MATH 1CH`])
    expect(has(t, `${DA}:MATH 1C`, honorsColleges(m))).toBe(true)
    expect(has(t, `${FH}:MATH 1C`, honorsColleges(m))).toBe(false)
    expect(has(t, `${FH}:MATH 1C`, true)).toBe(true)
    expect(has(t, `${FH}:MATH 1C`, false)).toBe(false)
  })
})

describe('split detection (F-09)', () => {
  it('MATH 1BH at De Anza + MATH 1B at Foothill is a duplicate, not a split', () => {
    const r = verifySchedule(new Set([`${DA}:MATH 1BH`, `${FH}:MATH 1B`]), ME)
    expect(r.splitSeriesViolations.map((v) => v.requirementId)).not.toContain('MATH 52')
  })
  it('MATH 1BH at De Anza + MATH 1C at Foothill is still a split', () => {
    const r = verifySchedule(new Set([`${DA}:MATH 1BH`, `${FH}:MATH 1C`]), ME)
    expect(r.splitSeriesViolations.map((v) => v.requirementId)).toContain('MATH 52')
  })
})

describe('missing (F-12)', () => {
  it('an OR is one named choice; its alternatives are not each required', () => {
    const r = verifySchedule(new Set(), MCS)
    expect(r.missing).toContain('One of: CSE 15L, CSE 29')
    expect(r.missing).not.toContain('CSE 15L')
    expect(r.missing).not.toContain('CSE 29')
    expect(r.missing.join()).not.toContain('(group)')
    expect(r.missing).toContain('MATH 20A')
  })
  it('names an alternative by what it still lacks, and drops a satisfied OR', () => {
    const r = (id: string): Requirement => ({ kind: 'req', id, label: id, units: 4, groups: [{ institutionId: DA, courses: [`${DA}:${id}`] }] })
    const or: ReqNode = { kind: 'node', type: 'OR', required: true, children: [
      { kind: 'node', type: 'AND', required: true, children: [r('A'), r('B'), r('C')] }, r('D')] }
    const a = { ...ME, root: { kind: 'node', type: 'AND', required: true, children: [or] } } as Agreement
    expect(verifySchedule(new Set([`${DA}:A`]), a).missing).toEqual(['One of: (B + C), D'])
    expect(verifySchedule(new Set([`${DA}:D`]), a).missing).toEqual([])
  })
})
