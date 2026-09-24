/**
 * Seeded randomness and synthetic agreements: nested AND / OR / N_OF, optional subtrees, UC-only rows (explicit
 * ASSIST reason), unrecorded rows (placeholder only), honors twins, shared courses and repeated requirement ids.
 * Independent of src/ (types only).
 */
import type { Agreement, Course, CourseId, ReqNode, Requirement } from '../../src/engine/types'

/** mulberry32: small, fast, reproducible. */
export function rng(seed: number) {
  let s = seed | 0
  const next = () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (n: number) => Math.floor(next() * n)
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)]
  const shuffle = <T>(xs: readonly T[]): T[] => {
    const a = [...xs]
    for (let i = a.length - 1; i > 0; i--) { const j = int(i + 1); [a[i], a[j]] = [a[j], a[i]] }
    return a
  }
  return { next, int, pick, shuffle }
}
export type Rng = ReturnType<typeof rng>

export const UC_REASONS = ['No Course Articulated', 'This course must be taken at the university after transfer']
export const NO_RECORD = 'No articulation listed'

export interface SynthOptions {
  /** children inherit their parent's `required` flag, as normalize produces (realistic); else random per node */
  inherit?: boolean
  ucOnly?: number      // share of rows that are UC-only
  noRecord?: number    // share of rows with no ASSIST record
  maxDepth?: number
  colleges?: number    // up to this many sending colleges (ids 1..k)
  /**
   * Allow the shapes behind the latent planner findings (COUNSELOR_REPORT MED-1, MED-2, LOW-2): a choice that mixes
   * unrecorded and UC-only alternatives, UC-only rows inside a choice's AND alternatives, and n >= 2. Off: the
   * realistic generator keeps choices to the shapes normalize can produce today plus a plain N_OF(n).
   */
  latentShapes?: boolean
}

export function randomAgreement(r: Rng, o: SynthOptions = {}): Agreement {
  const { inherit = false, ucOnly = 0.1, noRecord = 0.08, maxDepth = 2, colleges: maxCol = 3, latentShapes = true } = o
  const colleges = [1, 2, 3, 4].slice(0, 1 + r.int(maxCol))
  const nCourses = 3 + r.int(6)
  const catalog: Record<CourseId, Course> = {}
  for (const col of colleges) for (let i = 0; i < nCourses; i++) {
    const id = `${col}:C ${i}`
    catalog[id] = { id, institutionId: col, prefix: 'C', number: String(i), title: `Course ${i}`, units: 1 + r.int(5) }
    if (r.next() < 0.3) catalog[`${id}H`] = { ...catalog[id], id: `${id}H`, number: `${i}H` }
  }
  let rid = 0
  const made: Requirement[] = []
  type Kind = 'cc' | 'uc' | 'none'
  const leaf = (allow: Set<Kind>): Requirement => {
    const reuse = made.filter((x) => allow.has(kindOf(x)))
    if (reuse.length && r.next() < 0.12) return r.pick(reuse) // the same row listed twice (Berkeley ME chemistry)
    const req: Requirement = { kind: 'req', id: `R${rid++}`, label: 'r', units: 3, groups: [] }
    const x = r.next()
    if (x < ucOnly && allow.has('uc')) req.noArticulation = { 1: r.pick(UC_REASONS) }
    else if (x >= ucOnly && x < ucOnly + noRecord && allow.has('none')) req.noArticulation = { 1: NO_RECORD, 2: NO_RECORD }
    else {
      for (let g = 1 + r.int(3); g > 0; g--) {
        const col = r.pick(colleges)
        const cs = [...new Set(Array.from({ length: 1 + r.int(3) }, () => `${col}:C ${r.int(nCourses)}`))].sort()
        req.groups.push({ institutionId: col, courses: cs })
        if (r.next() < 0.3) { // honors twin group at the same college
          const tw = cs.map((c) => (r.next() < 0.6 && catalog[`${c}H`] ? `${c}H` : c))
          if (tw.join() !== cs.join()) req.groups.push({ institutionId: col, courses: tw })
        }
      }
      const seen = new Set<string>()
      req.groups = req.groups.filter((g) => { const k = `${g.institutionId}|${g.courses.join('+')}`; return !seen.has(k) && !!seen.add(k) })
      if (r.next() < 0.1) req.noArticulation = { 3: 'No Course Articulated' } // a reason at one college, groups elsewhere
    }
    made.push(req)
    return req
  }
  const all = new Set<Kind>(['cc', 'uc', 'none'])
  /** A leaf (35%, or past maxDepth) or a node whose children are drawn the same way. */
  const child = (d: number, parentRequired: boolean, leafAllow: Set<Kind>, nodeAllow: Set<Kind>, inChoice: boolean) =>
    d > maxDepth || r.next() < 0.35 ? leaf(leafAllow) : node(d, parentRequired, nodeAllow, inChoice)
  const node = (d: number, parentRequired: boolean, allow: Set<Kind>, inChoice: boolean): ReqNode => {
    const type = r.pick(['AND', 'AND', 'OR', 'N_OF'] as const)
    const k = 1 + r.int(4)
    const required = inherit ? (d === 0 ? r.next() < 0.85 : parentRequired) : r.next() < 0.85
    // Realistic shapes: a choice holds UC-only rows only as direct children (UC Davis CHE 002AH/BH), never below a
    // nested node, and never together with unrecorded rows anywhere in its subtree.
    let leafAllow = allow, nodeAllow = allow
    if (!latentShapes && type !== 'AND') {
      const mode: Kind = allow.has('uc') && allow.has('none') ? (r.next() < 0.5 ? 'uc' : 'none') : allow.has('uc') ? 'uc' : 'none'
      leafAllow = new Set<Kind>(['cc', ...(allow.has(mode) ? [mode] : [])])
      nodeAllow = new Set<Kind>(['cc', ...(mode === 'none' && allow.has('none') ? ['none' as const] : [])])
    } else if (!latentShapes && inChoice) leafAllow = nodeAllow = new Set([...allow].filter((x) => x !== 'uc'))
    const children = Array.from({ length: k }, () => child(d + 1, required, leafAllow, nodeAllow, inChoice || type !== 'AND'))
    const n = type === 'N_OF' ? 1 + r.int(Math.max(1, k + (r.next() < 0.1 ? 1 : 0))) : undefined
    return { kind: 'node', type, n, required, children }
  }
  const root: ReqNode = { kind: 'node', type: 'AND', required: true, children: Array.from({ length: 1 + r.int(4) }, () => child(0, true, all, all, false)) }
  return { receivingId: 1, major: 'synthetic', year: 'x', sendingIds: colleges, root, catalog }
}

const kindOf = (x: Requirement) =>
  x.groups.length ? 'cc' : Object.values(x.noArticulation ?? {}).some((w) => w !== NO_RECORD) ? 'uc' : 'none'
