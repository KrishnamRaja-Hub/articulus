/* Shared helpers for the pack tests (pack.critical.test.ts, pack.summer.test.ts). Not used by the app. */
import type { CourseId, Term } from './types'
import { pack, type PackOptions } from './pack'
import { prereqs } from './sequence'
import type { TermSystem } from './calendar'

export const FALL = { season: 'Fall' as const, year: 2026 }

/** Plan length: when the last term ends on the timeline, then how many terms. */
export const lengthOf = (ts: Term[]) => [Math.max(-Infinity, ...ts.map((t) => t.span![1])), ts.length]
export const notLonger = (x: Term[], y: Term[]) => { const a = lengthOf(x), b = lengthOf(y); return a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]) }

/** Every inferred prerequisite holds on the timeline: strictly earlier, or (a lab) not before its lecture. */
export function violations(ts: Term[], courses: CourseId[], titleOf: (c: CourseId) => string): string[] {
  const at = new Map(ts.flatMap((t) => t.courses.map((c): [CourseId, Term] => [c, t])))
  const out: string[] = []
  for (const e of prereqs(courses, titleOf).edges) {
    const p = at.get(e.from)!.span!, q = at.get(e.to)!.span!
    if (e.rule === 'co' ? q[0] < p[0] : q[0] <= p[1]) out.push(`${e.rule} ${e.from} -> ${e.to}`)
  }
  return out
}

export type MiniCatalog = Record<CourseId, { units: number; title: string; institutionId: number }>

/** pack() with the inputs solve() would give it, for a planned course list. */
export function packer(catalog: MiniCatalog, systems: Record<number, TermSystem>, home: TermSystem) {
  const sysOf = (c: CourseId) => systems[catalog[c].institutionId] ?? home
  const unitsOf = (c: CourseId) => { const u = catalog[c].units, f = sysOf(c); return f === home ? u : f === 'semester' ? u * 1.5 : u / 1.5 }
  const titleOf = (c: CourseId) => catalog[c]?.title ?? ''
  return { titleOf, unitsOf, run: (cs: CourseId[], cap: number, o: PackOptions = {}) => pack(cs, unitsOf, cap, FALL, home, titleOf, sysOf, o) }
}

/** Seeded PRNG (mulberry32), so a failure reproduces. */
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'omega', 'sigma']

/** Random plan: letter chains (with labs) at 1-3 colleges of random calendars, plus loose courses. */
export function randomCase(seed: number) {
  const r = rng(seed), pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)]
  const colleges = Array.from({ length: 1 + Math.floor(r() * 3) }, (_, i) => i + 1)
  const systems = Object.fromEntries(colleges.map((c) => [c, r() < 0.5 ? 'quarter' : 'semester'])) as Record<number, TermSystem>
  const home: TermSystem = r() < 0.5 ? 'quarter' : 'semester'
  const catalog: MiniCatalog = {}
  const add = (inst: number, code: string, units: number, title: string) => { catalog[`${inst}:${code}`] = { units, title, institutionId: inst } }
  const chains = 1 + Math.floor(r() * 4)
  for (let k = 0; k < chains; k++) {
    const inst = pick(colleges), prefix = `S${String.fromCharCode(65 + k)}`, len = 1 + Math.floor(r() * 4), w = pick(WORDS)
    for (let j = 0; j < len; j++) {
      const code = `${prefix} 1${String.fromCharCode(65 + j)}`
      add(inst, code, 1 + Math.floor(r() * 6), `Subject ${w} part ${WORDS[j]}`)
      if (r() < 0.2) add(inst, `${code}L`, 1 + Math.floor(r() * 2), `Subject ${w} part ${WORDS[j]} Lab`)
    }
  }
  const loose = Math.floor(r() * 5)
  for (let k = 0; k < loose; k++) add(pick(colleges), `L${String.fromCharCode(65 + k)} ${10 + k}`, 1 + Math.floor(r() * 6), `Loose ${WORDS[k % WORDS.length]}`)
  const cap = pick([4, 5, 6, 8, 10, 12, 16])
  return { catalog, systems, home, cap, courses: Object.keys(catalog).sort() }
}
