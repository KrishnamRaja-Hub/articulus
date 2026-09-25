import { describe, expect, it } from 'vitest'
import type { Agreement, CourseId } from '../engine/types'
import { errorPlan, type PlanResult } from '../engine/solveClient'
import { badgeStatus } from './plannerStatus'
import { authoritative, EMPTY_PLAN, inputsKey, planView, type PlanInputs, type Solved } from './planState'

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
