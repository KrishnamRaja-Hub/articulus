/**
 * The oracle side must stay independent of the app: it may import only types from src/, node builtins, and other
 * oracle-side files. Only the harness files (compare.ts, planner-harness.ts) and the tests touch the app's runtime.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const ORACLE_SIDE = ['oracle.ts', 'brute.ts', 'synth.ts', 'scenarios.ts', 'fixtures.ts', 'realcases.ts', 'budget.ts', 'metrics.ts']
const src = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8')

/** Every module specifier with whether it is a type-only import. */
const importsOf = (text: string) => [
  ...[...text.matchAll(/^\s*(import|export)\s+(type\s+)?[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => ({ spec: m[3], typeOnly: !!m[2], line: m[0].trim() })),
  ...[...text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)].map((m) => ({ spec: m[1], typeOnly: false, line: m[0].trim() })),
  ...[...text.matchAll(/\b(?:import|require)\s*\(\s*['"`]([^'"`]+)['"`]/g)].map((m) => ({ spec: m[1], typeOnly: false, line: m[0].trim() })),
]

describe('oracle independence', () => {
  for (const f of ORACLE_SIDE) it(`${f} imports nothing from the app but types`, () => {
    const bad = importsOf(src(f)).filter(({ spec, typeOnly }) => {
      if (spec.startsWith('node:')) return false
      if (/(^|\/)src\//.test(spec)) return !typeOnly
      if (spec.startsWith('./')) return !ORACLE_SIDE.includes(spec.slice(2))
      return true // no packages on the oracle side
    })
    expect(bad.map((b) => b.line)).toEqual([])
  })

  it('the checker sees imports it must reject', () => {
    const probe = "import { verifySchedule } from '../../src/engine/verify.ts'\nimport type { Agreement } from '../../src/engine/types'\nconst x = await import('../../src/engine/solve.ts')"
    expect(importsOf(probe).map((i) => [i.spec, i.typeOnly])).toEqual([
      ['../../src/engine/verify.ts', false], ['../../src/engine/types', true], ['../../src/engine/solve.ts', false],
    ])
  })

  it('the oracle-side files exist and the harness files are the only app bridges', () => {
    for (const f of ORACLE_SIDE) expect(src(f).length).toBeGreaterThan(0)
    for (const f of ['compare.ts', 'planner-harness.ts']) expect(importsOf(src(f)).some((i) => /src\/engine\/(verify|solve)/.test(i.spec) && !i.typeOnly)).toBe(true)
  })
})
