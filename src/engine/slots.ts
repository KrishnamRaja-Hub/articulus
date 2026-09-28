/**
 * One course, one slot (TESTER r6 M-4). In a "choose N of" group each chosen child fills one slot, and the courses a
 * child uses to be met are spent on that slot: no other slot of the same group may use them again.
 *
 * A child's "ways" are the alternative sets of ids it would spend: the taken course ids of one satisfied group per row
 * in it, plus one token per row (rowToken, UC-only rows included), so a row listed twice in a group still fills only
 * one slot. Which children can fill slots together is an exact assignment problem: a bipartite matching when every
 * clash is a single id, a small exact search otherwise. Nothing here is greedy, so a valid assignment is never missed.
 *
 * Every search here is bounded (a work budget, `bounded`). Past it the search stops, and the caller reads the result
 * so it can only fail closed: fewer slots filled, fewer ways, never a group met that is not.
 */

export type Way = readonly string[]
export type Ways = readonly Way[]

/** Stands for a row in a way: the same row filling two slots is a clash like a shared course. Course ids ("113:MATH 1A")
 *  never start with this character. */
export const rowToken = (id: string) => `\u0001${id}`
export const isRowToken = (x: string) => x.charCodeAt(0) === 1

/** A child that consumes nothing (nothing is tracked). */
export const NOTHING: Ways = [[]]

/** Most alternative ways kept per subtree; past it the extra ways are dropped (fail closed). */
export const WAYS_CAP = 256

/* ---- the work budget ---- */

let work = 0, limit = Infinity, cutFlag = false
/** Run `fn` with a work budget of its own (the caller's budget is untouched); `cut`: the budget ran out. */
export function bounded<T>(max: number, fn: () => T): { value: T; cut: boolean } {
  const saved = { work, limit, cutFlag }
  work = 0; limit = max; cutFlag = false
  try {
    const value = fn()
    return { value, cut: cutFlag }
  } finally { ({ work, limit, cutFlag } = saved) }
}
/** Count `n` units of work; true once the budget is spent. */
const spend = (n = 1): boolean => {
  work += n
  if (work > limit) cutFlag = true
  return cutFlag
}
/** Whether the budget of the current `bounded` run is spent. */
export const outOfWork = () => cutFlag

const SEP = '\u0002'
const keyOf = (w: Way) => w.join(SEP)
const tokensKey = (s: readonly string[]) => s.filter(isRowToken).join(SEP)

/**
 * Minimal ways only, deduplicated, sorted, capped. A way spending a superset of another is never needed, except, with
 * `heavy` (under a units group, where a row adds units), when it holds more rows: then it is kept.
 */
export function minimal(ways: Iterable<Way>, heavy = false): string[][] {
  const list = Array.isArray(ways) ? (ways as Way[]) : [...ways]
  if (list.length <= 1) return list.map((w) => [...new Set(w)].sort())
  const uniq = new Map<string, string[]>()
  for (const w of list) { const s = [...new Set(w)].sort(); uniq.set(keyOf(s), s) }
  spend(uniq.size)
  const sorted = [...uniq.entries()].sort(([x, a], [y, b]) => a.length - b.length || (x < y ? -1 : x > y ? 1 : 0)).map(([, s]) => s)
  const out: string[][] = [], toks: string[] = []
  for (const s of sorted) {
    if (out.length >= WAYS_CAP) break
    const t = heavy ? tokensKey(s) : '', ss = new Set(s)
    spend(out.length)
    let dominated = false
    for (let i = 0; i < out.length && !dominated; i++) {
      if (out[i].length >= s.length || (heavy && toks[i] !== t)) continue
      dominated = out[i].every((x) => ss.has(x))
    }
    if (dominated) continue
    out.push(s); toks.push(t)
  }
  return out
}

/**
 * Keeps the minimal distinct, filtered unions a search finds, as it finds them; stops early once the empty way is found
 * (it spends nothing). Past WAYS_CAP kept ways, new ones are dropped (fail closed).
 */
class Collector {
  private kept: { s: string[]; set: Set<string>; t: string }[] = []
  private keys = new Set<string>()
  empty = false
  capped = false
  private keep: ((x: string) => boolean) | null
  private heavy: boolean
  constructor(keep: ((x: string) => boolean) | null, heavy: boolean) { this.keep = keep; this.heavy = heavy }
  add(ids: readonly string[]) {
    const s = [...new Set(this.keep ? ids.filter(this.keep) : ids)].sort(), k = keyOf(s)
    if (this.keys.has(k)) return
    this.keys.add(k)
    if (!s.length && !this.heavy) { this.empty = true; return }
    const set = new Set(s), t = this.heavy ? tokensKey(s) : ''
    spend(this.kept.length)
    const sub = (a: { set: Set<string>; s: string[]; t: string }, b: { set: Set<string>; s: string[]; t: string }) =>
      a.s.length <= b.s.length && (!this.heavy || a.t === b.t) && a.s.every((x) => b.set.has(x))
    const me = { s, set, t }
    if (this.kept.some((o) => sub(o, me))) return
    this.kept = this.kept.filter((o) => !sub(me, o))
    if (this.kept.length >= WAYS_CAP) { this.capped = true; return }
    this.kept.push(me)
  }
  get full() { return this.empty || this.keys.size >= 16 * WAYS_CAP }
  get size() { return this.kept.length + (this.empty ? 1 : 0) }
  ways() { return this.empty ? [[]] : minimal(this.kept.map((x) => x.s), this.heavy) }
}

/** Every way to meet all of `list` at once (an AND): one way from each, their union. */
export function crossWays(list: readonly Ways[], heavy = false): string[][] {
  let acc: string[][] = [[]]
  for (const ws of list) {
    if (spend(acc.length * ws.length)) return []
    acc = minimal(acc.flatMap((a) => ws.map((w) => [...a, ...w])), heavy)
    if (!acc.length) return []
  }
  return acc
}

/**
 * Every assignment of candidates to slots (one way each, pairwise disjoint) that `accept` takes, as their unions,
 * filtered by `keep`. `accept(count, first, total)`: how many candidates, how many of the first `split` of them, and
 * their weight. `size`: the assignments to look at hold exactly this many candidates (or any, when undefined).
 */
function assignments(fams: readonly Ways[], opt: {
  size?: number; split?: number; weight?: (w: Way) => number
  accept: (count: number, first: number, total: number) => boolean
  keep: ((x: string) => boolean) | null; heavy?: boolean; stopAfterOne?: boolean
}): string[][] {
  const out = new Collector(opt.keep, !!opt.heavy), used = new Set<string>(), acc: Way[] = []
  const split = opt.split ?? fams.length, weight = opt.weight ?? (() => 0)
  // candidates that can spend fewest kept ids first: the few distinct unions show up early (the empty one ends it)
  const keep = opt.keep, cost = (j: number) => Math.min(...fams[j].map((w) => (keep ? w.filter(keep).length : 0)))
  const order = [...fams.keys()].sort((x, y) => cost(x) - cost(y) || x - y)
  const go = (k: number, count: number, first: number, total: number): void => {
    const i = order[k]
    if (out.full || spend()) return
    if (opt.size !== undefined && count === opt.size) {
      if (opt.accept(count, first, total)) out.add(acc.flat())
      return
    }
    if (k === fams.length) {
      if (opt.size === undefined && opt.accept(count, first, total)) out.add(acc.flat())
      return
    }
    if (opt.size !== undefined && fams.length - k < opt.size - count) return
    for (const w of fams[i]) {
      if (w.some((x) => used.has(x))) continue
      w.forEach((x) => used.add(x)); acc.push(w)
      go(k + 1, count + 1, first + (i < split ? 1 : 0), total + weight(w))
      w.forEach((x) => used.delete(x)); acc.pop()
      if (out.full || (opt.stopAfterOne && out.size)) return
    }
    go(k + 1, count, first, total)
  }
  go(0, 0, 0, 0)
  return out.ways()
}

/** Every way `k` candidates fill k slots together (unions, filtered by `keep`). */
export const unionsOf = (fams: readonly Ways[], k: number, keep: ((x: string) => boolean) | null = null, heavy = false): string[][] =>
  k <= 0 ? [[]] : assignments(fams, { size: k, accept: () => true, keep, heavy })

/**
 * Every way `k` candidates fill k slots together with at least `min` of the first `split` among them ("choose N"
 * passing through UC-only rows: C satisfied alternatives and UC-only ones for the rest). `any`: stop at the first.
 */
export const mixedUnions = (fams: readonly Ways[], k: number, split: number, min: number, keep: ((x: string) => boolean) | null, any = false): string[][] =>
  assignments(fams, { size: k, split, accept: (_c, first) => first >= min, keep, stopAfterOne: any })

/** Every way the candidates reach at least `need` units (units groups met), or exactly `need` when `exact`. */
export const unitWays = (fams: readonly Ways[], weight: (w: Way) => number, need: number, keep: ((x: string) => boolean) | null, exact = false): string[][] =>
  assignments(fams, { weight, accept: (_c, _f, total) => (exact ? Math.abs(total - need) < 1e-9 : total >= need), keep, heavy: true })

export interface Assignment {
  /** chosen candidates, ascending */
  pick: number[]
  /** the way each chosen candidate takes (parallel to `pick`); pairwise disjoint */
  ways: Way[]
  /** false: the work budget ran out, so more candidates might have fitted */
  exact: boolean
}

/**
 * Exact slot assignment. `fams[j]`: the ways candidate j can fill a slot. Returns the largest number of candidates, at
 * most `cap`, that can each take one of their ways with no id spent twice; among the largest, the first in candidate
 * order (lexicographically smallest set of indices), so callers control preference by ordering the candidates. Out of
 * budget: the best found so far (`exact` false).
 */
export function assignSlots(fams: readonly Ways[], cap: number): Assignment {
  const n = fams.length
  if (cap <= 0 || !n) return { pick: [], ways: [], exact: true }
  // Only ids spent by two or more candidates can clash; each way is reduced to those, minimal ones only.
  const first = new Map<string, number>(), shared = new Set<string>()
  fams.forEach((f, j) => { for (const w of f) for (const x of w) { const o = first.get(x); if (o === undefined) first.set(x, j); else if (o !== j) shared.add(x) } })
  const red: string[][][] = [], full: Map<string, Way>[] = []
  for (const f of fams) {
    const back = new Map<string, Way>()
    for (const w of f) { const r = w.filter((x) => shared.has(x)).sort(); const k = keyOf(r); if (!back.has(k)) back.set(k, w) }
    const rs = minimal([...back.keys()].map((k) => (k ? k.split(SEP) : [])))
    red.push(rs)
    full.push(new Map(rs.map((r) => [keyOf(r), back.get(keyOf(r))!])))
  }
  const usable = [...Array(n).keys()].filter((j) => red[j].length > 0)
  const way = (j: number, r: string[]) => full[j].get(keyOf(r))!
  // No clash at all: the first `cap` usable candidates.
  if (!shared.size) {
    const pick = usable.slice(0, cap)
    return { pick, ways: pick.map((j) => way(j, red[j][0])), exact: true }
  }
  const singles = usable.every((j) => red[j].every((r) => r.length <= 1))

  /** Most candidates of `order` (at most `cap`) that fit together, the first `must` of them all included; -1 if those
   *  cannot all fit. Also the reduced way each fitted candidate takes. */
  const fit = (order: number[], must: number, cap: number): { count: number; took: Map<number, string[]> } => {
    if (singles) {
      // bipartite matching (augmenting paths): candidates on one side, clashing ids on the other. A candidate matched
      // once stays matched while later ones augment, so the required ones go first.
      const owner = new Map<string, number>(), took = new Map<number, string[]>()
      const tryC = (c: number, seen: Set<string>): boolean => {
        for (const r of red[c]) {
          if (spend()) return false
          if (!r.length) { took.set(c, r); return true }
          const e = r[0]
          if (seen.has(e)) continue
          seen.add(e)
          const o = owner.get(e)
          if (o === undefined || tryC(o, seen)) { owner.set(e, c); took.set(c, r); return true }
        }
        return false
      }
      let count = 0
      for (let i = 0; i < order.length && count < cap; i++) {
        if (tryC(order[i], new Set())) count++
        else if (i < must) return { count: -1, took }
      }
      return { count, took }
    }
    // general case (a clash of two or more ids in one way): exact search, bounded by what is left
    const used = new Set<string>(), took = new Map<number, string[]>()
    let best = -1, bestTook = new Map<number, string[]>()
    const go = (i: number, got: number): boolean => {
      if (got >= cap || i === order.length) {
        if (got > best) { best = got; bestTook = new Map(took) }
        return got >= cap
      }
      if (spend() || got + (order.length - i) <= best) return false
      const c = order[i]
      for (const r of red[c]) {
        if (r.some((x) => used.has(x))) continue
        r.forEach((x) => used.add(x)); took.set(c, r)
        const done = go(i + 1, got + 1)
        took.delete(c); r.forEach((x) => used.delete(x))
        if (done) return true
      }
      return i >= must ? go(i + 1, got) : false
    }
    go(0, 0)
    return { count: best, took: bestTook }
  }

  const m = fit(usable, 0, cap).count
  // The first candidates (in order) that still leave room for a largest assignment.
  const pick: number[] = []
  for (const [x, j] of usable.entries()) {
    if (pick.length === m || outOfWork()) break
    if (fit([...pick, j, ...usable.slice(x + 1)], pick.length + 1, m).count >= m) pick.push(j)
  }
  // out of budget: the candidates picked so far, if they fit (fail closed: fewer slots)
  let { count, took } = fit(pick, pick.length, pick.length)
  while (count < 0 && pick.length) { pick.pop(); ({ count, took } = fit(pick, pick.length, pick.length)) }
  const ok = pick.filter((j) => took.has(j))
  return { pick: ok, ways: ok.map((j) => way(j, took.get(j)!)), exact: !outOfWork() && ok.length === m }
}

export interface Weighted extends Assignment { total: number }

/**
 * "N units from the following" (NFollowingUnits): the most total weight (units) candidates can reach, each taking one
 * of its ways, no id spent twice, counted up to `cap`; exact search. The candidates taken: in candidate order, each one
 * that can still be part of an assignment reaching that total, until those taken reach it alone (so callers control
 * preference by ordering, and the choice does not depend on the order of any candidate's ways). Out of budget: the
 * heaviest found so far (`exact` false).
 */
export function assignWeight(fams: readonly Ways[], weight: (w: Way) => number, cap: number): Weighted {
  const opts = fams.map((f) => f.map((w) => ({ w, u: weight(w) })).filter((x) => x.u > 0))
  const most = opts.map((o) => Math.max(0, ...o.map((x) => x.u)))
  /** An assignment of all of `must`, and any of `may`, reaching `goal`; or the heaviest when `goal` is Infinity. */
  const search = (must: number[], may: number[], goal: number): { total: number; pick: number[]; ways: Way[] } | null => {
    const order = [...must, ...may], used = new Set<string>(), pick: number[] = [], ways: Way[] = []
    const rest = order.map((_, i) => order.slice(i).reduce((t, j) => t + most[j], 0))
    const hold: { best: { total: number; pick: number[]; ways: Way[] } | null } = { best: null }
    const go = (i: number, total: number): boolean => {
      if (i >= must.length && (i === order.length || total >= goal)) {
        if (!hold.best || total > hold.best.total) hold.best = { total, pick: [...pick], ways: [...ways] }
        return total >= goal
      }
      if (i === order.length || spend()) return false
      if (total + rest[i] < goal && hold.best && total + rest[i] <= hold.best.total) return false
      for (const { w, u } of opts[order[i]]) {
        if (w.some((x) => used.has(x))) continue
        w.forEach((x) => used.add(x)); pick.push(order[i]); ways.push(w)
        const done = go(i + 1, total + u)
        w.forEach((x) => used.delete(x)); pick.pop(); ways.pop()
        if (done) return true
      }
      return i >= must.length ? go(i + 1, total) : false
    }
    go(0, 0)
    const best = hold.best
    return best && (goal === Infinity || best.total >= goal) ? best : null
  }
  const all = [...fams.keys()]
  const top = search([], all, cap)?.total ?? Math.min(cap, search([], all, Infinity)?.total ?? 0)
  if (top <= 0) return { total: 0, pick: [], ways: [], exact: !outOfWork() }
  const goal = Math.min(cap, top), taken: number[] = []
  for (const j of all) {
    if (outOfWork() || search(taken, [], goal)) break
    if (search([...taken, j], all.filter((k) => k > j), goal)) taken.push(j)
  }
  // out of budget: the heaviest assignment of those taken (fail closed: fewer units)
  const fit = search(taken, [], goal) ?? search(taken, [], Infinity) ?? { total: 0, pick: [], ways: [] }
  const order = taken.map((j) => fit.pick.indexOf(j))
  const ok = order.every((k) => k >= 0)
  return { total: ok ? fit.total : 0, pick: ok ? taken : [], ways: ok ? order.map((k) => fit.ways[k]) : [], exact: !outOfWork() }
}
