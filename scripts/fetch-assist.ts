/* One-shot: pull real ASSIST articulation for the demo pairs and write normalized fixtures. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { normalize, type RawPayload } from '../src/engine/normalize.ts'

const BASE = 'https://assist.org'
const YEAR = 76 // 2025-2026
const UCS = [79, 117, 7, 120, 89] // Berkeley, UCLA, UCSD, Irvine, Davis
// De Anza, Foothill, Santa Monica, Pasadena City, Diablo Valley, Irvine Valley, Orange Coast, El Camino,
// Berkeley City, City College of SF, San Jose City, Santa Barbara City, Saddleback, West Valley, Mission
const CCS = [113, 51, 137, 49, 114, 124, 74, 103, 58, 33, 136, 92, 65, 80, 32]
const MAJORS = (l: string) => /Computer Science|Electrical Engineering|Mechanical Engineering/.test(l) && /B\.[AS]\./.test(l) && !/Minor/.test(l)

// ASSIST returns 400 without the antiforgery cookie pair + header. Rate limits are per session, so on 429 we start a new one.
const session = async () => {
  const home = await fetch(BASE)
  const cookies = home.headers.getSetCookie().map((c) => c.split(';')[0])
  const xsrf = cookies.find((c) => c.startsWith('X-XSRF-TOKEN='))!.split('=')[1]
  return { Cookie: cookies.join('; '), 'X-XSRF-TOKEN': xsrf, Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' }
}
let headers = await session()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const get = async <T>(path: string, attempt = 0): Promise<T> => {
  const r = await fetch(BASE + path, { headers })
  if (r.status === 429 && attempt < 5) { await sleep(1500); headers = await session(); return get(path, attempt + 1) }
  if (!r.ok) throw new Error(`${r.status} ${path}`)
  await sleep(200)
  return r.json() as Promise<T>
}

mkdirSync('data/agreements', { recursive: true })

const inst = await get<{ id: number; names: { name: string }[]; isCommunityCollege: boolean; termType: number }[]>('/api/institutions')
const SHORT: Record<number, string> = { 79: 'UC Berkeley', 117: 'UCLA', 7: 'UC San Diego', 120: 'UC Irvine', 89: 'UC Davis', 33: 'CCSF' }
const short = (id: number, name: string) => SHORT[id] ?? name.replace(/^City College of /, '').replace(/ (Community )?College$/, '')
writeFileSync('data/institutions.json', JSON.stringify(
  inst.filter((i) => UCS.includes(i.id) || CCS.includes(i.id))
    .map((i) => ({ id: i.id, name: i.names.at(-1)!.name, short: short(i.id, i.names.at(-1)!.name), isCC: i.isCommunityCollege, terms: i.termType === 1 ? 'quarter' : 'semester' })), null, 2))

const index: { file: string; receivingId: number; major: string }[] = []
for (const uc of UCS) {
  // key -> label, discovered per CC; group payloads by major label
  const byMajor = new Map<string, RawPayload[]>()
  for (const cc of CCS) {
    const { reports } = await get<{ reports: { label: string; key: string }[] }>(
      `/api/agreements?receivingInstitutionId=${uc}&sendingInstitutionId=${cc}&academicYearId=${YEAR}&categoryCode=major`).catch(() => ({ reports: [] }))
    for (const m of reports.filter((r) => MAJORS(r.label))) {
      try {
        const p = await get<RawPayload>(`/api/articulation/Agreements?key=${m.key}`)
        byMajor.set(m.label, [...(byMajor.get(m.label) ?? []), p])
        console.log('fetched', SHORT[uc], '<-', SHORT[cc], m.label)
      } catch (e) { console.error('skip', SHORT[uc], '<-', SHORT[cc], m.label, String(e)) }
    }
  }
  for (const [label, payloads] of byMajor) {
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '')
    const file = `${uc}-${slug}.json`
    try {
      writeFileSync(`data/agreements/${file}`, JSON.stringify(normalize(payloads), null, 1))
      index.push({ file, receivingId: uc, major: label })
    } catch (e) { console.error('skip normalize', SHORT[uc], label, String(e)) }
  }
}
writeFileSync('data/index.json', JSON.stringify(index, null, 2))
console.log('wrote', index.length, 'agreements')
