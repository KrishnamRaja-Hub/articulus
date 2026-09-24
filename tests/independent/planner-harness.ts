/**
 * Planner rule checks: the app's solve() against the oracle and the independent brute force.
 *
 * Rules checked on every run:
 *  - plans only at allowed colleges, never re-plans a taken course, never plans a UC-only row;
 *  - creates no blocking split;
 *  - `unsolvable` is empty iff the root can pass at the allowed colleges (oracle, every offered course taken);
 *  - when it is empty, the planned transcript is valid per the oracle, and plan.result agrees with the oracle;
 *  - minimality: the plan's objective equals the brute-force minimum (units mode by default; see OBJECTIVE).
 */
import type { Agreement, CourseId, Plan } from '../../src/engine/types'
import { solve, type SolveOptions } from '../../src/engine/solve.ts'
import { bruteMin, feasible, planCost, PURE_UNITS, type Weights } from './brute.ts'
import { instOf, isUcOnly, oracle, uniqueRows } from './oracle.ts'

/**
 * Planner objective under test.
 *
 * TODO(after the planner-penalty merge): the parallel change adds college / chain penalties to solve() (units + 5 per
 * extra non-home college + 5 per subject chain across more than one college). To enforce that objective:
 *  1. set OPTION_NAMES to the SolveOptions field names it lands with (P_COLLEGE / P_CHAIN are placeholders);
 *  2. check that brute.ts `planCost` counts "extra college" and "subject chain" exactly as solve() does;
 *  3. run with INDEPENDENT_PLANNER_WEIGHTS=5,5 (or make it the default below) — the brute force then minimises the
 *     weighted objective and the app is passed the same weights.
 * Until then, pure-units mode passes weights 0 under those names, so the check stays valid after the merge as long
 * as the names match (if they do not, the units check fails loudly on multi-college plans).
 */
export const OPTION_NAMES = { college: 'P_COLLEGE', chain: 'P_CHAIN' } as const
export const OBJECTIVE: Weights = (() => {
  const w = process.env.INDEPENDENT_PLANNER_WEIGHTS
  if (!w) return PURE_UNITS
  const [college, chain] = w.split(',').map(Number)
  return { college: college || 0, chain: chain || 0 }
})()

export type Systems = Record<number, 'quarter' | 'semester'>

export interface PlanRun { a: Agreement; file: string; taken: CourseId[]; allowed: number[]; home: number; systems?: Systems; brute?: boolean; bruteBudget?: number }

export class PlannerStats {
  runs = 0
  solvable = 0
  validWhenSolvable = 0
  minimality = { checked: 0, agree: 0, budget: 0, nearMinimalHeuristic: 0 }
  violations: Record<string, number> = {}
  examples: { kind: string; run: Omit<PlanRun, 'a' | 'systems'>; detail: unknown }[] = []
  times: number[] = []
  readonly name: string
  constructor(name: string) { this.name = name }
  violate(kind: string, run: PlanRun, detail: unknown) {
    this.violations[kind] = (this.violations[kind] ?? 0) + 1
    if (this.examples.length < 20) this.examples.push({ kind, run: { file: run.file, taken: [...run.taken].sort(), allowed: run.allowed, home: run.home }, detail })
  }
  get violationCount() { return Object.values(this.violations).reduce((s, x) => s + x, 0) }
  summary() {
    const q = (p: number) => { const s = [...this.times].sort((x, y) => x - y); return s.length ? Number(s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2)) : null }
    return {
      name: this.name, runs: this.runs, solvable: this.solvable, validWhenSolvable: this.validWhenSolvable,
      objective: OBJECTIVE, minimality: this.minimality, ruleViolations: this.violations,
      solveMs: { p50: q(0.5), p95: q(0.95), max: q(1) },
    }
  }
}

/** Unit conversion to the home system, exact (the planner's totals use exact converted units). */
export const unitsFn = (a: Agreement, home: number, systems: Systems = {}) => (c: CourseId) => {
  const k = a.catalog[c]
  if (!k) return 0
  const to = systems[home] ?? 'quarter', from = systems[k.institutionId] ?? to
  return from === to ? k.units : from === 'semester' ? k.units * 1.5 : k.units / 1.5
}

export function runPlanner(S: PlannerStats, run: PlanRun): Plan | undefined {
  const { a, taken, allowed, home, systems = {} } = run
  S.runs++
  const termSystem = systems[home] ?? 'quarter'
  const opts: SolveOptions & Record<string, unknown> = {
    allowed, home, termSystem, unitSystems: systems, unitCap: termSystem === 'semester' ? 12 : 16, maxTerms: 6,
    [OPTION_NAMES.college]: OBJECTIVE.college, [OPTION_NAMES.chain]: OBJECTIVE.chain,
  }
  const T = new Set(taken)
  let p: Plan
  const t0 = performance.now()
  try { p = solve(new Set(taken), a, opts) } catch (e) { S.violate('THROW', run, String(e)); return }
  S.times.push(performance.now() - t0)
  const planned = p.terms.flatMap((t) => t.courses)

  const outside = planned.filter((c) => !allowed.includes(instOf(c)))
  if (outside.length) S.violate('PLANNED_OUTSIDE_ALLOWED', run, outside)
  const retake = planned.filter((c) => T.has(c))
  if (retake.length) S.violate('RE_PLANNED_TAKEN', run, retake)
  const rows = new Map(uniqueRows(a).map((r) => [r.id, r]))
  const ucPlanned = Object.keys(p.chosen).filter((id) => rows.get(id) && isUcOnly(rows.get(id)!))
  if (ucPlanned.length) S.violate('PLANNED_UC_ONLY_ROW', run, ucPlanned)

  const before = oracle(a, T), after = oracle(a, new Set([...taken, ...planned]))
  const created = [...after.blocking].filter((id) => !before.splits.has(id))
  if (created.length) S.violate('CREATED_BLOCKING_SPLIT', run, { created, planned, unsolvable: p.unsolvable })
  if (after.isValid !== p.result.isValid) S.violate('PLAN_RESULT_DISAGREES', run, { app: p.result.isValid, oracle: after.isValid, planned })

  const canPass = feasible(a, T, allowed), solvable = p.unsolvable.length === 0
  if (canPass !== solvable) S.violate(canPass ? 'UNSOLVABLE_BUT_FEASIBLE' : 'SOLVABLE_BUT_INFEASIBLE', run, { unsolvable: p.unsolvable, planned })
  if (solvable) {
    S.solvable++
    if (after.isValid) S.validWhenSolvable++
    else S.violate('PLAN_INVALID', run, { planned, missing: [...after.missing], blocking: [...after.blocking] })
  }

  if (run.brute && canPass && after.isValid) {
    const unitsOf = unitsFn(a, home, systems)
    const b = bruteMin(a, T, { allowed, home, unitsOf, weights: OBJECTIVE, budget: run.bruteBudget })
    if (b === 'budget') S.minimality.budget++
    else if (!b) S.violate('BRUTE_FOUND_NO_PLAN', run, { planned })
    else {
      S.minimality.checked++
      const mine = planCost(planned, unitsOf, OBJECTIVE, home)
      if (Math.abs(mine.cost - b.cost) < 1e-6) S.minimality.agree++
      else if (mine.cost < b.cost) S.violate('BEATS_BRUTE_FORCE', run, { app: mine, brute: b, planned })
      else if (p.optimal !== false) S.violate('OPTIMAL_BUT_NOT_MINIMAL', run, { app: mine, brute: b, planned: [...planned].sort(), optimal: p.optimal })
      else S.minimality.nearMinimalHeuristic++
    }
  }
  return p
}
