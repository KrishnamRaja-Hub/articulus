import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import institutions from '../../data/institutions.json'
import type { Agreement, CourseId, Institution, Term } from './types'
import { solve } from './solve'
import { pack } from './pack'
import type { TermSystem } from './calendar'

/* Pack regression (Round 10): the schedules pack() produced for real plans when this file was generated, stored with
 * everything pack needs (course units, titles and calendars), so the check depends neither on the solver nor on data/
 * refreshes. Any change to how terms are packed shows up here.
 *
 * Regenerate after an intended packing change:  UPDATE_PACK_GOLDEN=1 npx vitest run src/engine/pack.golden.test.ts */

const GOLDEN = new URL('./pack.golden.json', import.meta.url)
const START = { season: 'Fall' as const, year: 2026 }
const unitSystems = Object.fromEntries((institutions as Institution[]).map((i) => [i.id, i.terms])) as Record<number, TermSystem>

interface Golden {
  /** course id -> [native units, title, calendar] */
  catalog: Record<CourseId, [number, string, TermSystem]>
  cases: { name: string; home: TermSystem; cap: number; courses: CourseId[]; terms: [string, ...CourseId[]][] }[]
}

const shape = (ts: Term[]) => ts.map((t): [string, ...CourseId[]] => [t.name, ...t.courses])

function repack(g: Golden, c: Golden['cases'][number], opts: Parameters<typeof pack>[7] = {}): Term[] {
  const sysOf = (x: CourseId) => g.catalog[x][2]
  const unitsOf = (x: CourseId) => { const [u, , f] = g.catalog[x]; return f === c.home ? u : f === 'semester' ? u * 1.5 : u / 1.5 }
  return pack(c.courses, unitsOf, c.cap, START, c.home, (x) => g.catalog[x][1], sysOf, opts)
}

function generate(): Golden {
  const files = import.meta.glob('../../data/agreements/*.json', { eager: true, import: 'default' }) as Record<string, Agreement>
  const all = (institutions as Institution[]).filter((i) => i.isCC).map((i) => i.id)
  const g: Golden = { catalog: {}, cases: [] }
  for (const [path, a] of Object.entries(files).sort(([x], [y]) => (x < y ? -1 : 1))) {
    for (const [home, tag, allowed] of [[113, 'pair', [113, 51]], [113, 'all', all], [137, 'pair', [137, 51]], [137, 'all', all]] as [number, string, number[]][]) {
      const sys = unitSystems[home]
      for (const cap of sys === 'quarter' ? [16, 10] : [12, 7]) {
        const p = solve(new Set(), a, { allowed, home, termSystem: sys, unitSystems, unitCap: cap, startTerm: START })
        const courses = p.terms.flatMap((t) => t.courses).sort()
        for (const c of courses) { const k = a.catalog[c]; g.catalog[c] = [k.units, k.title, unitSystems[k.institutionId] ?? sys] }
        g.cases.push({ name: `${path.split('/').pop()} home ${home} ${tag} cap ${cap}`, home: sys, cap, courses, terms: shape(p.terms) })
      }
    }
  }
  g.catalog = Object.fromEntries(Object.entries(g.catalog).sort(([x], [y]) => (x < y ? -1 : 1)))
  return g
}

describe('pack regression: real plans (Round 10)', () => {
  if (process.env.UPDATE_PACK_GOLDEN) {
    it('regenerates pack.golden.json', () => { writeFileSync(GOLDEN, JSON.stringify(generate()) + '\n') }, 120_000)
    return
  }
  const g = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Golden

  it('covers every agreement, quarter and semester homes, mixed calendars', () => {
    expect(g.cases.length).toBeGreaterThanOrEqual(22 * 8)
    expect(g.cases.some((c) => c.terms.some((t) => / \((quarter|semester)\)$/.test(t[0])))).toBe(true)
  })

  it('pack gives exactly the stored schedules', () => {
    for (const c of g.cases) expect(shape(repack(g, c)), c.name).toEqual(c.terms)
  })

  it('never ends later than the old order (Round 4) on any stored plan', () => {
    const end = (ts: Term[]) => [Math.max(...ts.map((t) => t.span![1])), ts.length]
    for (const c of g.cases) {
      const now = end(repack(g, c)), old = end(repack(g, c, { order: 'legacy' }))
      expect(now[0] < old[0] || (now[0] === old[0] && now[1] <= old[1]), c.name).toBe(true)
    }
  })
})
