/* Raw payload store (gzip under data/raw) and the raw -> data/ build shared by fetch and renormalize. */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { normalize, templateMismatches } from '../../src/engine/normalize.ts'
import type { Agreement, Institution } from '../../src/engine/types.ts'
import type { PipelineConfig } from './config.ts'
import type { RawAgreement, RawBundle, RawInstitution } from './fetch.ts'

export interface IndexEntry { file: string; receivingId: number; major: string }
export interface RawManifest {
  schema: 1
  fetchedAt: string
  base: string
  academicYear: RawBundle['academicYear']
  yearInEffect?: string
  carriedOver?: boolean
  academicYears: unknown
  institutions: string
  agreements: { file: string; receivingId: number; major: string; sources: RawAgreement['sources']; raw: string; sha256: string; bytes: number }[]
}
export interface Built {
  institutions: Institution[]
  index: IndexEntry[]
  agreements: Map<string, Agreement>
  /** normalize() warnings per agreement file (template drift, optional additions, orphans). */
  notes: Record<string, string[]>
  /** Sending colleges whose template differs from the first payload's, per agreement file. */
  templateMismatches: Record<string, number[]>
}

// Deterministic gzip (Node writes mtime 0), so an unchanged payload gives an unchanged file and no git churn.
const gz = (v: unknown) => gzipSync(Buffer.from(JSON.stringify(v)), { level: 9 })
const ungz = <T>(path: string): T => JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')) as T
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

export function writeRaw(dataDir: string, bundle: RawBundle, cfg: PipelineConfig): { totalBytes: number } {
  const dir = join(dataDir, cfg.raw.dir)
  mkdirSync(join(dir, 'agreements'), { recursive: true })
  const inst = gz(bundle.institutions)
  writeFileSync(join(dir, 'institutions.json.gz'), inst)
  let total = inst.length
  const agreements: RawManifest['agreements'] = []
  for (const a of bundle.agreements) {
    const buf = gz(a.payloads), raw = `agreements/${a.file}.gz`
    if (buf.length > cfg.raw.maxFileBytes) throw new Error(`raw ${raw} is ${buf.length} bytes (> raw.maxFileBytes ${cfg.raw.maxFileBytes}); move raw storage to a workflow artifact`)
    writeFileSync(join(dir, raw), buf)
    total += buf.length
    agreements.push({ file: a.file, receivingId: a.receivingId, major: a.major, sources: a.sources, raw, sha256: sha(buf), bytes: buf.length })
  }
  if (total > cfg.raw.maxTotalBytes) throw new Error(`raw store is ${total} bytes (> raw.maxTotalBytes ${cfg.raw.maxTotalBytes}); move raw storage to a workflow artifact`)
  const manifest: RawManifest = { schema: 1, fetchedAt: bundle.fetchedAt, base: bundle.base, academicYear: bundle.academicYear, yearInEffect: bundle.yearInEffect, carriedOver: bundle.carriedOver, academicYears: bundle.academicYears, institutions: 'institutions.json.gz', agreements }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n')
  return { totalBytes: total }
}

export const hasRaw = (dataDir: string, cfg: PipelineConfig) => existsSync(join(dataDir, cfg.raw.dir, 'manifest.json'))

/** Read the raw store back, verifying every file against the manifest checksum. */
export function readRaw(dataDir: string, cfg: PipelineConfig): RawBundle {
  const dir = join(dataDir, cfg.raw.dir)
  if (!hasRaw(dataDir, cfg)) throw new Error(`no raw payloads at ${dir} (the data predates the raw store): run \`npm run fetch\` once`)
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as RawManifest
  if (m.schema !== 1 || !Array.isArray(m.agreements)) throw new Error(`${dir}/manifest.json: unknown schema`)
  const agreements = m.agreements.map((a): RawAgreement => {
    const path = join(dir, a.raw)
    if (!existsSync(path)) throw new Error(`raw store: ${a.raw} listed in manifest but missing`)
    if (sha(readFileSync(path)) !== a.sha256) throw new Error(`raw store: ${a.raw} does not match its manifest checksum`)
    return { file: a.file, receivingId: a.receivingId, major: a.major, sources: a.sources, payloads: ungz(path) }
  })
  return { fetchedAt: m.fetchedAt, base: m.base, academicYear: m.academicYear, yearInEffect: m.yearInEffect, carriedOver: m.carriedOver, academicYears: m.academicYears, institutions: ungz<RawInstitution[]>(join(dir, m.institutions)), agreements }
}

export const rawBytes = (dataDir: string, cfg: PipelineConfig) => {
  const dir = join(dataDir, cfg.raw.dir)
  if (!existsSync(dir)) return 0
  const walk = (d: string): number => readdirSync(d).reduce((t, f) => { const p = join(d, f), s = statSync(p); return t + (s.isDirectory() ? walk(p) : s.size) }, 0)
  return walk(dir)
}

const shortName = (cfg: PipelineConfig, id: number, name: string) =>
  cfg.shortNames[id] ?? name.replace(/^City College of /, '').replace(/ (Community )?College$/, '')

/** Normalize a raw bundle. Throws if any agreement fails to normalize (no silent skips). */
export function build(bundle: RawBundle, cfg: PipelineConfig): Built {
  const institutions: Institution[] = bundle.institutions
    .filter((i) => cfg.universities.includes(i.id) || cfg.colleges.includes(i.id))
    .map((i) => ({ id: i.id, name: i.names.at(-1)!.name, short: shortName(cfg, i.id, i.names.at(-1)!.name), isCC: i.isCommunityCollege, terms: i.termType === 1 ? 'quarter' : 'semester' }))
  const index: IndexEntry[] = [], agreements = new Map<string, Agreement>(), notes: Built['notes'] = {}, mismatches: Built['templateMismatches'] = {}
  for (const a of bundle.agreements) {
    const warn = console.warn, got: string[] = []
    console.warn = (...m: unknown[]) => { got.push(m.map(String).join(' ')) }
    try {
      agreements.set(a.file, normalize(a.payloads))
      mismatches[a.file] = templateMismatches(a.payloads)
    } catch (e) {
      throw new Error(`normalize failed for ${a.file} (${a.major}): ${(e as Error).message}`)
    } finally { console.warn = warn }
    if (got.length) notes[a.file] = got
    index.push({ file: a.file, receivingId: a.receivingId, major: a.major })
  }
  return { institutions, index, agreements, notes, templateMismatches: mismatches }
}

/** Write the normalized files in the format the app imports (same indentation as the original fetcher). */
export function writeBuilt(dataDir: string, built: Built) {
  mkdirSync(join(dataDir, 'agreements'), { recursive: true })
  writeFileSync(join(dataDir, 'institutions.json'), JSON.stringify(built.institutions, null, 2))
  writeFileSync(join(dataDir, 'index.json'), JSON.stringify(built.index, null, 2))
  for (const [file, a] of built.agreements) writeFileSync(join(dataDir, 'agreements', file), JSON.stringify(a, null, 1))
}
