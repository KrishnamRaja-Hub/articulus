/*
 * Behavioral canaries: known truths about real ASSIST data that must hold after every refresh.
 * `minNormalizeVersion`: DATA-DEPENDENT on the normalize fixes (FIXES F-01..F-03); data built by an older normalize
 * is expected to fail them and they are reported as "legacy" in CI mode.
 * `severity: 'warning'`: counselor findings (COUNSELOR_REPORT.md) not yet confirmed against a fresh fetch; promote
 * to 'error' once a refresh confirms them.
 */
import type { Agreement, ReqNode, Requirement } from '../../src/engine/types.ts'
import { sectionRules, type SectionRule } from '../../src/engine/normalize.ts'
import { verifySchedule } from '../../src/engine/verify.ts'

export interface Canary {
  id: string
  description: string
  severity: 'error' | 'warning'
  minNormalizeVersion?: number
  /** Agreement it runs on; omitted = every agreement. */
  target?: { receivingId: number; major: RegExp }
  /** null = pass; otherwise why it failed. */
  check: (a: Agreement) => string | null
}

const DA = 113, FH = 51
type Node = ReqNode | Requirement
/** Rows with their parent node and whether every ancestor is required. */
export const rows = (root: ReqNode) => {
  const out: { req: Requirement; parent: ReqNode; required: boolean; titles: string[] }[] = []
  const walk = (n: Node, parent: ReqNode | null, required: boolean, titles: string[]) => {
    if (n.kind === 'req') { out.push({ req: n, parent: parent!, required, titles }); return }
    for (const c of n.children) walk(c, n, required && n.required, n.title ? [...titles, n.title] : titles)
  }
  walk(root, null, true, [])
  return out
}

/**
 * Top-level groups with the section rule their titles resolve to, in order (normalize v3, TESTER1 H-4). Requirements
 * only other colleges' templates list ("only in some colleges") are always optional and are left out.
 */
export const sections = (root: ReqNode): [ReqNode, SectionRule][] => {
  const top = root.children.filter((n): n is ReqNode => n.kind === 'node' && !/only in some colleges/i.test(n.title ?? ''))
  const rules = sectionRules(top.map((n) => n.title ?? ''))
  return top.map((n, i) => [n, rules[i]])
}

export const CANARIES: Canary[] = [
  {
    id: 'canary.berkeley-me.phys-split-blocks',
    description: 'UC Berkeley ME: De Anza PHYS 4B + Foothill PHYS 4C is a blocking split on PHYSICS 7B (README "The trap")',
    severity: 'error',
    target: { receivingId: 79, major: /Mechanical Engineering/ },
    check: (a) => {
      const r = verifySchedule(new Set([`${DA}:PHYS 4B`, `${FH}:PHYS 4C`]), a)
      const v = r.splitSeriesViolations.find((x) => x.requirementId === 'PHYSICS 7B')
      if (!v) return 'no split violation on PHYSICS 7B'
      if (!v.blocking) return 'PHYSICS 7B split is not blocking'
      if (r.isValid) return 'isValid is true'
      return null
    },
  },
  {
    id: 'canary.berkeley-me.phys-same-college',
    description: 'UC Berkeley ME: De Anza PHYS 4B + 4C satisfies PHYSICS 7B with no violation',
    severity: 'error',
    target: { receivingId: 79, major: /Mechanical Engineering/ },
    check: (a) => {
      const r = verifySchedule(new Set([`${DA}:PHYS 4B`, `${DA}:PHYS 4C`]), a)
      if (r.satisfied['PHYSICS 7B']?.institutionId !== DA) return 'PHYSICS 7B not satisfied at De Anza'
      if (r.splitSeriesViolations.length) return `unexpected violations: ${r.splitSeriesViolations.map((v) => v.requirementId).join(', ')}`
      return null
    },
  },
  {
    id: 'canary.ucla-me.math31a-required',
    description: 'UCLA ME requires MATH 31A (COUNSELOR_REPORT CRITICAL-1): it is not under a recommended subtree, and a transcript with every non-math course is not valid',
    severity: 'error',
    minNormalizeVersion: 2,
    target: { receivingId: 117, major: /Mechanical Engineering/ },
    check: (a) => {
      const row = rows(a.root).find((r) => r.req.id === 'MATH 31A')
      if (!row) return 'no MATH 31A row'
      if (!rows(a.root).some((r) => r.req.id === 'MATH 31A' && r.required)) return `MATH 31A is optional (under "${row.titles.join(' / ')}")`
      const noMath = Object.values(a.catalog).filter((c) => !/^MATH/i.test(c.prefix)).map((c) => c.id)
      if (verifySchedule(new Set(noMath), a).isValid) return 'every non-math course gives a valid verdict'
      return null
    },
  },
  {
    id: 'canary.berkeley-me.foothill-chem',
    description: 'UC Berkeley ME: Foothill articulates the required chemistry row (COUNSELOR_REPORT HIGH-1, F-01)',
    severity: 'warning',
    minNormalizeVersion: 2,
    target: { receivingId: 79, major: /Mechanical Engineering/ },
    check: (a) => {
      const chem = rows(a.root).filter((r) => r.required && /^CHEM 1A\b/.test(r.req.id))
      if (!chem.length) return 'no required CHEM 1A row'
      return chem.some((r) => r.req.groups.some((g) => g.institutionId === FH)) ? null : 'no Foothill group on the required CHEM 1A row'
    },
  },
  {
    id: 'canary.davis-me.composition-choice',
    description: 'UC Davis ME: composition/communication is a choice, not "take all" (COUNSELOR_REPORT HIGH-3, F-02)',
    severity: 'warning',
    minNormalizeVersion: 2,
    target: { receivingId: 89, major: /Mechanical Engineering/ },
    check: (a) => {
      const r = rows(a.root).find((x) => x.req.id === 'UWP 001')
      if (!r) return 'no UWP 001 row'
      const choice = (n: ReqNode) => n.type === 'OR' || (n.type === 'N_OF' && (n.n ?? 1) < n.children.length)
      return choice(r.parent) ? null : `UWP 001 sits in a ${r.parent.type} of ${r.parent.children.length} rows`
    },
  },
  {
    id: 'canary.uci-me.admission-only',
    description: 'UC Irvine ME: only the admission section can fail a plan; "necessary to graduate in two years" and elective sections are optional, so one college can complete the major (TESTER1 H-4)',
    severity: 'warning',
    minNormalizeVersion: 3,
    target: { receivingId: 120, major: /Mechanical Engineering/ },
    check: (a) => {
      const advisory = sections(a.root).filter(([n, r]) => n.required && !r.required)
      if (advisory.length) return `advisory sections are required: ${advisory.map(([n, r]) => `"${n.title}" (${r.rule})`).join('; ')}`
      // permanently unmet = no college's full course list completes it
      const at = (inst: number) => verifySchedule(new Set(Object.values(a.catalog).filter((c) => c.institutionId === inst).map((c) => c.id)), a)
      if (!a.sendingIds.some((inst) => at(inst).isValid)) return `no single college completes it; with every De Anza course, still missing: ${at(DA).missing.join('; ')}`
      return null
    },
  },
  {
    id: 'canary.all.empty-transcript-invalid',
    description: 'Every agreement: nothing taken never gives a valid ("you are OK") verdict',
    severity: 'error',
    check: (a) => (verifySchedule(new Set(), a).isValid ? 'an empty transcript is valid' : null),
  },
]
