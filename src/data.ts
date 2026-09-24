import type { Agreement, Institution } from './engine/types'
import institutionsJson from '../data/institutions.json'
import indexJson from '../data/index.json'
import berkeleyME from '../data/agreements/79-mechanical-engineering-b-s.json'
import metaJson from '../data/meta.json'
import { dataTrust } from './data-trust'

export interface IndexEntry { file: string; receivingId: number; major: string }

// Berkeley ME is already in the main bundle (imported eagerly below), so keep it out of the lazy glob.
const TRAP = '../data/agreements/79-mechanical-engineering-b-s.json'
const files: Record<string, () => Promise<{ default: Agreement }>> = {
  ...import.meta.glob<{ default: Agreement }>(['../data/agreements/*.json', '!../data/agreements/79-mechanical-engineering-b-s.json']),
  [TRAP]: async () => ({ default: berkeleyME as unknown as Agreement }),
}

export const institutions = institutionsJson as Institution[]
export const byId = Object.fromEntries(institutions.map((i) => [i.id, i])) as Record<number, Institution>
export const colleges = institutions.filter((i) => i.isCC).sort((a, b) => a.name.localeCompare(b.name))
export const unitSystems = Object.fromEntries(institutions.map((i) => [i.id, i.terms])) as Record<number, 'quarter' | 'semester'>

export const index = indexJson as IndexEntry[]
// Only universities that actually have at least one fetched agreement; Berkeley first for the demo.
export const universities = institutions
  .filter((i) => !i.isCC && index.some((e) => e.receivingId === i.id))
  .sort((a, b) => (a.id === 79 ? -1 : b.id === 79 ? 1 : a.name.localeCompare(b.name)))
export const majorsFor = (receivingId: number) => index.filter((e) => e.receivingId === receivingId)
export const loadAgreement = (file: string): Promise<Agreement> => files[`../data/agreements/${file}`]().then((m) => m.default)

// eager sync export for Trap.tsx, which only needs Berkeley ME
export const agreements: Agreement[] = [berkeleyME as unknown as Agreement]

/** data/meta.json as bundled (DATA_CONTRACT.md). */
export const meta: unknown = metaJson
/** How far verdicts can be trusted. Evaluated when the page loads in the browser, with the viewer's current date, so a
 *  build that was fresh when deployed still turns amber, then untrusted, as it ages. */
export const trust = dataTrust(meta, new Date())
