import type { Agreement, Institution } from './engine/types'
import institutionsJson from '../data/institutions.json'
import indexJson from '../data/index.json'
import berkeleyME from '../data/agreements/79-mechanical-engineering-b-s.json'
import metaJson from '../data/meta.json'
import { useSyncExternalStore } from 'react'
import { dataTrust, sameTrust, type DataTrust } from './data-trust'
import { NORMALIZE_VERSION } from './engine/normalize'

export interface IndexEntry { file: string; receivingId: number; major: string }

// Berkeley ME is already in the main bundle (imported eagerly below), so keep it out of the lazy glob.
// Every other agreement is emitted as a plain JSON asset and fetched on demand. It is deliberately not a module
// import(): Chromium caches a failed dynamic import in its module map, so after a network blip "Try again" would
// replay the error until a page reload. A fetch() has no such memory, so a retry really goes back to the network.
const TRAP = '../data/agreements/79-mechanical-engineering-b-s.json'
const urls = import.meta.glob<string>(['../data/agreements/*.json', '!../data/agreements/79-mechanical-engineering-b-s.json'],
  { query: '?url', import: 'default', eager: true })
async function fetchAgreement(url: string, file: string): Promise<{ default: Agreement }> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`Agreement file ${file} failed to load (HTTP ${r.status})`)
  return { default: (await r.json()) as Agreement }
}
const files: Record<string, () => Promise<{ default: Agreement }>> = {
  ...Object.fromEntries(Object.entries(urls).map(([k, url]) => [k, () => fetchAgreement(url, k.split('/').pop()!)])),
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
/**
 * Memoises an async loader per key. A successful load stays cached; a rejected one evicts itself, so the next call
 * (e.g. the error boundary's "Try again") really calls the loader again instead of replaying the cached failure.
 */
export function memoizeLoader<K, V>(load: (key: K) => Promise<V>): (key: K) => Promise<V> {
  const cache = new Map<K, Promise<V>>()
  return (key) => {
    const hit = cache.get(key)
    if (hit) return hit
    let p: Promise<V>
    try { p = load(key) } catch (e) { p = Promise.reject(e) }
    cache.set(key, p)
    // evict only this attempt's promise, never a newer one started after it
    p.catch(() => { if (cache.get(key) === p) cache.delete(key) })
    return p
  }
}

/** Loads one agreement and records its academic year, so trust is re-checked against the agreements actually shown.
 *  A missing file rejects instead of throwing synchronously (TESTER2_REPORT M-8). Successful loads are cached; a
 *  failed one is dropped from the cache so "Try again" re-requests it: the loader is a fetch() of the agreement's
 *  JSON asset, which the browser re-issues on every call (unlike a failed dynamic import(), which Chromium replays
 *  from its module map until reload). */
export const loadAgreement: (file: string) => Promise<Agreement> = memoizeLoader((file: string) => {
  const get = files[`../data/agreements/${file}`]
  if (!get) return Promise.reject(new Error(`Agreement file ${file} is not bundled`))
  return get().then((m) => { noteAgreementYear(m.default?.year); return m.default })
})

// eager sync export for Trap.tsx, which only needs Berkeley ME
export const agreements: Agreement[] = [berkeleyME as unknown as Agreement]

/** data/meta.json as bundled (DATA_CONTRACT.md). */
export const meta: unknown = metaJson
/** How far verdicts can be trusted, evaluated in the browser with the viewer's current date, so a build that was fresh
 *  when deployed still turns amber, then untrusted, as it ages. meta.agreements must match the bundled index. */
/** The `year` of every agreement loaded so far (Berkeley ME is bundled eagerly); each must match meta.academicYear. */
const loadedYears: unknown[] = [(berkeleyME as { year?: unknown }).year]
export const trustAt = (now: Date): DataTrust => dataTrust(meta, now, NORMALIZE_VERSION, index.length, loadedYears)

// A tab left open for days must downgrade too: re-check every minute and whenever the tab becomes visible again.
const RECHECK_MS = 60_000
let current = trustAt(new Date())
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | undefined

/** The trust state right now (a stable object until it changes). */
export const getTrust = () => current

/** Re-evaluate with the current clock; notifies subscribers only when the level, reasons or dates changed. */
export function refreshTrust(now = new Date()) {
  const next = trustAt(now)
  if (sameTrust(next, current)) return
  current = next
  for (const l of listeners) l()
}

function noteAgreementYear(year: unknown) {
  if (loadedYears.includes(year)) return
  loadedYears.push(year)
  refreshTrust()
}

const onVisible = () => { if (document.visibilityState === 'visible') refreshTrust() }

export function subscribeTrust(listener: () => void) {
  listeners.add(listener)
  if (listeners.size === 1 && typeof window !== 'undefined') {
    timer = setInterval(() => refreshTrust(), RECHECK_MS)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && typeof window !== 'undefined') {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }
}

/** React hook: the current trust state, re-rendering when it changes. */
export const useTrust = () => useSyncExternalStore(subscribeTrust, getTrust, getTrust)
