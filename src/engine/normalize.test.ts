import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReqNode, Requirement } from './types'
import { normalize, templateMismatches, type RawPayload } from './normalize'
import { verifySchedule } from './verify'

/* Synthetic payloads in the ASSIST shape (nested JSON strings, positioned templateAssets). */
const DA = 113, FH = 51, SM = 137
const course = (p: string, n: string, u = 4) => ({ prefix: p, courseNumber: n, courseTitle: `${p} ${n}`, minUnits: u, maxUnits: u })
const cell = (p: string, n: string) => ({ type: 'Course', id: p + n, course: course(p, n) })
const series = (name: string, cs: [string, string][], conjunction = 'And') => ({ type: 'Series', id: name, series: { conjunction, name, courses: cs.map(([p, n]) => course(p, n)) } })
type Cell = ReturnType<typeof cell> | ReturnType<typeof series>
const section = (rows: Cell[][], nOf?: number) => ({ type: 'Section', position: 0, rows: rows.map((cells) => ({ cells })), ...(nOf ? { advisements: [{ type: 'NFollowing', amount: nOf }] } : {}) })
const group = (position: number, sections: object[], conjunction?: string) => ({ type: 'RequirementGroup', position, sections, ...(conjunction ? { instruction: { type: 'Conjunction', conjunction } } : {}) })
const title = (position: number, content: string) => ({ type: 'RequirementTitle', position, content })
const art = (uc: Cell, ...groups: [string, string][][]) => ({ templateCellId: uc.id, articulation: {
  type: uc.type, ...('course' in uc ? { course: uc.course } : { series: uc.series }),
  sendingArticulation: { noArticulationReason: groups.length ? null : 'No Course Articulated', items: groups.map((cs) => ({ courseConjunction: 'And', items: cs.map(([p, n]) => course(p, n)) })) },
} })
const payload = (inst: number, assets: object[], arts: object[]): RawPayload => ({ result: {
  name: 'Test', academicYear: '{"code":"2025-2026"}', receivingInstitution: '{"id":117}', sendingInstitution: JSON.stringify({ id: inst }),
  templateAssets: JSON.stringify(assets), articulations: JSON.stringify(arts),
} })
const reqsOf = (n: ReqNode | Requirement): Requirement[] => (n.kind === 'req' ? [n] : n.children.flatMap(reqsOf))
const M31A = cell('MATH', '31A'), M31B = cell('MATH', '31B'), M32A = cell('MATH', '32A'), P1A = cell('PHYSICS', '1A'), E100 = cell('EC ENGR', '100')
const arts = [art(M31A, [['MATH', '1']]), art(M31B, [['MATH', '2']]), art(M32A, [['MATH', '3']]), art(P1A, [['PHYS', '1']]), art(E100, [['ENGR', '100']])]

let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}) })
afterEach(() => warn.mockRestore())

describe('normalize: titles pair with groups by position (F-03)', () => {
  it('a later RECOMMENDED title does not shift onto earlier untitled groups', () => {
    // UCLA ME shape: one title over two groups (calculus, physics), then a recommended title over upper division.
    const a = normalize([payload(DA, [title(0, 'LOWER DIVISION'), group(1, [section([[M31A], [M31B]])]), group(2, [section([[P1A]])]),
      title(3, 'STRONGLY RECOMMENDED'), group(4, [section([[E100]])])], arts)])
    const [calc, phys, rec] = a.root.children as ReqNode[]
    expect([calc.title, calc.required]).toEqual(['LOWER DIVISION', true])
    expect([phys.title, phys.required]).toEqual(['LOWER DIVISION', true])
    expect([rec.title, rec.required]).toEqual(['STRONGLY RECOMMENDED', false])
    expect(verifySchedule(new Set(['113:ENGR 100']), a).missing).toContain('MATH 31A')
  })
  it('a heading before the first group title does not shift later titles', () => {
    const a = normalize([payload(DA, [title(0, 'REQUIRED FOR ADMISSION'), title(1, 'MATHEMATICS'), group(2, [section([[M31A]])]), title(3, 'PHYSICS'), group(4, [section([[P1A]])])], arts)])
    expect(a.root.children.map((g) => (g as ReqNode).title)).toEqual(['MATHEMATICS', 'PHYSICS'])
  })
  it('a group with no preceding title is required with an empty title; titles are matched regardless of array order', () => {
    const a = normalize([payload(DA, [group(3, [section([[E100]])]), title(2, 'Recommended'), group(0, [section([[M31A]])])], arts)])
    const [g0, g3] = a.root.children as ReqNode[]
    expect([g0.title, g0.required]).toEqual(['', true])
    expect([g3.title, g3.required]).toEqual(['Recommended', false])
  })
})

describe('normalize: N-of sections (F-02)', () => {
  it('a group whose only section is "complete 1 of the following" stays N_OF(1)', () => {
    const a = normalize([payload(DA, [title(0, 'Choose one'), group(1, [section([[M31A], [M31B], [M32A]], 1)])], arts)])
    const g = a.root.children[0] as ReqNode
    expect([g.type, g.n, g.title, g.children.length]).toEqual(['N_OF', 1, 'Choose one', 3])
    expect(verifySchedule(new Set(['113:MATH 2']), a).isValid).toBe(true)
  })
  it('an N_OF section next to a plain section keeps its N_OF node', () => {
    const a = normalize([payload(DA, [group(0, [section([[P1A]]), section([[M31A], [M31B], [M32A]], 2)])], arts)])
    const g = a.root.children[0] as ReqNode
    expect(g.type).toBe('AND')
    expect([(g.children[1] as ReqNode).type, (g.children[1] as ReqNode).n]).toEqual(['N_OF', 2])
  })
})

describe('normalize: articulations keyed by other templates (F-01)', () => {
  const CHEM = series('CHEM 1A, CHEM 1AL, CHEM 1B', [['CHEM', '1A'], ['CHEM', '1AL'], ['CHEM', '1B']])
  const CHEM_A = series('CHEM 1A, CHEM 1AL', [['CHEM', '1A'], ['CHEM', '1AL']]), CHEM_B = cell('CHEM', '1B')
  const whole = (inst: number) => payload(inst, [group(0, [section([[CHEM]])])], [art(CHEM, [['CHEM', '1A'], ['CHEM', '1B'], ['CHEM', '1C']])])
  const split = (inst: number) => payload(inst, [group(0, [section([[CHEM_A], [CHEM_B]])])], [art(CHEM_A, [['CHEM', '1A'], ['CHEM', '1B']]), art(CHEM_B, [['CHEM', '1C']])])

  it('a series split into separate cells at another college still satisfies the tree requirement', () => {
    const a = normalize([whole(DA), split(FH)])
    const [req] = reqsOf(a.root)
    expect(req.id).toBe(CHEM.series.name)
    expect(req.groups).toContainEqual({ institutionId: FH, courses: ['51:CHEM 1A', '51:CHEM 1B', '51:CHEM 1C'] })
    expect(verifySchedule(new Set(['51:CHEM 1A', '51:CHEM 1B', '51:CHEM 1C']), a).isValid).toBe(true)
    // Foothill's first two courses alone are a partial, not a pass.
    expect(verifySchedule(new Set(['51:CHEM 1A', '51:CHEM 1B']), a).isValid).toBe(false)
  })
  it('a merged series at another college covers each split tree cell', () => {
    const a = normalize([split(DA), whole(FH)])
    for (const r of reqsOf(a.root)) expect(r.groups).toContainEqual({ institutionId: FH, courses: ['51:CHEM 1A', '51:CHEM 1B', '51:CHEM 1C'] })
    expect(verifySchedule(new Set(['51:CHEM 1A', '51:CHEM 1B', '51:CHEM 1C']), a).isValid).toBe(true)
  })
  it('replaces the "No articulation listed" placeholder when another college articulates by UC course', () => {
    const a = normalize([payload(DA, [group(0, [section([[CHEM]])])], []), split(FH)])
    const [req] = reqsOf(a.root)
    expect(req.noArticulation).toEqual({ [DA]: 'No articulation listed' })
    expect(req.groups).toHaveLength(1)
  })
  it('a requirement only another template lists is kept as optional, and every catalog course is reachable', () => {
    const a = normalize([payload(DA, [group(0, [section([[M31A]])])], [art(M31A, [['MATH', '1']])]),
      payload(FH, [group(0, [section([[M31A]])]), title(1, 'PHYSICS'), group(2, [section([[P1A]])])], [art(M31A, [['MATH', '1A']]), art(P1A, [['PHYS', '4A']])])])
    const extra = a.root.children[1] as ReqNode
    expect(extra.required).toBe(false)
    expect(extra.title).toMatch(/^PHYSICS/)
    const inTree = new Set(reqsOf(a.root).flatMap((r) => r.groups.flatMap((g) => g.courses)))
    expect(Object.keys(a.catalog).filter((c) => !inTree.has(c))).toEqual([])
    expect(verifySchedule(new Set(['113:MATH 1']), a).isValid).toBe(true)
    expect(templateMismatches([whole(DA), split(FH)])).toEqual([FH])
  })
  it('does not attach a cell that covers only part of the requirement', () => {
    const a = normalize([whole(DA), payload(FH, [group(0, [section([[CHEM_A]])])], [art(CHEM_A, [['CHEM', '1A'], ['CHEM', '1B']])])])
    expect(reqsOf(a.root)[0].groups.every((g) => g.institutionId === DA)).toBe(true)
  })
})

describe('normalize: robustness (F-19)', () => {
  const simple = (inst: number) => payload(inst, [group(0, [section([[M31A]])])], [art(M31A, [['MATH', '1']])])
  it('rejects an empty payload list with a clear Error', () => {
    expect(() => normalize([])).toThrow(/no payloads/)
    expect(templateMismatches([])).toEqual([])
  })
  it('a duplicated payload does not duplicate sendingIds or groups', () => {
    const a = normalize([simple(DA), simple(FH), simple(FH)])
    expect(a.sendingIds).toEqual([DA, FH])
    expect(reqsOf(a.root)[0].groups).toHaveLength(2)
    expect(templateMismatches([simple(DA), simple(SM), payload(SM, [], [])])).toEqual([SM])
  })
  it('a UC "Or" series counts the units of one alternative', () => {
    const S = series('CHEM 1A or CHEM 4A', [['CHEM', '1A'], ['CHEM', '4A']], 'Or')
    const a = normalize([payload(DA, [group(0, [section([[S]])])], [art(S, [['CHEM', '1A']])])])
    expect(reqsOf(a.root)[0].units).toBe(4)
  })
  it('malformed nested JSON names the payload and field', () => {
    const bad = simple(FH)
    bad.result.templateAssets = 'not json'
    expect(() => normalize([simple(DA), bad])).toThrow(/sending \{"id":51\}.*templateAssets/)
  })
})
