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
const parsed = <T>(s: string): T => JSON.parse(s) as T
const sendingId = (p: RawPayload) => parsed<{ id: number }>(p.result.sendingInstitution).id

export const courseId = (inst: number, c: { prefix: string; courseNumber?: string; number?: string }): CourseId =>
  `${inst}:${c.prefix.trim()} ${(c.courseNumber ?? c.number ?? '').trim()}`

const groupKey = (g: CourseGroup) => `${g.institutionId}|${[...g.courses].sort().join('+')}`
const ucLabel = (c: RawCourse) => `${c.prefix.trim()} ${c.courseNumber.trim()}`

const cellKey = (cell: { type: string; course?: RawCourse; series?: RawSeries }): string | null =>
  cell.series ? cell.series.name : cell.course ? ucLabel(cell.course) : null

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

/** Merge one payload per sending college (same UC + major) into a single Agreement. */
export function normalize(payloads: RawPayload[]): Agreement {
  const first = payloads[0].result
  const sendingIds = payloads.map(sendingId)
  const catalog: Record<CourseId, Course> = {}
  const reqs = new Map<string, Requirement>()

  // Collect articulations from every college, keyed by UC course label.
  for (const p of payloads) {
    const inst = sendingId(p)
    const arts: RawArticulation[] = JSON.parse(p.result.articulations)
    for (const a of arts) {
      const key = cellKey(a.articulation)
      if (!key) continue // e.g. GeneralEducation / Requirement cells we do not model
      const uc = a.articulation.course
      const req = reqs.get(key) ?? {
        kind: 'req', id: key,
        label: uc ? uc.courseTitle : a.articulation.series!.name,
        units: uc ? uc.minUnits : a.articulation.series!.courses.reduce((s, c) => s + c.minUnits, 0),
        groups: [],
      }
      const groups = sendingGroups(inst, a.articulation.sendingArticulation, catalog)
      const seen = new Set(req.groups.map(groupKey))
      if (groups.length) req.groups.push(...groups.filter((g) => !seen.has(groupKey(g)) && seen.add(groupKey(g))))
      else (req.noArticulation ??= {})[inst] = a.articulation.sendingArticulation?.noArticulationReason ?? 'No Course Articulated'
      reqs.set(key, req)
    }
  }

  // Build the tree from the FIRST payload's template (templates are identical across colleges).
  // RequirementTitles and RequirementGroups are parallel sequences: k-th title labels k-th group.
  const assets: (RawGroup | RawTitle)[] = JSON.parse(first.templateAssets)
  const byPos = (a: { position: number }, b: { position: number }) => a.position - b.position
  const titles = assets.filter((a): a is RawTitle => a.type === 'RequirementTitle').sort(byPos)
  const groups = assets.filter((a): a is RawGroup => a.type === 'RequirementGroup').sort(byPos)
  const prune = (n: ReqNode): ReqNode | null => {
    const children = n.children
      .map((c) => (c.kind === 'node' ? prune(c) : c.groups.length || c.noArticulation ? c : null))
      .filter((c): c is ReqNode | Requirement => !!c)
    return children.length ? { ...n, children } : null
  }
  const children: ReqNode[] = []
  groups.forEach((asset, k) => {
    const title = titles[k]?.content ?? ''
    const required = !/RECOMMEND/i.test(title)
    const sections: ReqNode[] = asset.sections
      .filter((s) => s.type === 'Section' && s.rows?.length)
      .map((s) => {
        const rows = s.rows!.map((r): ReqNode | Requirement => {
          const cells = r.cells.map(cellKey).filter((k): k is string => !!k)
            .map((k) => reqs.get(k) ?? ({ kind: 'req', id: k, label: k, units: 0, groups: [], noArticulation: Object.fromEntries(sendingIds.map((id) => [id, 'No articulation listed'])) } as Requirement))
          return cells.length === 1 ? cells[0] : { kind: 'node', type: 'OR', required, children: cells }
        })
        const nOf = s.advisements?.find((a) => a.type === 'NFollowing')
        return nOf ? { kind: 'node', type: 'N_OF', n: nOf.amount, required, children: rows } : { kind: 'node', type: 'AND', required, children: rows }
      })
    const type = asset.instruction?.type === 'Conjunction' && asset.instruction.conjunction === 'Or' ? 'OR' : 'AND'
    const node = prune({ kind: 'node', type, title, required, children: sections.length === 1 ? sections[0].children : sections })
    if (node) children.push(node)
  })

  return {
    receivingId: parsed<{ id: number }>(first.receivingInstitution).id,
    major: first.name,
    year: parsed<{ code: string }>(first.academicYear).code,
    sendingIds,
    root: { kind: 'node', type: 'AND', required: true, children },
    catalog,
  }
}
