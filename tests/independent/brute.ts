/**
 * Independent exact planner: branch and bound over the oracle (no code shared with src/engine/solve.ts).
 *
 * Finds a cheapest set of catalog courses at the allowed colleges whose addition makes the root pass under the
 * oracle. Branching: an unsatisfied mandatory row (reached from the root through required ANDs only) if there is
 * one, else every row the oracle marks as needed. Each move completes one group of that row (honors twins swapped
 * in only at colleges that list a twin). This is complete: any passing plan satisfies some needed row by one of its
 * groups, and that group's missing courses are one of the moves.
 *
 * Objective (weights in the home system's units; the harness converts the quarter-unit weights):
 *  - units mode (weights 0): converted units, exactly the pure-units objective.
 *  - weighted mode: units + college * (distinct non-home colleges of PLANNED courses) + chain * (split subject
 *    chains, see `subjectChains`). Both penalties only grow as courses are added, so the unit lower bound stays
 *    admissible.
 */
import type { Agreement, CourseId, ReqNode, Requirement } from '../../src/engine/types'
import { instOf, isUcOnly, leaves, oracle, twinColleges } from './oracle.ts'

export interface Weights { college: number; chain: number }
export const PURE_UNITS: Weights = { college: 0, chain: 0 }

export interface BruteOptions {
  allowed: number[]
  home?: number
  unitsOf: (c: CourseId) => number
  weights?: Weights
  budget?: number
}
export type BruteResult = { cost: number; units: number; set: CourseId[] } | null | 'budget'

const EPS = 1e-9

/**
 * The planner's documented subject chains (the product spec, README "Solver"), written out again here:
 *  - a row's UC subject is the tokens of its id (up to the first comma) before the first token holding a digit:
 *    "MATH 51" -> MATH, "COM SCI M51A" -> COM SCI, "CHEM 1A, CHEM 1AL" -> CHEM; an empty subject is none;
 *  - a chain is a subject with two or more distinct row ids that have CC groups (any college, allowed or not; rows
 *    anywhere in the tree, optional subtrees included);
 *  - a course belongs to the chain when it, or its honors twin (one trailing H added or removed), is listed in a
 *    group of one of those rows; a course can belong to several chains;
 *  - `took`: the colleges of the taken courses that belong to it.
 */
export interface Chain { subject: string; members: Set<CourseId>; took: Set<number> }
export function subjectChains(a: Agreement, taken: Iterable<CourseId>): Chain[] {
  const subjectOf = (id: string) => {
    const words = id.split(',')[0].trim().split(/\s+/), out: string[] = []
    for (const w of words) { if (/[0-9]/.test(w)) break; out.push(w) }
    return out.join(' ')
  }
  const rows = new Map<string, { ids: Set<string>; members: Set<CourseId> }>()
  for (const r of leaves(a.root)) {
    const sub = subjectOf(r.id)
    if (!sub || !r.groups.length) continue
    if (!rows.has(sub)) rows.set(sub, { ids: new Set(), members: new Set() })
    const e = rows.get(sub)!
    e.ids.add(r.id)
    for (const g of r.groups) for (const c of g.courses) {
      e.members.add(c).add(`${c}H`)
      if (c.endsWith('H')) e.members.add(c.slice(0, -1))
    }
  }
  const T = [...taken]
  return [...rows].filter(([, e]) => e.ids.size >= 2)
    .map(([subject, { members }]) => ({ subject, members, took: new Set(T.filter((c) => members.has(c)).map(instOf)) }))
}

/** The weighted objective of a plan (a set of planned courses). A chain is split when it has a planned course and
 *  its planned courses plus the colleges where it was taken span two or more colleges; taken-only chains cost 0. */
export function planCost(set: Iterable<CourseId>, unitsOf: (c: CourseId) => number, w: Weights, home?: number, chains: Chain[] = []): { cost: number; units: number } {
  const cs = [...set]
  const units = cs.reduce((s, c) => s + unitsOf(c), 0)
  if (!w.college && !w.chain) return { cost: units, units }
  const away = new Set(cs.map(instOf).filter((i) => i !== home)).size
  let split = 0
  for (const ch of chains) {
    const mine = cs.filter((c) => ch.members.has(c))
    if (mine.length && new Set([...ch.took, ...mine.map(instOf)]).size >= 2) split++
  }
  return { cost: units + w.college * away + w.chain * split, units }
}

export function bruteMin(a: Agreement, taken: ReadonlySet<CourseId>, o: BruteOptions): BruteResult {
  const { allowed, home, unitsOf, weights = PURE_UNITS, budget = 200_000 } = o
  const byId = new Map(leaves(a.root).map((r) => [r.id, r]))
  const counted = (n: ReqNode | Requirement) => n.kind === 'req' || n.required
  const mandatory: Requirement[] = []
  const walk = (n: ReqNode | Requirement) => {
    if (n.kind === 'req') { if (!isUcOnly(n)) mandatory.push(n) } else if (n.type === 'AND') n.children.filter(counted).forEach(walk)
  }
  walk(a.root)
  const options = new Map<string, CourseId[][]>()
  for (const r of byId.values()) {
    const tw = twinColleges(r), out = new Map<string, CourseId[]>()
    for (const g of r.groups) {
      if (!allowed.includes(g.institutionId)) continue
      let vs: CourseId[][] = [[]]
      for (const c of g.courses) {
        const alts = [c, ...(tw.has(g.institutionId) ? [c.endsWith('H') ? c.slice(0, -1) : `${c}H`] : [])].filter((x) => a.catalog[x])
        vs = vs.flatMap((v) => alts.map((x) => [...v, x]))
      }
      for (const v of vs) { const s = [...new Set(v)].sort(); out.set(s.join('+'), s) }
    }
    options.set(r.id, [...out.values()])
  }
  const units = (cs: Iterable<CourseId>) => [...cs].reduce((s, c) => s + unitsOf(c), 0)
  const chains = weights.chain ? subjectChains(a, taken) : []
  let best: { cost: number; units: number; set: CourseId[] } | null = null
  let nodes = 0, blown = false
  const seen = new Set<string>()
  const dfs = (add: Set<CourseId>) => {
    if (blown || ++nodes > budget) { blown = true; return }
    const key = [...add].sort().join('|')
    if (seen.has(key)) return
    seen.add(key)
    const have = new Set([...taken, ...add])
    const res = oracle(a, have)
    const here = planCost(add, unitsOf, weights, home, chains)
    if (res.rootPass) {
      if (!best || here.cost < best.cost - EPS) best = { ...here, set: [...add].sort() }
      return
    }
    const open = mandatory.filter((r) => !res.rows.get(r.id)?.sat)
    // admissible bound: mandatory rows whose remaining course pools are disjoint each cost at least their cheapest move
    let lb = 0
    const used = new Set<CourseId>()
    for (const r of open) {
      const moves = options.get(r.id)!.map((s) => s.filter((c) => !have.has(c)))
      if (!moves.length) return // this row cannot be completed at the allowed colleges
      const pool = new Set(moves.flat())
      if ([...pool].some((c) => used.has(c))) continue
      pool.forEach((c) => used.add(c))
      lb += Math.min(...moves.map(units))
    }
    if (best && here.cost + lb > best.cost - EPS) return
    const branch = open.length ? [open[0]] : [...res.needed].map((id) => byId.get(id)!).filter((r) => r.groups.length)
    const moves: CourseId[][] = []
    for (const r of branch) for (const s of options.get(r.id)!) {
      const m = s.filter((c) => !have.has(c))
      if (m.length) moves.push(m)
    }
    moves.sort((x, y) => units(x) - units(y) || x.join().localeCompare(y.join()))
    for (const m of moves) dfs(new Set([...add, ...m]))
  }
  dfs(new Set())
  return blown ? 'budget' : best
}

/** Can the root pass at all at these colleges? (Take every catalog course they offer.) */
export const feasible = (a: Agreement, taken: ReadonlySet<CourseId>, allowed: number[]) =>
  oracle(a, new Set([...taken, ...Object.keys(a.catalog).filter((c) => allowed.includes(instOf(c)))])).rootPass
