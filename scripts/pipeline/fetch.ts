/* Pull every raw payload the data set needs. Any failure throws: a partial fetch is never published. */
import type { RawPayload } from '../../src/engine/normalize.ts'
import { parseAcademicYears, pickAcademicYear, type AcademicYear } from './academic-year.ts'
import { FetchError, type AssistClient } from './assist-client.ts'
import type { PipelineConfig } from './config.ts'

export interface RawInstitution { id: number; names: { name: string }[]; isCommunityCollege: boolean; termType: number; [k: string]: unknown }
export interface RawAgreement {
  /** Normalized file name, e.g. "79-mechanical-engineering-b-s.json". */
  file: string
  receivingId: number
  major: string
  /** ASSIST report keys, one per sending college, in payload order. */
  sources: { sendingId: number; key: string }[]
  payloads: RawPayload[]
}
export interface RawBundle {
  fetchedAt: string
  base: string
  academicYear: AcademicYear
  academicYears: unknown
  institutions: RawInstitution[]
  agreements: RawAgreement[]
}

export const slugFile = (receivingId: number, label: string) =>
  `${receivingId}-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '')}.json`

export async function fetchRaw(client: AssistClient, cfg: PipelineConfig, opts: { base: string; now: Date; pinYear?: number; log: (m: string) => void }): Promise<RawBundle> {
  const { log } = opts
  const academicYears = await client.get<unknown>('/api/AcademicYears')
  const academicYear = pickAcademicYear(parseAcademicYears(academicYears), opts.now, opts.pinYear)
  log(`academic year ${academicYear.code} (id ${academicYear.id})`)

  const all = await client.get<RawInstitution[]>('/api/institutions')
  if (!Array.isArray(all)) throw new Error('/api/institutions: expected an array')
  const wanted = [...cfg.universities, ...cfg.colleges]
  const institutions = all.filter((i) => wanted.includes(i?.id))
  const absent = wanted.filter((id) => !institutions.some((i) => i.id === id))
  if (absent.length) throw new Error(`/api/institutions: configured institutions missing from ASSIST: ${absent.join(', ')}`)
  for (const i of institutions) {
    if (!Array.isArray(i.names) || !i.names.length || typeof i.names.at(-1)?.name !== 'string' || typeof i.isCommunityCollege !== 'boolean' || typeof i.termType !== 'number')
      throw new Error(`/api/institutions: unexpected shape for ${i.id}: ${JSON.stringify(i).slice(0, 200)}`)
  }

  const agreements: RawAgreement[] = []
  for (const uc of cfg.universities) {
    const byMajor = new Map<string, RawAgreement>()
    for (const cc of cfg.colleges) {
      const path = `/api/agreements?receivingInstitutionId=${uc}&sendingInstitutionId=${cc}&academicYearId=${academicYear.id}&categoryCode=major`
      // 404 = no agreement between this pair this year (explicit, logged; the diff guard catches a vanished major).
      // Anything else (5xx, timeout, 400 after a session renewal) fails the run: the old fetcher skipped those silently.
      const listing = await client.get<{ reports?: { label: string; key: string }[] }>(path).catch((e: unknown) => {
        if (e instanceof FetchError && e.status === 404) { log(`no agreements ${uc} <- ${cc} (404)`); return { reports: [] } }
        throw e
      })
      if (!listing || !Array.isArray(listing.reports)) throw new Error(`/api/agreements ${uc}<-${cc}: expected { reports: [] }, got ${JSON.stringify(listing).slice(0, 200)}`)
      for (const m of listing.reports.filter((r) => typeof r?.label === 'string' && cfg.majorFilter(r.label))) {
        if (typeof m.key !== 'string' || !m.key) throw new Error(`/api/agreements ${uc}<-${cc}: report "${m.label}" has no key`)
        const p = await client.get<RawPayload>(`/api/articulation/Agreements?key=${m.key}`)
        const r = p?.result
        if (!r || ['templateAssets', 'articulations', 'academicYear', 'sendingInstitution', 'receivingInstitution'].some((f) => typeof (r as Record<string, unknown>)[f] !== 'string'))
          throw new Error(`articulation ${uc}<-${cc} "${m.label}": payload lacks the nested JSON string fields normalize needs`)
        const a = byMajor.get(m.label) ?? { file: slugFile(uc, m.label), receivingId: uc, major: m.label, sources: [], payloads: [] }
        a.sources.push({ sendingId: cc, key: m.key })
        a.payloads.push(p)
        byMajor.set(m.label, a)
        log(`fetched ${uc} <- ${cc} ${m.label}`)
      }
    }
    agreements.push(...byMajor.values())
  }
  const dup = agreements.map((a) => a.file).filter((f, i, all) => all.indexOf(f) !== i)
  if (dup.length) throw new Error(`two majors map to the same file name: ${dup.join(', ')}`)
  if (!agreements.length) throw new Error('no agreements matched the major filter: refusing to publish an empty data set')
  return { fetchedAt: opts.now.toISOString(), base: opts.base, academicYear, academicYears, institutions, agreements }
}
