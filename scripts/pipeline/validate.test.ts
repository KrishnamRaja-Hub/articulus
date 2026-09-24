/* The validation gate: each invariant fires on a targeted corruption of good (mock-built) data. */
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NORMALIZE_VERSION } from '../../src/engine/normalize.ts'
import type { Agreement, ReqNode, Requirement } from '../../src/engine/types.ts'
import { rows } from './canaries.ts'
import { PIPELINE } from './config.ts'
import { startMockAssist } from './mock-assist.ts'
import { checkRawReproducible } from './raw-check.ts'
import { minRows, validateData, type Report } from './validate.ts'
import { NOW, REPO, cleanupTmp, readJson, run, tmp } from './test-helpers.ts'
afterAll(cleanupTmp)

let good = ''
beforeAll(async () => {
  const m = await startMockAssist()
  good = join(tmp('validate'), 'data')
  const r = await run(m.url, good)
  await m.close()
  expect(r.ok, r.error).toBe(true)
})

const BME = '79-mechanical-engineering-b-s.json'
const copy = () => { const d = join(tmp('v'), 'data'); cpSync(good, d, { recursive: true }); return d }
const edit = (d: string, file: string, f: (v: any) => any) => { const p = join(d, file); writeFileSync(p, JSON.stringify(f(JSON.parse(readFileSync(p, 'utf8'))) ?? JSON.parse(readFileSync(p, 'utf8')))) }
const agreement = (d: string, f: (a: Agreement) => void) => edit(d, `agreements/${BME}`, (a) => { f(a); return a })
const validate = (d: string, mode: 'publish' | 'ci' = 'publish', extra = {}) => validateData(d, { cfg: PIPELINE, mode, now: NOW, ...extra })
const errors = (r: Report) => r.findings.filter((f) => f.severity === 'error').map((f) => f.check)
const warnings = (r: Report) => r.findings.filter((f) => f.severity === 'warning').map((f) => f.check)
const req = (a: Agreement, id: string) => rows(a.root).find((r) => r.req.id === id)!.req

describe('validate:data on good data', () => {
  it('passes with no findings and runs every canary', () => {
    const r = validate(good)
    expect(r.findings).toEqual([])
    expect(r.passed).toBe(true)
    expect(r.canaries.every((c) => c.result === 'pass')).toBe(true)
    expect(r.checks).toBeGreaterThan(500)
  })
  it('the raw store reproduces the published agreements', () => {
    const r = validate(good)
    checkRawReproducible(good, PIPELINE, r)
    expect(r.passed).toBe(true)
  })
})

describe('invariants (errors)', () => {
  const cases: [string, (d: string) => void, string][] = [
    ['group mixes colleges', (d) => agreement(d, (a) => { req(a, 'PHYSICS 7B').groups[0].courses.push('51:PHYS 4C') }), 'group.single-college'],
    ['group course missing from catalog', (d) => agreement(d, (a) => { delete a.catalog['113:PHYS 4C'] }), 'group.in-catalog'],
    ['zero units', (d) => agreement(d, (a) => { a.catalog['113:PHYS 4C'].units = 0 }), 'catalog.units'],
    ['NaN units (null in JSON)', (d) => agreement(d, (a) => { a.catalog['113:PHYS 4C'].units = null as unknown as number }), 'catalog.schema'],
    ['catalog id not matching its institution prefix', (d) => agreement(d, (a) => { a.catalog['113:PHYS 4C'].institutionId = 51 }), 'catalog.id'],
    ['group at a college outside the agreement', (d) => agreement(d, (a) => { a.sendingIds = a.sendingIds.filter((s) => s !== 137) }), 'group.in-scope'],
    ['empty requirement tree', (d) => agreement(d, (a) => { a.root.children = [] }), 'tree.empty'],
    ['empty node', (d) => agreement(d, (a) => { (a.root.children[0] as ReqNode).children = [] }), 'tree.empty-node'],
    ['requirement with neither groups nor reason', (d) => agreement(d, (a) => { const r = req(a, 'ENGIN 7'); r.groups = []; delete r.noArticulation }), 'tree.req-empty'],
    ['N_OF asks for more than it has', (d) => agreement(d, (a) => { const n = a.root.children[0] as ReqNode; n.type = 'N_OF'; n.n = 99 }), 'tree.n-of'],
    ['N_OF choose 0 (TESTER2 M-3)', (d) => agreement(d, (a) => { const n = a.root.children[0] as ReqNode; n.type = 'N_OF'; n.n = 0 }), 'tree.n-of'],
    ['required node with only optional children (TESTER2 M-3)', (d) => agreement(d, (a) => { const n = a.root.children[0] as ReqNode; n.children = [{ kind: 'node', type: 'AND', required: false, children: n.children }] }), 'tree.no-required-children'],
    ['advisory section marked required (TESTER1 H-4)', (d) => agreement(d, (a) => { const n = a.root.children[0] as ReqNode; a.root.children.push({ ...n, title: 'ADDITIONAL MAJOR ELECTIVES', required: true }) }), 'tree.advisory-required'],
    ['RECOMMENDED title marked required',(d) => agreement(d, (a) => { (a.root.children[1] as ReqNode).required = true }), 'tree.recommended-required'],
    ['bad node type', (d) => agreement(d, (a) => { (a.root.children[0] as { type: string }).type = 'XOR' }), 'tree.schema'],
    ['same requirement id, different content', (d) => agreement(d, (a) => { (a.root.children[1] as ReqNode).children.push({ ...req(a, 'MATH 51'), groups: [] } as Requirement) }), 'tree.req-consistent'],
    ['index/agreement mismatch', (d) => edit(d, 'index.json', (ix) => { ix.find((e: { file: string }) => e.file === BME).major = 'Other'; return ix }), 'agreement.index-match'],
    ['file listed but missing', (d) => rmSync(join(d, 'agreements', '120-computer-science-b-s.json')), 'agreement.present'],
    ['stray agreement file', (d) => writeFileSync(join(d, 'agreements', '1-stray.json'), '{}'), 'index.stray-file'],
    ['agreement the app imports removed from the index', (d) => edit(d, 'index.json', (ix) => ix.filter((e: { file: string }) => e.file !== BME)), 'index.app-imports'],
    ['invalid JSON', (d) => writeFileSync(join(d, 'agreements', BME), '{'), 'agreement.json'],
    ['duplicate institution', (d) => edit(d, 'institutions.json', (xs) => [...xs, xs[0]]), 'institutions.unique'],
    ['configured college missing', (d) => edit(d, 'institutions.json', (xs) => xs.filter((x: { id: number }) => x.id !== 32)), 'institutions.scope'],
    ['meta agreements count wrong', (d) => edit(d, 'meta.json', (m) => ({ ...m, agreements: 1 })), 'meta.agreements'],
    ['meta schema', (d) => edit(d, 'meta.json', (m) => ({ ...m, fetchedAt: 'yesterday' })), 'meta.schema'],
    ['meta from an older normalize', (d) => edit(d, 'meta.json', (m) => ({ ...m, normalizeVersion: NORMALIZE_VERSION - 1 })), 'meta.normalize-version'],
    ['stale data (> 30 days)', (d) => edit(d, 'meta.json', (m) => ({ ...m, fetchedAt: '2026-08-01T00:00:00Z' })), 'meta.age'],
    ['wrong academic year', (d) => { edit(d, 'meta.json', (m) => ({ ...m, academicYear: { id: 76, code: '2025-2026' } })) }, 'meta.academic-year'],
    ['never validated', (d) => edit(d, 'meta.json', (m) => ({ ...m, validation: null })), 'meta.validation'],
    ['agreement year differs from meta', (d) => agreement(d, (a) => { a.year = '2025-2026' }), 'agreement.year'],
    ['orphaned catalog courses (F-01)', (d) => agreement(d, (a) => { for (let i = 0; i < 10; i++) a.catalog[`51:X ${i}`] = { id: `51:X ${i}`, institutionId: 51, prefix: 'X', number: String(i), title: 't', units: 4 } }), 'catalog.orphans'],
    ['CRITICAL-1 shape: calculus recommended, upper division required', (d) => edit(d, 'agreements/117-mechanical-engineering-b-s.json', (a: Agreement) => {
      const [lower, phys, rec] = a.root.children as ReqNode[]
      a.root.children = [{ ...lower, required: false, title: 'STRONGLY RECOMMENDED COURSES' }, phys, { ...rec, required: true, title: 'UPPER DIVISION' }]
      return a
    }), 'heuristic.recommended-math'],
  ]
  it.each(cases)('%s', (_, corrupt, id) => {
    const d = copy()
    corrupt(d)
    const r = validate(d)
    expect(r.passed).toBe(false)
    expect(errors(r)).toContain(id)
  })
  it('a tree with nothing required is rejected (the engine also fails closed, so the canary stays quiet)', () => {
    const d = copy()
    agreement(d, (a) => { for (const n of a.root.children as ReqNode[]) n.required = false })
    const e = errors(validate(d))
    expect(e).toContain('tree.no-required')
    expect(e).not.toContain('canary.all.empty-transcript-invalid')
  })
  it('hand edits are caught by raw reproducibility', () => {
    const d = copy()
    agreement(d, (a) => { req(a, 'PHYSICS 7B').groups.pop() })
    const r = validate(d)
    checkRawReproducible(d, PIPELINE, r)
    expect(r.findings.filter((f) => f.check === 'raw.reproducible').map((f) => f.file)).toEqual([BME])
    expect(r.passed).toBe(false)
  })
})

describe('warnings', () => {
  it('placeholder-only rows, aging data, title/subject mismatch, "take all" N_OF', () => {
    const d = copy()
    agreement(d, (a) => {
      const r = req(a, 'ENGIN 7'); r.groups = []; r.noArticulation = { 113: 'No articulation listed' }
      ;(a.root.children[0] as ReqNode).title = 'CHEMISTRY ONLY PLEASE' // holds math/physics too, but has CHEM: no warning
    })
    edit(d, 'agreements/89-mechanical-engineering-b-s.json', (a: Agreement) => { (a.root.children[0] as ReqNode).title = 'PHYSICS'; return a })
    edit(d, 'meta.json', (m) => ({ ...m, fetchedAt: '2026-09-10T00:00:00Z' }))
    const w = warnings(validate(d))
    expect(w).toEqual(expect.arrayContaining(['meta.age', 'heuristic.title-subject']))
    expect(w).not.toContain('rows.placeholder-only') // ENGIN 7 is optional, only required rows count
    const d2 = copy()
    agreement(d2, (a) => { const r = req(a, 'MATH 51'); r.groups = []; r.noArticulation = { 113: 'No articulation listed' } })
    expect(warnings(validate(d2))).toContain('rows.placeholder-only')
  })
})

describe('CI mode on legacy data', () => {
  it('known legacy symptoms are "legacy", structural errors still fail', () => {
    const d = copy()
    edit(d, 'meta.json', (m) => ({ ...m, normalizeVersion: 1, fetchedAt: null, validation: null }))
    agreement(d, (a) => { for (let i = 0; i < 10; i++) a.catalog[`51:X ${i}`] = { id: `51:X ${i}`, institutionId: 51, prefix: 'X', number: String(i), title: 't', units: 4 } })
    const r = validate(d, 'ci')
    expect(r.passed).toBe(true)
    expect(r.findings.filter((f) => f.severity === 'legacy').map((f) => f.check)).toEqual(expect.arrayContaining(['meta.normalize-version', 'meta.fetched-at', 'meta.validation', 'catalog.orphans']))
    expect(validate(d, 'publish').passed).toBe(false)
    agreement(d, (a) => { req(a, 'PHYSICS 7B').groups[0].courses.push('51:PHYS 4C') })
    expect(errors(validate(d, 'ci'))).toContain('group.single-college')
  })
  it('current data in CI mode: stale/aging is a warning, not a failure', () => {
    const d = copy()
    edit(d, 'meta.json', (m) => ({ ...m, fetchedAt: '2026-07-01T00:00:00Z' }))
    const r = validate(d, 'ci')
    expect(r.passed).toBe(true)
    expect(warnings(r)).toContain('meta.age')
  })
  it('the committed repo data: strict mode fails on the known legacy problems, CI mode passes with them as legacy', () => {
    const data = join(REPO, 'data')
    const meta = readJson(join(data, 'meta.json'))
    const strict = validate(data)
    const ci = validate(data, 'ci')
    if (meta.normalizeVersion === NORMALIZE_VERSION && meta.validation?.passed) {
      expect(ci.passed).toBe(true) // refreshed data: must be clean
    } else {
      expect(strict.passed).toBe(false)
      expect(errors(strict)).toContain('meta.normalize-version')
      expect(ci.passed, JSON.stringify(ci.findings.filter((f) => f.severity === 'error'))).toBe(true)
      expect(ci.counts.legacy).toBeGreaterThan(0)
    }
  })
})

describe('minRows', () => {
  it('counts the cheapest way to finish, so "choose 1" -> "take all" moves it', () => {
    const r = (id: string): Requirement => ({ kind: 'req', id, label: id, units: 4, groups: [] })
    const n = (type: ReqNode['type'], children: (ReqNode | Requirement)[], extra: Partial<ReqNode> = {}): ReqNode => ({ kind: 'node', type, required: true, children, ...extra })
    expect(minRows(n('AND', [r('a'), n('N_OF', [r('b'), r('c'), r('d')], { n: 1 }), n('AND', [r('x')], { required: false })]))).toBe(2)
    expect(minRows(n('AND', [r('a'), n('AND', [r('b'), r('c'), r('d')])]))).toBe(4)
    expect(minRows(n('OR', [n('AND', [r('a'), r('b')]), r('c')]))).toBe(1)
  })
})
