/**
 * One course, one slot (TESTER r6 M-4). In a "choose N of" group each chosen child fills one slot, and the courses a
 * child uses to be met are spent on that slot: no other slot of the same group may use them again.
 *
 * A child's "ways" are the alternative sets of ids it would spend: the taken course ids of one satisfied group per row
 * in it, plus one token per row (rowToken), so a row listed twice in a group still fills only one slot. Which children
 * can fill slots together is an exact assignment problem: a bipartite matching when every clash is a single id, a
 * small exact search otherwise. Nothing here is greedy, so a valid assignment is never missed.
 */

export type Way = readonly string[]
export type Ways = readonly Way[]

/** Stands for a row in a way: the same row filling two slots is a clash like a shared course. Course ids ("113:MATH 1A")
 *  never start with this character. */
export const rowToken = (id: string) => `\u0001${id}`
export const isRowToken = (x: string) => x.charCodeAt(0) === 1

/** A child that consumes nothing (it passes through UC-only rows, or nothing is tracked). */
export const NOTHING: Ways = [[]]

/**
 * Most alternative ways kept per subtree. Only a "choose several" group nested inside another one's slot can have
 * more; past the cap the extra ways are dropped, which can only make that nested group read as unmet (fail closed).
 */
export const WAYS_CAP = 256
/** Search nodes per enumeration of a nested group's ways (the same fail-closed cap). */
const ENUM_BUDGET = 200_000

const SEP = '\u0002'
const keyOf = (w: Way) => w.join(SEP)

/** Minimal ways only (a way that spends a superset of another is never needed), deduplicated, sorted, capped. */
export function minimal(ways: Iterable<Way>): string[][] {
  const uniq = new Map<string, string[]>()
  for (const w of ways) { const s = [...new Set(w)].sort(); uniq.set(keyOf(s), s) }
  const sorted = [...uniq.entries()].sort(([x, a], [y, b]) => a.length - b.length || (x < y ? -1 : x > y ? 1 : 0)).map(([, s]) => s)
  const out: string[][] = [], sets: Set<string>[] = []
  for (const s of sorted) {
    if (out.length >= WAYS_CAP) break
    if (sets.some((o) => o.size <= s.length && [...o].every((x) => s.includes(x)))) continue
    out.push(s); sets.push(new Set(s))
  }
  return out
}

/** Every way to meet all of `list` at once (an AND): one way from each, their union. */
export function crossWays(list: readonly Ways[]): string[][] {
  let acc: string[][] = [[]]
  for (const ws of list) {
    acc = minimal(acc.flatMap((a) => ws.map((w) => [...a, ...w])))
    if (!acc.length) return []
  }
  return acc
}

/**
 * Every way `k` of the candidates can fill k slots together: one way each, pairwise disjoint, their union. Minimal
 * ways only, capped (WAYS_CAP, ENUM_BUDGET).
 */
export function unionsOf(fams: readonly Ways[], k: number): string[][] {
  if (k <= 0) return [[]]
  const out: string[][] = [], used = new Map<string, number>(), acc: string[] = []
  let nodes = 0
  const go = (i: number, got: number): void => {
    if (out.length >= 4 * WAYS_CAP || ++nodes > ENUM_BUDGET) return
    if (got === k) return void out.push([...acc])
    if (fams.length - i < k - got) return
    for (const w of fams[i]) {
      if (w.some((x) => used.has(x))) continue
      for (const x of w) used.set(x, (used.get(x) ?? 0) + 1)
      acc.push(...w)
      go(i + 1, got + 1)
      acc.length -= w.length
      for (const x of w) { const n = used.get(x)! - 1; if (n) used.set(x, n); else used.delete(x) }
    }
    go(i + 1, got)
  }
  go(0, 0)
  return minimal(out)
}

export interface Assignment {
  /** chosen candidates, ascending */
  pick: number[]
  /** the way each chosen candidate takes (parallel to `pick`); pairwise disjoint */
  ways: Way[]
}

/**
 * Exact slot assignment. `fams[j]`: the ways candidate j can fill a slot. Returns the largest number of candidates, at
 * most `cap`, that can each take one of their ways with no id spent twice; among the largest, the first in candidate
 * order (lexicographically smallest set of indices), so callers control preference by ordering the candidates.
 */
export function assignSlots(fams: readonly Ways[], cap: number): Assignment {
  const n = fams.length
  if (cap <= 0 || !n) return { pick: [], ways: [] }
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
    return { pick, ways: pick.map((j) => way(j, red[j][0])) }
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
      if (got + (order.length - i) <= best) return false
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
    if (pick.length === m) break
    if (fit([...pick, j, ...usable.slice(x + 1)], pick.length + 1, m).count >= m) pick.push(j)
  }
  const { took } = fit(pick, pick.length, pick.length)
  return { pick, ways: pick.map((j) => way(j, took.get(j)!)) }
}
