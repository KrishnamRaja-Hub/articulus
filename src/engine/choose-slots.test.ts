import { describe, expect, it } from 'vitest'
import type { Agreement } from './types'
import { verifySchedule } from './verify'
import { solve } from './solve'

// Regressions from the independent tester's review of round 10 (choose-N one course per slot, UNITS thresholds).
const cat: Record<string, unknown> = {}
const course = (i: number | string) => {
  const c = `1:P${i} 1`
  cat[c] = { id: c, institutionId: 1, prefix: `P${i}`, number: '1', title: `t${i}q`, units: 4 }
  return c
}
const row = (id: string, cs: string[][], units = 4): any => ({ kind: 'req', id, label: id, units, groups: cs.map((c) => ({ institutionId: 1, courses: c })) })
const uc = (id: string, units = 4): any => ({ kind: 'req', id, label: id, units, groups: [], noArticulation: { 1: 'No Course Articulated' } })
const node = (type: string, children: any[], n?: number): any => ({ kind: 'node', type, required: true, children, ...(n !== undefined ? { n } : {}) })
const ag = (root: any) => ({ receivingId: 99, major: 'x', year: '2025', sendingIds: [1], root, catalog: cat }) as unknown as Agreement
const opts = (timeLimitMs = 3000): any => ({ allowed: [1], home: 1, termSystem: 'quarter', unitSystems: { 1: 'quarter' }, startTerm: { season: 'Fall', year: 2026 }, timeLimitMs })
const verify = (root: any, taken: string[]) => verifySchedule(new Set(taken), ag(root))
const plan = (root: any, taken: string[], ms?: number) => solve(new Set(taken), ag(root), opts(ms))
const blank = (s: string) => /(^|: )$|of: $|of:\s*(—|$)/.test(s)

const cs = [...Array(60).keys()].map(course)
const [A, B, C, D] = cs

describe('choose N: the kept ways are not capped before they are deduplicated', () => {
  it('choose 3 of [choose 6 of 14, X, Y], all 14 courses taken: met', () => {
    const inner = node('N_OF', cs.slice(0, 14).map((c, i) => row('I' + i, [[c]])), 6)
    const r = node('N_OF', [inner, row('X', [[cs[0]]]), row('Y', [[cs[1]]])], 3)
    expect(verify(r, cs.slice(0, 14)).isValid).toBe(true)
    expect(plan(r, cs.slice(0, 14)).unsolvable).toEqual([])
  })
})

describe('UNITS: a heavier option is not dropped for a lighter one it contains', () => {
  it('UNITS 4 of [AND(OR(R0 unknown units, R1 4u), R0)], both courses taken: met', () => {
    const r = node('UNITS', [node('AND', [node('OR', [row('R0', [[A]], NaN), row('R1', [[B]], 4)]), row('R0', [[A]], NaN)])], 4)
    expect(verify(r, [A, B]).isValid).toBe(true)
    const p = plan(r, [])
    expect(p.unsolvable).toEqual([])
    expect(verify(r, p.terms.flatMap((t) => t.courses)).isValid).toBe(true)
  })
  it('UNITS 12 of [AND(choose 2 of (X0 unknown, X2 5u, X1 4u), X4 4u, X0)], all taken: met', () => {
    const X0 = row('X0', [[C]], NaN)
    const r = node('UNITS', [node('AND', [node('N_OF', [X0, row('X2', [[A]], 5), row('X1', [[B]], 4)], 2), row('X4', [[D]], 4), X0])], 12)
    expect(verify(r, [A, B, C, D]).isValid).toBe(true)
  })
})

describe('a UC-only row listed twice fills one slot, not two', () => {
  const U = uc('U')
  it('choose 2 of [U, U]: cannot be met, and says so by name', () => {
    const r = node('N_OF', [U, U], 2)
    const v = verify(r, [])
    expect(v.isValid).toBe(false)
    expect(v.missing.length).toBeGreaterThan(0)
    const p = plan(r, [])
    expect(p.unsolvable.length).toBeGreaterThan(0)
    for (const m of [...v.missing, ...p.unsolvable]) expect(blank(m), m).toBe(false)
  })
  it('choose 3 of [C, U, U] with C taken: cannot be met', () => {
    const r = node('N_OF', [row('C', [[C]]), U, U], 3)
    expect(verify(r, [C]).isValid).toBe(false)
    expect(plan(r, [C]).unsolvable.length).toBeGreaterThan(0)
  })
  it('choose 2 of [U, AND(U, C)] with C taken: cannot be met', () => {
    const r = node('N_OF', [U, node('AND', [U, row('C', [[C]])])], 2)
    expect(verify(r, [C]).isValid).toBe(false)
    expect(plan(r, [C]).unsolvable.length).toBeGreaterThan(0)
  })
  it('two different UC-only rows still fill two slots', () => {
    const r = node('N_OF', [U, uc('V')], 2)
    const v = verify(r, [])
    expect(v.isValid).toBe(true)
    expect(v.deferred).toEqual(['U', 'V'])
  })
})

describe('missing messages are never blank', () => {
  it('choose 2 of [A, B], both needing the same course, taken', () => {
    const r = node('N_OF', [row('A', [[A]]), row('B', [[A]])], 2)
    const v = verify(r, [A])
    expect(v.isValid).toBe(false)
    expect(v.missing.length).toBeGreaterThan(0)
    for (const m of v.missing) expect(blank(m), m).toBe(false)
  })
  it('UNITS of UC-only rows only, short of the threshold', () => {
    const r = node('UNITS', [uc('U', 4), uc('U', 4)], 8)
    const v = verify(r, [])
    expect(v.isValid).toBe(false)
    for (const m of [...v.missing, ...plan(r, []).unsolvable]) expect(blank(m), m).toBe(false)
  })
})

// The tester's performance trees: each used to take seconds to minutes (units 60/40 k=14: 55 s in verify, over
// 4 minutes in solve). The search is now budgeted. Limits are generous for loaded CI machines.
describe('choose-N / UNITS search is bounded', () => {
  const deep = (d: number, off: number): any =>
    d === 0 ? row(`D${off}`, [[cs[off % 12]], [cs[(off + 5) % 12]]]) : node('N_OF', [0, 1, 2, 3].map((k) => deep(d - 1, off * 4 + k)), 2)
  const trees: [string, any, string[]][] = [
    ['choose 20 of 40', node('N_OF', cs.slice(0, 40).map((c, i) => row('R' + i, [[c]])), 20), cs.slice(0, 20)],
    ['choose 20 of 40, shared courses', node('N_OF', [...Array(40).keys()].map((i) => row('S' + i, [[cs[i % 25]], [cs[(i + 1) % 25]]])), 20), cs.slice(0, 25)],
    ['choose 10 of 30, two-course series', node('N_OF', [...Array(30).keys()].map((i) => row('Q' + i, [[cs[i % 20], cs[(i + 3) % 20]], [cs[(i + 7) % 20], cs[(i + 11) % 20]]])), 10), cs.slice(0, 18)],
    ['nested choose 2 of 4, depth 4', deep(4, 1), cs.slice(0, 12)],
    ['nested choose 2 of 4, depth 5', deep(5, 1), cs.slice(0, 12)],
    ['UNITS 60 over 40 rows', node('UNITS', [...Array(40).keys()].map((i) => row('U' + i, [[cs[i % 25]], [cs[(i + 1) % 25]]], 1 + (i % 5))), 60), cs.slice(0, 14)],
  ]
  it.each(trees)('%s: verify stays fast', (_, r, taken) => {
    verify(r, taken) // first call builds the per-agreement caches
    const t = performance.now()
    verify(r, taken)
    verify(r, [])
    expect(performance.now() - t).toBeLessThan(1500)
  })
  it.each(trees)('%s: solve respects its time limit and its plan passes', (_, r) => {
    const t = performance.now()
    const p = plan(r, [], 1000)
    expect(performance.now() - t).toBeLessThan(6000)
    if (!p.unsolvable.length) expect(verify(r, p.terms.flatMap((x) => x.courses)).isValid).toBe(true)
  }, 20_000)
})
