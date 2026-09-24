/**
 * Transcript generators over the real agreements (independent of src/, types only).
 *  - exhaustive: for every row, every subset of the courses its groups list at 1, 2 or 3 colleges (plus catalog honors
 *    twins), alone and on top of a background where every other row is complete; capped subsets are sampled.
 *  - random: sparse / dense / near-complete / honors-flipped / garbage transcripts over 1-15 colleges.
 */
import type { Agreement, CourseId } from '../../src/engine/types'
import { uniqueRows } from './oracle.ts'
import type { Rng } from './synth.ts'

const combos = <T>(xs: T[], k: number): T[][] =>
  k === 0 ? [[]] : xs.flatMap((x, i) => combos(xs.slice(i + 1), k - 1).map((c) => [x, ...c]))

export interface ExhaustiveBudget { subsetCap: number; pairs: number; triples: number; pairCap: number }

export function* exhaustive(a: Agreement, r: Rng, b: ExhaustiveBudget): Generator<Set<CourseId>> {
  const rows = uniqueRows(a)
  const cover = new Map<number, number>()
  for (const row of rows) for (const g of row.groups) cover.set(g.institutionId, (cover.get(g.institutionId) ?? 0) + 1)
  const best = [...cover].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0]?.[0]
  for (const row of rows) {
    const background = rows.filter((x) => x.id !== row.id && x.groups.length)
      .flatMap((x) => (x.groups.find((g) => g.institutionId === best) ?? x.groups[0]).courses)
    const insts = [...new Set(row.groups.map((g) => g.institutionId))]
    const sets = [...combos(insts, 1), ...r.shuffle(combos(insts, 2)).slice(0, b.pairs), ...r.shuffle(combos(insts, 3)).slice(0, b.triples)]
    for (const S of sets) {
      const courses = [...new Set(row.groups.filter((g) => S.includes(g.institutionId)).flatMap((g) => g.courses))]
      for (const c of [...courses]) {
        const twin = c.endsWith('H') ? c.slice(0, -1) : `${c}H`
        if (a.catalog[twin] && !courses.includes(twin)) courses.push(twin)
      }
      const cap = S.length === 1 ? b.subsetCap : S.length === 2 ? b.pairCap : Math.max(1, b.pairCap / 2)
      const subs: CourseId[][] = []
      if (courses.length < 31 && 2 ** courses.length <= cap)
        for (let m = 0; m < 2 ** courses.length; m++) subs.push(courses.filter((_, i) => (m >> i) & 1))
      else for (let k = 0; k < cap; k++) subs.push(courses.filter(() => r.next() < 0.5))
      for (const s of subs) {
        yield new Set(s)
        yield new Set([...background, ...s])
      }
    }
  }
}

export const GARBAGE = ['999:FAKE 1', '', '113:', 'MATH 1A', '113:math 1a', ' 113:MATH 1A', ':']

export function randomTranscript(a: Agreement, r: Rng, ccs: number[]): Set<CourseId> {
  const rows = uniqueRows(a)
  const colleges = r.shuffle(ccs).slice(0, r.pick([1, 1, 2, 2, 3, 3, 4, 15]))
  const mode = r.pick(['sparse', 'dense', 'near', 'near', 'honors', 'garbage'] as const)
  let taken = new Set<CourseId>()
  const cat = Object.keys(a.catalog).filter((c) => colleges.includes(Number(c.slice(0, c.indexOf(':')))))
  if (mode === 'sparse') for (const c of cat) if (r.next() < 0.1) taken.add(c)
  if (mode === 'dense') for (const c of cat) if (r.next() < 0.5) taken.add(c)
  if (mode === 'near' || mode === 'honors' || mode === 'garbage') {
    for (const row of rows) {
      const gs = row.groups.filter((g) => colleges.includes(g.institutionId))
      if (!gs.length) continue
      for (const c of r.pick(gs).courses) if (r.next() < 0.93) taken.add(c)
      if (r.next() < 0.08) for (const c of r.pick(row.groups).courses) if (r.next() < 0.5) taken.add(c) // stray piece elsewhere
    }
  }
  if (mode === 'honors') taken = new Set([...taken].map((c) => (r.next() < 0.4 ? (c.endsWith('H') ? c.slice(0, -1) : `${c}H`) : c)))
  if (mode === 'garbage') for (const g of GARBAGE) taken.add(g)
  return taken
}
