import { describe, expect, it } from 'vitest'
import type { Plan, ValidationResult, Violation } from '../engine/types'
import { badgeStatus, CAUTION_TITLE, CAVEAT, completedSplits, COMPLETE_NOTE, deferredOf, noMatchNote, optimalExplain, optimalNote, PREREQ_TAG, PLAN_FAILED_TITLE, prereqOnlySet, REVIEW_TITLE, unmetNames, scheduleCaveat, scheduleNote, splitUnsolvable, UNCONFIRMED_TITLE } from './plannerStatus'
import type { TrustLevel } from '../data-trust'
import { dataTrust } from '../data-trust'
import { NORMALIZE_VERSION as NORMALIZE_VERSION_FOR_TEST } from '../engine/normalize'
import { verifySchedule } from '../engine/verify'
import { nextOpenTerm, termLabel } from '../terms'
import { solve } from '../engine/solve'
import type { Agreement, Institution } from '../engine/types'
import bundledMeta from '../../data/meta.json'
import institutionsJson from '../../data/institutions.json'
import uclaMe from '../../data/agreements/117-mechanical-engineering-b-s.json'
import berkeleyMe from '../../data/agreements/79-mechanical-engineering-b-s.json'
import berkeleyEecs from '../../data/agreements/79-electrical-engineering-computer-sciences-b-s.json'

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

describe('H-1: completed-course splits are judged with the plan', () => {
  it('a split the plan reports as not blocking is a warning, not red', () => {
    const current = result({ isValid: false, splitSeriesViolations: [split('BIOLOGY 1B', true)] })
    const p = plan({}, { splitSeriesViolations: [split('BIOLOGY 1B', false)] })
    expect(completedSplits(current, p).map((v) => v.blocking)).toEqual([false])
    expect(badgeStatus(current, p, 'UCB')).toEqual({ ok: true, tone: 'ok', title: 'Every requirement covered', details: ['1 warning'] })
  })

  it('stays red when the plan still reports it blocking, or the plan does not finish', () => {
    const current = result({ isValid: false, splitSeriesViolations: [split('BIOLOGY 1B', true)] })
    expect(badgeStatus(current, plan({}, { splitSeriesViolations: [split('BIOLOGY 1B', true)] }), 'UCB').tone).toBe('problem')
    // the plan does not finish: nothing is relaxed
    const unfinished = plan({}, { isValid: false, splitSeriesViolations: [split('BIOLOGY 1B', false)] })
    expect(completedSplits(current, unfinished)[0].blocking).toBe(true)
    expect(badgeStatus(current, unfinished, 'UCB')).toMatchObject({ ok: false, title: '1 split-series violation in your completed courses' })
    const unsolvable = plan({ unsolvable: ['CHEM 1A'] }, { splitSeriesViolations: [split('BIOLOGY 1B', false)] })
    expect(badgeStatus(current, unsolvable, 'UCB').ok).toBe(false)
    // a plan that says nothing about the split (e.g. the empty plan) never relaxes it
    expect(badgeStatus(current, plan(), 'UCB').tone).toBe('problem')
  })

  it('a relaxed split on untrusted or prior-year data is still not green', () => {
    const current = result({ isValid: false, splitSeriesViolations: [split('BIOLOGY 1B', true)] })
    const p = plan({}, { splitSeriesViolations: [split('BIOLOGY 1B', false)] })
    expect(badgeStatus(current, p, 'UCB', 'untrusted').ok).toBe(false)
    expect(badgeStatus(current, p, 'UCB', { level: 'aging', yearNote: 'x' }).ok).toBe(false)
  })

  it('real data: Berkeley EECS, De Anza + Foothill biology split, fixed by planned PHYS 4D, is not red', () => {
    const a = berkeleyEecs as unknown as Agreement
    const taken = new Set(['113:MATH 1A', '113:MATH 1B', '113:MATH 1C', '113:MATH 1D', '113:MATH 2A', '113:MATH 2B',
      '113:PHYS 4A', '113:PHYS 4B', '113:PHYS 4C', '113:BIOL 6A', '51:BIOL 1B'])
    const current = verifySchedule(taken, a)
    const p = solve(taken, a, { allowed: [113, 51], home: 113, startTerm: { season: 'Fall', year: 2026 } })
    // the completed courses alone show blocking splits; the plan, with its scheduled courses, finishes everything
    expect(current.splitSeriesViolations.some((v) => v.blocking)).toBe(true)
    expect(p.result.isValid).toBe(true)
    expect(p.unsolvable).toEqual([])
    const s = badgeStatus(current, p, 'UCB', 'trusted')
    expect(s.tone).not.toBe('problem')
    expect(s.title).not.toMatch(/split-series violation/)
    expect(s).toMatchObject({ ok: true, tone: 'ok', title: 'Every requirement covered' })
    // the splits are still reported, as warnings
    expect(completedSplits(current, p).length).toBe(current.splitSeriesViolations.length)
    expect(completedSplits(current, p).some((v) => v.blocking)).toBe(false)
    // and never green on untrusted or prior-year data
    expect(badgeStatus(current, p, 'UCB', 'untrusted').ok).toBe(false)
    expect(badgeStatus(current, p, 'UCB', { level: 'aging', yearNote: "2026-27 agreements aren't published on ASSIST yet" }).tone).toBe('caution')
  })
})

describe('L-1: prior-year (carried-over) data is amber, never green', () => {
  const carried = { schema: 1, fetchedAt: '2026-09-23T00:00:00Z', academicYear: { code: '2025-2026' }, carriedOver: true, validation: { passed: true }, agreements: 22 }

  it('a would-be green on carried-over data is caution, not ok', () => {
    const t = dataTrust({ ...carried, normalizeVersion: NORMALIZE_VERSION_FOR_TEST }, new Date('2026-09-24T00:00:00Z'), NORMALIZE_VERSION_FOR_TEST, 22, Array(22).fill('2025-2026'))
    expect(t.level).toBe('aging')
    expect(t.yearNote).not.toBeNull()
    const s = badgeStatus(result(), plan(), 'UCB', t)
    expect(s).toEqual({ ok: false, tone: 'caution', title: CAUTION_TITLE, details: [], caveat: CAVEAT.priorYear })
    expect(s.title).not.toMatch(/^Every requirement covered/)
    // the schedule note never says "complete" either
    const n = scheduleNote(s, plan(), t.level)
    expect(n?.tone).toBe('warn')
    expect(n?.text).not.toBe(COMPLETE_NOTE)
  })

  it('red stays red on carried-over data; plain aging (no year note) is unchanged', () => {
    const t = { level: 'aging' as const, yearNote: "2026-27 agreements aren't published on ASSIST yet" }
    expect(badgeStatus(result(), plan({}, { isValid: false }), 'UCB', t).tone).toBe('problem')
    expect(badgeStatus(result(), plan(), 'UCB', { level: 'aging', yearNote: null })).toEqual(badgeStatus(result(), plan(), 'UCB', 'aging'))
    expect(badgeStatus(result(), plan(), 'UCB', { level: 'trusted', yearNote: null })).toEqual(badgeStatus(result(), plan(), 'UCB'))
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

  it('never says "minimum units": the planner trades units against extra colleges and split subjects (M-1)', () => {
    expect(optimalNote(plan({ optimal: true }))).toBe('lowest cost under our rules')
    expect(optimalNote(plan({ optimal: false }))).toBe('near-lowest cost')
    expect(optimalNote(plan())).toBeNull()
    for (const optimal of [true, false, undefined]) {
      expect(optimalNote(plan({ optimal })) ?? '').not.toMatch(/minimum/i)
      expect(optimalExplain(plan({ optimal }))).toMatch(/extra college/)
    }
    expect(optimalExplain(plan({ optimal: false }))).toMatch(/better plan may exist/)
  })

  it('splits the "offered at" suffix off unsolvable entries', () => {
    expect(splitUnsolvable('CHEM 1A — offered at Foothill, De Anza')).toEqual({ what: 'CHEM 1A', offeredAt: 'Foothill, De Anza' })
    expect(splitUnsolvable('2 of: MATH 1A, MATH 1B')).toEqual({ what: '2 of: MATH 1A, MATH 1B' })
  })
})

describe('scheduleNote (C-1): "complete" only when the verdict is complete', () => {
  const LEVELS: TrustLevel[] = ['trusted', 'aging', 'untrusted']
  const term = { name: 'Winter 2027', courses: ['113:MATH 1A'], units: 5 }
  const cases = {
    complete: [result(), plan()],
    unsolvable: [result(), plan({ unsolvable: ['CHEM 1A — offered at De Anza', 'CHEM 1B — offered at De Anza'] }, { isValid: false, missing: ['CHEM 1A', 'CHEM 1B'] })],
    'one unsolvable': [result(), plan({ unsolvable: ['CHEM 1A — offered at De Anza'] }, { isValid: false, missing: ['CHEM 1A'] })],
    'blocking split taken': [result({ isValid: false, splitSeriesViolations: [split('PHYSICS 7B', true)] }), plan({}, { isValid: false, splitSeriesViolations: [split('PHYSICS 7B', true)] })],
    'invalid plan': [result(), plan({}, { isValid: false, missing: ['MATH 53'] })],
  } as const

  for (const [name, [cur, base]] of Object.entries(cases)) for (const t of LEVELS) for (const withTerms of [false, true]) {
    it(`${name} · ${t} · ${withTerms ? 'terms scheduled' : 'nothing scheduled'}`, () => {
      const p: Plan = { ...base, terms: withTerms ? [term] : [] }
      const status = badgeStatus(cur, p, 'UCLA', t)
      const n = scheduleNote(status, p, t)
      const complete = name === 'complete'
      // the completion sentence appears exactly when the verdict is complete, on data that may be trusted, with nothing left
      expect(n?.text === COMPLETE_NOTE).toBe(complete && t !== 'untrusted' && !withTerms)
      if (n) expect(n.text).not.toMatch(/minimum/i)
      if (complete && withTerms) expect(n).toBeNull()
      if (complete && !withTerms && t === 'untrusted') {
        expect(n).toEqual({ tone: 'warn', text: "Nothing more to schedule, but the data needs a refresh, so we can't confirm you are done. Confirm with a counselor before you stop taking courses." })
      }
      if (!complete) {
        expect(n?.tone).toBe('alert')
        expect(n!.text).not.toMatch(/already complete|nothing left/i)
        expect(n!.text).toMatch(/still unmet/)
        expect(n!.text.includes('data also needs a refresh')).toBe(t === 'untrusted')
        expect(n!.text.startsWith(withTerms ? 'This schedule does not finish your plan.' : 'Nothing more can be scheduled at the selected colleges.')).toBe(true)
      }
    })
  }

  it('counts the unmet requirements in plain words', () => {
    const [cur, p] = cases.unsolvable
    expect(scheduleNote(badgeStatus(cur, p, 'UCLA'), p)).toEqual({ tone: 'alert', text: 'Nothing more can be scheduled at the selected colleges. 2 requirements are still unmet: CHEM 1A (offered at De Anza); CHEM 1B (offered at De Anza).' })
    const [c1, p1] = cases['one unsolvable']
    expect(scheduleNote(badgeStatus(c1, p1, 'UCLA'), p1)!.text).toBe('Nothing more can be scheduled at the selected colleges. 1 requirement is still unmet: CHEM 1A (offered at De Anza).')
    const withTerms = { ...p1, terms: [term] }
    expect(scheduleNote(badgeStatus(c1, withTerms, 'UCLA'), withTerms)!.text)
      .toBe('This schedule does not finish your plan. 1 requirement is still unmet and cannot be scheduled at the selected colleges: CHEM 1A (offered at De Anza).')
  })

  it('never trusts a green status that disagrees with the plan (defensive)', () => {
    const p = plan({ unsolvable: ['CHEM 1A'] }, { isValid: false })
    expect(scheduleNote({ ok: true, tone: 'ok', title: 'x', details: [] }, p)?.text).not.toBe(COMPLETE_NOTE)
  })
})

describe('C-1 repro: Mission student, Berkeley ME, chemistry not offered (TESTER1_REPORT)', () => {
  const a = berkeleyMe as unknown as Agreement
  const institutions = institutionsJson as Institution[]
  const unitSystems = Object.fromEntries(institutions.map((i) => [i.id, i.terms]))
  const taken = new Set(['32:MAT 003A', '32:MAT 003B', '32:MAT 004A', '32:MAT 004B', '32:MAT 004C', '32:PHY 004A', '32:PHY 004B', '32:PHY 004C', '32:PHY 004D'])
  const p = solve(taken, a, { allowed: [32], home: 32, termSystem: institutions.find((i) => i.id === 32)!.terms, unitSystems })

  it('nothing can be scheduled, requirements remain, and the note says so on every trust level', () => {
    expect(p.terms).toEqual([])
    expect(p.unsolvable.length).toBeGreaterThan(0)
    for (const t of ['trusted', 'aging', 'untrusted'] as TrustLevel[]) {
      const status = badgeStatus(verifySchedule(taken, a), p, 'UC Berkeley', t)
      expect(status.tone).toBe('problem')
      const n = scheduleNote(status, p, t)!
      expect(n.tone).toBe('alert')
      expect(n.text).not.toBe(COMPLETE_NOTE)
      expect(n.text).toMatch(new RegExp(`^Nothing more can be scheduled at the selected colleges\\. ${p.unsolvable.length} requirements? (is|are) still unmet`))
    }
  })
})

describe('scheduleCaveat (M-3)', () => {
  const withTerms = plan({ terms: [{ name: 'Winter 2027', courses: ['113:MATH 1A'], units: 5 }] })
  it('is on the schedule when the data is untrusted or aging, and absent when trusted or empty', () => {
    expect(scheduleCaveat(withTerms, 'trusted')).toBeNull()
    expect(scheduleCaveat(plan(), 'untrusted')).toBeNull()
    expect(scheduleCaveat(withTerms, 'untrusted')).toEqual({ tone: 'alert', text: 'This schedule is built from ASSIST data that needs a refresh, so courses may be missing or wrong. Check every course with a counselor before you enroll.' })
    expect(scheduleCaveat(withTerms, 'aging', 'Sep 12, 2026')).toEqual({ tone: 'warn', text: 'This schedule is built from ASSIST data downloaded Sep 12, 2026. Check it with a counselor before you enroll.' })
  })
})

describe('noMatchNote (L-7)', () => {
  const a = berkeleyMe as unknown as Agreement
  const short = (i: number) => ({ 113: 'De Anza', 51: 'Foothill' } as Record<number, string>)[i] ?? String(i)
  it('names an honors twin that is not articulated: it will not count', () => {
    expect(a.catalog['51:MATH 1BH']).toBeUndefined()
    expect(a.catalog['51:MATH 1B']).toBeDefined()
    expect(noMatchNote('math 1bh', a.catalog, [51], new Set(), short))
      .toBe('MATH 1BH is not articulated for this major at Foothill — it will not count. ASSIST lists MATH 1B instead; ask a counselor before you retake anything.')
    expect(noMatchNote('MATH1BH', a.catalog, [51], new Set(), short)).toMatch(/^MATH 1BH is not articulated/)
  })

  it('names a course code with no articulation in a subject the college does articulate', () => {
    expect(noMatchNote('MATH 99', a.catalog, [113, 51], new Set(), short))
      .toBe('MATH 99 is not articulated for this major at De Anza or Foothill — it will not count.')
  })

  it('says a course is already added, and falls back to a general line for unknown subjects or words', () => {
    expect(noMatchNote('math 1a', a.catalog, [113], new Set(['113:MATH 1A']), short)).toBe('MATH 1A at De Anza is already in your completed courses.')
    expect(noMatchNote('HIST 17A', a.catalog, [113], new Set(), short)).toBe('No course at De Anza that counts for this major matches "HIST 17A". Courses not listed here are not articulated for this major and will not count.')
    expect(noMatchNote('underwater basket', a.catalog, [113, 51], new Set(), short)).toMatch(/^No course at De Anza or Foothill that counts/)
  })
})

describe('unmetNames (C-1: say what is unmet)', () => {
  it('names unschedulable rows with where they are offered, else the missing ones, capped at 3', () => {
    expect(unmetNames(plan({ unsolvable: ['CHEM 1A — offered at De Anza', 'CHEM 1B'] }))).toBe('CHEM 1A (offered at De Anza); CHEM 1B')
    expect(unmetNames(plan({}, { missing: ['A', 'B', 'C', 'D', 'E'] }))).toBe('A; B; C; and 2 more')
    expect(unmetNames(plan())).toBe('')
  })
})

describe('prerequisite-only courses', () => {
  it('reads Plan.prereqOnly defensively and tags with "prerequisite"', () => {
    expect(PREREQ_TAG).toBe('prerequisite')
    expect([...prereqOnlySet(plan())]).toEqual([])
    expect(prereqOnlySet(plan({ prereqOnly: ['113:MATH 1A'] })).has('113:MATH 1A')).toBe(true)
    expect([...prereqOnlySet({ ...plan(), prereqOnly: 'bad' } as unknown as Plan)]).toEqual([])
  })
})

describe('start term (M-5)', () => {
  it('the default start on the tester date is passed to solve and labels the first term', () => {
    const a = berkeleyMe as unknown as Agreement
    const institutions = institutionsJson as Institution[]
    const unitSystems = Object.fromEntries(institutions.map((i) => [i.id, i.terms]))
    const start = nextOpenTerm(new Date('2026-09-24T12:00:00Z'), 'quarter')!
    const p = solve(new Set(), a, { allowed: [113], home: 113, termSystem: 'quarter', unitSystems, startTerm: start })
    expect(p.terms.length).toBeGreaterThan(0)
    expect(p.terms[0].name).toBe(termLabel(start))
    expect(p.terms[0].name).not.toBe('Fall 2026')
  })
})

describe('M-4 safety net: a "choose several" group is never green', () => {
  it('turns a would-be green amber with the counselor caveat and names the group', () => {
    const s = badgeStatus(result({ review: ['"Choose 2"'] }), plan({}, { review: ['"Choose 2"'] }), 'UCLA')
    expect(s).toMatchObject({ ok: false, tone: 'caution', title: REVIEW_TITLE, caveat: CAVEAT.review })
    expect(s.details).toContain('Check: "Choose 2"')
  })
  it('is amber when only the plan result carries the flag', () => {
    expect(badgeStatus(result(), plan({}, { review: ['x'] }), 'UCLA').tone).toBe('caution')
  })
  it('red stays red, and untrusted stays unconfirmed', () => {
    expect(badgeStatus(result({ isValid: false }), plan({}, { isValid: false, review: ['x'] }), 'UCLA').tone).toBe('problem')
    expect(badgeStatus(result({ review: ['x'] }), plan({}, { review: ['x'] }), 'UCLA', 'untrusted').tone).toBe('unconfirmed')
  })
  it('with prior-year data too, the caveat keeps both the review and the prior-year sentences (round 7 L-5)', () => {
    const t = { level: 'aging' as const, yearNote: "2026-27 agreements aren't published on ASSIST yet" }
    const s = badgeStatus(result({ review: ['"Choose 2"'] }), plan({}, { review: ['"Choose 2"'] }), 'UCLA', t)
    expect(s).toMatchObject({ ok: false, tone: 'caution', title: REVIEW_TITLE, caveat: CAVEAT.reviewPriorYear })
    expect(s.caveat).toMatch(/choose several of these/)
    expect(s.caveat).toMatch(/prior academic year's agreements/)
    expect(s.caveat?.match(/Confirm with a counselor/g)).toHaveLength(1)
    expect(s.details).toContain('Check: "Choose 2"')
    // without a year note, the review caveat alone, as before
    expect(badgeStatus(result({ review: ['x'] }), plan({}, { review: ['x'] }), 'UCLA', { level: 'aging', yearNote: null }).caveat).toBe(CAVEAT.review)
    // a failed plan still wins over both
    const failed = { ...plan({}, { review: ['x'] }), error: 'timed out' } as Plan
    expect(badgeStatus(result({ review: ['x'] }), failed, 'UCLA', t)).toMatchObject({ tone: 'problem', title: PLAN_FAILED_TITLE })
  })
  it('the schedule note never says complete, and names the choose-several reason', () => {
    const p = plan({}, { review: ['x'] })
    const note = scheduleNote(badgeStatus(result({ review: ['x'] }), p, 'UCLA'), p)
    expect(note?.tone).toBe('warn')
    expect(note?.text).toMatch(/choose several/)
    expect(note?.text).not.toBe(COMPLETE_NOTE)
  })
})

describe('round 7: only exactly "trusted" or "aging" may be green', () => {
  const invalid: unknown[] = ['Untrusted', 'TRUSTED', '', ' trusted', 0, null, { level: undefined }, { level: 'Trusted', yearNote: null }, {}, { level: null }]
  for (const t of invalid) it(`${JSON.stringify(t) ?? 'undefined'} is untrusted, and does not throw`, () => {
    const s = badgeStatus(result(), plan(), 'UCLA', t as TrustLevel)
    expect(s).toEqual({ ok: false, tone: 'unconfirmed', title: UNCONFIRMED_TITLE, details: [], caveat: CAVEAT.unconfirmed })
    const red = badgeStatus(result(), plan({}, { isValid: false }), 'UCLA', t as TrustLevel)
    expect(red).toMatchObject({ ok: false, tone: 'problem', caveat: CAVEAT.problem })
  })
  it('an omitted trust keeps the "trusted" default; valid levels are unchanged', () => {
    expect(badgeStatus(result(), plan(), 'UCLA').tone).toBe('ok')
    expect(badgeStatus(result(), plan(), 'UCLA', { level: 'aging', yearNote: null }).caveat).toBe(CAVEAT.aging)
  })
  it('scheduleNote and scheduleCaveat read an invalid level as untrusted', () => {
    const s = badgeStatus(result(), plan(), 'UCLA')
    expect(scheduleNote(s, plan(), 'Trusted' as TrustLevel)?.text).not.toBe(COMPLETE_NOTE)
    const withTerms = plan({ terms: [{} as Plan['terms'][number]] })
    expect(scheduleCaveat(withTerms, '' as TrustLevel)?.tone).toBe('alert')
  })
})

describe('N-2: a failed plan is reported, never a verdict', () => {
  it('shows "Couldn\'t build a plan" with the error, even on trusted data with a valid completed-course check', () => {
    const failed = { ...plan({}, { isValid: false }), unsolvable: ['Planning failed: boom'], error: 'boom' }
    const s = badgeStatus(result(), failed, 'UCLA', 'trusted')
    expect(s).toMatchObject({ ok: false, tone: 'problem', title: PLAN_FAILED_TITLE, details: ['boom'], caveat: CAVEAT.planFailed })
  })
})
