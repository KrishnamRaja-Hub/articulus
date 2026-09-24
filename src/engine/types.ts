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
  type: 'AND' | 'OR' | 'N_OF'
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

/** units: home-system units, nearest 0.5. overCap: one course alone exceeds the per-term unit cap. */
export interface Term { name: string; courses: CourseId[]; units: number; overCap?: boolean }

export interface Plan {
  terms: Term[]
  chosen: Record<string, CourseGroup>      // requirementId -> group the solver picked
  result: ValidationResult                 // verification of taken + planned
  totalUnits: number
  unsolvable: string[]                     // required reqs with no group at allowed colleges
  optimal?: boolean                        // true: planned set proven unit-minimal; false: heuristic fallback
}
