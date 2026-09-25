/*
 * Release decision: may a refresh publish on its own, or does a human have to review it first? (TESTER2 C-1, H-4, H-5)
 *
 * Rule: publish automatically only changes that are neutral or STRICTER for the student. Anything that could turn a
 * red transcript green (a looser change), and any large per-college loss, goes to review.
 *
 * The new data is compared with two references:
 *   - the previously published data (yesterday), and
 *   - the last REVIEWED baseline, data/baseline-manifest.json. It is written only when a refresh goes to review (the
 *     reviewed PR carries it), and on the very first publish. Auto-publishes carry it over unchanged, so slow drift
 *     (H-4) accumulates against it instead of resetting every day.
 * Looseness is judged against the baseline when there is one: a change back to what a human already reviewed (a row
 * that flapped away yesterday and came back today) is not new looseness. Drops are judged against both.
 *
 * Three layers:
 *   1. Semantic diff per agreement (UC x major), per row and per college: rows removed or added, required -> optional,
 *      N lowered, alternatives added, groups shortened or added (a new CC route), rows that became UC-only (deferred).
 *   2. Behavioral diff: transcripts built from the new data (empty, a minimal plan per college, the solver's plan per
 *      college) are verified on the old and the new data; any that go from not valid to valid is a false green.
 *   3. Per-college statistics (H-5): a college that goes dark in an agreement, loses a large share of its groups in
 *      one agreement, or loses more than 10% of its groups or agreements overall.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Agreement, CourseGroup, CourseId, ReqNode, Requirement } from '../../src/engine/types.ts'
import { honorsColleges, ucOnly, verifySchedule } from '../../src/engine/verify.ts'
import { solve } from '../../src/engine/solve.ts'

export const BASELINE_FILE = 'baseline-manifest.json'

export const DIFF_LIMITS = {
  /** A college losing more than this share of its groups, or of the agreements it articulates, across all agreements. */
  maxCollegeDrop: 0.1,
  /** A college losing more than this share of its groups inside one agreement (when it had at least minGroups). */
  maxCollegeAgreementDrop: 0.3,
  minGroups: 4,
  /** Solver search budget per (agreement, college) for the behavioral diff. */
  solveBudget: 20_000,
}

export type Direction = 'looser' | 'stricter' | 'neutral'
export interface Change {
  file: string
  direction: Direction
  code: string
  /** Row id, node path or college id. */
  where: string
  detail: string
}
export interface CollegeDrop { college: number; file?: string; before: number; after: number; ref: 'previous' | 'baseline'; what: 'groups' | 'agreements' }
export interface Decision {
  decision: 'publish' | 'review'
  reasons: string[]
  /** What the looseness was judged against. */
  reference: 'baseline' | 'previous' | 'none'
  baseline: { reviewedAt: string; academicYear: string | null; normalizeVersion: number | null } | null
  /** Looser/stricter changes against the reference (neutral ones are counted only). */
  changes: Change[]
  counts: Record<Direction, number>
  /** Looser changes vs yesterday that are not looser vs the baseline (restorations of reviewed data). */
  restored: number
  drops: CollegeDrop[]
  /** Write data/baseline-manifest.json with the new data (review PR or first publish). */
  updateBaseline: boolean
}

/** What the baseline keeps per agreement: everything verifySchedule reads (no catalog). */
export type BaselineAgreement = Pick<Agreement, 'receivingId' | 'major' | 'year' | 'sendingIds' | 'root'>
export interface Baseline {
  schema: 1
  reviewedAt: string
  fetchedAt: string | null
  academicYear: string | null
  normalizeVersion: number | null
  agreements: Record<string, BaselineAgreement>
}
export interface DataSet {
  agreements: Map<string, BaselineAgreement & { catalog?: Agreement['catalog'] }>
  academicYear: string | null
  normalizeVersion: number | null
  fetchedAt: string | null
}

const readJson = (p: string): any => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return undefined } }

/** Read a published or staged data directory (undefined if it has no index.json). */
export function readDataSet(dir: string): DataSet | undefined {
  const index = readJson(join(dir, 'index.json'))
  if (!Array.isArray(index)) return undefined
  const meta = readJson(join(dir, 'meta.json'))
  const agreements = new Map<string, Agreement>()
  for (const e of index) { const a = readJson(join(dir, 'agreements', e.file)); if (a?.root) agreements.set(e.file, a) }
  return { agreements, academicYear: meta?.academicYear?.code ?? null, normalizeVersion: meta?.normalizeVersion ?? null, fetchedAt: meta?.fetchedAt ?? null }
}

export function readBaseline(dataDir: string): Baseline | undefined {
  const b = readJson(join(dataDir, BASELINE_FILE))
  return b?.schema === 1 && b.agreements && typeof b.agreements === 'object' ? b : undefined
}
export const baselineData = (b: Baseline): DataSet =>
  ({ agreements: new Map(Object.entries(b.agreements)), academicYear: b.academicYear, normalizeVersion: b.normalizeVersion, fetchedAt: b.fetchedAt })

export function makeBaseline(d: DataSet, reviewedAt: Date): Baseline {
  const agreements: Record<string, BaselineAgreement> = {}
  for (const [f, a] of [...d.agreements].sort(([x], [y]) => x.localeCompare(y)))
    agreements[f] = { receivingId: a.receivingId, major: a.major, year: a.year, sendingIds: a.sendingIds, root: a.root }
  return { schema: 1, reviewedAt: reviewedAt.toISOString(), fetchedAt: d.fetchedAt, academicYear: d.academicYear, normalizeVersion: d.normalizeVersion, agreements }
}
export const writeBaseline = (dataDir: string, b: Baseline) => writeFileSync(join(dataDir, BASELINE_FILE), JSON.stringify(b) + '\n')

/* ------------------------------------------------------------------ semantic diff */

type Node = ReqNode | Requirement
interface Level { need: number; slack: number; required: boolean; type: string; path: string; /** Unique per node within one tree. */ id: number }
interface Row { key: string; req: Requirement; chain: Level[]; parentType: string; required: boolean }

/** How many children a node needs, and how many it can skip. Optional children are not counted. */
const levelOf = (n: ReqNode, path: string, id: number): Level => {
  const m = n.children.filter((c) => c.kind === 'req' || c.required).length
  const need = n.type === 'AND' ? m : n.type === 'OR' ? Math.min(1, m) : Math.min(n.n ?? 1, m)
  return { need, slack: m - need, required: n.required, type: n.type, path, id }
}

/** Rows keyed by id (#k for a repeated id), with the ancestor chain and whether every ancestor is required. */
function rowsOf(root: ReqNode): Map<string, Row> {
  const out = new Map<string, Row>(), seen = new Map<string, number>()
  let ids = 0
  const walk = (n: Node, chain: Level[], parent: ReqNode | null, path: string) => {
    if (n.kind === 'req') {
      const k = seen.get(n.id) ?? 0; seen.set(n.id, k + 1)
      out.set(k ? `${n.id}#${k}` : n.id, { key: n.id, req: n, chain, parentType: parent?.type ?? 'AND', required: chain.every((l) => l.required) })
      return
    }
    const p = `${path}/${n.title ?? n.type}`
    const next = [...chain, levelOf(n, p, ids++)]
    for (const c of n.children) walk(c, next, n, p)
  }
  walk(root, [], null, '')
  return out
}

const gkey = (g: CourseGroup) => `${g.institutionId}|${[...g.courses].sort().join('+')}`
const subset = (a: CourseId[], b: CourseId[]) => a.every((c) => b.includes(c))

/** Classify every change between two versions of one agreement. */
export function semanticDiff(file: string, old: BaselineAgreement, neu: BaselineAgreement): Change[] {
  const out: Change[] = []
  const add = (direction: Direction, code: string, where: string, detail: string) => out.push({ file, direction, code, where, detail })
  const R0 = rowsOf(old.root), R1 = rowsOf(neu.root)
  const reportedNodes = new Set<string>()
  // Old nodes none of whose rows survive: the node itself is gone (matched by its set of row ids, not its path, since
  // untitled siblings share a path).
  const alive = new Set<number>()
  for (const [k, r0] of R0) if (R1.has(k)) for (const l of r0.chain) alive.add(l.id)
  /** The outermost gone ancestor of a removed row, if dropping it removes a required unit (its parent is an AND, or it
   *  is the root) rather than one alternative of a surviving choice. */
  const goneUnit = (r0: Row) => {
    const i = r0.chain.findIndex((l) => !alive.has(l.id))
    if (i < 0) return undefined
    const l = r0.chain[i]
    return (i === 0 || r0.chain[i - 1].type === 'AND') && l.need > 0 ? l : undefined
  }

  for (const [k, r0] of R0) {
    const r1 = R1.get(k)
    if (!r1) {
      // A row the student needed is gone: looser. Gone from an OR/N_OF: one alternative fewer (stricter).
      if (!r0.required) add('neutral', 'row-removed-optional', k, 'optional row removed')
      else if (r0.parentType === 'AND') add('looser', 'row-removed', k, 'required row removed')
      else {
        // A required OR/N_OF that disappears whole is a requirement the student no longer has to meet: looser, even
        // when a new required row appears elsewhere (M1). Only a removal inside a surviving choice is stricter.
        const g = goneUnit(r0)
        if (g) { if (!reportedNodes.has(`gone|${g.id}`)) { reportedNodes.add(`gone|${g.id}`); add('looser', 'choice-removed', g.path, `required ${g.type} choice removed (needed ${g.need})`) } }
        else add('stricter', 'alternative-removed', k, `row removed from a ${r0.parentType} choice`)
      }
      continue
    }
    // The ancestor chain: required flags, how many children each node needs and how many it can skip.
    if (r0.chain.length !== r1.chain.length) { add('looser', 'structure-changed', k, `nesting depth ${r0.chain.length} -> ${r1.chain.length}`); continue }
    r0.chain.forEach((l0, i) => {
      const l1 = r1.chain[i], node = `${l0.path} (${k})`
      const once = (code: string) => { const id = `${code}|${l0.path}|${i}|${l1.need}|${l1.slack}|${l1.required}`; if (reportedNodes.has(id)) return false; reportedNodes.add(id); return true }
      if (l0.required && !l1.required && once('required')) add('looser', 'required-to-optional', node, `node became optional (${l0.type})`)
      if (!l0.required && l1.required && once('required')) add('stricter', 'optional-to-required', node, 'node became required')
      if (l1.need < l0.need && once('need')) add('looser', 'n-decreased', node, `needs ${l0.need} -> ${l1.need} (${l0.type} -> ${l1.type})`)
      if (l1.need > l0.need && once('need')) add('stricter', 'n-increased', node, `needs ${l0.need} -> ${l1.need} (${l0.type} -> ${l1.type})`)
      if (l1.slack > l0.slack && once('slack')) add('looser', 'alternative-added', node, `can skip ${l0.slack} -> ${l1.slack} children`)
    })
    if (r0.required && !r1.required && !r1.chain.some((l, i) => !l.required && r0.chain[i]?.required)) add('looser', 'required-to-optional', k, 'row no longer required')

    // Deferral: a row the student had to take becomes UC-only (completed after transfer).
    const u0 = ucOnly(r0.req), u1 = ucOnly(r1.req)
    if (!u0 && u1) add('looser', 'deferral-added', k, 'row became UC-only (deferred to the university)')
    if (u0 && !u1) add('stricter', 'deferral-removed', k, 'UC-only row now needs CC courses')

    // Routes: a new group that is not a superset of an existing one at that college is an easier way through.
    const g0 = r0.req.groups, g1 = r1.req.groups
    const k0 = new Set(g0.map(gkey)), k1 = new Set(g1.map(gkey))
    for (const g of g1) {
      if (k0.has(gkey(g))) continue
      if (u0) { add('stricter', 'route-added-to-deferred', k, `${g.institutionId}: ${g.courses.join(' + ')}`); continue }
      const same = g0.filter((h) => h.institutionId === g.institutionId)
      if (same.some((h) => subset(h.courses, g.courses))) add('stricter', 'group-lengthened', k, `${g.institutionId}: ${g.courses.join(' + ')}`)
      else if (same.some((h) => subset(g.courses, h.courses))) add('looser', 'group-shortened', k, `${g.institutionId}: ${same.find((h) => subset(g.courses, h.courses))!.courses.join(' + ')} -> ${g.courses.join(' + ')}`)
      else add('looser', 'route-added', k, `${g.institutionId}: ${g.courses.join(' + ')}`)
    }
    // Honors mix: a college where a course and its honors twin become interchangeable (a duplicated group does it too).
    const h0 = honorsColleges(r0.req)
    for (const c of honorsColleges(r1.req)) if (!h0.has(c)) add('looser', 'honors-mix-added', k, `college ${c}: regular and honors courses now combine`)
    for (const g of g0) if (!k1.has(gkey(g)) && !g1.some((h) => h.institutionId === g.institutionId && (subset(h.courses, g.courses) || subset(g.courses, h.courses))))
      add('stricter', 'route-removed', k, `${g.institutionId}: ${g.courses.join(' + ')}`)
  }
  for (const [k, r1] of R1) {
    if (R0.has(k)) continue
    if (!r1.required) add('neutral', 'row-added-optional', k, 'optional row added')
    else if (r1.parentType === 'AND') add('stricter', 'row-added', k, 'required row added')
    else add('looser', 'alternative-added', k, `row added to a ${r1.parentType} choice`)
  }
  if (old.root.required && !neu.root.required) add('looser', 'required-to-optional', '/', 'the whole agreement became optional')
  for (const s of neu.sendingIds) if (!old.sendingIds.includes(s)) add('looser', 'college-added', String(s), 'new sending college')
  if (old.receivingId !== neu.receivingId) add('looser', 'identity-changed', 'receivingId', `${old.receivingId} -> ${neu.receivingId}`)
  return out
}

/* ------------------------------------------------------------------ behavioral diff */

const reqsOf = (root: ReqNode) => [...rowsOf(root).values()].map((r) => r.req)

/** Transcripts to try: empty; per college, the smallest group of every row (new-only groups first); the solver's plan. */
function samples(a: BaselineAgreement & { catalog?: Agreement['catalog'] }, old: BaselineAgreement, budget: number) {
  const out: [string, Set<CourseId>][] = [['empty transcript', new Set()]]
  const oldKeys = new Set(reqsOf(old.root).flatMap((r) => r.groups.map(gkey)))
  const reqs = reqsOf(a.root)
  for (const c of a.sendingIds) {
    const pick = new Set<CourseId>()
    for (const r of reqs) {
      const gs = r.groups.filter((g) => g.institutionId === c)
        .sort((x, y) => Number(oldKeys.has(gkey(x))) - Number(oldKeys.has(gkey(y))) || x.courses.length - y.courses.length)
      gs[0]?.courses.forEach((x) => pick.add(x))
    }
    if (pick.size) out.push([`minimal groups at college ${c}`, pick])
    if (a.catalog) {
      try {
        const p = solve(new Set(), a as Agreement, { allowed: [c], home: c, budget })
        if (!p.unsolvable.length) out.push([`solver plan at college ${c}`, new Set(p.terms.flatMap((t) => t.courses))])
      } catch { /* the solver's own failure is a validation matter, not a diff one */ }
    }
  }
  return out
}

export function behavioralDiff(file: string, old: BaselineAgreement, neu: BaselineAgreement & { catalog?: Agreement['catalog'] }, budget = DIFF_LIMITS.solveBudget): Change[] {
  const out: Change[] = []
  const valid = (t: Set<CourseId>, a: BaselineAgreement) => { try { return verifySchedule(t, a as Agreement).isValid } catch { return false } }
  for (const [what, t] of samples(neu, old, budget)) {
    if (valid(t, neu) && !valid(t, old)) {
      const miss = (() => { try { return verifySchedule(t, old as Agreement).missing.slice(0, 3).join(', ') } catch { return '' } })()
      out.push({ file, direction: 'looser', code: 'false-green', where: what, detail: `${t.size} course(s) valid on the new data, not on the old${miss ? ` (old still needs ${miss})` : ''}` })
    }
  }
  return out
}

/* ------------------------------------------------------------------ per-college statistics */

/** groups[college][file] = groups that college has in that agreement. */
function collegeGroups(d: DataSet) {
  const m = new Map<number, Map<string, number>>()
  for (const [f, a] of d.agreements) {
    for (const s of a.sendingIds) { if (!m.has(s)) m.set(s, new Map()); m.get(s)!.set(f, 0) }
    for (const r of reqsOf(a.root)) for (const g of r.groups) {
      if (!m.has(g.institutionId)) m.set(g.institutionId, new Map())
      const byFile = m.get(g.institutionId)!
      byFile.set(f, (byFile.get(f) ?? 0) + 1)
    }
  }
  return m
}

export function collegeDrops(ref: DataSet, next: DataSet, which: CollegeDrop['ref'], lim = DIFF_LIMITS): CollegeDrop[] {
  const out: CollegeDrop[] = []
  const a = collegeGroups(ref), b = collegeGroups(next)
  for (const [c, files0] of a) {
    const files1 = b.get(c) ?? new Map<string, number>()
    let t0 = 0, t1 = 0, n0 = 0, n1 = 0
    for (const [f, g0] of files0) {
      const g1 = files1.get(f) ?? 0
      t0 += g0; t1 += g1
      if (g0 > 0) { n0++; if (g1 > 0) n1++ }
      if (g0 > 0 && (g1 === 0 || (g0 >= lim.minGroups && (g0 - g1) / g0 > lim.maxCollegeAgreementDrop)))
        out.push({ college: c, file: f, before: g0, after: g1, ref: which, what: 'groups' })
    }
    if (t0 && (t0 - t1) / t0 > lim.maxCollegeDrop) out.push({ college: c, before: t0, after: t1, ref: which, what: 'groups' })
    if (n0 && (n0 - n1) / n0 > lim.maxCollegeDrop) out.push({ college: c, before: n0, after: n1, ref: which, what: 'agreements' })
  }
  return out
}

/* ------------------------------------------------------------------ decision */

function compare(ref: DataSet, next: DataSet, behavioral: boolean): Change[] {
  const out: Change[] = []
  for (const [f, a0] of ref.agreements) {
    const a1 = next.agreements.get(f)
    if (!a1) { out.push({ file: f, direction: 'looser', code: 'agreement-removed', where: f, detail: 'agreement disappeared' }); continue }
    if (JSON.stringify(a0.root) === JSON.stringify(a1.root) && JSON.stringify(a0.sendingIds) === JSON.stringify(a1.sendingIds) && a0.receivingId === a1.receivingId) continue
    out.push(...semanticDiff(f, a0, a1))
    if (behavioral) out.push(...behavioralDiff(f, a0, a1))
  }
  for (const f of next.agreements.keys()) if (!ref.agreements.has(f)) out.push({ file: f, direction: 'looser', code: 'agreement-added', where: f, detail: 'new agreement (never reviewed)' })
  return out
}

const sig = (c: Change) => `${c.file}|${c.code}|${c.where}|${c.detail}`

export interface DecideInput {
  /** Previously published data (undefined on the first publish). */
  prev?: DataSet
  next: DataSet
  baseline?: Baseline
  /** Skip the behavioral diff (tests of the semantic layer). */
  behavioral?: boolean
}

export function decide({ prev, next, baseline, behavioral = true }: DecideInput): Decision {
  const reasons: string[] = []
  const counts: Record<Direction, number> = { looser: 0, stricter: 0, neutral: 0 }
  const base = baseline ? baselineData(baseline) : undefined
  const meta = baseline ? { reviewedAt: baseline.reviewedAt, academicYear: baseline.academicYear, normalizeVersion: baseline.normalizeVersion } : null

  if (!prev && !base) {
    // Nothing to compare against means nobody reviewed any of this data: never publish it on its own.
    return { decision: 'review', reasons: ['first publish: no previous data or reviewed baseline to compare against, so all of this data needs human review; merging it creates the baseline'], reference: 'none', baseline: null, changes: [], counts, restored: 0, drops: [], updateBaseline: true }
  }
  if (!base) reasons.push(`no reviewed baseline (data/${BASELINE_FILE}); this review establishes it`)
  else {
    if (base.academicYear !== next.academicYear) reasons.push(`academic year ${base.academicYear} -> ${next.academicYear} since the reviewed baseline`)
    if (base.normalizeVersion !== next.normalizeVersion) reasons.push(`normalize v${base.normalizeVersion} -> v${next.normalizeVersion} since the reviewed baseline`)
  }

  const ref = base ?? prev!
  const changes = compare(ref, next, behavioral)
  let restored = 0
  if (base && prev) {
    // Looser vs yesterday but not vs the baseline: back to reviewed data (counted, not a reason).
    const vsBase = new Set(changes.filter((c) => c.direction === 'looser').map((c) => c.file))
    restored = compare(prev, next, false).filter((c) => c.direction === 'looser' && !vsBase.has(c.file)).length
  }
  for (const c of changes) counts[c.direction]++
  const looser = changes.filter((c) => c.direction === 'looser')
  if (looser.length) {
    const files = new Set(looser.map((c) => c.file))
    const codes = [...new Set(looser.map((c) => c.code))].join(', ')
    reasons.push(`${looser.length} looser change(s) in ${files.size} agreement(s) vs the ${base ? 'reviewed baseline' : 'previous data'}: ${codes}`)
  }

  const drops = [...(prev ? collegeDrops(prev, next, 'previous') : []), ...(base ? collegeDrops(base, next, 'baseline') : [])]
  const seen = new Set<string>(), uniq = drops.filter((d) => { const k = `${d.college}|${d.file}|${d.what}|${d.ref}`; return !seen.has(k) && !!seen.add(k) })
  if (uniq.length) reasons.push(`large per-college drop: ${[...new Set(uniq.map((d) => d.college))].join(', ')}`)

  const kept = changes.filter((c) => c.direction !== 'neutral')
  const dedup = [...new Map(kept.map((c) => [sig(c), c])).values()]
  const review = reasons.length > 0
  return { decision: review ? 'review' : 'publish', reasons, reference: base ? 'baseline' : 'previous', baseline: meta, changes: dedup, counts, restored, drops: uniq, updateBaseline: review }
}

/** decide() for a published data dir (with its baseline) and a staged one. */
export function decideDirs(prevDir: string | undefined, nextDir: string, behavioral = true): Decision {
  const next = readDataSet(nextDir)
  if (!next) throw new Error(`${nextDir}: no index.json`)
  const prev = prevDir && existsSync(join(prevDir, 'index.json')) ? readDataSet(prevDir) : undefined
  return decide({ prev, next, baseline: prevDir ? readBaseline(prevDir) : undefined, behavioral })
}

/* ------------------------------------------------------------------ report */

/** ASSIST-controlled text in Markdown (TESTER2 L-7): no tables broken, no HTML, no mentions or links. */
export const esc = (s: string) => s.replace(/[\\`*_{}[\]<>|#@!~]/g, (c) => `\\${c}`).replace(/\r?\n/g, ' ').slice(0, 200)

export function decisionMarkdown(d: Decision, maxRows = 150): string {
  const L: string[] = []
  L.push(`### Release decision: **${d.decision === 'publish' ? 'publish' : 'REVIEW REQUIRED'}**`, '')
  L.push(d.decision === 'publish' && d.reasons.length
    ? 'Changes that normally need review were accepted by a human override (reasons below); published, and recorded as the reviewed baseline.'
    : d.decision === 'publish'
    ? 'Only neutral or stricter changes against the reviewed baseline; published automatically.'
    : 'This refresh may make requirements easier or lost a college\'s articulation. Do not merge until each item below is confirmed against ASSIST. Merging records this data as the new reviewed baseline.')
  L.push('')
  if (d.reasons.length) { L.push('Reasons:'); for (const r of d.reasons) L.push(`- ${esc(r)}`); L.push('') }
  L.push(`Compared with: ${d.reference === 'baseline' ? `reviewed baseline of ${d.baseline!.reviewedAt} (${d.baseline!.academicYear})` : d.reference === 'previous' ? 'previous data (no baseline)' : 'nothing (first publish)'}. ` +
    `Changes: ${d.counts.looser} looser, ${d.counts.stricter} stricter, ${d.counts.neutral} neutral${d.restored ? `; ${d.restored} restoration(s) of reviewed data` : ''}.`, '')
  const table = (rows: Change[], title: string) => {
    if (!rows.length) return
    L.push(`#### ${title} (${rows.length})`, '', '| Agreement | Change | Where | Detail |', '|---|---|---|---|')
    for (const c of rows.slice(0, maxRows)) L.push(`| ${esc(c.file)} | ${c.code} | ${esc(c.where)} | ${esc(c.detail)} |`)
    if (rows.length > maxRows) L.push(`| … | ${rows.length - maxRows} more | | |`)
    L.push('')
  }
  table(d.changes.filter((c) => c.direction === 'looser'), 'Looser (could turn a red transcript green)')
  if (d.drops.length) {
    L.push(`#### Per-college drops (${d.drops.length})`, '', '| College | Agreement | What | Before | After | Against |', '|---|---|---|---|---|---|')
    for (const x of d.drops.slice(0, maxRows)) L.push(`| ${x.college} | ${x.file ? esc(x.file) : '(all)'} | ${x.what} | ${x.before} | ${x.after} | ${x.ref} |`)
    L.push('')
  }
  table(d.changes.filter((c) => c.direction === 'stricter'), 'Stricter')
  return L.join('\n')
}
