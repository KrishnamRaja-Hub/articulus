import type { Agreement, Course, CourseGroup, CourseId, ReqNode, Requirement } from './types'

/* Raw ASSIST shapes, only the fields we read. */
interface RawCourse { prefix: string; courseNumber: string; courseTitle: string; minUnits: number; maxUnits: number }
interface RawSeries { conjunction: string; name: string; courses: RawCourse[] }
interface RawCell { type: 'Course' | 'Series'; course?: RawCourse; series?: RawSeries; id: string }
interface RawSection { type: string; position: number; rows?: { cells: RawCell[] }[]; advisements?: { type: string; amount: number }[] }
interface RawGroup { type: 'RequirementGroup'; position: number; sections: RawSection[]; instruction?: { type: string; conjunction?: string } }
interface RawTitle { type: 'RequirementTitle' | 'GeneralTitle' | 'GeneralText'; position: number; content: string }
interface RawSendingGroup { courseConjunction: 'And' | 'Or'; items: RawCourse[] }
interface RawArticulation {
  templateCellId: string
  articulation: {
    type: 'Course' | 'Series'
    course?: RawCourse
    series?: RawSeries
    sendingArticulation?: { noArticulationReason: string | null; items: RawSendingGroup[] }
  }
}
/* Note: ASSIST nests JSON-encoded strings inside the JSON response. */
export interface RawPayload {
  result: { name: string; templateAssets: string; articulations: string; academicYear: string; sendingInstitution: string; receivingInstitution: string }
}
/** Parse one nested JSON field, naming the payload on failure. */
const parsed = <T>(p: RawPayload, f: keyof RawPayload['result']): T => {
  try { return JSON.parse(p.result[f]) as T }
  catch (e) { throw new Error(`normalize: ${p.result?.name ?? '?'} (sending ${p.result?.sendingInstitution ?? '?'}): bad ${f}: ${(e as Error).message}`) }
}
const sendingId = (p: RawPayload) => parsed<{ id: number }>(p, 'sendingInstitution').id

export const courseId = (inst: number, c: { prefix: string; courseNumber?: string; number?: string }): CourseId =>
  `${inst}:${c.prefix.trim()} ${(c.courseNumber ?? c.number ?? '').trim()}`

const groupKey = (g: CourseGroup) => `${g.institutionId}|${[...g.courses].sort().join('+')}`
const ucLabel = (c: RawCourse) => `${c.prefix.trim()} ${c.courseNumber.trim()}`

const cellKey = (cell: { type: string; course?: RawCourse; series?: RawSeries }): string | null =>
  cell.series ? cell.series.name : cell.course ? ucLabel(cell.course) : null
/** UC courses a cell needs (all of them); null for an "Or" series, which only matches by key. */
const ucSet = (cell: { course?: RawCourse; series?: RawSeries }): string[] | null =>
  cell.series ? (cell.series.conjunction === 'Or' ? null : cell.series.courses.map(ucLabel)) : cell.course ? [ucLabel(cell.course)] : null
const addGroups = (req: Requirement, groups: CourseGroup[]) => {
  const seen = new Set(req.groups.map(groupKey))
  req.groups.push(...groups.filter((g) => !seen.has(groupKey(g)) && seen.add(groupKey(g))))
}

/** Expand sending groups into flat CourseGroups. "Or" groups fan out into one group per course. */
function sendingGroups(inst: number, sa: RawArticulation['articulation']['sendingArticulation'], catalog: Record<CourseId, Course>): CourseGroup[] {
  if (!sa) return []
  const out: CourseGroup[] = []
  for (const g of sa.items ?? []) {
    const items = (g.items ?? []).filter((c) => c.prefix && c.courseNumber)
    if (!items.length) continue
    const ids = items.map((c) => {
      const id = courseId(inst, c)
      catalog[id] ??= { id, institutionId: inst, prefix: c.prefix.trim(), number: c.courseNumber.trim(), title: c.courseTitle, units: c.minUnits }
      return id
    })
    if (g.courseConjunction === 'Or') ids.forEach((id) => out.push({ institutionId: inst, courses: [id] }))
    else out.push({ institutionId: inst, courses: ids })
  }
  return out
}

const byPos = (a: { position: number }, b: { position: number }) => a.position - b.position

/** Requirement shape of a payload's template: titles, group conjunctions, N-of advisements and UC cells, in order. */
const templateShape = (p: RawPayload) => {
  const assets = parsed<(RawGroup | RawTitle)[]>(p, 'templateAssets')
  return JSON.stringify([...assets].sort(byPos).flatMap<unknown>((a) =>
    a.type === 'RequirementTitle' ? [a.content]
    : a.type === 'RequirementGroup' ? [[a.instruction?.conjunction ?? '', a.sections.filter((x) => x.type === 'Section').map((x) =>
        [x.advisements?.find((v) => v.type === 'NFollowing')?.amount ?? 0, (x.rows ?? []).map((r) => r.cells.map(cellKey))])]]
    : []))
}

/** Sending colleges whose template differs from the first payload's (the one the tree is built from). */
export const templateMismatches = (payloads: RawPayload[]): number[] => {
  if (!payloads?.length) return []
  const ref = templateShape(payloads[0])
  return [...new Set(payloads.slice(1).filter((p) => templateShape(p) !== ref).map(sendingId))]
}

/** Merge one payload per sending college (same UC + major) into a single Agreement. */
export function normalize(payloads: RawPayload[]): Agreement {
  if (!payloads?.length) throw new Error('normalize: no payloads (need at least one sending college)')
  const first = payloads[0]
  const sendingIds = [...new Set(payloads.map(sendingId))]
  const drift = templateMismatches(payloads)
  if (drift.length) console.warn(`normalize: ${first.result.name}: template differs from college ${sendingIds[0]} at colleges ${drift.join(', ')}; tree uses ${sendingIds[0]}'s, other articulations are matched by UC course`)
  const catalog: Record<CourseId, Course> = {}
  const reqs = new Map<string, Requirement>()
  // Per college: UC cell key -> the UC courses it needs and its groups (to match cells keyed differently from the tree).
  const cellsOf = new Map<number, Map<string, { uc: string[] | null; groups: CourseGroup[] }>>(sendingIds.map((id) => [id, new Map()]))

  // Collect articulations from every college, keyed by UC course label.
  for (const p of payloads) {
    const inst = sendingId(p), cells = cellsOf.get(inst)!
    for (const a of parsed<RawArticulation[]>(p, 'articulations')) {
      const key = cellKey(a.articulation)
      if (!key) continue // e.g. GeneralEducation / Requirement cells we do not model
      const uc = a.articulation.course, s = a.articulation.series
      const req = reqs.get(key) ?? {
        kind: 'req', id: key,
        label: uc ? uc.courseTitle : s!.name,
        // informational; an "Or" series needs only one of its courses
        units: uc ? uc.minUnits : s!.conjunction === 'Or' ? Math.min(...s!.courses.map((c) => c.minUnits)) : s!.courses.reduce((t, c) => t + c.minUnits, 0),
        groups: [],
      }
      const groups = sendingGroups(inst, a.articulation.sendingArticulation, catalog)
      if (groups.length) addGroups(req, groups)
      else (req.noArticulation ??= {})[inst] = a.articulation.sendingArticulation?.noArticulationReason ?? 'No Course Articulated'
      reqs.set(key, req)
      const cell = cells.get(key) ?? { uc: ucSet(a.articulation), groups: [] }
      cell.groups.push(...groups)
      cells.set(key, cell)
    }
  }

  const leaf = (k: string): Requirement => {
    if (!reqs.has(k)) reqs.set(k, { kind: 'req', id: k, label: k, units: 0, groups: [], noArticulation: Object.fromEntries(sendingIds.map((id) => [id, 'No articulation listed'])) })
    return reqs.get(k)!
  }
  const prune = (n: ReqNode): ReqNode | null => {
    const children = n.children
      .map((c) => (c.kind === 'node' ? prune(c) : c.groups.length || c.noArticulation ? c : null))
      .filter((c): c is ReqNode | Requirement => !!c)
    return children.length ? { ...n, children } : null
  }
  const placed = new Map<string, string[] | null>() // tree requirement key -> UC courses it needs
  /** Tree nodes for one template. Each group takes the nearest RequirementTitle before it by position. */
  const build = (assets: (RawGroup | RawTitle)[], keep: (k: string) => boolean, optional = '') => {
    const out: ReqNode[] = []
    let title = ''
    for (const asset of [...assets].sort(byPos)) {
      if (asset.type === 'RequirementTitle') title = asset.content ?? ''
      if (asset.type !== 'RequirementGroup') continue
      const required = !optional && !/RECOMMEND/i.test(title)
      const sections: ReqNode[] = (asset.sections ?? [])
        .filter((s) => s.type === 'Section' && s.rows?.length)
        .map((s) => {
          const rows = s.rows!.map((r): ReqNode | Requirement => {
            const cells = r.cells.filter((c) => { const k = cellKey(c); return !!k && keep(k) })
              .map((c) => { const k = cellKey(c)!; if (!placed.has(k)) placed.set(k, ucSet(c)); return leaf(k) })
            return cells.length === 1 ? cells[0] : { kind: 'node', type: 'OR', required, children: cells }
          })
          const nOf = s.advisements?.find((a) => a.type === 'NFollowing')
          return nOf ? { kind: 'node', type: 'N_OF', n: nOf.amount, required, children: rows } : { kind: 'node', type: 'AND', required, children: rows }
        })
      const type = asset.instruction?.type === 'Conjunction' && asset.instruction.conjunction === 'Or' ? 'OR' : 'AND'
      const t = (title + optional).trim()
      // One section: the group is that section (keeps its N_OF). Several: the group's conjunction joins them.
      const node = prune(sections.length === 1 ? { ...sections[0], title: t } : { kind: 'node', type, title: t, required, children: sections })
      if (node) out.push(node)
    }
    return out
  }

  // The tree is built from the FIRST payload's template.
  const children = build(parsed(first, 'templateAssets'), () => true)

  // A college with no articulation under a tree requirement's key may still articulate its UC courses under
  // differently shaped cells (a series split into rows, or rows merged into a series). Attach those by UC course.
  const used = new Set<string>() // `${inst}|${key}` of college cells that reached the tree
  for (const [key, want] of placed) {
    const req = reqs.get(key)!
    for (const [inst, cells] of cellsOf) {
      if (cells.has(key)) { used.add(`${inst}|${key}`); continue }
      if (!want) continue
      const parts = [...cells].filter(([, c]) => c.uc && c.groups.length && c.uc.some((u) => want.includes(u)))
      const supers = parts.filter(([, c]) => want.every((u) => c.uc!.includes(u)))
      const use = supers.length ? supers : want.every((u) => parts.some(([, c]) => c.uc!.includes(u))) ? parts : []
      if (!use.length) continue
      // A cell covering every UC course articulates alone; otherwise one group from each overlapping cell is needed.
      addGroups(req, supers.length ? supers.flatMap(([, c]) => c.groups)
        : use.reduce<CourseGroup[]>((acc, [, c]) => acc.flatMap((g) => c.groups.map((h) => ({ institutionId: inst, courses: [...new Set([...g.courses, ...h.courses])] }))).slice(0, 64), [{ institutionId: inst, courses: [] }]))
      if (req.noArticulation) { delete req.noArticulation[inst]; if (!Object.keys(req.noArticulation).length) delete req.noArticulation }
      use.forEach(([k]) => used.add(`${inst}|${k}`))
    }
  }

  // Articulations still outside the tree belong to requirements only other templates list. Never drop them:
  // add them as optional groups built from their own college's template.
  const leftover = new Set([...cellsOf].flatMap(([inst, cells]) => [...cells].filter(([k, c]) => c.groups.length && !used.has(`${inst}|${k}`)).map(([k]) => k)))
  if (leftover.size) {
    for (const p of payloads.slice(1)) children.push(...build(parsed(p, 'templateAssets'), (k) => leftover.has(k) && !placed.has(k), ' (only in some colleges\' agreements)'))
    const added = [...leftover].filter((k) => placed.has(k)), orphan = [...leftover].filter((k) => !placed.has(k))
    if (added.length) console.warn(`normalize: ${first.result.name}: not in college ${sendingIds[0]}'s template, added as optional: ${added.join('; ')}`)
    if (orphan.length) console.warn(`normalize: ${first.result.name}: articulated but in no template, not added: ${orphan.join('; ')}`)
  }

  return {
    receivingId: parsed<{ id: number }>(first, 'receivingInstitution').id,
    major: first.result.name,
    year: parsed<{ code: string }>(first, 'academicYear').code,
    sendingIds,
    root: { kind: 'node', type: 'AND', required: true, children },
    catalog,
  }
}
