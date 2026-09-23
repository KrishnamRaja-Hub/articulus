/* Dev-only smoke test: solve every agreement for a few home/extras combos. Usage: node scripts/smoke.mjs */
import { readFileSync } from 'node:fs'
import { solve } from '../src/engine/solve.ts'
import { verifySchedule } from '../src/engine/verify.ts'

const root = new URL('../', import.meta.url)
const json = (p) => JSON.parse(readFileSync(new URL(p, root), 'utf8'))
const index = json('data/index.json')
const institutions = json('data/institutions.json')
const unitSystems = Object.fromEntries(institutions.map((i) => [i.id, i.terms]))
const solveSrc = readFileSync(new URL('src/engine/solve.ts', root), 'utf8')
const supportsTerms = /termSystem/.test(solveSrc) && /unitSystems/.test(solveSrc)

const rows = []
let fails = 0
const record = (name, ok, reason = '') => { rows.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${reason ? '  -- ' + reason : ''}`); if (!ok) fails++ }

for (const entry of index) {
  const a = json(`data/agreements/${entry.file}`)
  for (const home of [113, 137]) {
    for (const extras of [[], [51]]) {
      const name = `${entry.file} home=${home} extras=[${extras}]`
      const cap = (unitSystems[home] === 'quarter' ? 16 : 12) + 0.01
      try {
        const opts = { allowed: [home, ...extras], home }
        if (supportsTerms) Object.assign(opts, { termSystem: unitSystems[home], unitSystems })
        const plan = solve(new Set(), a, opts)
        const problems = []
        if (Number.isNaN(plan.totalUnits)) problems.push('totalUnits NaN')
        for (const t of plan.terms) {
          if (Number.isNaN(t.units)) problems.push(`${t.name} units NaN`)
          else if (t.units > cap) problems.push(`${t.name} ${t.units}u > cap ${cap - 0.01}`)
        }
        if (plan.result.splitSeriesViolations.length) problems.push(`${plan.result.splitSeriesViolations.length} split violations`)
        record(name, problems.length === 0, problems.join('; '))
      } catch (e) {
        record(name, false, `threw ${e?.message ?? e}`)
      }
    }
  }
}

// Scenario 2: PHYS 4A/4B at De Anza, 4C at Foothill -> split series on Berkeley PHYSICS 7B; solver must repair it.
{
  const me = json(`data/agreements/${index.find((e) => e.receivingId === 79 && /Mechanical/.test(e.major)).file}`)
  const taken = new Set(['113:PHYS 4A', '113:PHYS 4B', '51:PHYS 4C'])
  const v = verifySchedule(taken, me)
  const hit = v.splitSeriesViolations.some((x) => /PHYSICS 7B/.test(x.label) || /PHYSICS 7B/.test(x.requirementId))
  record('scenario2 verifySchedule flags PHYSICS 7B split', hit, hit ? '' : `violations: ${JSON.stringify(v.splitSeriesViolations.map((x) => x.label))}`)
  try {
    const opts = { allowed: [113, 51], home: 113 }
    if (supportsTerms) Object.assign(opts, { termSystem: 'quarter', unitSystems })
    const plan = solve(taken, me, opts)
    record('scenario2 solve isValid', plan.result.isValid, plan.result.isValid ? '' : `missing=${plan.result.missing} splits=${plan.result.splitSeriesViolations.length} unsolvable=${plan.unsolvable}`)
  } catch (e) {
    record('scenario2 solve isValid', false, `threw ${e?.message ?? e}`)
  }
}

// UI-adjacent: every non-CC institution with agreements must yield majors (mirrors data.ts universities/majorsFor).
for (const uc of institutions.filter((i) => !i.isCC)) {
  const majors = index.filter((e) => e.receivingId === uc.id)
  record(`majorsFor(${uc.id} ${uc.short}) non-empty`, majors.length > 0, majors.length ? '' : 'no agreements in index')
}

console.log(rows.join('\n'))
console.log(`\n${rows.length - fails}/${rows.length} passed${supportsTerms ? '' : '  (termSystem/unitSystems not in SolveOptions; omitted)'}`)
process.exit(fails ? 1 : 0)
