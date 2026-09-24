/**
 * Fixture access for the independent suite. Reads data/ straight from disk: it does not go through src/data.ts, so a
 * bug in the app's loader cannot hide a bug in the rules.
 */
import { readFileSync } from 'node:fs'
import type { Agreement, Institution } from '../../src/engine/types'

const DATA = new URL('../../data/', import.meta.url)
const json = <T>(rel: string): T => JSON.parse(readFileSync(new URL(rel, DATA), 'utf8')) as T

export interface IndexEntry { file: string; receivingId: number; major: string }
export interface Meta { schema: number; normalizeVersion: number; fetchedAt: string | null; validation: unknown }

export const INDEX = json<IndexEntry[]>('index.json')
export const INSTITUTIONS = json<Institution[]>('institutions.json')
export const META = json<Meta>('meta.json')
export const CCS = INSTITUTIONS.filter((i) => i.isCC).map((i) => i.id)
export const SYS: Record<number, 'quarter' | 'semester'> = Object.fromEntries(INSTITUTIONS.map((i) => [i.id, i.terms]))
export const SHORT: Record<number, string> = Object.fromEntries(INSTITUTIONS.map((i) => [i.id, i.short]))

/**
 * Refetch-dependent scenarios (COUNSELOR_REPORT CRITICAL-1, HIGH-1..3) are enforced only once data/ was rebuilt by
 * a normalize that includes F-01..F-03 (normalizeVersion >= 2, DATA_CONTRACT.md).
 */
export const DATA_REFRESHED = (META.normalizeVersion ?? 1) >= 2

const cache = new Map<string, Agreement>()
/** A fresh parse per file, cached. Callers must not mutate it. */
export const loadAgreement = (file: string): Agreement => {
  let a = cache.get(file)
  if (!a) cache.set(file, (a = json<Agreement>(`agreements/${file}`)))
  return a
}

/* Community colleges by id (data/institutions.json). */
export const DA = 113, FH = 51, SMC = 137, PCC = 49, DVC = 114, IVC = 124, OCC = 74, ECC = 103, BCC = 58, CCSF = 33, SJCC = 136,
  SBCC = 92, SAD = 65, WVC = 80, MIS = 32

export const FILES = {
  bme: '79-mechanical-engineering-b-s.json', beecs: '79-electrical-engineering-computer-sciences-b-s.json', bcs: '79-computer-science-b-a.json',
  lame: '117-mechanical-engineering-b-s.json', laee: '117-electrical-engineering-b-s.json', lacs: '117-computer-science-b-s.json',
  lacse: '117-computer-science-and-engineering-b-s.json', laling: '117-linguistics-and-computer-science-b-a.json',
  sdmae: '7-mae-mechanical-engineering-b-s.json', sdece: '7-ece-electrical-engineering-b-s.json', sdeces: '7-ece-electrical-engineering-and-society-b-a.json',
  sdcse: '7-cse-computer-science-b-s.json', sdmcs: '7-mathematics-computer-science-b-s.json',
  sdbio: '7-cse-computer-science-with-a-specialization-in-bioinformatics-b-s.json',
  ics: '120-computer-science-b-s.json', icse: '120-computer-science-and-engineering-b-s.json', ime: '120-mechanical-engineering-b-s.json',
  iee: '120-electrical-engineering-b-s.json',
  dcs: '89-computer-science-b-s.json', dee: '89-electrical-engineering-b-s.json', dcse: '89-computer-science-engineering-b-s.json',
  dme: '89-mechanical-engineering-b-s.json',
} as const
