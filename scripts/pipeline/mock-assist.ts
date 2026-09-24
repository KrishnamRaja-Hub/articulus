/*
 * Local mock of the ASSIST endpoints the fetcher uses, for offline tests (assist.org is never called by tests).
 * Serves synthetic payloads in the real shapes normalize.ts reads (JSON-in-JSON strings, positioned templateAssets,
 * articulations), enforces the antiforgery cookie + X-XSRF-TOKEN handshake, and injects 429 / 5xx / hangs on demand.
 * Run standalone: npm run mock:assist  (then ASSIST_BASE=http://127.0.0.1:8787 npm run fetch -- --dry-run)
 */
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { pathToFileURL } from 'node:url'
import { slugFile } from './fetch.ts'
import { appImportedAgreements } from './validate.ts'

type Cell = { type: 'Course'; id: string; course: RawC } | { type: 'Series'; id: string; series: { conjunction: string; name: string; courses: RawC[] } }
interface RawC { prefix: string; courseNumber: string; courseTitle: string; minUnits: number; maxUnits: number }

const course = (p: string, n: string, u = 4): RawC => ({ prefix: p, courseNumber: n, courseTitle: `${p} ${n} title`, minUnits: u, maxUnits: u })
export const ucCell = (p: string, n: string, u = 4): Cell => ({ type: 'Course', id: `${p}${n}`, course: course(p, n, u) })
export const ucSeries = (name: string, cs: [string, string][], conjunction = 'And'): Cell =>
  ({ type: 'Series', id: name, series: { conjunction, name, courses: cs.map(([p, n]) => course(p, n)) } })
const section = (rows: Cell[][], nOf?: number) => ({ type: 'Section', position: 0, rows: rows.map((cells, i) => ({ position: i, cells })), ...(nOf ? { advisements: [{ type: 'NFollowing', amount: nOf, selectionType: 'Course' }] } : {}) })
export const group = (position: number, sections: object[], conjunction?: string) => ({ type: 'RequirementGroup', position, sections, ...(conjunction ? { instruction: { type: 'Conjunction', conjunction } } : {}) })
export const title = (position: number, content: string) => ({ type: 'RequirementTitle', position, content })

/** One UC row and, per college, the CC course groups that articulate it ("And" within a group, "Or" between groups). */
export interface MockRow { cell: Cell; by: Record<number, [string, string, number?][][]> }
export interface MockMajor { receivingId: number; label: string; colleges: number[]; assets: (rows: Record<string, Cell>) => object[]; rows: MockRow[] }

const art = (row: MockRow, cc: number) => {
  const groups = row.by[cc] ?? []
  return {
    templateCellId: row.cell.id,
    articulation: {
      type: row.cell.type,
      ...(row.cell.type === 'Course' ? { course: row.cell.course } : { series: row.cell.series }),
      sendingArticulation: {
        noArticulationReason: groups.length ? null : 'No Course Articulated',
        items: groups.map((cs) => ({ courseConjunction: 'And', items: cs.map(([p, n, u]) => course(p, n, u ?? 4)) })),
        courseGroupConjunctions: [],
      },
    },
  }
}

const DA = 113, FH = 51, SM = 137
const both = (...cs: [string, string][]) => ({ [DA]: [cs], [FH]: [cs] }) as Record<number, [string, string][][]>
const cellsOf = (rows: MockRow[]) => Object.fromEntries(rows.map((r) => [r.cell.id, r.cell]))

/** A small, realistic data set that satisfies every canary in scripts/pipeline/canaries.ts. */
export function defaultDataset() {
  const bme: MockRow[] = [
    { cell: ucCell('MATH', '51'), by: { ...both(['MATH', '1A']), [SM]: [[['MATH', '7']]] } },
    { cell: ucCell('MATH', '52'), by: { ...both(['MATH', '1B'], ['MATH', '1C']), [SM]: [[['MATH', '8']]] } },
    { cell: ucCell('PHYSICS', '7A'), by: { ...both(['PHYS', '4A']), [SM]: [[['PHYSCS', '21']]] } },
    { cell: ucCell('PHYSICS', '7B'), by: { ...both(['PHYS', '4B'], ['PHYS', '4C']), [SM]: [[['PHYSCS', '22'], ['PHYSCS', '23']]] } },
    { cell: ucSeries('CHEM 1A, CHEM 1AL, CHEM 1B', [['CHEM', '1A'], ['CHEM', '1AL'], ['CHEM', '1B']]), by: { ...both(['CHEM', '1A'], ['CHEM', '1B'], ['CHEM', '1C']), [SM]: [[['CHEM', '11'], ['CHEM', '12']]] } },
    { cell: ucCell('ENGIN', '7'), by: { [FH]: [[['ENGR', '11']]], [DA]: [[['ENGR', '37']]] } },
  ]
  const lme: MockRow[] = [
    { cell: ucCell('MATH', '31A'), by: { ...both(['MATH', '1A']), [SM]: [[['MATH', '7']]] } },
    { cell: ucCell('MATH', '31B'), by: { ...both(['MATH', '1B']), [SM]: [[['MATH', '8']]] } },
    { cell: ucSeries('PHYSICS 1A, PHYSICS 1B', [['PHYSICS', '1A'], ['PHYSICS', '1B']]), by: both(['PHYS', '4A'], ['PHYS', '4B']) },
    { cell: ucCell('EC ENGR', '100'), by: { [DA]: [[['ENGR', '100']]] } },
  ]
  const sd: MockRow[] = [
    { cell: ucCell('MATH', '20A'), by: both(['MATH', '1A']) },
    { cell: ucCell('MATH', '20B'), by: both(['MATH', '1B']) },
    { cell: ucCell('CSE', '8A'), by: both(['CIS', '22A']) },
    { cell: ucCell('CSE', '29'), by: {} }, // no college articulates it
  ]
  const ir: MockRow[] = [
    { cell: ucCell('MATH', '2A'), by: both(['MATH', '1A']) },
    { cell: ucCell('MATH', '2B'), by: both(['MATH', '1B']) },
    { cell: ucCell('I&C SCI', '31'), by: both(['CIS', '22A']) },
    { cell: ucCell('I&C SCI', '32'), by: both(['CIS', '22B']) },
  ]
  const dv: MockRow[] = [
    { cell: ucCell('MAT', '021A'), by: both(['MATH', '1A']) },
    { cell: ucCell('MAT', '021B'), by: both(['MATH', '1B']) },
    { cell: ucCell('UWP', '001'), by: both(['EWRT', '1A']) },
    { cell: ucCell('COM', '001'), by: { [DA]: [[['COMM', '1']]] } },
    { cell: ucCell('ENL', '003'), by: { [FH]: [[['ENGL', '1B']]] } },
  ]
  const majors: MockMajor[] = [
    { receivingId: 79, label: 'Mechanical Engineering, B.S.', colleges: [DA, FH, SM], rows: bme, assets: (c) => [
      title(0, 'REQUIRED COURSES FOR ADMISSION'),
      group(1, [section([[c.MATH51], [c.MATH52], [c.PHYSICS7A], [c.PHYSICS7B], [c['CHEM 1A, CHEM 1AL, CHEM 1B']]])]),
      title(2, 'STRONGLY RECOMMENDED COURSES'),
      group(3, [section([[c.ENGIN7]])]),
    ] },
    { receivingId: 117, label: 'Mechanical Engineering/B.S.', colleges: [DA, FH, SM], rows: lme, assets: (c) => [
      title(0, 'LOWER DIVISION MAJOR REQUIREMENTS'),
      group(1, [section([[c.MATH31A], [c.MATH31B]])]),
      group(2, [section([[c['PHYSICS 1A, PHYSICS 1B']]])]),
      title(3, 'STRONGLY RECOMMENDED COURSES'),
      group(4, [section([[c['EC ENGR100']]])]),
    ] },
    { receivingId: 7, label: 'CSE: Computer Science B.S.', colleges: [DA, FH], rows: sd, assets: (c) => [
      title(0, 'LOWER DIVISION'), group(1, [section([[c.MATH20A], [c.MATH20B], [c.CSE8A], [c.CSE29]])]),
    ] },
    { receivingId: 120, label: 'Computer Science, B.S.', colleges: [DA, FH], rows: ir, assets: (c) => [
      title(0, 'REQUIRED'), group(1, [section([[c.MATH2A], [c.MATH2B]])]), group(2, [section([[c['I&C SCI31'], c['I&C SCI32']]])]),
    ] },
    { receivingId: 89, label: 'Mechanical Engineering B.S.', colleges: [DA, FH], rows: dv, assets: (c) => [
      title(0, 'MATHEMATICS'), group(1, [section([[c.MAT021A], [c.MAT021B]])]),
      title(2, 'COMPOSITION AND COMMUNICATION'), group(3, [section([[c.UWP001], [c.COM001], [c.ENL003]], 1)]),
    ] },
  ]
  // Agreements the app imports by file name must exist, as with real data: add a generic major for each one missing.
  for (const file of appImportedAgreements()) {
    if (majors.some((m) => slugFile(m.receivingId, m.label) === file)) continue
    const [, uc, slug] = /^(\d+)-(.+)\.json$/.exec(file) ?? []
    if (!uc) continue
    const label = slug.replace(/-b-([as])$/, (_, t: string) => ` B.${t.toUpperCase()}.`).split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')
    const rows: MockRow[] = [{ cell: ucCell('MATH', '1'), by: both(['MATH', '1A']) }, { cell: ucCell('CS', '1'), by: both(['CIS', '22A']) }]
    majors.push({ receivingId: Number(uc), label, colleges: [DA, FH], rows, assets: (c) => [title(0, 'REQUIRED'), group(1, [section([[c.MATH1], [c.CS1]])])] })
  }
  // A report the major filter must skip.
  const extra = { receivingId: 79, label: 'History, B.A.', colleges: [DA] }
  const names: Record<number, [string, boolean, number]> = {
    79: ['University of California, Berkeley', false, 2], 117: ['University of California, Los Angeles', false, 1],
    7: ['University of California, San Diego', false, 1], 120: ['University of California, Irvine', false, 1], 89: ['University of California, Davis', false, 1],
    113: ['De Anza College', true, 1], 51: ['Foothill College', true, 1], 137: ['Santa Monica College', true, 2], 49: ['Pasadena City College', true, 2],
    114: ['Diablo Valley College', true, 2], 124: ['Irvine Valley College', true, 2], 74: ['Orange Coast College', true, 2], 103: ['El Camino College', true, 2],
    58: ['Berkeley City College', true, 2], 33: ['City College of San Francisco', true, 2], 136: ['San Jose City College', true, 2],
    92: ['Santa Barbara City College', true, 2], 65: ['Saddleback College', true, 2], 80: ['West Valley College', true, 2], 32: ['Mission College', true, 2],
    1: ['Some Other College', true, 2],
  }
  const institutions = Object.entries(names).map(([id, [name, cc, term]]) =>
    ({ id: Number(id), names: [{ name, fromYear: 1995, hasDepartments: true, hideInList: false }], code: `C${id}`, prefers2016LegacyReport: false, isCommunityCollege: cc, termType: term, category: cc ? 2 : 0 }))
  return {
    academicYears: [{ Id: 75, FallYear: 2024 }, { Id: 76, FallYear: 2025 }, { Id: 77, FallYear: 2026 }] as unknown,
    institutions, majors, extra,
  }
}
export type MockDataset = ReturnType<typeof defaultDataset>

export interface Fault {
  /** Substring or regex matched against the request path + query. */
  match: string | RegExp
  /** Respond with this status (e.g. 500, 503, 404). */
  status?: number
  /** Never respond within this many ms (to trigger client timeouts). */
  hangMs?: number
  /** Only the first N matching requests fault (default: all). */
  times?: number
}
/** The request an articulation payload answers, for `rewrite`. */
export interface PayloadRequest { receivingId: number; sendingId: number; yearId: number; label: string }
export type MockPayload = ReturnType<typeof payload>
/** Identity rewrites of a payload's nested JSON (C-2 scenarios: a proxy or ASSIST serving the wrong agreement). */
export const setIdentity = (p: MockPayload, f: 'sendingInstitution' | 'receivingInstitution' | 'academicYear', v: object) => { p.result[f] = JSON.stringify(v) }
export interface MockOptions {
  /** Rewrite an articulation payload before it is served (identity mismatch scenarios). */
  rewrite?: (p: MockPayload, req: PayloadRequest, ds: MockDataset) => void
  /** Pad every articulation response with this many extra bytes (oversized response scenario). */
  padBytes?: number
  dataset?: MockDataset
  faults?: Fault[]
  /** Academic year ids whose agreements are published (default: every listed year). A listed year that is not
   *  published answers every listing with no reports: ASSIST's state for weeks after July 1 (M-6). */
  publishedYearIds?: number[]
  /** API requests allowed per session before 429 (ASSIST rate-limits per session). */
  rateLimitPerSession?: number
}

const yearOf = (ds: MockDataset, id: number) => {
  const y = (ds.academicYears as { Id: number; FallYear: number }[]).find((x) => x.Id === id)
  return y ? { id: y.Id, code: `${y.FallYear}-${y.FallYear + 1}` } : null
}

function payload(ds: MockDataset, m: MockMajor, cc: number, yearId: number) {
  const inst = (id: number) => ds.institutions.find((i) => i.id === id)!
  return {
    validationFailure: null,
    isSuccessful: true,
    result: {
      name: m.label,
      type: 'Major',
      publishDate: '2026-06-01T00:00:00',
      templateAssets: JSON.stringify(m.assets(cellsOf(m.rows))),
      articulations: JSON.stringify(m.rows.map((r) => art(r, cc))),
      academicYear: JSON.stringify(yearOf(ds, yearId)),
      sendingInstitution: JSON.stringify({ id: cc, names: inst(cc).names, isCommunityCollege: true }),
      receivingInstitution: JSON.stringify({ id: m.receivingId, names: inst(m.receivingId).names, isCommunityCollege: false }),
    },
  }
}

export interface MockAssist {
  url: string
  /** Every request path seen, in order. */
  log: string[]
  opts: MockOptions & { dataset: MockDataset; faults: Fault[] }
  close: () => Promise<void>
}

export async function startMockAssist(options: MockOptions = {}, port = 0): Promise<MockAssist> {
  const opts = { ...options, dataset: options.dataset ?? defaultDataset(), faults: options.faults ?? [] }
  const sessions = new Map<string, { token: string; used: number }>()
  const hits = new Map<Fault, number>()
  const log: string[] = []
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(typeof body === 'string' ? body : JSON.stringify(body))
  }
  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://mock')
    const path = url.pathname + url.search
    log.push(path)
    for (const f of opts.faults) {
      const n = hits.get(f) ?? 0
      if ((typeof f.match === 'string' ? path.includes(f.match) : f.match.test(path)) && (f.times === undefined || n < f.times)) {
        hits.set(f, n + 1)
        if (f.hangMs) { const t = setTimeout(() => send(res, 200, '{}'), f.hangMs); res.on('close', () => clearTimeout(t)); return }
        return send(res, f.status ?? 500, { error: 'injected fault' })
      }
    }
    if (url.pathname === '/') {
      const sid = randomBytes(8).toString('hex'), token = randomBytes(12).toString('base64url')
      sessions.set(sid, { token, used: 0 })
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': [
        `.AspNetCore.Antiforgery.mock=${sid}; path=/; samesite=strict; httponly`,
        `X-XSRF-TOKEN=${token}; path=/; samesite=strict`,
      ] })
      return res.end('<html>ASSIST mock</html>')
    }
    // Antiforgery: both cookies and a matching header, as ASSIST requires.
    const cookies = Object.fromEntries((req.headers.cookie ?? '').split(/;\s*/).filter(Boolean).map((c) => [c.slice(0, c.indexOf('=')), c.slice(c.indexOf('=') + 1)]))
    const s = sessions.get(cookies['.AspNetCore.Antiforgery.mock'])
    if (!s || cookies['X-XSRF-TOKEN'] !== s.token || req.headers['x-xsrf-token'] !== s.token) return send(res, 400, { error: 'antiforgery' })
    if (opts.rateLimitPerSession !== undefined && ++s.used > opts.rateLimitPerSession) return send(res, 429, { error: 'rate limited' })

    const ds = opts.dataset
    if (url.pathname === '/api/AcademicYears') return send(res, 200, ds.academicYears)
    if (url.pathname === '/api/institutions') return send(res, 200, ds.institutions)
    if (url.pathname === '/api/agreements') {
      const uc = Number(url.searchParams.get('receivingInstitutionId')), cc = Number(url.searchParams.get('sendingInstitutionId')), y = Number(url.searchParams.get('academicYearId'))
      if (!yearOf(ds, y)) return send(res, 400, { error: 'bad year' })
      if (opts.publishedYearIds && !opts.publishedYearIds.includes(y)) return send(res, 200, { reports: [], allReports: [] })
      const reports = [...ds.majors, ds.extra].filter((m) => m.receivingId === uc && m.colleges.includes(cc))
        .map((m) => ({ label: m.label, key: `${y}/${cc}/to/${uc}/Major/${Buffer.from(m.label).toString('hex')}`, ownerInstitutionId: uc }))
      return send(res, 200, { reports, allReports: reports })
    }
    if (url.pathname === '/api/articulation/Agreements') {
      const key = url.searchParams.get('key') ?? ''
      const [y, cc, , uc, , label] = key.split('/')
      const m = ds.majors.find((x) => x.receivingId === Number(uc) && Buffer.from(x.label).toString('hex') === label && x.colleges.includes(Number(cc)))
      if (!m) return send(res, 404, { error: 'no such agreement' })
      const p = payload(ds, m, Number(cc), Number(y))
      opts.rewrite?.(p, { receivingId: Number(uc), sendingId: Number(cc), yearId: Number(y), label: m.label }, ds)
      return send(res, 200, opts.padBytes ? { ...p, pad: 'x'.repeat(opts.padBytes) } : p)
    }
    return send(res, 404, { error: 'not found' })
  }
  const server = createServer(handle)
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r))
  const { port: p } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${p}`, log, opts,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()) }),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const m = await startMockAssist({}, Number(process.env.PORT ?? 8787))
  console.log(`mock ASSIST listening on ${m.url} (Ctrl-C to stop)`)
}
