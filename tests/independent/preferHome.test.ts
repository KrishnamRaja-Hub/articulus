/**
 * "Prefer home college" (solve's preferHome, the Planner default) on the real agreements, checked with the oracle's own
 * row evaluation: only allowed colleges; no course planned twice; nothing an already-complete row needs is retaken;
 * no requirement the plan without the setting meets is lost; every course away from home is explained once in
 * `fallbacks`; a row the plan relies on (`chosen`) that home covers is met away from home only with a stated reason ('started' or 'series'), and a
 * 'not-at-home' note is only given for a row home has no articulated course for.
 */
import { describe, expect, it } from 'vitest'
import type { Agreement, CourseId, Plan } from '../../src/engine/types'
import { solve } from '../../src/engine/solve.ts'
import { SEED, SLOW } from './budget.ts'
import { CCS, DA, FH, INDEX, loadAgreement, SYS } from './fixtures.ts'
import { evalRow, instOf, leaves } from './oracle.ts'
import { rng } from './synth.ts'

const plannedOf = (p: Plan) => p.terms.flatMap((t) => t.courses)
const validUnits = (a: Agreement, c: CourseId) => typeof a.catalog[c]?.units === 'number' && Number.isFinite(a.catalog[c].units) && a.catalog[c].units >= 0

function check(a: Agreement, taken: CourseId[], home: number, allowed: number[]): string[] {
  const T = new Set(taken), bad: string[] = []
  const opts = { allowed, home, termSystem: SYS[home], unitSystems: SYS, startTerm: { season: 'Fall' as const, year: 2026 } }
  const on = solve(T, a, { ...opts, preferHome: true }), off = solve(T, a, opts)
  const cs = plannedOf(on), all = new Set([...T, ...cs]), rows = leaves(a.root)
  for (const c of cs) if (!allowed.includes(instOf(c))) bad.push(`planned at a college not selected: ${c}`)
  if (new Set(cs).size !== cs.length) bad.push('a course planned twice')
  for (const c of cs) if (T.has(c)) bad.push(`re-plans taken ${c}`)
  if (off.result.isValid && !on.result.isValid) bad.push('plan without the setting is valid, with it not')
  if (on.result.missing.length > off.result.missing.length) bad.push(`more requirements missing: ${on.result.missing} vs ${off.result.missing}`)
  const fb = on.fallbacks ?? [], listed = fb.flatMap((f) => f.courses)
  if (new Set(listed).size !== listed.length) bad.push('a course listed twice in fallbacks')
  for (const c of cs) if (instOf(c) !== home && !listed.includes(c)) bad.push(`course away from home not explained: ${c}`)
  for (const c of listed) if (instOf(c) === home || !cs.includes(c)) bad.push(`fallback lists ${c}, not planned away from home`)
  const homeCan = (id: string) => rows.filter((r) => r.id === id).some((r) => r.groups.some((g) => g.institutionId === home && g.courses.every((c) => T.has(c) || validUnits(a, c))))
  for (const f of fb) {
    const id = f.requirementIds[0]
    if (f.reason === 'not-at-home' && rows.some((r) => r.id === id && r.groups.some((g) => g.institutionId === home))) bad.push(`"not offered" but home lists ${id}`)
    if (f.reason === 'no-data' && homeCan(id)) bad.push(`"details missing" but home can cover ${id}`)
    if (!f.note.trim()) bad.push('empty note')
  }
  for (const r of rows) {
    if (!on.chosen[r.id] || !homeCan(r.id) || evalRow(r, T).sat) continue // rows the plan relies on
    const e = evalRow(r, all)
    if (!e.sat || e.satGroups.some((g) => g.institutionId === home)) continue
    if (!fb.some((f) => f.requirementIds.includes(r.id) && f.reason !== 'prerequisite')) bad.push(`${r.id} met away from home, which could cover it, with no reason given`)
  }
  return bad
}

describe('prefer home college on the real agreements', () => {
  it('every agreement: homes De Anza, Foothill, Santa Monica, Irvine Valley x {home + one, home + three}', () => {
    const fails: string[] = []
    for (const e of INDEX) {
      const a = loadAgreement(e.file)
      for (const home of [DA, FH, 137, 124]) for (const allowed of [[home, home === FH ? DA : FH], [home, ...CCS.filter((x) => x !== home).slice(0, 3)]])
        for (const f of check(a, [], home, allowed)) fails.push(`${e.file} home=${home} allowed=${allowed}: ${f}`)
    }
    expect(fails).toEqual([])
  }, SLOW)

  it('random transcripts, including courses taken at colleges the student did not select', () => {
    const r = rng(SEED + 21), fails: string[] = []
    for (let i = 0; i < 60; i++) {
      const e = r.pick(INDEX), a = loadAgreement(e.file), home = r.pick(CCS)
      const allowed = [...new Set([home, ...r.shuffle(CCS).slice(0, 1 + r.int(3))])]
      const cols = r.shuffle(CCS).slice(0, 1 + r.int(3))
      const taken = Object.keys(a.catalog).filter((c) => cols.includes(instOf(c)) && r.next() < 0.3)
      for (const f of check(a, taken, home, allowed)) fails.push(`${e.file} home=${home} allowed=${allowed} taken=${JSON.stringify(taken)}: ${f}`)
    }
    expect(fails).toEqual([])
  }, SLOW)
})
