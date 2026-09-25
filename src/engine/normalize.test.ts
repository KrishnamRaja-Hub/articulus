import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReqNode, Requirement } from './types'
import { classifyTitle, normalize, NORMALIZE_VERSION, NOT_LISTED, sectionRules, templateMismatches, type RawPayload } from './normalize'
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
  it('choose 0 is kept as N_OF(0), warned about, and never reads as valid (TESTER2 M-3)', () => {
    const s0 = { ...section([[M31A], [M31B]]), advisements: [{ type: 'NFollowing', amount: 0 }] }
    const a = normalize([payload(DA, [group(0, [s0])], arts)])
    expect([(a.root.children[0] as ReqNode).type, (a.root.children[0] as ReqNode).n]).toEqual(['N_OF', 0])
    expect(warn.mock.calls.flat().join(' ')).toMatch(/NFollowing 0/)
    expect(verifySchedule(new Set(), a).isValid).toBe(false)
  })
})

describe('normalize v3: only admission sections are required (TESTER1 H-4)', () => {
  it('NORMALIZE_VERSION is 4', () => expect(NORMALIZE_VERSION).toBe(4))
  it('classifies titles', () => {
    expect(classifyTitle('MAJOR PREPARATION COURSES REQUIRED FOR TRANSFER').kind).toBe('admission')
    expect(classifyTitle('LOWER DIVISION MAJOR REQUIREMENTS').kind).toBe('required')
    expect(classifyTitle('STRONGLY RECOMMENDED').kind).toBe('advisory')
    expect(classifyTitle('MAJOR PREPARATION COURSES NECESSARY TO GRADUATE IN TWO YEARS').kind).toBe('advisory')
    expect(classifyTitle('ADDITIONAL MAJOR ELECTIVES').kind).toBe('additional')
    expect(classifyTitle('ADDITIONAL LOWER DIVISION COURSES').kind).toBe('additional')
    expect(classifyTitle('REQUIRED: RECOMMENDED COURSES').kind).toBe('ambiguous')
    expect(classifyTitle('MATHEMATICS').kind).toBe('neutral')
  })
  it('"ADDITIONAL ..." is optional only beside an explicit required-for-admission section', () => {
    expect(sectionRules(['REQUIRED FOR ADMISSION', 'ADDITIONAL COURSES']).map((r) => r.required)).toEqual([true, false])
    expect(sectionRules(['ADDITIONAL COURSES'])[0]).toMatchObject({ required: true, ambiguous: true })
  })
  it('a subject heading takes the section above it; under an optional one it stays required but ambiguous', () => {
    expect(sectionRules(['MATHEMATICS'])[0].required).toBe(true)
    expect(sectionRules(['RECOMMENDED', 'PHYSICS'])[1]).toMatchObject({ required: true, ambiguous: true })
  })
  it('UC Irvine shape: time-to-degree and elective sections become optional; the admission section still decides', () => {
    const a = normalize([payload(DA, [
      title(0, 'MAJOR PREPARATION COURSES REQUIRED FOR TRANSFER'), group(1, [section([[M31A], [M31B]])]),
      title(2, 'MAJOR PREPARATION COURSES NECESSARY TO GRADUATE IN TWO YEARS'), group(3, [section([[P1A]])]),
      title(4, 'ADDITIONAL MAJOR ELECTIVES'), group(5, [section([[E100]])]),
    ], arts)])
    expect((a.root.children as ReqNode[]).map((n) => n.required)).toEqual([true, false, false])
    expect(verifySchedule(new Set(['113:MATH 1', '113:MATH 2']), a).isValid).toBe(true)
    expect(verifySchedule(new Set(['113:PHYS 1', '113:ENGR 100']), a).missing).toContain('MATH 31A')
  })
  it('an ambiguous title is kept required and warned about', () => {
    const a = normalize([payload(DA, [title(0, 'REQUIRED: RECOMMENDED COURSES'), group(1, [section([[M31A]])])], arts)])
    expect((a.root.children[0] as ReqNode).required).toBe(true)
    expect(warn.mock.calls.flat().join(' ')).toMatch(/ambiguous section title/)
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
  it('a requirement only another template lists keeps its section\'s required-ness (M-2), and every catalog course is reachable', () => {
    const a = normalize([payload(DA, [group(0, [section([[M31A]])])], [art(M31A, [['MATH', '1']])]),
      payload(FH, [group(0, [section([[M31A]])]), title(1, 'PHYSICS'), group(2, [section([[P1A]])])], [art(M31A, [['MATH', '1A']]), art(P1A, [['PHYS', '4A']])])])
    const extra = a.root.children[1] as ReqNode
    expect(extra.required).toBe(true)
    expect(extra.title).toMatch(/^PHYSICS/)
    const inTree = new Set(reqsOf(a.root).flatMap((r) => r.groups.flatMap((g) => g.courses)))
    expect(Object.keys(a.catalog).filter((c) => !inTree.has(c))).toEqual([])
    // DA does not list PHYSICS 1A: NOT_LISTED there, so a DA student is never complete on MATH alone (counselor).
    expect(reqsOf(extra)[0].noArticulation).toEqual({ [DA]: NOT_LISTED })
    expect(verifySchedule(new Set(['113:MATH 1']), a).isValid).toBe(false)
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

describe('normalize v4: never complete on missing proof (verdict round 6)', () => {
  const T = [title(0, 'REQUIRED FOR ADMISSION'), group(1, [section([[M31A], [P1A]])])]
  const rawArt = (uc: ReturnType<typeof cell>, sa: unknown) => ({ templateCellId: uc.id, articulation: { type: 'Course', course: uc.course, sendingArticulation: sa } })
  const physOf = (a: ReturnType<typeof normalize>) => reqsOf(a.root).find((r) => r.id === 'PHYSICS 1A')!
  const withPhys = (sa: unknown) => normalize([payload(DA, T, [art(M31A, [['MATH', '1']]), rawArt(P1A, sa)])])

  it('H-2: no groups and a null reason is NOT_LISTED, not UC-only', () => {
    const a = withPhys({ noArticulationReason: null, items: [] })
    expect(physOf(a).noArticulation).toEqual({ [DA]: NOT_LISTED })
    expect(verifySchedule(new Set(['113:MATH 1']), a).isValid).toBe(false)
  })
  it('H-2: a missing sendingArticulation is NOT_LISTED', () => {
    const a = withPhys(null)
    expect(physOf(a).noArticulation).toEqual({ [DA]: NOT_LISTED })
    expect(verifySchedule(new Set(['113:MATH 1']), a).isValid).toBe(false)
  })
  it('H-2: a blank reason is NOT_LISTED; an explicit reason is kept', () => {
    expect(physOf(withPhys({ noArticulationReason: '  ', items: [] })).noArticulation).toEqual({ [DA]: NOT_LISTED })
    expect(physOf(withPhys({ noArticulationReason: 'No Course Articulated', items: [] })).noArticulation).toEqual({ [DA]: 'No Course Articulated' })
  })
  it('"Course(s) Denied" is NOT_LISTED (counselor), never proof the row is waived', () => {
    const a = withPhys({ noArticulationReason: 'Course(s) Denied', items: [] })
    expect(physOf(a).noArticulation).toEqual({ [DA]: NOT_LISTED })
    expect(verifySchedule(new Set(['113:MATH 1']), a).isValid).toBe(false)
  })
  it('M-1: an And group with a blank course is dropped whole, not shortened', () => {
    const a = withPhys({ noArticulationReason: null, items: [{ courseConjunction: 'And', items: [course('PHYS', '4A'), { ...course('PHYS', '4AL'), courseNumber: '' }] }] })
    expect(physOf(a).groups).toEqual([])
    expect(physOf(a).noArticulation).toEqual({ [DA]: NOT_LISTED })
    expect(verifySchedule(new Set(['113:MATH 1', '113:PHYS 4A']), a).isValid).toBe(false)
    expect(warn.mock.calls.flat().join(' ')).toMatch(/unreadable sending course/)
  })
  it('M-1: a malformed And group is dropped but a well-formed alternative group survives', () => {
    const a = withPhys({ noArticulationReason: null, items: [
      { courseConjunction: 'And', items: [course('PHYS', '4A'), { ...course('', '4AL'), prefix: '' }] },
      { courseConjunction: 'And', items: [course('PHYS', '2A'), course('PHYS', '2B')] },
    ] })
    expect(physOf(a).groups).toEqual([{ institutionId: DA, courses: ['113:PHYS 2A', '113:PHYS 2B'] }])
    expect(physOf(a).noArticulation).toBeUndefined()
    expect(verifySchedule(new Set(['113:MATH 1', '113:PHYS 4A']), a).isValid).toBe(false)
    expect(verifySchedule(new Set(['113:MATH 1', '113:PHYS 2A', '113:PHYS 2B']), a).isValid).toBe(true)
  })
  it('M-2: a required row only another college lists stays required and blocks a college that lacks it', () => {
    const TA = [title(0, 'REQUIRED FOR ADMISSION'), group(1, [section([[M31A]])])]
    const a = normalize([payload(DA, TA, [art(M31A, [['MATH', '1A']])]), payload(FH, T, [art(M31A, [['MATH', '1A']]), art(P1A, [['PHYS', '4A']])])])
    expect(physOf(a).noArticulation).toEqual({ [DA]: NOT_LISTED })
    expect(verifySchedule(new Set(['51:MATH 1A']), a).isValid).toBe(false)
    expect(verifySchedule(new Set(['113:MATH 1A']), a).isValid).toBe(false)
    expect(verifySchedule(new Set(['51:MATH 1A', '51:PHYS 4A']), a).isValid).toBe(true)
  })
  it('M-2: a row only in another college\'s RECOMMENDED section stays optional', () => {
    const TA = [title(0, 'REQUIRED FOR ADMISSION'), group(1, [section([[M31A]])])]
    const TB = [...TA, title(2, 'RECOMMENDED'), group(3, [section([[P1A]])])]
    const a = normalize([payload(DA, TA, [art(M31A, [['MATH', '1A']])]), payload(FH, TB, [art(M31A, [['MATH', '1A']]), art(P1A, [['PHYS', '4A']])])])
    expect((a.root.children[1] as ReqNode).required).toBe(false)
    expect(verifySchedule(new Set(['113:MATH 1A']), a).isValid).toBe(true)
  })
  it('M-3: "ELECTIVE(S)" is optional only beside a required-for-admission section', () => {
    expect(classifyTitle('SCIENCE ELECTIVE: COMPLETE ONE COURSE').kind).toBe('additional')
    expect(sectionRules(['LOWER DIVISION MAJOR REQUIREMENTS', 'SCIENCE ELECTIVE: COMPLETE ONE COURSE'])[1]).toMatchObject({ required: true, ambiguous: true })
    expect(sectionRules(['REQUIRED FOR ADMISSION', 'ADDITIONAL MAJOR ELECTIVES'])[1]).toMatchObject({ required: false })
    expect(sectionRules(['REQUIRED FOR ADMISSION', 'RECOMMENDED ELECTIVES'])[1]).toMatchObject({ required: false })
    expect(classifyTitle('REQUIRED: choose from the approved electives').kind).toBe('ambiguous')
    const T5 = [title(0, 'LOWER DIVISION MAJOR REQUIREMENTS'), group(1, [section([[M31A]])]), title(2, 'SCIENCE ELECTIVE: COMPLETE ONE COURSE'), group(3, [section([[P1A], [E100]], 1)])]
    const a = normalize([payload(DA, T5, arts)])
    expect(verifySchedule(new Set(['113:MATH 1']), a).isValid).toBe(false)
    expect(verifySchedule(new Set(['113:MATH 1', '113:ENGR 100']), a).isValid).toBe(true)
  })
})

describe('normalize: sending course-group conjunctions (C-1)', () => {
  const T = [title(0, 'REQUIRED FOR ADMISSION'), group(1, [section([[M31A], [P1A]])])]
  const g = (conj: string, cs: [string, string][], position?: number) => ({ courseConjunction: conj, items: cs.map(([p, n]) => course(p, n)), ...(position !== undefined ? { position } : {}) })
  const cj = (groupConjunction: string, b: number, e: number) => ({ id: 1, groupConjunction, sendingCourseGroupBeginPosition: b, sendingCourseGroupEndPosition: e })
  const physArt = (items: object[], courseGroupConjunctions: unknown) => ({ templateCellId: P1A.id, articulation: { type: 'Course', course: P1A.course,
    sendingArticulation: { noArticulationReason: null, items, courseGroupConjunctions } } })
  const run = (items: object[], conj: unknown) => normalize([payload(DA, T, [art(M31A, [['MATH', '1']]), physArt(items, conj)])])
  const phys = (a: ReturnType<typeof normalize>) => reqsOf(a.root).find((r) => r.id === 'PHYSICS 1A')!
  const courses = (a: ReturnType<typeof normalize>) => phys(a).groups.map((x) => x.courses.map((c) => c.slice(4)).sort().join('+')).sort()
  const ok = (a: ReturnType<typeof normalize>, ...cs: string[]) => verifySchedule(new Set(['113:MATH 1', ...cs.map((c) => `113:${c}`)]), a).isValid

  it('an And range is the cross product: PHYS 4A And (PHYS 4AL or PHYS 4AX)', () => {
    const a = run([g('And', [['PHYS', '4A']]), g('Or', [['PHYS', '4AL'], ['PHYS', '4AX']])], [cj('And', 0, 1)])
    expect(courses(a)).toEqual(['PHYS 4A+PHYS 4AL', 'PHYS 4A+PHYS 4AX'])
    expect(ok(a, 'PHYS 4A')).toBe(false)
    expect(ok(a, 'PHYS 4AL')).toBe(false)
    expect(ok(a, 'PHYS 4A', 'PHYS 4AX')).toBe(true)
  })
  it('CIS 22A And CIS 22B And CIS 22C needs all three (the COM SCI 32 symptom)', () => {
    const a = run([g('And', [['CIS', '22A']]), g('And', [['CIS', '22B']]), g('And', [['CIS', '22C']])], [cj('And', 0, 2)])
    expect(courses(a)).toEqual(['CIS 22A+CIS 22B+CIS 22C'])
    expect(ok(a, 'CIS 22A')).toBe(false)
  })
  it('groups no conjunction covers are Or (the default); an Or range is too', () => {
    for (const conj of [[], null, undefined, [cj('Or', 0, 1)], [cj('OR', 0, 1)]]) {
      const a = run([g('And', [['PHYS', '4A']]), g('And', [['PHYS', '2A']])], conj)
      expect(courses(a)).toEqual(['PHYS 2A', 'PHYS 4A'])
      expect(ok(a, 'PHYS 2A')).toBe(true)
    }
  })
  it('mixed: (A And B) Or C, positions matched by each group\'s `position` field', () => {
    // Positions 1..3 (not the array indexes 0..2), listed out of order.
    const a = run([g('And', [['PHYS', '2A']], 3), g('And', [['PHYS', '4A']], 1), g('And', [['PHYS', '4B']], 2)], [cj('and', 1, 2)])
    expect(courses(a)).toEqual(['PHYS 2A', 'PHYS 4A+PHYS 4B'])
    expect(ok(a, 'PHYS 4A')).toBe(false)
    expect(ok(a, 'PHYS 2A')).toBe(true)
    expect(ok(a, 'PHYS 4A', 'PHYS 4B')).toBe(true)
  })
  it('an And range with an unreadable group is dropped whole', () => {
    const a = run([g('And', [['PHYS', '4A']]), { courseConjunction: 'And', items: [course('', '4AL')] }, g('And', [['PHYS', '2A']])], [cj('And', 0, 1)])
    expect(courses(a)).toEqual(['PHYS 2A'])
    expect(ok(a, 'PHYS 4A')).toBe(false)
    expect(warn.mock.calls.flat().join(' ')).toMatch(/unreadable sending course/)
  })
  it.each([
    ['unknown conjunction', [cj('Xor', 0, 1)]],
    ['unknown field names', [{ conjunction: 'And', begin: 0, end: 1 }]],
    ['missing position', [{ groupConjunction: 'And', sendingCourseGroupBeginPosition: 0 }]],
    ['position not a group', [cj('And', 0, 5)]],
    ['begin after end', [cj('And', 1, 0)]],
    ['overlapping ranges', [cj('And', 0, 1), cj('Or', 1, 1)]],
    ['not a list', { groupConjunction: 'And' }],
    ['null entry', [null]],
  ])('malformed conjunctions (%s) fail closed: NOT_LISTED at that college + note', (_, conj) => {
    const a = run([g('And', [['PHYS', '4A']]), g('And', [['PHYS', '2A']])], conj)
    expect(phys(a).groups).toEqual([])
    expect(phys(a).noArticulation).toEqual({ [DA]: NOT_LISTED })
    expect(ok(a, 'PHYS 4A', 'PHYS 2A')).toBe(false)
    expect(warn.mock.calls.flat().join(' ')).toMatch(/sending course-group conjunctions not applied.*PHYSICS 1A at 113/)
    expect(a.catalog['113:PHYS 4A']).toBeUndefined()
  })
  it('an And range over MAX_ALTERNATIVES fails closed', () => {
    const or9 = (p: string) => g('Or', Array.from({ length: 9 }, (_, i) => [p, String(i)] as [string, string]))
    const a = run([or9('A'), or9('B')], [cj('And', 0, 1)]) // 81 > 64
    expect(phys(a).noArticulation).toEqual({ [DA]: NOT_LISTED })
    expect(warn.mock.calls.flat().join(' ')).toMatch(/over 64 alternatives/)
    const b = run([or9('A'), g('Or', [['B', '1'], ['B', '2']])], [cj('And', 0, 1)]) // 18
    expect(phys(b).groups).toHaveLength(18)
  })
})

describe('normalize: conjunctions, N-of and ids read case-insensitively (L-1)', () => {
  const T = [group(0, [section([[P1A]])])]
  const raw = (items: object[]) => ({ templateCellId: P1A.id, articulation: { type: 'Course', course: P1A.course, sendingArticulation: { noArticulationReason: null, items } } })
  it('a lowercase "or" course group is Or', () => {
    const a = normalize([payload(DA, T, [raw([{ courseConjunction: 'or', items: [course('PHYS', '4A'), course('PHYS', '2A')] }])])])
    expect(verifySchedule(new Set(['113:PHYS 2A']), a).isValid).toBe(true)
  })
  it('an uppercase "OR" group instruction joins sections by OR', () => {
    const a = normalize([payload(DA, [group(0, [section([[M31A]]), section([[P1A]])], 'OR')], arts)])
    expect((a.root.children[0] as ReqNode).type).toBe('OR')
  })
  it('a group "NFollowing" instruction is N_OF(n) over its sections', () => {
    const ins = { type: 'RequirementGroup', position: 0, sections: [section([[M31A]]), section([[P1A]]), section([[E100]])], instruction: { type: 'NFollowing', amount: 2 } }
    const a = normalize([payload(DA, [ins], arts)])
    const n = a.root.children[0] as ReqNode
    expect([n.type, n.n, n.children.length]).toEqual(['N_OF', 2, 3])
    expect(verifySchedule(new Set(['113:MATH 1']), a).isValid).toBe(false)
    expect(verifySchedule(new Set(['113:MATH 1', '113:ENGR 100']), a).isValid).toBe(true)
  })
  it('a lowercase section "nfollowing" advisement is N_OF', () => {
    const s = { ...section([[M31A], [P1A]]), advisements: [{ type: 'nfollowing', amount: 1 }] }
    expect((normalize([payload(DA, [group(0, [s])], arts)]).root.children[0] as ReqNode).type).toBe('N_OF')
  })
  it('"NFollowingUnits" keeps the section "take all" and warns', () => {
    const s = { ...section([[M31A], [P1A]]), advisements: [{ type: 'NFollowingUnits', amount: 4 }] }
    const a = normalize([payload(DA, [title(0, 'Complete 4 units'), group(1, [s])], arts)])
    expect((a.root.children[0] as ReqNode).type).toBe('AND')
    expect(verifySchedule(new Set(['113:MATH 1']), a).isValid).toBe(false)
    expect(warn.mock.calls.flat().join(' ')).toMatch(/NFollowingUnits not modelled.*Complete 4 units/)
  })
  it('an unknown group instruction joins sections by AND and warns', () => {
    const ins = { type: 'RequirementGroup', position: 0, sections: [section([[M31A]]), section([[P1A]])], instruction: { type: 'Mystery' } }
    const a = normalize([payload(DA, [ins], arts)])
    expect((a.root.children[0] as ReqNode).type).toBe('AND')
    expect(warn.mock.calls.flat().join(' ')).toMatch(/unknown group instruction/)
  })
  it('sending prefixes differing only in case or spacing are one course id', () => {
    const a = normalize([payload(DA, [group(0, [section([[M31A], [P1A]])])], [art(M31A, [['Math', ' 1A ']]), art(P1A, [['MATH', '1A']])])])
    expect(Object.keys(a.catalog)).toEqual(['113:MATH 1A'])
    expect(verifySchedule(new Set(['113:MATH 1A']), a).isValid).toBe(true)
    expect(Object.keys(normalize([payload(DA, T, [art(P1A, [['EC  engr', '1']])])]).catalog)).toEqual(['113:EC ENGR 1'])
  })
})

describe('normalize: unmodelled template content is never dropped (M-3)', () => {
  it('a section type differing in case is read', () => {
    const a = normalize([payload(DA, [group(0, [{ ...section([[M31A]]), type: 'SECTION' }])], arts)])
    expect(reqsOf(a.root).map((r) => r.id)).toEqual(['MATH 31A'])
  })
  it('a section of another type is read (strictly) and warned about', () => {
    const a = normalize([payload(DA, [group(0, [{ ...section([[M31A]]), type: 'Other' }])], arts)])
    expect(reqsOf(a.root).map((r) => r.id)).toEqual(['MATH 31A'])
    expect(warn.mock.calls.flat().join(' ')).toMatch(/section type is not "Section"/)
  })
  it('a GE / "Requirement" cell becomes a required row NOT_LISTED at every college (counselor)', () => {
    const ge = { type: 'Requirement', id: 'GE1', requirement: { name: 'Complete IGETC Area 2' } }
    const a = normalize([payload(DA, [title(0, 'REQUIRED FOR ADMISSION'), group(1, [section([[M31A], [ge as never]])])], [art(M31A, [['MATH', '1']])]),
      payload(FH, [title(0, 'REQUIRED FOR ADMISSION'), group(1, [section([[M31A], [ge as never]])])], [art(M31A, [['MATH', '1A']])])])
    const row = reqsOf(a.root).find((r) => r.label === 'Complete IGETC Area 2')!
    expect(row.groups).toEqual([])
    expect(row.noArticulation).toEqual({ [DA]: NOT_LISTED, [FH]: NOT_LISTED })
    expect((a.root.children[0] as ReqNode).required).toBe(true)
    expect(verifySchedule(new Set(['113:MATH 1']), a).isValid).toBe(false)
    expect(warn.mock.calls.flat().join(' ')).toMatch(/template cell not modelled.*Complete IGETC Area 2/)
  })
  it('an unmodelled cell OR a course in one row: the course still satisfies the row', () => {
    const ge = { type: 'GeneralEducation', id: 'GE2' }
    const a = normalize([payload(DA, [group(0, [section([[M31A, ge as never]])])], [art(M31A, [['MATH', '1']])])])
    expect(reqsOf(a.root).map((r) => r.label)).toContain('GeneralEducation cell GE2')
    expect(verifySchedule(new Set(['113:MATH 1']), a).isValid).toBe(true)
  })
})
