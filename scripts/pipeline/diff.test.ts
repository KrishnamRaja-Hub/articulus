/* Release decision (diff.ts): looser changes and large per-college drops go to review; neutral/stricter publish. */
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Agreement, ReqNode } from '../../src/engine/types.ts'
import { rows } from './canaries.ts'
import { BASELINE_FILE, decide, decideDirs, decisionMarkdown, esc, makeBaseline, readBaseline, readDataSet, semanticDiff, type DataSet } from './diff.ts'
import { startMockAssist } from './mock-assist.ts'
import { cleanupTmp, NOW, readJson, run, tmp } from './test-helpers.ts'
afterAll(cleanupTmp)

const BME = '79-mechanical-engineering-b-s.json'
let good = ''
let base: DataSet
beforeAll(async () => {
  const m = await startMockAssist()
  good = join(tmp('diff'), 'data')
  const r = await run(m.url, good)
  await m.close()
  expect(r.ok, r.error).toBe(true)
  base = readDataSet(good)!
})

const clone = (d: DataSet): DataSet => ({ ...d, agreements: new Map([...d.agreements].map(([f, a]) => [f, structuredClone(a)])) })
/** Apply f to Berkeley ME in a copy of the good data and decide against it (prev = baseline = good). */
const mutate = (f: (a: Agreement) => void, behavioral = true) => {
  const next = clone(base)
  f(next.agreements.get(BME) as Agreement)
  return decide({ prev: base, next, baseline: makeBaseline(base, NOW), behavioral })
}
const nodes = (n: ReqNode): ReqNode[] => [n, ...n.children.flatMap((c) => (c.kind === 'node' ? nodes(c) : []))]
const reqRow = (a: Agreement, id: string) => rows(a.root).find((r) => r.req.id === id)!
const codes = (d: ReturnType<typeof decide>) => [...new Set(d.changes.filter((c) => c.direction === 'looser').map((c) => c.code))]

describe('decide', () => {
  it('unchanged data publishes', () => {
    const d = decide({ prev: base, next: clone(base), baseline: makeBaseline(base, NOW) })
    expect(d.decision).toBe('publish')
    expect(d.changes).toEqual([])
    expect(d.updateBaseline).toBe(false)
  })
  it('first publish publishes and initializes the baseline; no baseline yet goes to review', () => {
    expect(decide({ next: base })).toMatchObject({ decision: 'publish', updateBaseline: true })
    expect(decide({ prev: base, next: clone(base) })).toMatchObject({ decision: 'review', updateBaseline: true })
  })

  const looser: [string, (a: Agreement) => void, string][] = [
    ['a required row removed', (a) => { const r = reqRow(a, 'PHYSICS 7B'); r.parent.children = r.parent.children.filter((c) => c !== r.req) }, 'row-removed'],
    ['required -> optional', (a) => { nodes(a.root).find((n) => n !== a.root && n.required)!.required = false }, 'required-to-optional'],
    ['a series loses a course', (a) => { const g = reqRow(a, 'PHYSICS 7B').req.groups.find((g) => g.courses.length > 1)!; g.courses.pop() }, 'group-shortened'],
    ['a requirement gains a CC route', (a) => { const r = reqRow(a, 'PHYSICS 7B').req; r.groups.push({ institutionId: r.groups[0].institutionId, courses: [`${r.groups[0].institutionId}:ZZZ 1`] }) }, 'route-added'],
    ['a row becomes UC-only (deferred)', (a) => { const r = reqRow(a, 'PHYSICS 7B').req; r.groups = []; r.noArticulation = Object.fromEntries(a.sendingIds.map((s) => [s, 'No Course Articulated'])) }, 'deferral-added'],
    ['take all -> all but one', (a) => { const n = nodes(a.root).find((n) => n !== a.root && n.type === 'AND' && n.children.length >= 2)!; n.type = 'N_OF'; n.n = n.children.length - 1 }, 'n-decreased'],
  ]
  it.each(looser)('%s goes to review', (_, f, code) => {
    const d = mutate(f)
    expect(d.decision).toBe('review')
    expect(codes(d)).toContain(code)
    expect(d.updateBaseline).toBe(true)
  })

  it('a stricter change publishes (a series gains a course; a choose-1 becomes take-all)', () => {
    const d = mutate((a) => { const g = reqRow(a, 'PHYSICS 7B').req.groups[0]; g.courses.push(`${g.institutionId}:ZZZ 2`) })
    expect(d.decision).toBe('publish')
    expect(d.counts.stricter).toBeGreaterThan(0)
  })
  it('a title-only change is neutral', () => {
    const d = mutate((a) => { nodes(a.root).forEach((n) => { n.title = (n.title ?? '') + ' (2026)' }) })
    expect(d.decision).toBe('publish')
  })
  it('the behavioral diff alone flags a false green', () => {
    const next = clone(base), a = next.agreements.get(BME) as Agreement
    const r = reqRow(a, 'PHYSICS 7B'); r.parent.children = r.parent.children.filter((c) => c !== r.req)
    const d = decide({ prev: base, next, baseline: makeBaseline(base, NOW) })
    expect(d.changes.some((c) => c.code === 'false-green')).toBe(true)
  })

  it('H-5: a college going dark inside one agreement goes to review', () => {
    const d = mutate((a) => { for (const r of rows(a.root)) r.req.groups = r.req.groups.filter((g) => g.institutionId !== a.sendingIds[0]) }, false)
    expect(d.decision).toBe('review')
    expect(d.drops.some((x) => x.file === BME && x.after === 0)).toBe(true)
  })

  it('H-4: slow drift is measured against the reviewed baseline, not yesterday', () => {
    const baseline = makeBaseline(base, NOW)
    let prev = base
    const decisions: string[] = []
    for (let day = 0; day < 4; day++) {
      const next = clone(prev), a = next.agreements.get(BME) as Agreement
      const c = a.sendingIds[0]
      // remove one more of college c's groups each day (stricter, small per day)
      const r = rows(a.root).find((x) => x.req.groups.some((g) => g.institutionId === c) && x.req.groups.length > 1)
      if (r) r.req.groups = r.req.groups.filter((g, i) => g.institutionId !== c || i !== r.req.groups.findIndex((h) => h.institutionId === c))
      const vsYesterday = decide({ prev, next, baseline: undefined, behavioral: false })
      const d = decide({ prev, next, baseline, behavioral: false })
      decisions.push(d.decision)
      expect(vsYesterday.changes.every((x) => x.direction !== 'looser')).toBe(true)
      prev = next
    }
    expect(decisions).toContain('review')
    expect(decisions[0]).toBe('publish')
  })

  it('a change back to the reviewed baseline is not looser (flap)', () => {
    const baseline = makeBaseline(base, NOW)
    const dropped = clone(base); const r = reqRow(dropped.agreements.get(BME) as Agreement, 'PHYSICS 7B').req; r.groups = r.groups.slice(1)
    expect(decide({ prev: base, next: dropped, baseline }).decision).toBe('publish')
    const back = decide({ prev: dropped, next: clone(base), baseline })
    expect(back.decision).toBe('publish')
    expect(back.restored).toBeGreaterThan(0)
  })

  it('an academic-year rollover vs the baseline goes to review', () => {
    const next = clone(base); next.academicYear = '2099-2100'
    expect(decide({ prev: base, next, baseline: makeBaseline(base, NOW) }).decision).toBe('review')
  })
})

describe('semanticDiff', () => {
  it('a row added to an OR is looser, to an AND stricter', () => {
    const a = structuredClone(base.agreements.get(BME)) as Agreement
    const b = structuredClone(a)
    const and = nodes(b.root).find((n) => n.type === 'AND' && n.required)!
    and.children.push({ kind: 'req', id: 'NEW 1', label: 'x', units: 4, groups: [{ institutionId: b.sendingIds[0], courses: ['x:1'] }] })
    expect(semanticDiff(BME, a, b).map((c) => [c.direction, c.code])).toContainEqual(['stricter', 'row-added'])
    const c = structuredClone(a)
    const or = nodes(c.root).find((n) => n.type !== 'AND')
    if (or) {
      or.children.push({ kind: 'req', id: 'NEW 2', label: 'x', units: 4, groups: [{ institutionId: c.sendingIds[0], courses: ['x:1'] }] })
      expect(semanticDiff(BME, a, c).some((x) => x.direction === 'looser')).toBe(true)
    }
  })
})

describe('report and pipeline hook', () => {
  it('escapes ASSIST text in the Markdown report', () => {
    expect(esc('a|b <img> @user [x](y)')).not.toMatch(/(^|[^\\])[|<>@[]/)
    const d = mutate((a) => { reqRow(a, 'PHYSICS 7B').req.groups[0].courses.pop() }, false)
    const md = decisionMarkdown(d)
    expect(md).toContain('REVIEW REQUIRED')
    expect(md).toContain('group-shortened')
  })

  it('the first publish writes the baseline; a looser refresh fails by default and stages with a new baseline in PR mode', async () => {
    expect(readBaseline(good)).toBeDefined()
    expect(existsSync(join(good, BASELINE_FILE))).toBe(true)
    const m = await startMockAssist()
    // the reviewed baseline is stricter than what ASSIST now serves: today's refresh is looser than reviewed
    const data = join(tmp('hook'), 'data'); cpSync(good, data, { recursive: true })
    const b = readBaseline(data)!
    const req = rows(b.agreements[BME].root).find((r) => r.req.groups.some((g) => g.courses.length > 1))!.req
    req.groups = req.groups.map((g) => ({ ...g, courses: [...g.courses, `${g.institutionId}:ZZZ 9`] })) // reviewed data was stricter
    writeFileSync(join(data, BASELINE_FILE), JSON.stringify(b))
    const before = readFileSync(join(data, 'meta.json'), 'utf8')
    const r = await run(m.url, data)
    expect(r).toMatchObject({ ok: false, published: false, decision: 'review', stage: 'review' })
    expect(readFileSync(join(data, 'meta.json'), 'utf8')).toBe(before)
    expect(readFileSync(join(data, '..', 'work', 'failure.md'), 'utf8')).toContain('REVIEW REQUIRED')
    expect(readJson(join(data, '..', 'work', 'decision.json')).decision).toBe('review')

    const staged = await run(m.url, data, { envExtra: { DATA_REFRESH_ON_REVIEW: 'pr' } })
    await m.close()
    expect(staged).toMatchObject({ ok: true, published: true, decision: 'review' })
    expect(readBaseline(data)!.agreements[BME]).toEqual(readBaseline(good)!.agreements[BME]) // new baseline = the served data
    expect(decideDirs(data, data, false).decision).toBe('publish')
  })
})
