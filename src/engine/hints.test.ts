import { describe, expect, it } from 'vitest'
import type { Agreement, ReqNode, Requirement } from './types'
import { honorsHint, honorsHints, honorsNote } from './hints'
import { verifySchedule } from './verify'
import ucsdMae from '../../data/agreements/7-mae-mechanical-engineering-b-s.json'
import ucsdEce from '../../data/agreements/7-ece-electrical-engineering-b-s.json'
import berkeleyMe from '../../data/agreements/79-mechanical-engineering-b-s.json'

const DA = 113, FH = 51
const reqs = (n: ReqNode, acc: Requirement[] = []): Requirement[] => {
  for (const c of n.children) if (c.kind === 'req') acc.push(c); else reqs(c, acc)
  return acc
}
const find = (a: Agreement, id: string) => reqs(a.root).find((r) => r.id === id)!
const req = (id: string, groups: [number, string[]][]): Requirement =>
  ({ kind: 'req', id, label: id, units: 4, groups: groups.map(([institutionId, courses]) => ({ institutionId, courses })) })

describe('honorsHint on real agreements (COUNSELOR_REPORT HIGH-5)', () => {
  for (const [name, json] of [['UCSD MAE', ucsdMae], ['UCSD ECE', ucsdEce]] as const) {
    const a = json as unknown as Agreement
    const taken = new Set([`${DA}:MATH 1CH`, `${DA}:MATH 1D`])

    it(`${name}: De Anza MATH 1CH + 1D gets a hint on MATH 20E, which lists only 1C + 1D`, () => {
      const h = honorsHint(find(a, 'MATH 20E'), taken)
      expect(h).toEqual([{
        requirementId: 'MATH 20E', institutionId: DA,
        group: { institutionId: DA, courses: [`${DA}:MATH 1C`, `${DA}:MATH 1D`] },
        swaps: [{ listed: `${DA}:MATH 1C`, taken: `${DA}:MATH 1CH` }],
      }])
      expect(honorsNote(h[0])).toBe('ASSIST lists MATH 1C, not MATH 1CH, for this row. Honors versions are usually accepted — confirm with a counselor before retaking.')
    })

    it(`${name}: the verdict stays strict (20E unsatisfied), and 20C (which lists the honors twin) needs no hint`, () => {
      const r = verifySchedule(taken, a)
      expect(r.satisfied['MATH 20E']).toBeUndefined()
      expect(r.satisfied['MATH 20C']).toBeDefined()
      expect(honorsHint(find(a, 'MATH 20C'), taken)).toEqual([])
      const all = honorsHints(reqs(a.root), taken)
      expect(Object.keys(all)).toEqual(['MATH 20E'])
      // the hint module never touches the result
      expect(verifySchedule(taken, a)).toEqual(r)
    })

    it(`${name}: no hint when the regular courses were taken, or when the honors course alone is not enough`, () => {
      expect(honorsHint(find(a, 'MATH 20E'), new Set([`${DA}:MATH 1C`, `${DA}:MATH 1D`]))).toEqual([])
      expect(honorsHint(find(a, 'MATH 20E'), new Set([`${DA}:MATH 1CH`]))).toEqual([])
      expect(honorsHint(find(a, 'MATH 20E'), new Set([`${DA}:MATH 1CH`, `${FH}:MATH 1D`]))).toEqual([]) // twin at the wrong college
      expect(honorsHints(reqs(a.root), new Set())).toEqual({})
    })

    it(`${name}: both honors (1CH + 1DH) name both swaps`, () => {
      const h = honorsHint(find(a, 'MATH 20E'), new Set([`${DA}:MATH 1CH`, `${DA}:MATH 1DH`]))
      expect(honorsNote(h[0])).toBe('ASSIST lists MATH 1C and MATH 1D, not MATH 1CH and MATH 1DH, for this row. Honors versions are usually accepted — confirm with a counselor before retaking.')
    })
  }

  it('Berkeley ME: De Anza lists honors twins on every math row, so honors never needs a hint there', () => {
    const a = berkeleyMe as unknown as Agreement
    const taken = new Set(['1AH', '1BH', '1CH', '1DH', '2AH', '2BH', '1A', '1C', '2A'].map((c) => `${DA}:MATH ${c}`))
    expect(honorsHints(reqs(a.root), taken)).toEqual({})
  })

  it('Berkeley ME: Foothill lists no honors twin for MATH 52, so a Foothill 1BH gets a hint (synthetic course id)', () => {
    const a = berkeleyMe as unknown as Agreement
    const h = honorsHint(find(a, 'MATH 52'), new Set([`${FH}:MATH 1BH`, `${FH}:MATH 1C`]))
    expect(h.map((x) => [x.institutionId, x.swaps])).toEqual([[FH, [{ listed: `${FH}:MATH 1B`, taken: `${FH}:MATH 1BH` }]]])
    expect(verifySchedule(new Set([`${FH}:MATH 1BH`, `${FH}:MATH 1C`]), a).satisfied['MATH 52']).toBeUndefined()
  })
})

describe('honorsHint on synthetic rows', () => {
  it('handles the reverse direction: regular taken where only the honors course is listed', () => {
    const r = req('X 1', [[1, ['1:X 1AH']]])
    const h = honorsHint(r, new Set(['1:X 1A']))
    expect(h[0].swaps).toEqual([{ listed: '1:X 1AH', taken: '1:X 1A' }])
    expect(honorsNote(h[0])).toBe('ASSIST lists X 1AH, not X 1A, for this row. Regular and honors versions usually count the same, but only the honors version is listed — confirm with a counselor before retaking.')
  })

  it('words a mixed swap neutrally', () => {
    const r = req('X 2', [[1, ['1:X 1A', '1:X 1BH']]])
    const h = honorsHint(r, new Set(['1:X 1AH', '1:X 1B']))
    expect(honorsNote(h[0])).toBe('ASSIST lists X 1A and X 1BH, not X 1AH and X 1B, for this row. Regular and honors versions usually count the same — confirm with a counselor before retaking.')
  })

  it('is empty for a satisfied row, even if another group would need a swap', () => {
    const r = req('X 3', [[1, ['1:X 1A']], [2, ['2:X 1A']]])
    expect(honorsHint(r, new Set(['1:X 1A', '2:X 1AH']))).toEqual([])
  })

  it('skips colleges that already list an honors twin (the engine swaps there, so the row would be satisfied)', () => {
    const r = req('X 4', [[1, ['1:X 1A', '1:X 1B']], [1, ['1:X 1AH', '1:X 1BH']]])
    expect(honorsHint(r, new Set(['1:X 1AH', '1:X 1B']))).toEqual([]) // satisfied by the engine
    expect(honorsHint(r, new Set(['1:X 1AH']))).toEqual([])
  })

  it('gives one hint per college (fewest swaps) and one per college that qualifies', () => {
    const r = req('X 5', [[1, ['1:X 1A', '1:X 1B']], [1, ['1:X 1B', '1:X 1C']], [2, ['2:X 1A']]])
    const h = honorsHint(r, new Set(['1:X 1AH', '1:X 1BH', '1:X 1C', '2:X 1AH']))
    expect(h.map((x) => [x.institutionId, x.swaps.length, x.group.courses])).toEqual([[1, 1, ['1:X 1B', '1:X 1C']], [2, 1, ['2:X 1A']]])
  })

  it('never offers a hint without a real swap, or across colleges', () => {
    const r = req('X 6', [[1, ['1:X 1A', '1:X 1B']]])
    expect(honorsHint(r, new Set(['1:X 1A']))).toEqual([])
    expect(honorsHint(r, new Set(['1:X 1A', '2:X 1BH']))).toEqual([])
    expect(honorsHint(req('X 7', []), new Set(['1:X 1A']))).toEqual([])
  })

  it('does not double-strip: a course ending in HH is not a twin of H', () => {
    const r = req('X 8', [[1, ['1:X 1A']]])
    expect(honorsHint(r, new Set(['1:X 1AHH']))).toEqual([])
  })
})
