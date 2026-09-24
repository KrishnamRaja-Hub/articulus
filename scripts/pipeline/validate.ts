/*
 * Data validation gate. Every check adds to `checks`; problems become findings:
 *   error    fails the gate
 *   warning  reported, does not fail
 *   info     statistics worth reading
 *   legacy   (CI mode only) an error that is a known symptom of data built by an older NORMALIZE_VERSION
 * See scripts/validate-data.ts for the CLI and the list of checks in its header.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { classifyTitle, NORMALIZE_VERSION, NOT_LISTED } from '../../src/engine/normalize.ts'
import type { Agreement, Course, Institution, ReqNode, Requirement } from '../../src/engine/types.ts'
import { codeInEffect } from './academic-year.ts'
import { CANARIES, rows, sections } from './canaries.ts'
import type { PipelineConfig } from './config.ts'
import type { IndexEntry } from './store.ts'

export type Severity = 'error' | 'warning' | 'info' | 'legacy'
export interface Finding { check: string; severity: Severity; message: string; file?: string }
export interface AgreementStats {
  file: string; major: string; receivingId: number; sendingColleges: number
  requirements: number; requiredRows: number; minRowsToComplete: number; groups: number; catalog: number; orphans: number
  placeholderRows: number; ucOnlyRows: number; templateMismatches: number[] | null
}
export interface Meta {
  schema: 1
  normalizeVersion: number
  fetchedAt: string | null
  academicYear: { id: number; code: string } | null
  validation: { passed: boolean; at: string; checks: number; report: string } | null
  agreements: number
}
export interface DiffSummary {
  previous: { agreements: number; groups: number; normalizeVersion: number | null; academicYear: string | null } | null
  added: string[]; removed: string[]; changed: string[]; unchanged: number
  /** agreements, index or institutions differ from the previous data. */
  contentChanged: boolean
  overridden: boolean
}
export interface Report {
  schema: 1
  generatedAt: string
  mode: 'publish' | 'ci'
  dataDir: string
  normalizeVersion: number
  dataNormalizeVersion: number | null
  legacyData: boolean
  passed: boolean
  checks: number
  counts: Record<Severity, number>
  findings: Finding[]
  agreements: AgreementStats[]
  canaries: { id: string; description: string; file: string | null; result: 'pass' | 'fail' | 'skipped'; severity: Severity | null; message?: string }[]
  diff: DiffSummary | null
  suites: { name: string; command: string; ok: boolean; ms: number; tail?: string }[]
}

export interface ValidateOptions {
  cfg: PipelineConfig
  mode: 'publish' | 'ci'
  now: Date
  /** Staged data: meta.json is the candidate written by the pipeline; its `validation` is not set yet. */
  staged?: boolean
  /** Previously published data directory, for the diff guard. */
  prevDir?: string
  acceptDiff?: boolean
  /** From the build step: normalize warnings and template mismatches per file (unknown for committed data without raw). */
  notes?: Record<string, string[]>
  templateMismatches?: Record<string, number[]>
  /** Agreement files that must exist (default: those src/ imports by name). */
  appImports?: string[]
}

const SEVERITIES: Severity[] = ['error', 'warning', 'info', 'legacy']
/** Title suffix normalize gives requirements only other colleges' templates list (always optional). */
const ONLY_SOME = /only in some colleges/i
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isInt = (v: unknown): v is number => Number.isInteger(v)
const isIso = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v))
const readJson = (path: string): { ok: true; value: unknown } | { ok: false; error: string } => {
  try { return { ok: true, value: JSON.parse(readFileSync(path, 'utf8')) } } catch (e) { return { ok: false, error: (e as Error).message } }
}
/** "C&EE M20" -> 20; "MATH 31A" -> 31. Course numbers >= 100 are upper division at the UC. */
const ucNumber = (label: string) => Number(/(?:^|\s)[A-Z]*(\d+)/.exec(label.trim().split(/\s+/).at(-1) ?? '')?.[1] ?? NaN)
const ucParts = (id: string) => id.split(',').map((s) => s.trim()).filter(Boolean)
const isLowerMath = (id: string) => ucParts(id).some((p) => /^(MATH|MAT)\s/i.test(p) && ucNumber(p) < 100)
const isUpperDiv = (id: string) => ucParts(id).some((p) => ucNumber(p) >= 100)
/** Subject words in requirement titles, and the UC prefixes rows under them should use (title-shift heuristic, F-03). */
const TITLE_SUBJECTS: [RegExp, RegExp][] = [[/\bMATH/i, /^(MATH|MAT)\b/], [/\bCHEM/i, /^(CHEM|CHE)\b/], [/\bPHYSICS\b/i, /^(PHYSICS|PHYS|PHY)\b/], [/\bBIOLOG/i, /^(BIO|BIOL|BIS|BILD|MCELLBI|LIFESCI)/]]

/**
 * Agreement files the app or its tests import by name (src/data.ts imports Berkeley ME eagerly; engine tests import
 * several). They must stay in the data set or the build and the suites break. Scanned from src/ and smoke.mjs.
 */
export function appImportedAgreements(repoRoot = join(import.meta.dirname, '..', '..')): string[] {
  const found = new Set<string>()
  const scan = (p: string) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const q = join(p, e.name)
      if (e.isDirectory()) scan(q)
      else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) for (const m of readFileSync(q, 'utf8').matchAll(/data\/agreements\/([A-Za-z0-9_.-]+\.json)/g)) found.add(m[1])
    }
  }
  if (existsSync(join(repoRoot, 'src'))) scan(join(repoRoot, 'src'))
  const smoke = join(repoRoot, 'scripts', 'smoke.mjs')
  if (existsSync(smoke)) for (const m of readFileSync(smoke, 'utf8').matchAll(/data\/agreements\/([A-Za-z0-9_.-]+\.json)/g)) found.add(m[1])
  return [...found].sort()
}

export function validateData(dataDir: string, o: ValidateOptions): Report {
  const findings: Finding[] = []
  let checks = 0
  /** Record one check. `legacy`: failing it is a known symptom of pre-fix data (downgraded in CI mode). */
  const check = (ok: boolean, id: string, severity: 'error' | 'warning' | 'info', message: string, file?: string, legacy = false) => {
    checks++
    if (!ok) findings.push({ check: id, severity, message, file, ...(legacy ? { legacy: true } : {}) } as Finding)
    return ok
  }
  const info = (id: string, message: string, file?: string) => findings.push({ check: id, severity: 'info', message, file })
  const agreementsStats: AgreementStats[] = []
  const canaryResults: Report['canaries'] = []

  // ---------- files ----------
  const load = (name: string) => {
    const p = join(dataDir, name)
    if (!check(existsSync(p), 'files.present', 'error', `${name} is missing`)) return undefined
    const r = readJson(p)
    return check(r.ok, 'files.json', 'error', `${name} is not valid JSON: ${r.ok ? '' : r.error}`) && r.ok ? r.value : undefined
  }
  const instRaw = load('institutions.json'), indexRaw = load('index.json'), metaRaw = load('meta.json')
  check(existsSync(join(dataDir, 'agreements')), 'files.present', 'error', 'agreements/ directory is missing')

  // ---------- meta.json (DATA_CONTRACT.md) ----------
  let meta: Meta | undefined
  if (metaRaw !== undefined) {
    const m = metaRaw as Record<string, unknown>
    const ok = [
      check(isObj(m) && m.schema === 1, 'meta.schema', 'error', 'meta.json: schema must be 1'),
      check(isInt(m?.normalizeVersion) && (m.normalizeVersion as number) >= 1, 'meta.schema', 'error', 'meta.json: normalizeVersion must be a positive integer'),
      check(m?.fetchedAt === null || isIso(m?.fetchedAt), 'meta.schema', 'error', 'meta.json: fetchedAt must be an ISO date or null'),
      check(m?.academicYear === null || (isObj(m?.academicYear) && isInt(m.academicYear.id) && typeof m.academicYear.code === 'string' && /^\d{4}-\d{4}$/.test(m.academicYear.code)),
        'meta.schema', 'error', 'meta.json: academicYear must be { id, code: "YYYY-YYYY" } or null'),
      check(m?.validation === null || (isObj(m?.validation) && typeof m.validation.passed === 'boolean' && isIso(m.validation.at) && isInt(m.validation.checks) && typeof m.validation.report === 'string'),
        'meta.schema', 'error', 'meta.json: validation must be { passed, at, checks, report } or null'),
      check(isInt(m?.agreements), 'meta.schema', 'error', 'meta.json: agreements must be an integer'),
    ].every(Boolean)
    if (ok) meta = m as unknown as Meta
  }
  const dataVersion = meta?.normalizeVersion ?? null
  const legacyData = dataVersion !== NORMALIZE_VERSION
  if (meta) {
    check(meta.normalizeVersion === NORMALIZE_VERSION, 'meta.normalize-version', 'error',
      `data built by normalize v${meta.normalizeVersion}, code is v${NORMALIZE_VERSION}: run \`npm run renormalize\` (raw stored) or \`npm run fetch\``, undefined, true)
    if (check(meta.fetchedAt !== null, 'meta.fetched-at', 'error', 'fetchedAt is null: data was never fetched by the pipeline', undefined, true)) {
      const days = (o.now.getTime() - Date.parse(meta.fetchedAt!)) / 86_400_000
      check(days > -1, 'meta.fetched-at', 'error', `fetchedAt ${meta.fetchedAt} is in the future`)
      const stale = o.mode === 'publish' ? 'error' : 'warning'
      if (check(days <= o.cfg.validate.staleErrorDays, 'meta.age', stale, `data is ${days.toFixed(1)} days old (> ${o.cfg.validate.staleErrorDays}): the app treats it as untrusted`, undefined, true))
        check(days <= o.cfg.validate.agingDays, 'meta.age', 'warning', `data is ${days.toFixed(1)} days old (> ${o.cfg.validate.agingDays}): the app shows it as aging`)
    }
    const want = codeInEffect(o.now)
    check(meta.academicYear?.code === want, 'meta.academic-year', o.mode === 'publish' ? 'error' : 'warning',
      `academic year ${meta.academicYear?.code ?? 'null'} is not the one in effect (${want}): the app treats the data as untrusted`, undefined, true)
    if (!o.staged) check(!!meta.validation?.passed, 'meta.validation', 'error', 'meta.validation is missing or failed: this data never passed the gate', undefined, true)
  }

  // ---------- institutions.json ----------
  const institutions: Institution[] = []
  if (instRaw !== undefined && check(Array.isArray(instRaw), 'institutions.schema', 'error', 'institutions.json must be an array')) {
    const seen = new Set<number>()
    for (const [i, x] of (instRaw as unknown[]).entries()) {
      const v = x as Record<string, unknown>
      const ok = check(isObj(v) && isInt(v.id) && typeof v.name === 'string' && !!v.name && typeof v.short === 'string' && !!v.short && typeof v.isCC === 'boolean' && (v.terms === 'quarter' || v.terms === 'semester'),
        'institutions.schema', 'error', `institutions[${i}] must be { id, name, short, isCC, terms: quarter|semester }: ${JSON.stringify(x)?.slice(0, 120)}`)
      if (ok && check(!seen.has(v.id as number), 'institutions.unique', 'error', `institution ${v.id} listed twice`)) { seen.add(v.id as number); institutions.push(v as unknown as Institution) }
    }
    if (o.mode === 'publish') {
      for (const id of o.cfg.universities) check(institutions.some((x) => x.id === id && !x.isCC), 'institutions.scope', 'error', `configured university ${id} missing or marked as a community college`)
      for (const id of o.cfg.colleges) check(institutions.some((x) => x.id === id && x.isCC), 'institutions.scope', 'error', `configured college ${id} missing or not a community college`)
    }
  }
  const instById = new Map(institutions.map((x) => [x.id, x]))

  // ---------- index.json ----------
  const index: IndexEntry[] = []
  if (indexRaw !== undefined && check(Array.isArray(indexRaw), 'index.schema', 'error', 'index.json must be an array')) {
    const files = new Set<string>(), pairs = new Set<string>()
    for (const [i, x] of (indexRaw as unknown[]).entries()) {
      const v = x as Record<string, unknown>
      if (!check(isObj(v) && typeof v.file === 'string' && /^\d+-[a-z0-9-]+\.json$/.test(v.file) && isInt(v.receivingId) && typeof v.major === 'string' && !!v.major,
        'index.schema', 'error', `index[${i}] must be { file: "<ucId>-<slug>.json", receivingId, major }: ${JSON.stringify(x)?.slice(0, 120)}`)) continue
      const e = v as unknown as IndexEntry
      check(!files.has(e.file), 'index.unique', 'error', `${e.file} listed twice`)
      check(!pairs.has(`${e.receivingId}|${e.major}`), 'index.unique', 'error', `${e.receivingId} "${e.major}" listed twice`)
      check(e.file.startsWith(`${e.receivingId}-`), 'index.file-prefix', 'error', `${e.file} does not start with its receivingId ${e.receivingId}`, e.file)
      check(instById.get(e.receivingId)?.isCC === false, 'index.receiving', 'error', `receivingId ${e.receivingId} is not a university in institutions.json`, e.file)
      if (o.mode === 'publish') check(o.cfg.universities.includes(e.receivingId), 'index.scope', 'error', `receivingId ${e.receivingId} is not a configured university`, e.file)
      files.add(e.file); pairs.add(`${e.receivingId}|${e.major}`)
      index.push(e)
    }
    check(index.length > 0, 'index.nonempty', 'error', 'index.json lists no agreements')
    if (meta) check(meta.agreements === index.length, 'meta.agreements', 'error', `meta.agreements is ${meta.agreements}, index lists ${index.length}`)
    if (o.mode === 'publish') for (const uc of o.cfg.universities) check(index.some((e) => e.receivingId === uc), 'index.coverage', 'error', `no agreement for configured university ${uc}`)
    for (const f of o.appImports ?? appImportedAgreements())
      check(index.some((e) => e.file === f), 'index.app-imports', 'error', `${f} is imported by name in src/ (app or tests); it must stay in the data set or the build breaks`, f)
  }
  const dir = join(dataDir, 'agreements')
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) check(index.some((e) => e.file === f), 'index.stray-file', 'error', `agreements/${f} is not listed in index.json (the app would still bundle it)`, f)
  }

  // ---------- agreements ----------
  const agreements = new Map<string, Agreement>()
  const years = new Set<string>()
  for (const e of index) {
    const p = join(dir, e.file)
    if (!check(existsSync(p), 'agreement.present', 'error', `agreements/${e.file} is listed in index.json but missing`, e.file)) continue
    const r = readJson(p)
    if (!check(r.ok, 'agreement.json', 'error', `not valid JSON: ${r.ok ? '' : r.error}`, e.file) || !r.ok) continue
    const a = r.value as Agreement
    const f = e.file
    const err = (ok: boolean, id: string, msg: string, legacy = false) => check(ok, id, 'error', msg, f, legacy)
    const warn = (ok: boolean, id: string, msg: string, legacy = false) => check(ok, id, 'warning', msg, f, legacy)

    // schema
    if (!err(isObj(a) && isInt(a.receivingId) && typeof a.major === 'string' && typeof a.year === 'string' && Array.isArray(a.sendingIds) && isObj(a.root) && isObj(a.catalog),
      'agreement.schema', 'must be { receivingId, major, year, sendingIds, root, catalog }')) continue
    err(a.receivingId === e.receivingId, 'agreement.index-match', `receivingId ${a.receivingId} but index says ${e.receivingId}`)
    err(a.major === e.major, 'agreement.index-match', `major "${a.major}" but index says "${e.major}"`)
    err(/^\d{4}-\d{4}$/.test(a.year), 'agreement.schema', `year "${a.year}" is not YYYY-YYYY`)
    years.add(a.year)
    if (meta?.academicYear) err(a.year === meta.academicYear.code, 'agreement.year', `year ${a.year} but meta.academicYear is ${meta.academicYear.code}`)
    err(a.sendingIds.length > 0 && a.sendingIds.every(isInt) && new Set(a.sendingIds).size === a.sendingIds.length, 'agreement.sending', 'sendingIds must be unique integers, at least one')
    for (const s of a.sendingIds) {
      err(instById.get(s)?.isCC === true, 'agreement.sending', `sending college ${s} is not a community college in institutions.json`)
      if (o.mode === 'publish') err(o.cfg.colleges.includes(s), 'agreement.sending', `sending college ${s} is not configured`)
    }

    // catalog
    let catalogOk = true
    for (const [k, c] of Object.entries(a.catalog) as [string, Course][]) {
      const ok = err(isObj(c) && isInt(c.institutionId) && typeof c.prefix === 'string' && typeof c.number === 'string' && typeof c.title === 'string' && typeof c.units === 'number',
        'catalog.schema', `catalog["${k}"] must be { id, institutionId, prefix, number, title, units }`)
      if (!ok) { catalogOk = false; continue }
      err(c.id === k && k === `${c.institutionId}:${c.prefix} ${c.number}`, 'catalog.id', `catalog key "${k}" does not match "${c.institutionId}:${c.prefix} ${c.number}"`)
      err(a.sendingIds.includes(c.institutionId), 'catalog.institution', `catalog course ${k} is from ${c.institutionId}, not a sending college of this agreement`)
    }

    // tree
    const reqById = new Map<string, Requirement>()
    const referenced = new Set<string>()
    let treeOk = true
    const walk = (n: ReqNode | Requirement, path: string): void => {
      if (isObj(n) && n.kind === 'req') {
        const r = n as Requirement
        if (!err(typeof r.id === 'string' && !!r.id && typeof r.label === 'string' && typeof r.units === 'number' && Number.isFinite(r.units) && r.units >= 0 && Array.isArray(r.groups),
          'tree.schema', `${path}: requirement must be { id, label, units >= 0, groups }`)) { treeOk = false; return }
        const prev = reqById.get(r.id)
        if (prev) err(JSON.stringify(prev) === JSON.stringify(r), 'tree.req-consistent', `requirement ${r.id} appears twice with different content (the engine keys rows by id)`)
        else reqById.set(r.id, r)
        err(r.groups.length > 0 || (isObj(r.noArticulation) && Object.keys(r.noArticulation).length > 0), 'tree.req-empty', `${r.id}: no groups and no noArticulation reason`)
        if (r.noArticulation !== undefined) err(isObj(r.noArticulation) && Object.entries(r.noArticulation).every(([k, v]) => isInt(Number(k)) && typeof v === 'string'), 'tree.schema', `${r.id}: noArticulation must map college id -> reason`)
        for (const [gi, g] of r.groups.entries()) {
          if (!err(isObj(g) && isInt(g.institutionId) && Array.isArray(g.courses) && g.courses.length > 0 && g.courses.every((c) => typeof c === 'string'),
            'group.schema', `${r.id} group ${gi}: must be { institutionId, courses: [≥1 id] }`)) { treeOk = false; continue }
          err(a.sendingIds.includes(g.institutionId), 'group.in-scope', `${r.id}: group at ${g.institutionId}, not a sending college of this agreement`)
          err(g.courses.every((c) => c.startsWith(`${g.institutionId}:`)), 'group.single-college', `${r.id}: group at ${g.institutionId} contains ${g.courses.filter((c) => !c.startsWith(`${g.institutionId}:`)).join(', ')}`)
          err(new Set(g.courses).size === g.courses.length, 'group.duplicates', `${r.id}: group repeats a course: ${g.courses.join('+')}`)
          for (const c of g.courses) {
            referenced.add(c)
            const course = a.catalog[c]
            if (err(!!course, 'group.in-catalog', `${r.id}: course ${c} is not in the catalog`))
              err(Number.isFinite(course.units) && course.units > 0, 'catalog.units', `${c}: units ${course.units} (used by ${r.id}) must be finite and > 0`)
          }
        }
        return
      }
      if (!err(isObj(n) && n.kind === 'node' && ['AND', 'OR', 'N_OF'].includes((n as ReqNode).type) && typeof (n as ReqNode).required === 'boolean' && Array.isArray((n as ReqNode).children),
        'tree.schema', `${path}: node must be { kind: "node", type: AND|OR|N_OF, required, children }`)) { treeOk = false; return }
      const node = n as ReqNode
      if (node.title !== undefined) err(typeof node.title === 'string', 'tree.schema', `${path}: title must be a string`)
      err(node.children.length > 0, 'tree.empty-node', `${path}${node.title ? ` "${node.title}"` : ''}: node has no children`)
      if (node.type === 'N_OF') {
        err(isInt(node.n) && node.n! >= 1 && node.n! <= node.children.length, 'tree.n-of', `${path}: N_OF n=${node.n} with ${node.children.length} children`)
        warn(node.n !== node.children.length, 'tree.n-of-all', `${path}: N_OF ${node.n} of ${node.children.length} is "take all"`)
      }
      if (node.title) {
        // a title that also says "required" is ambiguous and kept required on purpose (tree.ambiguous-title)
        err(!(/RECOMMEND/i.test(node.title) && node.required && classifyTitle(node.title).kind !== 'ambiguous'), 'tree.recommended-required', `"${node.title}" is marked required`)
      }
      node.children.forEach((c, i) => walk(c, `${path}/${i}`))
    }
    walk(a.root, 'root')
    if (treeOk) {
      err(a.root.required === true && a.root.type === 'AND', 'tree.root', 'root must be a required AND node')
      err(a.root.children.length > 0, 'tree.empty', 'requirement tree is empty')
    }
    if (!treeOk || !catalogOk) continue
    agreements.set(f, a)

    // semantics
    const all = rows(a.root)
    const required = [...new Map(all.filter((r) => r.required).map((r) => [r.req.id, r])).values()]
    // Sections (TESTER1 H-4): the top-level groups' titles, resolved in order the way normalize v3 does. Rows under a
    // time-to-degree, elective or other advisory section must not fail a plan; a title it cannot place stays required.
    // Degenerate trees (TESTER2 M-3): the engine fails closed on them, but they must never publish. A tree with no
    // required row, or a required node none of whose children are required, would otherwise read as "nothing to do".
    err(required.length > 0, 'tree.no-required', 'requirement tree has no required rows: every plan would be trivially complete')
    for (const n of nodes(a.root)) {
      if (!n.required || !n.children.length) continue // tree.empty-node reports childless nodes
      const req = n.children.filter((c) => c.kind === 'req' || c.required).length
      err(req > 0, 'tree.no-required-children', `${n.title ? `"${n.title}"` : `${n.type} node`}: required, but none of its ${n.children.length} children is`)
      if (n.type === 'N_OF') err(isInt(n.n) && n.n! >= 1 && n.n! <= req, 'tree.n-of-required', `${n.title ? `"${n.title}"` : 'N_OF node'}: choose ${n.n} of ${req} required children`)
    }
    const secs = new Map(sections(a.root))
    for (const [n, r] of secs) {
      if (!n.required) continue
      const ids = rows(n).map((x) => x.req.id), list = `${ids.slice(0, 6).join('; ')}${ids.length > 6 ? '; ...' : ''}`
      err(r.required, 'tree.advisory-required', `"${n.title}" is required but reads as advisory (${r.rule}); normalize v3 makes it optional. Rows: ${list}`, true)
      warn(!r.ambiguous, 'tree.ambiguous-title', `"${n.title ?? ''}" kept required, but its title is ambiguous (${r.rule}): confirm on ASSIST whether these are needed for admission. Rows: ${list}`)
    }
    for (const n of nodes(a.root)) {
      if (!n.required && n.title) warn(ONLY_SOME.test(n.title) || secs.get(n)?.required === false || ['advisory', 'additional'].includes(classifyTitle(n.title).kind), 'tree.optional-title', `optional node "${n.title}" has no advisory ("recommended", electives, ...) title`)
      for (const [subject, prefix] of TITLE_SUBJECTS) {
        if (!n.title || !subject.test(n.title)) continue
        const ids = rows(n).map((r) => r.req.id)
        warn(ids.some((id) => ucParts(id).some((p) => prefix.test(p))), 'heuristic.title-subject',
          `"${n.title}" holds none of its subject's courses (${ids.slice(0, 4).join('; ')}${ids.length > 4 ? '; ...' : ''}): titles may be paired with the wrong groups (F-03)`, true)
      }
    }
    const orphans = Object.keys(a.catalog).filter((c) => !referenced.has(c))
    const catalogSize = Object.keys(a.catalog).length
    const orphanFrac = catalogSize ? orphans.length / catalogSize : 0
    if (err(orphanFrac <= o.cfg.validate.maxOrphanFraction, 'catalog.orphans',
      `${orphans.length}/${catalogSize} catalog courses (${(orphanFrac * 100).toFixed(1)}%) count toward no requirement (F-01), e.g. ${orphans.slice(0, 3).join(', ')}`, true))
      warn(!orphans.length, 'catalog.orphans', `${orphans.length} catalog courses count toward no requirement: ${orphans.slice(0, 5).join(', ')}${orphans.length > 5 ? ', ...' : ''}`)
    const placeholder = required.filter((r) => !r.req.groups.length && Object.values(r.req.noArticulation ?? {}).every((v) => v === NOT_LISTED))
    warn(!placeholder.length, 'rows.placeholder-only', `${placeholder.length} required rows have no ASSIST record at any college ("${NOT_LISTED}"); wherever the major needs one it cannot show green: ${placeholder.map((r) => r.req.id).join('; ')}`)
    const ucOnly = required.filter((r) => !r.req.groups.length && Object.values(r.req.noArticulation ?? {}).some((v) => v !== NOT_LISTED))

    // Heuristics for the CRITICAL-1 shape: calculus under a recommended title while upper-division UC courses are required.
    const optionalMath = all.filter((r) => !r.required && isLowerMath(r.req.id) && r.titles.some((t) => /RECOMMEND/i.test(t)))
    const requiredUpper = required.filter((r) => isUpperDiv(r.req.id))
    err(!(optionalMath.length && requiredUpper.length), 'heuristic.recommended-math',
      `lower-division math (${optionalMath.map((r) => r.req.id).join(', ')}) is only recommended while upper-division ${requiredUpper.map((r) => r.req.id).join(', ')} is required: likely a title shift (CRITICAL-1)`, true)
    if (o.cfg.validate.mathRequiredMajors.test(a.major))
      err(required.some((r) => isLowerMath(r.req.id)), 'heuristic.no-required-math', 'no lower-division math row is required for an engineering/CS major: a false "you are OK" risk', true)
    warn(!requiredUpper.length, 'heuristic.upper-division-required', `upper-division UC courses are required for transfer: ${requiredUpper.map((r) => r.req.id).join(', ')}`, true)

    const mism = o.templateMismatches?.[f] ?? null
    if (mism?.length) warn(false, 'normalize.template-mismatch', `template differs from the first college's at colleges ${mism.join(', ')}; their rows were matched by UC course`)
    for (const note of o.notes?.[f] ?? []) {
      if (/in no template, not added/.test(note)) warn(false, 'normalize.dropped', note)
      else if (/ambiguous section title/.test(note)) warn(false, 'normalize.ambiguous-title', note)
      else info('normalize.note', note, f)
    }
    agreementsStats.push({
      file: f, major: a.major, receivingId: a.receivingId, sendingColleges: a.sendingIds.length,
      requirements: reqById.size, requiredRows: required.length, minRowsToComplete: minRows(a.root), groups: [...reqById.values()].reduce((t, r) => t + r.groups.length, 0),
      catalog: catalogSize, orphans: orphans.length, placeholderRows: placeholder.length, ucOnlyRows: ucOnly.length, templateMismatches: mism,
    })
  }
  check(years.size <= 1, 'agreement.year', 'error', `agreements mix academic years: ${[...years].join(', ')}`)

  // ---------- canaries ----------
  for (const c of CANARIES) {
    const targets = c.target ? index.filter((e) => e.receivingId === c.target!.receivingId && c.target!.major.test(e.major)).map((e) => e.file) : [...agreements.keys()]
    const tag = c.minNormalizeVersion ? ` [data-dependent: needs normalize v${c.minNormalizeVersion}+]` : ''
    if (!targets.length) {
      check(false, c.id, c.severity, `${c.description}: target agreement not in the data set${tag}`)
      canaryResults.push({ id: c.id, description: c.description, file: null, result: 'fail', severity: c.severity, message: 'target agreement missing' })
      continue
    }
    for (const f of targets) {
      const a = agreements.get(f)
      if (!a) { canaryResults.push({ id: c.id, description: c.description, file: f, result: 'skipped', severity: null, message: 'agreement failed schema checks' }); continue }
      let msg: string | null
      try { msg = c.check(a) } catch (e) { msg = `threw ${(e as Error).message}` }
      const legacy = !!c.minNormalizeVersion && (dataVersion ?? 0) < c.minNormalizeVersion
      check(msg === null, c.id, c.severity, `${c.description}: ${msg}${tag}`, f, legacy)
      canaryResults.push({ id: c.id, description: c.description, file: f, result: msg === null ? 'pass' : 'fail', severity: msg === null ? null : c.severity, ...(msg ? { message: msg } : {}) })
    }
  }

  // ---------- diff guard ----------
  const diff = o.prevDir ? diffGuard(o.prevDir, dataDir, index, agreements, dataVersion, meta?.academicYear?.code ?? null, o, check) : null

  // CI mode on legacy data: known legacy symptoms are reported, not failed.
  for (const x of findings as (Finding & { legacy?: boolean })[]) {
    if (x.legacy && o.mode === 'ci' && legacyData && x.severity === 'error') x.severity = 'legacy'
    delete x.legacy
    const ack = o.cfg.validate.acknowledged[`${x.check}|${x.file ?? ''}`]
    if (ack && x.severity === 'error') { x.severity = 'warning'; x.message += ` (acknowledged: ${ack})` }
  }
  for (const c of canaryResults) {
    const f = findings.find((x) => x.check === c.id && x.file === (c.file ?? undefined))
    if (f && c.result === 'fail') c.severity = f.severity
  }
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, findings.filter((x) => x.severity === s).length])) as Record<Severity, number>
  return {
    schema: 1, generatedAt: o.now.toISOString(), mode: o.mode, dataDir, normalizeVersion: NORMALIZE_VERSION, dataNormalizeVersion: dataVersion,
    legacyData, passed: counts.error === 0, checks, counts, findings, agreements: agreementsStats, canaries: canaryResults, diff, suites: [],
  }
}

/**
 * Fewest rows that complete the tree: AND sums its required children, OR takes the cheapest, N_OF the n cheapest.
 * Unlike a row count, it moves when "choose 1 of" turns into "take all" (the F-02 shape).
 */
export function minRows(n: ReqNode | Requirement): number {
  if (n.kind === 'req') return 1
  const kids = n.children.filter((c) => c.kind === 'req' || c.required).map(minRows).sort((a, b) => a - b)
  if (n.type === 'AND') return kids.reduce((t, k) => t + k, 0)
  if (n.type === 'OR') return kids[0] ?? 0
  return kids.slice(0, n.n ?? 1).reduce((t, k) => t + k, 0)
}

function nodes(n: ReqNode | Requirement): ReqNode[] {
  return n.kind === 'req' ? [] : [n, ...n.children.flatMap(nodes)]
}

type Check = (ok: boolean, id: string, severity: 'error' | 'warning' | 'info', message: string, file?: string, legacy?: boolean) => boolean

/** Compare against the previously published data; refuse large unexplained drops. */
function diffGuard(prevDir: string, newDir: string, index: IndexEntry[], next: Map<string, Agreement>, nextVersion: number | null, nextYear: string | null, o: ValidateOptions, check: Check): DiffSummary {
  const d = o.cfg.diff
  const read = (p: string) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return undefined } }
  const text = (p: string) => { try { return readFileSync(p, 'utf8') } catch { return undefined } }
  const prevIndex = read(join(prevDir, 'index.json')) as IndexEntry[] | undefined
  const empty: DiffSummary = { previous: null, added: index.map((e) => e.file), removed: [], changed: [], unchanged: 0, contentChanged: true, overridden: !!o.acceptDiff }
  if (!Array.isArray(prevIndex)) return empty // first publish: nothing to compare
  const prevMeta = read(join(prevDir, 'meta.json')) as Meta | undefined
  const prevVersion = isInt(prevMeta?.normalizeVersion) ? prevMeta!.normalizeVersion : null
  const prevYear = prevMeta?.academicYear?.code ?? null
  // Row counts legitimately move when normalize changes meaning or the academic year rolls over.
  const shapeMayMove = prevVersion !== nextVersion || prevYear !== nextYear
  const why = shapeMayMove ? ` (warning only: ${prevVersion !== nextVersion ? `normalize v${prevVersion} -> v${nextVersion}` : `year ${prevYear} -> ${nextYear}`})` : ''
  const sev = (hard: boolean): 'error' | 'warning' => (hard && !o.acceptDiff ? 'error' : 'warning')
  const note = o.acceptDiff ? ` [accepted by ${d.overrideEnv}]` : ''

  const prevFiles = new Set(prevIndex.map((e) => e.file)), nextFiles = new Set(index.map((e) => e.file))
  const removed = [...prevFiles].filter((f) => !nextFiles.has(f)), added = [...nextFiles].filter((f) => !prevFiles.has(f))
  for (const f of removed) check(false, 'diff.agreement-removed', sev(true), `agreement disappeared since the last publish${note}`, f)
  for (const f of added) check(false, 'diff.agreement-added', 'info', 'new agreement', f)

  const prevInst = read(join(prevDir, 'institutions.json')) as Institution[] | undefined
  const nextInst = read(join(newDir, 'institutions.json')) as Institution[] | undefined
  for (const i of prevInst ?? []) check((nextInst ?? []).some((x) => x.id === i.id), 'diff.institution-removed', sev(true), `institution ${i.id} (${i.short}) disappeared${note}`)

  const stat = (a: Agreement) => {
    const all = rows(a.root)
    const reqs = new Map(all.map((r) => [r.req.id, r.req]))
    return { groups: [...reqs.values()].reduce((t, r) => t + r.groups.length, 0), required: minRows(a.root), catalog: Object.keys(a.catalog).length }
  }
  let prevTotal = 0, nextTotal = 0
  const changed: string[] = []
  let unchanged = 0
  for (const e of index) {
    const a = next.get(e.file)
    const pa = prevFiles.has(e.file) ? (read(join(prevDir, 'agreements', e.file)) as Agreement | undefined) : undefined
    if (!a || !pa?.root) continue
    if (text(join(prevDir, 'agreements', e.file)) === text(join(newDir, 'agreements', e.file))) unchanged++
    else changed.push(e.file)
    const s0 = stat(pa), s1 = stat(a)
    prevTotal += s0.groups; nextTotal += s1.groups
    const drop = s0.groups ? (s0.groups - s1.groups) / s0.groups : 0
    check(drop <= d.maxAgreementGroupDrop, 'diff.groups-drop', sev(!shapeMayMove), `course groups ${s0.groups} -> ${s1.groups} (-${(drop * 100).toFixed(0)}% > ${d.maxAgreementGroupDrop * 100}%)${why}${note}`, e.file)
    const rc = s0.required ? Math.abs(s1.required - s0.required) / s0.required : s1.required ? 1 : 0
    check(rc <= d.maxRequiredRowChange, 'diff.required-rows', sev(!shapeMayMove), `rows needed to complete the major ${s0.required} -> ${s1.required} (${(rc * 100).toFixed(0)}% > ${d.maxRequiredRowChange * 100}%)${why}${note}`, e.file)
    const cd = s0.catalog ? (s0.catalog - s1.catalog) / s0.catalog : 0
    check(cd <= d.maxCatalogDrop, 'diff.catalog-drop', 'warning', `catalog ${s0.catalog} -> ${s1.catalog} courses (-${(cd * 100).toFixed(0)}%)`, e.file)
    const lost = pa.sendingIds.filter((s) => !a.sendingIds.includes(s))
    check(!lost.length, 'diff.college-removed', sev(true), `sending colleges no longer in the agreement: ${lost.join(', ')}${note}`, e.file)
  }
  // Removed agreements count toward the total drop too.
  for (const f of removed) { const pa = read(join(prevDir, 'agreements', f)) as Agreement | undefined; if (pa?.root) prevTotal += stat(pa).groups }
  const totalDrop = prevTotal ? (prevTotal - nextTotal) / prevTotal : 0
  check(totalDrop <= d.maxTotalGroupDrop, 'diff.total-groups-drop', sev(true), `total course groups ${prevTotal} -> ${nextTotal} (-${(totalDrop * 100).toFixed(1)}% > ${d.maxTotalGroupDrop * 100}%)${note}`)

  const same = (n: string) => text(join(prevDir, n)) === text(join(newDir, n))
  const contentChanged = !!(removed.length || added.length || changed.length || !same('index.json') || !same('institutions.json'))
  return {
    previous: { agreements: prevIndex.length, groups: prevTotal, normalizeVersion: prevVersion, academicYear: prevYear },
    added, removed, changed, unchanged, contentChanged, overridden: !!o.acceptDiff,
  }
}
