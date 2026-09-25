/* Pull every raw payload the data set needs. Any failure throws: a partial fetch is never published. */
import type { RawPayload } from '../../src/engine/normalize.ts'
import { candidateYears, codeInEffect, parseAcademicYears, type AcademicYear } from './academic-year.ts'
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
  /** The academic year in effect when fetched ("2026-2027"). Absent in raw stores written before M-6. */
  yearInEffect?: string
  /** True when ASSIST had not published `yearInEffect` for the configured pairs, so the prior year was fetched. */
  carriedOver?: boolean
  academicYears: unknown
  institutions: RawInstitution[]
  agreements: RawAgreement[]
}

/** What a payload must be for: the request that fetched it (C-2). */
export interface PayloadIdentity { sendingId: number; receivingId: number; academicYear: { id: number; code: string }; major: string }

/** A payload that is not for the college / UC / year / major that was requested. Never stored or published. */
export class PayloadIdentityError extends FetchError {
  readonly mismatches: string[]
  constructor(mismatches: string[]) {
    super(`${mismatches.length} ASSIST payload(s) do not match their request (identity mismatch, nothing published):\n  ${mismatches.join('\n  ')}`, '/api/articulation/Agreements', undefined, true)
    this.mismatches = mismatches
  }
}

/**
 * Compare a payload's own identity (the JSON-in-JSON sendingInstitution, receivingInstitution, academicYear and the
 * report name) with what was requested. Returns one message per mismatch; empty means the payload is what we asked for.
 */
export function payloadIdentityErrors(p: RawPayload, want: PayloadIdentity): string[] {
  const r = p?.result as Record<string, unknown> | undefined
  const obj = (f: string): Record<string, unknown> | undefined => {
    try { const v = JSON.parse(String(r?.[f])); return v && typeof v === 'object' ? v : undefined } catch { return undefined }
  }
  const errs: string[] = []
  const snd = obj('sendingInstitution'), rcv = obj('receivingInstitution'), yr = obj('academicYear')
  if (snd?.id !== want.sendingId) errs.push(`sendingInstitution ${String(snd?.id)} (requested ${want.sendingId})`)
  if (rcv?.id !== want.receivingId) errs.push(`receivingInstitution ${String(rcv?.id)} (requested ${want.receivingId})`)
  if (yr?.code !== want.academicYear.code || (yr?.id !== undefined && yr.id !== want.academicYear.id))
    errs.push(`academicYear ${String(yr?.id)}/${String(yr?.code)} (requested ${want.academicYear.id}/${want.academicYear.code})`)
  if (r?.name !== want.major) errs.push(`name "${String(r?.name)}" (requested report "${want.major}")`)
  return errs
}

export const slugFile = (receivingId: number, label: string) =>
  `${receivingId}-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '')}.json`

export async function fetchRaw(client: AssistClient, cfg: PipelineConfig, opts: { base: string; now: Date; pinYear?: number; log: (m: string) => void }): Promise<RawBundle> {
  const { log } = opts
  const academicYears = await client.get<unknown>('/api/AcademicYears')
  const yearInEffect = codeInEffect(opts.now) // first: an unknown date fails with a clear message
  const candidates = candidateYears(parseAcademicYears(academicYears), opts.now, opts.pinYear)

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

  const fetchYear = async (academicYear: AcademicYear): Promise<RawAgreement[]> => {
    const agreements: RawAgreement[] = []
    const mismatches: string[] = []
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
        // L2: one report per major per college. An exact repeat (same label and key) is dropped with a log line; the
        // same label under a different key is ambiguous (which one is the agreement?), so the fetch fails.
        const keyOf = new Map<string, string>()
        for (const m of listing.reports.filter((r) => typeof r?.label === 'string' && cfg.majorFilter(r.label))) {
          if (typeof m.key !== 'string' || !m.key) throw new Error(`/api/agreements ${uc}<-${cc}: report "${m.label}" has no key`)
          const seenKey = keyOf.get(m.label)
          if (seenKey !== undefined) {
            if (seenKey !== m.key) throw new Error(`/api/agreements ${uc}<-${cc}: report "${m.label}" listed twice with different keys (${seenKey}, ${m.key}); refusing to guess which is the agreement`)
            log(`duplicate listing entry ignored: ${uc} <- ${cc} ${m.label} (key ${m.key})`)
            continue
          }
          keyOf.set(m.label, m.key)
          const p = await client.get<RawPayload>(`/api/articulation/Agreements?key=${m.key}`)
          const r = p?.result
          if (!r || ['templateAssets', 'articulations', 'academicYear', 'sendingInstitution', 'receivingInstitution'].some((f) => typeof (r as Record<string, unknown>)[f] !== 'string'))
            throw new Error(`articulation ${uc}<-${cc} "${m.label}": payload lacks the nested JSON string fields normalize needs`)
          // C-2: the payload must be for the college, UC, year and major we asked for. A mismatch is a fetch error:
          // keep going to report every one, then fail the run (a mismatched payload is never stored or published).
          const bad = payloadIdentityErrors(p, { sendingId: cc, receivingId: uc, academicYear, major: m.label })
          if (bad.length) {
            client.stats.identityMismatches = (client.stats.identityMismatches ?? 0) + 1
            mismatches.push(`${uc} <- ${cc} "${m.label}" (key ${m.key}): ${bad.join('; ')}`)
            log(`REJECTED ${uc} <- ${cc} ${m.label}: payload identity mismatch: ${bad.join('; ')}`)
            continue
          }
          const a = byMajor.get(m.label) ?? { file: slugFile(uc, m.label), receivingId: uc, major: m.label, sources: [], payloads: [] }
          a.sources.push({ sendingId: cc, key: m.key })
          a.payloads.push(p)
          byMajor.set(m.label, a)
          log(`fetched ${uc} <- ${cc} ${m.label}`)
        }
      }
      agreements.push(...byMajor.values())
    }
    if (mismatches.length) throw new PayloadIdentityError(mismatches)
    return agreements
  }

  // M-6: the newest year with published agreements for the configured pairs; the year in effect first. A year ASSIST
  // lists but has published nothing for (all 404 / no matching reports) is skipped, and the carry-over is explicit.
  let academicYear = candidates[0]
  let agreements: RawAgreement[] = []
  for (const y of candidates) {
    academicYear = y
    log(`academic year ${y.code} (id ${y.id})${y.code === yearInEffect ? '' : `: carried over, ${yearInEffect} agreements are not published yet`}`)
    agreements = await fetchYear(y)
    if (agreements.length) break
    log(`no agreements published for ${y.code} matched the major filter`)
  }
  const carriedOver = academicYear.code !== yearInEffect
  const dup = agreements.map((a) => a.file).filter((f, i, all) => all.indexOf(f) !== i)
  if (dup.length) throw new Error(`two majors map to the same file name: ${dup.join(', ')}`)
  if (!agreements.length) throw new Error('no agreements matched the major filter: refusing to publish an empty data set')
  return { fetchedAt: opts.now.toISOString(), base: opts.base, academicYear, yearInEffect, carriedOver, academicYears, institutions, agreements }
}
