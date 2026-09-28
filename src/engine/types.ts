/** `${institutionId}:${prefix} ${number}` e.g. "113:PHYS 4B" */
export type CourseId = string

export interface Course {
  id: CourseId
  institutionId: number
  prefix: string
  number: string
  title: string
  units: number
}

/** All courses must be taken, all at this one college. */
export interface CourseGroup {
  institutionId: number
  courses: CourseId[]
}

/** Satisfied by ANY one complete group. */
export interface Requirement {
  kind: 'req'
  id: string          // UC course label, e.g. "PHYSICS 7B" or series name
  label: string       // UC course title
  units: number       // UC-side units, informational
  groups: CourseGroup[]
  noArticulation?: Record<number, string>  // institutionId -> reason
}

export interface ReqNode {
  kind: 'node'
  /** UNITS: "complete N units from the following" (ASSIST NFollowingUnits): met when the chosen alternatives, each
   *  with courses of its own, add up to at least `n` units (the rows' `units`). */
  type: 'AND' | 'OR' | 'N_OF' | 'UNITS'
  n?: number
  title?: string
  required: boolean
  children: (ReqNode | Requirement)[]
}

export interface Institution { id: number; name: string; short: string; isCC: boolean; terms: 'quarter' | 'semester' }

export interface Agreement {
  receivingId: number
  major: string
  year: string
  sendingIds: number[]
  root: ReqNode
  catalog: Record<CourseId, Course>
}

export interface Partial { institutionId: number; have: CourseId[]; missing: CourseId[] }

export interface Violation {
  requirementId: string
  label: string
  partials: Partial[]
  /** true: the agreement still needs this requirement, so the split fails the plan. false: the pieces earn no
   *  credit, but the plan does not depend on this requirement (optional subtree, or an alternative not needed). */
  blocking: boolean
}

export interface ValidationResult {
  isValid: boolean
  satisfied: Record<string, CourseGroup>   // requirementId -> group that satisfied it
  missing: string[]                        // required requirement ids not satisfied
  incomplete: Record<string, Partial>      // single-college partial progress
  splitSeriesViolations: Violation[]      // blocking ones fail isValid; non-blocking ones are warnings
  /** required requirement ids no sending college in the agreement articulates: completed at the university
   *  after transfer. They do not make isValid false and are never "missing". */
  deferred: string[]
}

/** A calendar period at one kind of college (H-3). units: home-system units, nearest 0.5. span: the quarter periods
 *  it covers on the shared timeline (see engine/calendar.ts); terms whose spans intersect run concurrently.
 *  load: the heaviest combined units, across this term and every term overlapping it, in any quarter period it
 *  covers. overCap: load exceeds the per-term unit cap (only when one course alone is bigger than the cap). */
export interface Term {
  name: string; courses: CourseId[]; units: number; overCap?: boolean
  system?: 'quarter' | 'semester'; season?: 'Fall' | 'Winter' | 'Spring' | 'Summer'; year?: number  // Summer: opt-in only
  span?: [number, number]; load?: number
  concurrent?: string[]   // names of the other planned terms that overlap this one
}

export interface Plan {
  terms: Term[]
  chosen: Record<string, CourseGroup>      // requirementId -> group the solver picked
  result: ValidationResult                 // verification of taken + planned
  totalUnits: number
  unsolvable: string[]                     // required reqs with no group at allowed colleges
  optimal?: boolean                        // true: planned set proven minimal-cost (solve: units + penalties); false: not proven
  /** Planned courses that no chosen group needs: enrollment prerequisites of other planned courses, at the same college
   *  (inferred, sequence.ts). They are in `terms` and `totalUnits`. Absent when there are none. */
  prereqOnly?: string[]
  /** Human-readable prerequisite notes, e.g. an inferred prerequisite the agreement lists only at another college. */
  prereqWarnings?: string[]
  /** preferHome only (solve.ts): each chosen requirement planned at a college other than home, in plain words.
   *  Absent when there are none. */
  fallbacks?: Fallback[]
}

/** Courses planned away from the home college (preferHome), with the plain-words reason in `note`.
 *  reason 'not-at-home': home has no articulated course for the requirement; 'no-data': home articulates it but its
 *  course data is missing; 'started': the student already began that college's series; 'series': part of the series
 *  of a requirement home cannot cover (taking it at home would take it twice); 'prerequisite': needed to enroll in a
 *  later course there (requirementIds empty). `courses`: planned courses, each listed in one entry only. */
export interface Fallback {
  requirementIds: string[]
  institutionId: number
  courses: CourseId[]
  reason: 'not-at-home' | 'no-data' | 'started' | 'series' | 'prerequisite'
  note: string
}
