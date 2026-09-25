import { describe, expect, it } from 'vitest'
import type { Agreement, CourseId } from '../engine/types'
import { errorPlan, type PlanResult } from '../engine/solveClient'
import { badgeStatus } from './plannerStatus'
import { authoritative, beyondWindow, EMPTY_PLAN, inputsKey, maxTermsFor, planView, showSchedule, tooLongNote, type PlanInputs, type Solved } from './planState'

const agA = { receivingId: 79, major: 'A' } as unknown as Agreement
const agB = { receivingId: 79, major: 'B' } as unknown as Agreement
const inputs = (over: Partial<PlanInputs> = {}): PlanInputs =>
  ({ taken: new Set<CourseId>(), allowed: [113, 51], home: 113, unitCap: 16, maxTerms: 6, start: 'Winter-2027', ...over })
const green: PlanResult = { ...EMPTY_PLAN, result: { ...EMPTY_PLAN.result, isValid: true }, terms: [{ name: 'Winter 2027', courses: ['113:MATH 1A'], units: 5 }] as PlanResult['terms'] }
const solvedFor = (agreement: Agreement, i: PlanInputs, plan: PlanResult = green): Solved => ({ agreement, key: inputsKey(i), plan })

describe('inputsKey', () => {
  it('ignores the order of completed courses but not their content', () => {
    expect(inputsKey(inputs({ taken: new Set(['1:A', '2:B']) }))).toBe(inputsKey(inputs({ taken: new Set(['2:B', '1:A']) })))
    expect(inputsKey(inputs({ taken: new Set(['1:A']) }))).not.toBe(inputsKey(inputs()))
  })
  it('changes with every other solver input', () => {
    const base = inputsKey(inputs())
    for (const over of [{ allowed: [113] }, { home: 51 }, { unitCap: 12 }, { maxTerms: 5 }, { start: 'Spring-2027' }])
      expect(inputsKey(inputs(over))).not.toBe(base)
  })
})

describe('planView (r7 M-1/M-2: planning is derived synchronously from the inputs)', () => {
  it('no agreement: nothing to plan', () => {
    expect(planView(null, null, inputsKey(inputs()))).toMatchObject({ planning: false, plan: EMPTY_PLAN })
  })

  it('M-1: a newly loaded agreement is planning on its first render, never a verdict on the empty plan', () => {
    const k = inputsKey(inputs())
    const v = planView(solvedFor(agA, inputs()), agB, k) // the old agreement's plan is still in state
    expect(v).toMatchObject({ planning: true, stale: false, plan: EMPTY_PLAN })
    expect(authoritative(v)).toBe(false)
    expect(planView(null, agA, k).planning).toBe(true)
  })

  it('M-2: a change to completed courses or colleges is planning until the plan for those inputs arrives', () => {
    const old = solvedFor(agA, inputs())
    for (const now of [inputs({ taken: new Set(['113:PHYS 4A']) }), inputs({ allowed: [113] }), inputs({ start: 'Spring-2027' })]) {
      const v = planView(old, agA, inputsKey(now))
      expect(v.planning).toBe(true)
      expect(v.stale).toBe(true) // the previous plan may be shown, dimmed, never as the answer
      expect(authoritative(v)).toBe(false)
    }
  })

  it('shows the verdict once the plan for exactly these inputs arrives', () => {
    const i = inputs({ taken: new Set(['113:PHYS 4A']) })
    const v = planView(solvedFor(agA, i), agA, inputsKey(inputs({ taken: new Set(['113:PHYS 4A']) })))
    expect(v).toEqual({ plan: green, planning: false, stale: false, failed: false })
    expect(authoritative(v)).toBe(true)
  })

  it('N-2: an error plan for these inputs is not planning, is failed, and is not authoritative', () => {
    const v = planView(solvedFor(agA, inputs(), errorPlan('worker crashed')), agA, inputsKey(inputs()))
    expect(v).toMatchObject({ planning: false, failed: true })
    expect(authoritative(v)).toBe(false)
    expect(badgeStatus({ ...EMPTY_PLAN.result, isValid: true }, v.plan, 'UCLA').title).toBe("Couldn't build a plan")
  })

  it('an error plan for other inputs is just stale (planning), not failed', () => {
    const v = planView(solvedFor(agA, inputs(), errorPlan('x')), agA, inputsKey(inputs({ home: 51 })))
    expect(v).toMatchObject({ planning: true, stale: true, failed: false })
  })
})

describe('maxTermsFor / tooLongNote (fix 3): the limit is two academic years in the home calendar', () => {
  it('is 4 semesters or 6 quarters', () => {
    expect(maxTermsFor('semester')).toBe(4)
    expect(maxTermsFor('quarter')).toBe(6)
  })
  it('the note names the home calendar, and is null when nothing is beyond the window', () => {
    expect(tooLongNote(false, 'semester')).toBeNull()
    expect(tooLongNote(true, 'semester')).toBe('More than 4 semesters (two academic years) needed at this unit cap. Talk to a counselor about your timeline before you enroll.')
    expect(tooLongNote(false, 'quarter')).toBeNull()
    expect(tooLongNote(true, 'quarter')).toMatch(/^More than 6 quarters/)
  })
  it('the limit is part of the inputs key, so switching calendars re-plans', () => {
    expect(inputsKey(inputs({ maxTerms: maxTermsFor('semester') }))).not.toBe(inputsKey(inputs({ maxTerms: maxTermsFor('quarter') })))
  })
})

describe('showSchedule (fix 7): no empty schedule header for a failed plan', () => {
  const i = inputs()
  it('hides the schedule for an error plan', () => {
    const v = planView(solvedFor(agA, i, errorPlan('timed out')), agA, inputsKey(i))
    expect(v.failed).toBe(true)
    expect(showSchedule(v)).toBe(false)
  })
  it('hides it while the first plan is being built, shows a stale plan dimmed', () => {
    expect(showSchedule(planView(null, agA, inputsKey(i)))).toBe(false)
    expect(showSchedule(planView(solvedFor(agA, i), agA, inputsKey(inputs({ home: 51 }))))).toBe(true)
  })
  it('shows a settled plan, with terms or with none (its note says why nothing is scheduled)', () => {
    expect(showSchedule(planView(solvedFor(agA, i), agA, inputsKey(i)))).toBe(true)
    expect(showSchedule(planView(solvedFor(agA, i, EMPTY_PLAN), agA, inputsKey(i)))).toBe(true)
  })
})

describe('beyondWindow (r9: the too-long window is measured in time, not by counting cards)', () => {
  type Sys = 'quarter' | 'semester'
  // a planned term as the solver emits it (span from engine/calendar.ts: Fall Y = 3Y, Winter/Spring semester Y = [3(Y-1)+1, 3(Y-1)+2])
  const card = (label: string): PlanResult['terms'][number] => {
    const m = /^(Fall|Winter|Spring) (\d{4})(?: \((quarter|semester)\))?$/.exec(label)!
    const season = m[1] as 'Fall' | 'Winter' | 'Spring', year = Number(m[2]), system = (m[3] ?? 'quarter') as Sys
    const base = season === 'Fall' ? 3 * year : 3 * (year - 1) + 1
    const span: [number, number] = season === 'Fall' ? [base, base]
      : system === 'semester' ? [base, base + 1] : season === 'Winter' ? [base, base] : [base + 1, base + 1]
    return { name: label, courses: [], units: 12, system, season, year, span }
  }
  const sem = (label: string) => card(`${label} (semester)`)
  const run = (labels: string[], mk: (l: string) => PlanResult['terms'][number], start: string, home: Sys) => {
    const [season, year] = start.split(' ')
    return beyondWindow(labels.map(mk), { season: season as 'Fall', year: Number(year) }, home)
  }

  it('single semester calendar: 4 semesters fit, the 5th is beyond', () => {
    const four = ['Spring 2027', 'Fall 2027', 'Spring 2028', 'Fall 2028']
    expect(run(four, sem, 'Spring 2027', 'semester')).toEqual([])
    expect(run([...four, 'Spring 2029'], sem, 'Spring 2027', 'semester')).toEqual([4])
    expect(run(['Fall 2026', 'Spring 2027', 'Fall 2027', 'Spring 2028', 'Fall 2028'], sem, 'Fall 2026', 'semester')).toEqual([4])
  })

  it('single quarter calendar: 6 quarters fit, the 7th is beyond', () => {
    const six = ['Fall 2026', 'Winter 2027', 'Spring 2027', 'Fall 2027', 'Winter 2028', 'Spring 2028']
    expect(run(six, card, 'Fall 2026', 'quarter')).toEqual([])
    expect(run([...six, 'Fall 2028'], card, 'Fall 2026', 'quarter')).toEqual([6])
  })

  it('start term not Fall: the window starts at the chosen term', () => {
    const q = ['Winter 2027', 'Spring 2027', 'Fall 2027', 'Winter 2028', 'Spring 2028', 'Fall 2028', 'Winter 2029']
    expect(run(q.slice(0, 6), card, 'Winter 2027', 'quarter')).toEqual([])
    expect(run(q, card, 'Winter 2027', 'quarter')).toEqual([6])
    const s = ['Spring 2027', 'Fall 2027', 'Spring 2028', 'Fall 2028', 'Spring 2029']
    expect(run(s.slice(0, 4), sem, 'Spring 2027', 'semester')).toEqual([])
    expect(run(s, sem, 'Spring 2027', 'semester')).toEqual([4])
  })

  it('under-warn repro: quarter home + semester extra, 6 mixed cards running to Winter 2029 (7th quarter) is flagged', () => {
    const labels = ['Spring 2027 (semester)', 'Fall 2027 (quarter)', 'Fall 2027 (semester)', 'Spring 2028 (semester)', 'Fall 2028 (quarter)', 'Winter 2029 (quarter)']
    expect(run(labels, card, 'Winter 2027', 'quarter')).toEqual([5])
  })

  it('false-alarm repro: semester home + quarter extra, 8 mixed cards within Spring 2027-Fall 2028 is not flagged', () => {
    const labels = ['Winter 2027 (quarter)', 'Spring 2027 (semester)', 'Spring 2027 (quarter)', 'Fall 2027 (quarter)', 'Fall 2027 (semester)',
      'Winter 2028 (quarter)', 'Spring 2028 (semester)', 'Fall 2028 (semester)']
    expect(run(labels, card, 'Spring 2027', 'semester')).toEqual([])
    // one more semester, and only the card past the window is red
    expect(run([...labels, 'Spring 2029 (semester)'], card, 'Spring 2027', 'semester')).toEqual([8])
  })

  it('a semester term that starts inside a quarter window but ends after it is beyond (the "ends after" rule)', () => {
    // quarter home from Spring 2027: 6 quarters end with Winter 2029; Spring 2029 semester runs Jan-May 2029
    expect(run(['Spring 2027 (quarter)', 'Winter 2029 (quarter)', 'Spring 2029 (semester)'], card, 'Spring 2027', 'quarter')).toEqual([2])
  })

  it('terms without calendar info fall back to position', () => {
    const bare = Array.from({ length: 7 }, (_, i) => ({ name: `T${i}`, courses: [], units: 12 }))
    expect(beyondWindow(bare, { season: 'Fall', year: 2026 }, 'quarter')).toEqual([6])
  })
})
