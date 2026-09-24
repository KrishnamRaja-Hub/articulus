/**
 * App vs oracle comparison and metrics. This file is the only bridge between the two sides: it imports the app's
 * verifySchedule and the independent oracle, and never lets one inform the other.
 *
 * Every disagreement is a failure with an exact repro, except the documented deviations in COUNSELOR_REPORT.md,
 * which are recognised by construction (not by pattern-matching output) and counted separately:
 *  - LOW-3: deferred listing for a choice with several UC-only alternatives (recomputed with the app's convention).
 *  - LOW-6: a split the app misses because it keeps one partial per college (splitHiddenByBestPartial).
 *  - wording: a UC-only row named, or not, inside a "N of: ..." missing string (compared on non-UC-only ids only).
 * The verdict (isValid) and per-row satisfaction have no tolerated deviations on generated input.
 */
import type { Agreement, CourseId, ValidationResult } from '../../src/engine/types'
import { verifySchedule } from '../../src/engine/verify.ts'
import { idsIn, oracle, splitHiddenByBestPartial, uniqueRows, type OracleResult } from './oracle.ts'

export type Confusion = { TP: number; TN: number; FP: number; FN: number }
const cm = (): Confusion => ({ TP: 0, TN: 0, FP: 0, FN: 0 })
const bump = (m: Confusion, expected: boolean, actual: boolean) => { m[expected ? (actual ? 'TP' : 'FN') : actual ? 'FP' : 'TN']++ }

export interface Failure { kind: string; file: string; taken: CourseId[]; expected: unknown; actual: unknown; detail?: unknown }

export class Metrics {
  cases = 0
  verdict = cm()
  row = cm()
  split = { TP: 0, FP: 0, FN: 0 }
  blocking = { agree: 0, total: 0, blocking: 0, warning: 0 }
  deferred = { TP: 0, FP: 0, FN: 0 }
  missing = { exact: 0, total: 0 }
  known: Record<string, number> = {}
  failures: Failure[] = []
  private kinds = new Map<string, number>()
  readonly name: string
  constructor(name: string) { this.name = name }

  fail(f: Failure) {
    const n = this.kinds.get(f.kind) ?? 0
    this.kinds.set(f.kind, n + 1)
    if (n < 10) this.failures.push({ ...f, taken: [...f.taken].sort() })
  }
  note(kind: string) { this.known[kind] = (this.known[kind] ?? 0) + 1 }
  get failureCount() { return [...this.kinds.values()].reduce((s, x) => s + x, 0) }

  merge(o: Metrics) {
    this.cases += o.cases
    for (const k of ['TP', 'TN', 'FP', 'FN'] as const) { this.verdict[k] += o.verdict[k]; this.row[k] += o.row[k] }
    for (const k of ['TP', 'FP', 'FN'] as const) { this.split[k] += o.split[k]; this.deferred[k] += o.deferred[k] }
    for (const k of ['agree', 'total', 'blocking', 'warning'] as const) this.blocking[k] += o.blocking[k]
    this.missing.exact += o.missing.exact; this.missing.total += o.missing.total
    for (const [k, v] of Object.entries(o.known)) this.known[k] = (this.known[k] ?? 0) + v
    for (const [k, v] of o.kinds) this.kinds.set(k, (this.kinds.get(k) ?? 0) + v)
    this.failures.push(...o.failures.slice(0, Math.max(0, 40 - this.failures.length)))
  }

  summary() {
    const pct = (x: number, y: number) => (y ? Number((100 * x / y).toFixed(3)) : null)
    const { TP, TN, FP, FN } = this.verdict
    return {
      name: this.name, cases: this.cases,
      verdict: { TP, TN, FP, FN, precision: pct(TP, TP + FP), recall: pct(TP, TP + FN) },
      row: { ...this.row, accuracy: pct(this.row.TP + this.row.TN, this.row.TP + this.row.TN + this.row.FP + this.row.FN) },
      split: { ...this.split, precision: pct(this.split.TP, this.split.TP + this.split.FP), recall: pct(this.split.TP, this.split.TP + this.split.FN) },
      blocking: { ...this.blocking, accuracy: pct(this.blocking.agree, this.blocking.total) },
      deferred: { ...this.deferred, precision: pct(this.deferred.TP, this.deferred.TP + this.deferred.FP), recall: pct(this.deferred.TP, this.deferred.TP + this.deferred.FN) },
      missing: { ...this.missing, exactRate: pct(this.missing.exact, this.missing.total) },
      knownDeviations: this.known,
      failures: Object.fromEntries(this.kinds),
    }
  }
}

const idMemo = new WeakMap<Agreement, string[]>()
const rowIds = (a: Agreement) => {
  let ids = idMemo.get(a)
  if (!ids) idMemo.set(a, (ids = uniqueRows(a).map((r) => r.id)))
  return ids
}
const same = (x: Set<string>, y: Set<string>) => x.size === y.size && [...x].every((v) => y.has(v))

export interface Checked { o: OracleResult; v: ValidationResult }

export type Verifier = (taken: Set<CourseId>, a: Agreement) => ValidationResult

/** Compare the app (or, for the harness self-test, a stand-in `verify`) with the oracle on one transcript. */
export function check(M: Metrics, file: string, a: Agreement, taken: ReadonlySet<CourseId>, verify: Verifier = verifySchedule): Checked {
  M.cases++
  const o = oracle(a, taken)
  const T = [...taken]
  let v: ValidationResult
  try { v = verify(new Set(taken), a) } catch (e) {
    M.fail({ kind: 'THROW', file, taken: T, expected: 'no throw', actual: String(e) })
    return { o, v: { isValid: false, satisfied: {}, missing: [], incomplete: {}, splitSeriesViolations: [], deferred: [] } }
  }
  bump(M.verdict, o.isValid, v.isValid)
  if (o.isValid !== v.isValid)
    M.fail({ kind: v.isValid ? 'VERDICT_FP' : 'VERDICT_FN', file, taken: T, expected: o.isValid, actual: v.isValid,
      detail: { oracleMissing: [...o.missing], appMissing: v.missing, oracleBlocking: [...o.blocking] } })

  for (const [id, e] of o.rows) {
    const g = v.satisfied[id]
    bump(M.row, e.sat, !!g)
    if (e.sat !== !!g) M.fail({ kind: g ? 'ROW_FP' : 'ROW_FN', file, taken: T, expected: { id, sat: e.sat }, actual: { id, sat: !!g, group: g } })
    else if (g && !e.satGroups.some((x) => x.institutionId === g.institutionId && x.courses.join('|') === g.courses.join('|')))
      M.fail({ kind: 'SAT_GROUP_NOT_COMPLETE', file, taken: T, expected: e.satGroups, actual: g })
  }
  for (const id of Object.keys(v.satisfied)) if (!o.rows.has(id)) M.fail({ kind: 'SAT_UNKNOWN_ROW', file, taken: T, expected: null, actual: id })

  const app = new Map(v.splitSeriesViolations.map((x) => [x.requirementId, x]))
  if (app.size !== v.splitSeriesViolations.length) M.fail({ kind: 'SPLIT_REPORTED_TWICE', file, taken: T, expected: 'unique', actual: v.splitSeriesViolations.map((x) => x.requirementId) })
  for (const id of new Set([...o.splits, ...app.keys()])) {
    const inO = o.splits.has(id), x = app.get(id)
    if (inO && x) {
      M.split.TP++
      M.blocking.total++
      const ob = o.blocking.has(id)
      M.blocking[ob ? 'blocking' : 'warning']++
      if (ob === x.blocking) M.blocking.agree++
      else M.fail({ kind: 'BLOCKING_CLASS', file, taken: T, expected: { id, blocking: ob }, actual: { id, blocking: x.blocking } })
      if (new Set(x.partials.map((p) => p.institutionId)).size !== x.partials.length) M.fail({ kind: 'PARTIAL_COLLEGE_TWICE', file, taken: T, expected: id, actual: x.partials })
      if (x.partials.some((p) => p.have.some((c) => !taken.has(c)))) M.fail({ kind: 'PARTIAL_NOT_TAKEN', file, taken: T, expected: id, actual: x.partials })
    } else if (inO) {
      if (splitHiddenByBestPartial(o.rows.get(id)!, taken)) M.note('LOW-6 split hidden by best-partial-per-college')
      else { M.split.FN++; M.fail({ kind: 'SPLIT_FN', file, taken: T, expected: id, actual: null, detail: Object.fromEntries([...o.rows.get(id)!.have].map(([k, s]) => [k, [...s]])) }) }
    } else { M.split.FP++; M.fail({ kind: 'SPLIT_FP', file, taken: T, expected: null, actual: id }) }
  }

  const ad = new Set(v.deferred)
  if (same(ad, o.deferred)) M.deferred.TP += ad.size
  else if (same(ad, oracle(a, taken, { defer: 'app-low3' }).deferred)) M.note('LOW-3 deferred listing (several UC-only alternatives)')
  else for (const id of new Set([...ad, ...o.deferred])) {
    if (ad.has(id) && o.deferred.has(id)) M.deferred.TP++
    else if (ad.has(id)) { M.deferred.FP++; M.fail({ kind: 'DEFERRED_FP', file, taken: T, expected: [...o.deferred], actual: [...ad] }) }
    else { M.deferred.FN++; M.fail({ kind: 'DEFERRED_FN', file, taken: T, expected: [...o.deferred], actual: [...ad] }) }
  }

  // missing: the rows named, ignoring UC-only rows (whether "N of:" names one is wording)
  M.missing.total++
  const ids = rowIds(a)
  const named = new Set(v.missing.flatMap((s) => [...idsIn(s, ids)]))
  const notUc = (id: string) => !o.rows.get(id)?.ucOnly
  const got = new Set([...named].filter(notUc)), want = new Set([...o.missing].filter(notUc))
  if (same(got, want)) {
    M.missing.exact++
    if (!same(named, o.missing)) M.note('wording: UC-only row named in missing')
  } else M.fail({ kind: 'MISSING_DIFF', file, taken: T, expected: [...want].sort(), actual: [...got].sort(), detail: v.missing })
  if (v.isValid && v.missing.length) M.fail({ kind: 'VALID_BUT_MISSING', file, taken: T, expected: [], actual: v.missing })
  return { o, v }
}

/** One line per failure, with enough to paste into a repro. */
export const describeFailures = (M: Metrics) =>
  M.failures.map((f) => `${f.kind} ${f.file}\n  taken: ${JSON.stringify(f.taken)}\n  expected: ${JSON.stringify(f.expected)}\n  actual: ${JSON.stringify(f.actual)}${f.detail ? `\n  detail: ${JSON.stringify(f.detail)}` : ''}`).join('\n')
