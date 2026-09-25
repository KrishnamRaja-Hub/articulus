import type { Agreement, Course, CourseGroup, CourseId, ReqNode, Requirement } from './types'

/* Raw ASSIST shapes, only the fields we read. */
interface RawCourse { prefix: string; courseNumber: string; courseTitle: string; minUnits: number; maxUnits: number }
interface RawSeries { conjunction: string; name: string; courses: RawCourse[] }
interface RawCell { type: 'Course' | 'Series'; course?: RawCourse; series?: RawSeries; id: string }
interface RawSection { type: string; position: number; rows?: { cells: RawCell[] }[]; advisements?: { type: string; amount: number }[] }
interface RawGroup { type: 'RequirementGroup'; position: number; sections: RawSection[]; instruction?: { type: string; conjunction?: string; amount?: number } }
interface RawTitle { type: 'RequirementTitle' | 'GeneralTitle' | 'GeneralText'; position: number; content: string }
interface RawSendingGroup { courseConjunction: string; items: RawCourse[]; position?: number }
/**
 * How ASSIST joins sending course groups (C-1), to the best of our knowledge: each entry joins the groups from
 * `sendingCourseGroupBeginPosition` to `sendingCourseGroupEndPosition` (inclusive) with `groupConjunction` ("And" /
 * "Or"); groups no entry covers are joined by "Or". Positions are matched against the groups' own `position` fields
 * when every group carries one, else against their index in `items` (assumption: ASSIST numbers them the same way).
 * Other fields (ids, etc.) are ignored; an entry without these three readable fields fails the row closed.
 */
interface RawGroupConjunction { groupConjunction?: unknown; sendingCourseGroupBeginPosition?: unknown; sendingCourseGroupEndPosition?: unknown }
interface RawArticulation {
  templateCellId: string
  articulation: {
    type: 'Course' | 'Series'
    course?: RawCourse
    series?: RawSeries
    sendingArticulation?: { noArticulationReason: string | null; items: RawSendingGroup[]; courseGroupConjunctions?: RawGroupConjunction[] | null }
  }
}
/* Note: ASSIST nests JSON-encoded strings inside the JSON response. */
export interface RawPayload {
  result: { name: string; templateAssets: string; articulations: string; academicYear: string; sendingInstitution: string; receivingInstitution: string }
}
/** Parse one nested JSON field, naming the payload on failure. */
/**
 * Bump whenever normalize() output changes meaning. data/meta.json records the version that built data/; the app
 * trusts verdicts only when the two match (src/data-trust.ts).
 *   1 = fixtures fetched before FIXES rounds 1-3.
 *   2 = titles paired by position, N_OF kept, other templates matched by UC course (F-01..F-03).
 *   3 = only admission sections are required: time-to-degree, elective and other advisory sections ("...NECESSARY TO
 *       GRADUATE IN TWO YEARS", "ADDITIONAL MAJOR ELECTIVES", "ADDITIONAL ... COURSES" beside a "REQUIRED FOR
 *       TRANSFER" section) become optional, like "RECOMMENDED" ones (TESTER1 H-4; `sectionRules`).
 *   4 = never green on missing proof (verdict round 6): a row with no groups and no explicit ASSIST reason, or whose
 *       reason is "Course(s) Denied", is NOT_LISTED (not UC-only); an And group with an unreadable course is dropped
 *       whole; rows only other colleges' templates list keep their section's required-ness (NOT_LISTED at colleges
 *       that do not list them); "ELECTIVE(S)" titles are optional only beside a required-for-admission section.
 *       Same release (import round, C-1/L-1/M-3): sending course groups are joined by ASSIST's
 *       `courseGroupConjunctions` (an "And" range is one alternative per combination, capped at MAX_ALTERNATIVES; an
 *       unreadable conjunction list or a range over the cap makes the row NOT_LISTED at that college); conjunctions
 *       and advisement/section types are matched case-insensitively; a group instruction "NFollowing" is N_OF(n);
 *       "NFollowingUnits" (not modelled) keeps the section "take all" with a warning; sending course ids are
 *       upper-cased with whitespace collapsed; template cells that are not UC courses or series (GE / "Requirement"
 *       cells) become required-where-placed rows NOT_LISTED at every college (counselor) instead of being dropped.
 */
export const NORMALIZE_VERSION = 4

/*
 * Section titles (TESTER1 H-4). ASSIST puts the courses a campus requires for admission under one heading ("MAJOR
 * PREPARATION COURSES REQUIRED FOR TRANSFER", "REQUIRED FOR ADMISSION", "LOWER DIVISION MAJOR REQUIREMENTS") and
 * guidance under others (recommended courses, courses to graduate on time, electives). Only the first kind can fail a
 * plan; the others are optional (shown as recommended). Titles are classified conservatively: a title that reads as
 * both required and advisory, or that cannot be placed, stays required and is reported as ambiguous.
 */
/** Advisory wording, by rule name (first match names the rule). */
export const ADVISORY_TITLE: readonly (readonly [string, RegExp])[] = [
  ['not required', /\bNOT\s+(?:BE\s+)?REQUIRED\b|\bNOT\s+(?:AN?\s+)?(?:ADMISSION\s+|TRANSFER\s+)?REQUIREMENTS?\b/i],
  ['recommended', /RECOMMEND/i],
  ['time to degree', /\bGRADUAT(?:E|ION)\s+(?:IN|WITHIN)\b|\bTIMELY\b|\bTIME[\s-]+TO[\s-]+DEGREE\b|\bNORMAL\s+PROGRESS\b/i],
  ['after transfer', /\bNOT\s+COMPLETED\s+(?:PRIOR\s+TO|BEFORE)\s+TRANSFER\b|\bAFTER\s+TRANSFER\b/i],
  ['optional', /\bOPTIONAL\b|\bSUGGESTED\b|\bENCOURAGED\b/i],
]
/** "ELECTIVE(S)": like "ADDITIONAL", optional only beside an explicit required-for-admission section (M-3). */
const ELECTIVE_TITLE = /\bELECTIVES?\b/i
/** Explicitly the admission set. */
const ADMISSION_TITLE = /\bREQUIRED\s+(?:COURSES\s+)?(?:FOR|PRIOR\s+TO|BEFORE)\s+(?:ADMISSION|TRANSFER)\b|\b(?:ADMISSION|TRANSFER|SELECTION)\s+(?:REQUIREMENTS?|CRITERIA)\b|\bMUST\s+BE\s+COMPLETED\b/i
/** Required wording that overrides nothing: next to advisory wording it makes the title ambiguous. */
const MUST_TITLE = /\bREQUIRED\b|\bMUST\b/i
/** Major-preparation wording: required when nothing advisory is in the title. */
const PREP_TITLE = /\bREQUIRED\b|\bREQUIREMENTS?\b|\bMUST\b|\bPREPARATION\b|\bPREREQUISITES?\b/i

export type TitleKind = 'admission' | 'required' | 'advisory' | 'additional' | 'ambiguous' | 'neutral'
/** What one title says on its own. `rule` names the pattern that decided it. */
export function classifyTitle(title: string): { kind: TitleKind; rule: string } {
  const adv = ADVISORY_TITLE.find(([, re]) => re.test(title))?.[0]
  if (adv === 'not required') return { kind: 'advisory', rule: adv }
  if (ADMISSION_TITLE.test(title)) return adv || ELECTIVE_TITLE.test(title) ? { kind: 'ambiguous', rule: `required for admission + ${adv ?? 'electives'}` } : { kind: 'admission', rule: 'required for admission/transfer' }
  if (adv) return MUST_TITLE.test(title) ? { kind: 'ambiguous', rule: `required + ${adv}` } : { kind: 'advisory', rule: adv }
  if (ELECTIVE_TITLE.test(title)) return MUST_TITLE.test(title) ? { kind: 'ambiguous', rule: 'required + electives' } : { kind: 'additional', rule: 'electives' }
  if (/\bADDITIONAL\b/i.test(title)) return { kind: 'additional', rule: 'additional' }
  if (PREP_TITLE.test(title)) return { kind: 'required', rule: 'major preparation' }
  return { kind: 'neutral', rule: title.trim() ? 'subject heading' : 'untitled' }
}

export interface SectionRule { required: boolean; ambiguous: boolean; rule: string }
/**
 * Resolve a template's titles, in position order, to required / optional:
 *   admission, major preparation      required
 *   advisory (recommended, time to degree, not required, after transfer, optional)   optional
 *   "ADDITIONAL ...", "ELECTIVE(S)"   optional when the agreement also has an explicit required-for-admission section
 *                                     (it is then, by contrast, not that set); otherwise ambiguous: required
 *   required + advisory wording       ambiguous: required
 *   a subject heading ("CHEMISTRY") or empty title   takes the section it sits under (required before any heading);
 *                                     under an optional section it is ambiguous: required
 */
export function sectionRules(titles: readonly string[]): SectionRule[] {
  const kinds = titles.map(classifyTitle)
  const admission = kinds.some((k) => k.kind === 'admission')
  let section: SectionRule = { required: true, ambiguous: false, rule: 'untitled' }
  return kinds.map(({ kind, rule }) => {
    if (kind === 'neutral') {
      return section.required ? { ...section, rule: section.rule === 'untitled' ? rule : `${rule} under ${section.rule}` }
        : { required: true, ambiguous: true, rule: `${rule} under an optional section (${section.rule})` }
    }
    section = kind === 'admission' || kind === 'required' ? { required: true, ambiguous: false, rule }
      : kind === 'advisory' ? { required: false, ambiguous: false, rule }
      : kind === 'ambiguous' ? { required: true, ambiguous: true, rule }
      : admission ? { required: false, ambiguous: false, rule: `${rule}, beside a required-for-admission section` }
      : { required: true, ambiguous: true, rule: `${rule}, with no required-for-admission section` }
    return section
  })
}

/**
 * Placeholder for a UC row with no ASSIST proof at a college: absent from its payload, no explicit reason, unreadable
 * courses, or "Course(s) Denied". Not an ASSIST statement that the course is taken at the UC, so it never makes a row
 * UC-only; the student is sent to a counselor.
 */
export const NOT_LISTED = 'No articulation listed'
/**
 * The only ASSIST reasons accepted as proof the course is taken at the UC after transfer (round 7 H-1). An allowlist,
 * so anything else ("Course(s) Denied", "Pending", "See counselor", "N/A", blank, a new wording) fails closed to
 * NOT_LISTED and the student is sent to a counselor. Matched case- and space-insensitively, ignoring a trailing period.
 */
export const UC_ONLY_REASONS = ['No Course Articulated', 'This course must be taken at the university after transfer', 'This Course is Never Articulated'] as const
const canon = (s: string) => s.trim().replace(/[.\s]+$/, '').replace(/\s+/g, ' ').toLowerCase() // trailing period ignored
/** A conjunction / type word compared case- and space-insensitively ("Or", "OR", " or "); '' when not a string. */
const word = (s: unknown): string => (typeof s === 'string' ? canon(s) : '')
/** Course prefix / number as used in ids: trimmed, whitespace collapsed, upper-cased ("Math" and "MATH" are one course). */
const code = (s: string) => s.trim().replace(/\s+/g, ' ').toUpperCase()
const UC_ONLY = new Set(UC_ONLY_REASONS.map(canon))
/** Whether a stored or ASSIST reason is proof the row is UC-only. */
export const isUcOnlyProof = (why: unknown): boolean => typeof why === 'string' && UC_ONLY.has(canon(why))
/** An explicit ASSIST reason that may make a row UC-only, or null (then the row is NOT_LISTED at that college). */
export const ucOnlyReason = (why: unknown): string | null => (isUcOnlyProof(why) ? (why as string).trim() : null)

const parsed = <T>(p: RawPayload, f: keyof RawPayload['result']): T => {
  try { return JSON.parse(p.result[f]) as T }
  catch (e) { throw new Error(`normalize: ${p.result?.name ?? '?'} (sending ${p.result?.sendingInstitution ?? '?'}): bad ${f}: ${(e as Error).message}`) }
}
const sendingId = (p: RawPayload) => parsed<{ id: number }>(p, 'sendingInstitution').id

export const courseId = (inst: number, c: { prefix: string; courseNumber?: string; number?: string }): CourseId =>
  `${inst}:${code(c.prefix)} ${code(c.courseNumber ?? c.number ?? '')}`

const groupKey = (g: CourseGroup) => `${g.institutionId}|${[...g.courses].sort().join('+')}`
const ucLabel = (c: RawCourse) => `${c.prefix.trim()} ${c.courseNumber.trim()}`

const cellKey = (cell: { type: string; course?: RawCourse; series?: RawSeries }): string | null =>
  cell.series ? cell.series.name : cell.course ? ucLabel(cell.course) : null
/** UC courses a cell needs (all of them); null for an "Or" series, which only matches by key. */
const ucSet = (cell: { course?: RawCourse; series?: RawSeries }): string[] | null =>
  cell.series ? (word(cell.series.conjunction) === 'or' ? null : cell.series.courses.map(ucLabel)) : cell.course ? [ucLabel(cell.course)] : null
const addGroups = (req: Requirement, groups: CourseGroup[]) => {
  const seen = new Set(req.groups.map(groupKey))
  req.groups.push(...groups.filter((g) => !seen.has(groupKey(g)) && seen.add(groupKey(g))))
}

/** Most alternatives one "And" range of sending groups may expand to; more fails the row closed (NOT_LISTED). */
export const MAX_ALTERNATIVES = 64

/**
 * Expand a sending articulation into flat CourseGroups (alternatives, any one of which satisfies the row): the DNF of
 * its course groups joined by `courseGroupConjunctions` (C-1). An "And" group is one alternative with all its courses,
 * an "Or" group one alternative per course; an "And" range of groups is the cross product of its groups'
 * alternatives; groups outside any "And" range are alternatives on their own.
 * Unreadable sending groups are counted in `dropped`: an And group with any unreadable course is dropped whole (M-1),
 * and so is every "And" range containing a dropped or empty group. `failed` (row NOT_LISTED at this college, no
 * groups) when the conjunction list cannot be read or a range expands past MAX_ALTERNATIVES.
 */
function sendingGroups(inst: number, sa: RawArticulation['articulation']['sendingArticulation'], catalog: Record<CourseId, Course>, dropped: { n: number }): { groups: CourseGroup[]; failed?: string } {
  if (!sa) return { groups: [] }
  const readable = (c: RawCourse | null | undefined): c is RawCourse =>
    !!c && typeof c.prefix === 'string' && typeof c.courseNumber === 'string' && !!c.prefix.trim() && !!c.courseNumber.trim()
  const raw: RawSendingGroup[] = Array.isArray(sa.items) ? sa.items : []
  const byId = new Map<CourseId, RawCourse>()
  // Per group: its alternatives, or 'dropped' (unreadable, already counted) / 'empty' (no courses at all).
  const alts = raw.map((g): string[][] | 'dropped' | 'empty' => {
    const all = Array.isArray(g?.items) ? g.items : []
    const items = all.filter(readable)
    const or = word(g?.courseConjunction) === 'or' // anything else reads as the stricter "And"
    if (!or && items.length !== all.length) { dropped.n++; return 'dropped' }
    if (!items.length) { if (all.length) { dropped.n++; return 'dropped' } return 'empty' }
    const ids = items.map((c) => { const id = courseId(inst, c); byId.set(id, c); return id })
    return or ? ids.map((id) => [id]) : [ids]
  })

  // Blocks of group indexes joined by "And"; every other group is a block of its own.
  const conj = sa.courseGroupConjunctions
  if (conj != null && !Array.isArray(conj)) return { groups: [], failed: 'courseGroupConjunctions is not a list' }
  const blockOf: number[] = raw.map((_, i) => i)
  if (conj?.length) {
    const withPos = raw.filter((g) => Number.isInteger(g?.position)).length
    if (withPos && withPos !== raw.length) return { groups: [], failed: 'some course groups have no position' }
    const posOf = raw.map((g, i) => (withPos ? g.position! : i))
    if (new Set(posOf).size !== posOf.length) return { groups: [], failed: 'duplicate course-group positions' }
    const owner = new Map<number, number>() // group index -> conjunction entry that covers it
    for (const [ci, c] of conj.entries()) {
      const b = c?.sendingCourseGroupBeginPosition, e = c?.sendingCourseGroupEndPosition, j = word(c?.groupConjunction)
      if (!c || typeof c !== 'object') return { groups: [], failed: `entry ${ci} is not an object` }
      if (j !== 'and' && j !== 'or') return { groups: [], failed: `entry ${ci}: conjunction ${JSON.stringify(c.groupConjunction)}` }
      if (!Number.isInteger(b) || !Number.isInteger(e) || (b as number) > (e as number)) return { groups: [], failed: `entry ${ci}: positions ${JSON.stringify([b, e])}` }
      if (!posOf.includes(b as number) || !posOf.includes(e as number)) return { groups: [], failed: `entry ${ci}: positions ${b}-${e} not in the course groups` }
      const members = posOf.flatMap((p, i) => (p >= (b as number) && p <= (e as number) ? [i] : []))
      if (members.some((i) => owner.has(i))) return { groups: [], failed: `entry ${ci}: overlapping ranges` }
      members.forEach((i) => owner.set(i, ci))
      if (j === 'and') members.forEach((i) => (blockOf[i] = members[0]))
    }
  }

  const out: CourseGroup[] = []
  for (const head of new Set(blockOf)) {
    const members = blockOf.flatMap((h, i) => (h === head ? [i] : []))
    const parts = members.map((i) => alts[i])
    if (members.length === 1) { if (Array.isArray(parts[0])) out.push(...parts[0].map((courses) => ({ institutionId: inst, courses }))); continue }
    // An "And" range with a dropped or empty group cannot be satisfied as ASSIST states it: drop the whole range.
    if (parts.some((a) => !Array.isArray(a))) { if (!parts.includes('dropped')) dropped.n++; continue }
    const lists = parts as string[][][]
    if (lists.reduce((n, a) => n * a.length, 1) > MAX_ALTERNATIVES) return { groups: [], failed: `"And" range expands to over ${MAX_ALTERNATIVES} alternatives` }
    const combos = lists.reduce<string[][]>((acc, a) => acc.flatMap((x) => a.map((y) => [...new Set([...x, ...y])])), [[]])
    out.push(...combos.map((courses) => ({ institutionId: inst, courses })))
  }
  for (const id of new Set(out.flatMap((g) => g.courses))) {
    const c = byId.get(id)!
    catalog[id] ??= { id, institutionId: inst, prefix: code(c.prefix), number: code(c.courseNumber), title: c.courseTitle, units: c.minUnits }
  }
  return { groups: out }
}

const byPos = (a: { position: number }, b: { position: number }) => a.position - b.position

/**
 * Text of a template cell normalize does not model (M-3: a GE area, a "Requirement" text cell, a course cell with no
 * course). The field names are best guesses at ASSIST's; without any, the cell's type and id are used.
 */
const cellText = (c: unknown): string => {
  const x = (c ?? {}) as Record<string, any>
  for (const v of [x.requirement?.name, x.requirement?.description, x.generalEducationArea?.name, x.generalEducationArea?.code, x.name, x.text, x.content, x.title, x.description]) {
    if (typeof v === 'string' && v.trim()) return v.trim().replace(/\s+/g, ' ')
  }
  return `${typeof x.type === 'string' ? x.type : 'unknown'} cell ${x.id ?? '?'}`
}
/** Requirement id of an unmodelled template cell. */
const unmodeledKey = (c: unknown): string => `NOT MODELLED: ${(c as { id?: unknown })?.id ?? cellText(c)}`

/** Requirement shape of a payload's template: titles, group conjunctions, N-of advisements and UC cells, in order. */
const templateShape = (p: RawPayload) => {
  const assets = parsed<(RawGroup | RawTitle)[]>(p, 'templateAssets')
  return JSON.stringify([...assets].sort(byPos).flatMap<unknown>((a) =>
    a.type === 'RequirementTitle' ? [a.content]
    : a.type === 'RequirementGroup' ? [[word(a.instruction?.type), word(a.instruction?.conjunction), a.instruction?.amount ?? 0, (a.sections ?? []).map((x) =>
        [word(x?.type), (x?.advisements ?? []).map((v) => [word(v?.type), v?.amount ?? 0]), (x?.rows ?? []).map((r) => (r?.cells ?? []).map((c) => cellKey(c) ?? cellText(c)))])]]
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

  const unreadable: string[] = [], unrecorded: string[] = [], unjoined: string[] = []
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
      const dropped = { n: 0 }
      const { groups, failed } = sendingGroups(inst, a.articulation.sendingArticulation, catalog, dropped)
      if (dropped.n) unreadable.push(`${key} at ${inst}`)
      if (failed) unjoined.push(`${key} at ${inst} (${failed})`)
      const why = a.articulation.sendingArticulation?.noArticulationReason
      if (!groups.length && !dropped.n && !failed && !(typeof why === 'string' && why.trim())) unrecorded.push(`${key} at ${inst}`)
      if (groups.length) addGroups(req, groups)
      // No groups: UC-only only on an explicit ASSIST reason; missing proof never defers the row (H-2, decision 2).
      else (req.noArticulation ??= {})[inst] = (!dropped.n && !failed && ucOnlyReason(a.articulation.sendingArticulation?.noArticulationReason)) || NOT_LISTED
      reqs.set(key, req)
      const cell = cells.get(key) ?? { uc: ucSet(a.articulation), groups: [] }
      cell.groups.push(...groups)
      cells.set(key, cell)
    }
  }

  if (unrecorded.length) console.warn(`normalize: ${first.result.name}: articulation with no courses and no ASSIST reason, kept as "${NOT_LISTED}": ${unrecorded.join('; ')}`)
  if (unjoined.length) console.warn(`normalize: ${first.result.name}: sending course-group conjunctions not applied, kept as "${NOT_LISTED}": ${unjoined.join('; ')}`)
  if (unreadable.length) console.warn(`normalize: ${first.result.name}: unreadable sending course (blank prefix or number), whole articulation group dropped: ${unreadable.join('; ')}`)
  const leaf = (k: string): Requirement => {
    if (!reqs.has(k)) reqs.set(k, { kind: 'req', id: k, label: k, units: 0, groups: [], noArticulation: Object.fromEntries(sendingIds.map((id) => [id, NOT_LISTED])) })
    return reqs.get(k)!
  }
  const prune = (n: ReqNode): ReqNode | null => {
    const children = n.children
      .map((c) => (c.kind === 'node' ? prune(c) : c.groups.length || c.noArticulation ? c : null))
      .filter((c): c is ReqNode | Requirement => !!c)
    return children.length ? { ...n, children } : null
  }
  const placed = new Map<string, string[] | null>() // tree requirement key -> UC courses it needs
  const notes = { oddSection: new Set<string>(), unmodeled: new Set<string>(), units: new Set<string>(), instruction: new Set<string>() }
  const ambiguous = new Map<string, string>() // title -> why it was kept required
  /** Tree nodes for one template. Each group takes the nearest RequirementTitle before it by position, and is required
   *  only if that title's section is (`sectionRules`). */
  const build = (assets: (RawGroup | RawTitle)[], keep: (k: string) => boolean, suffix = '') => {
    const out: ReqNode[] = []
    const sorted = [...assets].sort(byPos)
    const rules = sectionRules(sorted.filter((a): a is RawTitle => a.type === 'RequirementTitle').map((a) => a.content ?? ''))
    let title = '', rule: SectionRule = { required: true, ambiguous: false, rule: 'untitled' }, ti = 0
    for (const asset of sorted) {
      if (asset.type === 'RequirementTitle') { title = asset.content ?? ''; rule = rules[ti++] }
      if (asset.type !== 'RequirementGroup') continue
      const required = rule.required
      // Every section with rows is read, whatever its type says; a type other than "Section" is warned about (M-3).
      const sections: ReqNode[] = (asset.sections ?? [])
        .filter((s) => s?.rows?.length)
        .map((s) => {
          if (word(s.type) !== 'section') notes.oddSection.add(`${JSON.stringify(s.type)} in "${title}"`)
          const rows = s.rows!.map((r): ReqNode | Requirement => {
            const cells = (r?.cells ?? []).flatMap((c): Requirement[] => {
              const k = cellKey(c)
              if (k) { if (!keep(k)) return []; if (!placed.has(k)) placed.set(k, ucSet(c)); return [leaf(k)] }
              // Not a UC course or series: a required counselor row, never silently dropped (M-3).
              const u = unmodeledKey(c)
              if (!keep(u)) return []
              if (!reqs.has(u)) {
                reqs.set(u, { kind: 'req', id: u, label: cellText(c), units: 0, groups: [], noArticulation: Object.fromEntries(sendingIds.map((id) => [id, NOT_LISTED])) })
                notes.unmodeled.add(`"${cellText(c)}" in "${title}"`)
              }
              return [reqs.get(u)!]
            })
            return cells.length === 1 ? cells[0] : { kind: 'node', type: 'OR', required, children: cells }
          })
          const adv = s.advisements ?? []
          // "Complete N units from the following" is not modelled: kept as "take all" (stricter), with a warning (L-1).
          const units = adv.find((a) => word(a?.type) === 'nfollowingunits')
          if (units) notes.units.add(`"${title}" (${units.amount} units)`)
          const nOf = units ? undefined : adv.find((a) => word(a?.type) === 'nfollowing')
          // "choose 0" (or a missing amount) is kept as is: the validator rejects it and verify never counts it as met (TESTER2 M-3)
          if (nOf && !(Number.isInteger(nOf.amount) && nOf.amount >= 1)) console.warn(`normalize: ${first.result.name}: NFollowing ${nOf.amount} in "${title}"`)
          return nOf ? { kind: 'node', type: 'N_OF', n: nOf.amount, required, children: rows } : { kind: 'node', type: 'AND', required, children: rows }
        })
      // The group's instruction joins its sections: "Conjunction" And / Or, or "NFollowing" (N of the sections).
      // Anything else reads as the stricter AND, with a warning (L-1).
      const ins = asset.instruction, kind = word(ins?.type), j = word(ins?.conjunction)
      let type: ReqNode['type'] = 'AND', n: number | undefined
      if (kind === 'conjunction' && j === 'or') type = 'OR'
      else if (kind === 'nfollowing') {
        type = 'N_OF'; n = ins!.amount
        if (!(Number.isInteger(n) && n! >= 1)) console.warn(`normalize: ${first.result.name}: NFollowing ${n} in "${title}"`)
      } else if (kind && !(kind === 'conjunction' && j === 'and')) notes.instruction.add(`${JSON.stringify(ins)} in "${title}"`)
      const t = (title + suffix).trim()
      // One section: the group is that section (keeps its N_OF). Several: the group's conjunction joins them.
      const node = prune(sections.length === 1 && !(type === 'N_OF' && n !== 1) ? { ...sections[0], title: t }
        : { kind: 'node', type, ...(type === 'N_OF' ? { n } : {}), title: t, required, children: sections })
      if (node) out.push(node)
      if (node && required && rule.ambiguous) ambiguous.set(title, rule.rule)
    }
    return out
  }

  // The tree is built from the FIRST payload's template.
  const children = build(parsed(first, 'templateAssets'), () => true)
  const flush = () => {
    if (notes.oddSection.size) console.warn(`normalize: ${first.result.name}: template section type is not "Section", read as one: ${[...notes.oddSection].join('; ')}`)
    if (notes.unmodeled.size) console.warn(`normalize: ${first.result.name}: template cell not modelled (not a UC course or series), kept as "${NOT_LISTED}" at every college: ${[...notes.unmodeled].join('; ')}`)
    if (notes.units.size) console.warn(`normalize: ${first.result.name}: NFollowingUnits not modelled, every course in the section kept required: ${[...notes.units].join('; ')}`)
    if (notes.instruction.size) console.warn(`normalize: ${first.result.name}: unknown group instruction, sections joined by AND: ${[...notes.instruction].join('; ')}`)
    Object.values(notes).forEach((x) => x.clear())
  }
  flush()
  if (ambiguous.size) console.warn(`normalize: ${first.result.name}: ambiguous section title, kept required: ${[...ambiguous].map(([t, why]) => `"${t}" (${why})`).join('; ')}`)

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

  // Articulations still outside the tree belong to requirements only other templates list. Never drop them: add them
  // as groups built from their own college's template, keeping its section's required-ness (M-2). Colleges that
  // articulate nothing for such a row are NOT_LISTED there, so their students are sent to a counselor.
  const leftover = new Set([...cellsOf].flatMap(([inst, cells]) => [...cells].filter(([k, c]) => c.groups.length && !used.has(`${inst}|${k}`)).map(([k]) => k)))
  if (leftover.size) {
    for (const p of payloads.slice(1)) children.push(...build(parsed(p, 'templateAssets'), (k) => leftover.has(k) && !placed.has(k), ' (only in some colleges\' agreements)'))
    flush()
    const added = [...leftover].filter((k) => placed.has(k)), orphan = [...leftover].filter((k) => !placed.has(k))
    for (const k of added) {
      const req = reqs.get(k)!
      for (const inst of sendingIds) if (!req.groups.some((g) => g.institutionId === inst) && !req.noArticulation?.[inst]) (req.noArticulation ??= {})[inst] = NOT_LISTED
    }
    if (added.length) console.warn(`normalize: ${first.result.name}: not in college ${sendingIds[0]}'s template, added with their section's required-ness (${NOT_LISTED} at colleges without it): ${added.join('; ')}`)
    if (orphan.length) console.warn(`normalize: ${first.result.name}: articulated but in no template, not added: ${orphan.join('; ')}`)
  }

  const anyRequired = (n: ReqNode | Requirement): boolean => n.kind === 'req' || (n.required && n.children.some(anyRequired))
  if (!children.some(anyRequired)) console.warn(`normalize: ${first.result.name}: no required rows; the agreement can never read as complete`)

  return {
    receivingId: parsed<{ id: number }>(first, 'receivingInstitution').id,
    major: first.result.name,
    year: parsed<{ code: string }>(first, 'academicYear').code,
    sendingIds,
    root: { kind: 'node', type: 'AND', required: true, children },
    catalog,
  }
}
