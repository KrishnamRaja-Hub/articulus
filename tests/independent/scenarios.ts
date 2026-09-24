/**
 * Named counselor scenarios on the real fixtures (ported from the counselor tester's catalog, COUNSELOR_REPORT.md).
 * Each one states what a transfer counselor expects by the rules, read off the ASSIST rows by hand, and why.
 *
 * `expect` is the answer the rules give on the current fixtures. Where the correct real-world answer differs because
 * the fixtures predate the normalize fixes (F-01..F-03: COUNSELOR_REPORT CRITICAL-1, HIGH-1..HIGH-4), the scenario is
 * `dataDependent: 'refetch'`: `expect` is enforced only on legacy data and `realWorld` only once data/ is refreshed.
 * `realWorld: undefined` on a refetch scenario means the answer must be re-derived after `npm run fetch`.
 *
 * Independent of src/ (types only): taken lists are built from the fixture rows, never from the app.
 */
import type { CourseId } from '../../src/engine/types'
import { CCSF, DA, DVC, FH, FILES as F, INDEX, IVC, MIS, OCC, PCC, SMC, loadAgreement, CCS } from './fixtures.ts'
import { uniqueRows } from './oracle.ts'

export interface Expect {
  valid: boolean
  sat?: string[]              // rows satisfied
  unsat?: string[]            // rows not satisfied
  split?: string[]            // rows that are split series; [] = no split at all (unless `warn` lists some)
  blocking?: string[]         // split series that fail the plan
  warn?: string[]             // split series that are warnings only
  notSplit?: string[]
  deferred?: string[]         // exactly the rows completed at the UC after transfer
  missingIncludes?: string[]  // rows named as still needed
}
export interface PlanExpect {
  validPlan?: boolean         // unsolvable is empty
  notPlanned?: CourseId[]
  mustPlan?: CourseId[]
  onlyAt?: number[]
  unsolvableMentions?: string[]
  unsolvableExcludes?: string[]
  offeredAtIncludes?: string[]
  counselor?: boolean         // some unsolvable entry sends the student to a counselor
}
export interface Scenario {
  id: string
  name: string
  file: string
  taken: CourseId[]
  allowed: number[]
  home: number
  expect: Expect
  plan?: PlanExpect
  /** one-line counselor rationale */
  why: string
  story?: 'Plan.md Scenario 1' | 'Plan.md Scenario 2' | 'Plan.md Scenario 3'
  dataDependent?: 'refetch'
  realWorld?: { expect: Expect; plan?: PlanExpect; why: string; finding: string }
  /** the rule gives this answer, but a counselor would add a caveat (not a failure) */
  ruleRisk?: string
  /** a documented app deviation on hostile input the UI cannot produce; the verdict must still match */
  knownAppDeviation?: { finding: string; rows: string[] }
}

const at = (inst: number) => (...xs: string[]): CourseId[] => xs.map((x) => `${inst}:${x}`)
const da = at(DA), fh = at(FH), smc = at(SMC)

/** Input construction only: the courses of the i-th ASSIST group listed for `row` at college `inst`. */
const grp = (file: string, row: string, inst: number, i = 0): CourseId[] => {
  const g = uniqueRows(loadAgreement(file)).find((r) => r.id === row)?.groups.filter((x) => x.institutionId === inst)[i]
  if (!g) throw new Error(`no group ${file} ${row} @${inst}`)
  return g.courses
}
const everything = (file: string): CourseId[] => Object.keys(loadAgreement(file).catalog)

// Rest-of-major transcripts, hand-assembled from the fixture rows.
const BME_MATH_DA = da('MATH 1A', 'MATH 1B', 'MATH 1C', 'MATH 1D', 'MATH 2A', 'MATH 2B')
const BME_CHEM_DA = da('CHEM 1A', 'CHEM 1B', 'CHEM 1C')
const BME_FULL_DA = [...BME_MATH_DA, ...da('PHYS 4A', 'PHYS 4B', 'PHYS 4C'), ...BME_CHEM_DA]
const BEECS_CORE_DA = [...BME_MATH_DA, ...da('PHYS 4A', 'PHYS 4B', 'PHYS 4C')]
const LAME_REST = [...da('CHEM 1A', 'CHEM 1B', 'CHEM 1C', 'ENGL C1000', 'CIS 22B'), ...fh('ENGR 11', 'ENGR 37L', 'ENGR 47'), ...at(DVC)('ENGIN 230', 'ENGIN 257', 'ENGIN 240')]
const SDECE_CC = [...da('MATH 1A', 'MATH 1B', 'MATH 1C', 'MATH 1D', 'MATH 2A', 'MATH 2B', 'PHYS 4A', 'PHYS 4B', 'PHYS 4C', 'PHYS 4D'), ...at(CCSF)('CS 270')]
const SDECE_DEF = ['ECE 35', 'ECE 45', 'ECE 5', 'ECE 65', 'ECE 15', 'ECE 25']
const DME_FULL = [...da('CHEM 1A', 'CHEM 1B', 'ENGR 35', 'ENGR 37', 'MATH 1A', 'MATH 1B', 'MATH 1C', 'MATH 1D', 'MATH 2A', 'MATH 2B', 'PHYS 4A', 'PHYS 4B', 'PHYS 4C', 'ENGL C1000', 'NAIS 15', 'ELIT 39', 'EWRT 1B', 'COMM C1000'),
  ...fh('ENGR 11', 'ENGR 6', 'ENGR 45'), ...smc('ENGL 3', 'ENGL 4'), ...at(DVC)('ENGIN 110')]
const ICS_FULL = [...da('CIS 40', 'CIS 41A', 'CIS 41B', 'MATH 1A', 'MATH 1B', 'MATH 23', 'CIS 29', 'CIS 22A', 'CIS 22B', 'CIS 22C', 'MATH 22', 'MATH 2B'), ...at(OCC)('CS A253'), ...fh('C S 40A'), ...at(IVC)('CS 40A', 'CS 40B')]
const IME_FULL = [...da('CHEM 1A', 'CIS 22B', 'PHYS 4A', 'PHYS 4B', 'PHYS 4C', 'MATH 1A', 'MATH 1B', 'MATH 1D', 'MATH 2A', 'MATH 2B', 'ENGR 35', 'ENGR 37', 'ECON 2'),
  ...smc('ENGR 11'), ...fh('ENGR 47', 'ENGR 45'), ...at(IVC)('ENGR 91', 'ENGR 7')]
const UCLA_PHYS = 'PHYSICS 1A, PHYSICS 1B, PHYSICS 1C, PHYSICS 4AL, PHYSICS 4BL'
const BME_CHEM_ROW = 'CHEM 1A, CHEM 1AL, CHEM 1B'

type Draft = Omit<Scenario, 'allowed' | 'home'> & { allowed?: number[]; home?: number }
const S: Scenario[] = []
const add = (s: Draft) => {
  const allowed = s.allowed ?? CCS
  S.push({ ...s, allowed, home: s.home ?? (allowed.includes(DA) ? DA : allowed[0]) })
}

/* ---------- A. Plan.md rescind stories ---------- */
add({ id: 'A1', story: 'Plan.md Scenario 2', name: 'Berkeley ME: De Anza PHYS 4A+4B, Foothill PHYS 4C, rest at De Anza', file: F.bme,
  taken: [...BME_MATH_DA, ...BME_CHEM_DA, ...da('PHYS 4A', 'PHYS 4B'), ...fh('PHYS 4C')], allowed: [DA, FH], home: DA,
  expect: { valid: false, sat: ['PHYSICS 7A'], unsat: ['PHYSICS 7B'], blocking: ['PHYSICS 7B'] },
  why: '7B needs 4B+4C from one college; the student split it. Rescind risk.' })
add({ id: 'A2', story: 'Plan.md Scenario 2', name: 'UCLA ME as told: DA PHYS 4A, FH PHYS 4B, DA PHYS 4C, rest complete', file: F.lame,
  taken: [...LAME_REST, ...da('PHYS 4A', 'PHYS 4C'), ...fh('PHYS 4B')], allowed: [DA, FH, DVC], home: DA,
  expect: { valid: false, unsat: [UCLA_PHYS], blocking: [UCLA_PHYS] },
  why: 'UCLA lists the whole 3-course physics series as one row; split across DA/FH earns zero credit.' })
add({ id: 'A3', story: 'Plan.md Scenario 2', name: 'Scenario 2 done right: PHYS 4A/4B/4C all at Foothill, rest complete (UCLA ME, no calculus)', file: F.lame,
  taken: [...LAME_REST, ...fh('PHYS 4A', 'PHYS 4B', 'PHYS 4C')], expect: { valid: true, sat: [UCLA_PHYS] },
  why: 'Physics series from one college.', dataDependent: 'refetch',
  realWorld: { expect: { valid: false, sat: [UCLA_PHYS] }, finding: 'CRITICAL-1',
    why: 'The student took no calculus; UCLA requires MATH 31A-33A for ME. The legacy fixture marks the math "strongly recommended" (F-03 title shift).' } })
add({ id: 'A4', story: 'Plan.md Scenario 1', name: 'DA MATH 1A+1B, then Foothill MATH 1C+1D online (CVC) in the last term, Berkeley ME', file: F.bme,
  taken: [...da('MATH 1A', 'MATH 1B', 'MATH 2A', 'MATH 2B', 'PHYS 4A', 'PHYS 4B', 'PHYS 4C'), ...BME_CHEM_DA, ...fh('MATH 1C', 'MATH 1D')],
  expect: { valid: false, sat: ['MATH 51', 'MATH 53'], unsat: ['MATH 52'], blocking: ['MATH 52'] },
  why: 'MATH 52 = 1B+1C from one college; 1B at DA + 1C at FH is the online-course rescind.' })
add({ id: 'A5', story: 'Plan.md Scenario 1', name: 'Scenario 1 repaired: also retook MATH 1B at Foothill', file: F.bme,
  taken: [...da('MATH 1A', 'MATH 1B', 'MATH 2A', 'MATH 2B', 'PHYS 4A', 'PHYS 4B', 'PHYS 4C'), ...BME_CHEM_DA, ...fh('MATH 1B', 'MATH 1C', 'MATH 1D')],
  expect: { valid: true, sat: ['MATH 51', 'MATH 52', 'MATH 53'], split: [] },
  why: 'FH 1B+1C completes MATH 52 at one college; DA 1B is a duplicate code, not a split.' })
add({ id: 'A6', story: 'Plan.md Scenario 3', name: 'UC Davis CSE: chose the ECS 032A/032B route (ECS 034 never articulated, 032C unrecorded)', file: F.dcse,
  taken: da('CIS 41A', 'CIS 22C'), expect: { valid: false, sat: ['ECS 032A', 'ECS 032B'], unsat: ['ECS 036B'] },
  why: 'That route cannot be completed at a CC; the CC route (036A/B/C) is owed. The tool must not call the choice done.' })
add({ id: 'A7', story: 'Plan.md Scenario 3', name: 'Berkeley EECS: math+physics done, no science (thinks it can wait)', file: F.beecs,
  taken: BEECS_CORE_DA, expect: { valid: false, missingIncludes: ['PHYSICS 7C'] },
  why: 'The science choose-1 has CC routes; it must be done before transfer.' })

/* ---------- B. Berkeley PHYSICS 7B = PHYS 4B+4C, every placement across DA/FH ---------- */
const PLACES = ['none', 'DA', 'FH', 'both'] as const
const place = (course: string, p: (typeof PLACES)[number]) => (p === 'DA' ? da(course) : p === 'FH' ? fh(course) : p === 'both' ? [...da(course), ...fh(course)] : [])
for (const b of PLACES) for (const c of PLACES) {
  const has = (p: string, col: string) => p === col || p === 'both'
  const sat = (has(b, 'DA') && has(c, 'DA')) || (has(b, 'FH') && has(c, 'FH'))
  const colleges = new Set([...(b === 'none' ? [] : b === 'both' ? ['DA', 'FH'] : [b]), ...(c === 'none' ? [] : c === 'both' ? ['DA', 'FH'] : [c])])
  const split = !sat && colleges.size >= 2 && Number(b !== 'none') + Number(c !== 'none') >= 2
  add({ id: `B-${b}-${c}`, name: `Berkeley ME PHYSICS 7B: PHYS 4B at ${b}, PHYS 4C at ${c} (rest complete at DA)`, file: F.bme,
    taken: [...BME_MATH_DA, ...BME_CHEM_DA, ...da('PHYS 4A'), ...place('PHYS 4B', b), ...place('PHYS 4C', c)],
    expect: { valid: sat, [sat ? 'sat' : 'unsat']: ['PHYSICS 7B'], ...(split ? { blocking: ['PHYSICS 7B'] } : { notSplit: ['PHYSICS 7B'] }) },
    why: sat ? 'A whole 4B+4C pair exists at one college.' : split ? 'Pieces at two colleges: split in a needed row, blocking.' : 'Incomplete at one college (or a duplicate): not a split.' })
}

/* ---------- C. UCLA physics series 4A/4B/4C placement ---------- */
for (const pa of ['DA', 'FH'] as const) for (const pb of ['DA', 'FH'] as const) for (const pc of ['DA', 'FH'] as const) {
  const one = pa === pb && pb === pc
  add({ id: `C-${pa}${pb}${pc}`, name: `UCLA EE physics: 4A@${pa} 4B@${pb} 4C@${pc}`, file: F.laee,
    taken: [...place('PHYS 4A', pa), ...place('PHYS 4B', pb), ...place('PHYS 4C', pc)],
    expect: { valid: false, [one ? 'sat' : 'unsat']: [UCLA_PHYS], ...(one ? {} : { blocking: [UCLA_PHYS] }) },
    why: one ? 'One-college series.' : 'Series split: zero credit. (UCLA EE is never valid here: EC ENGR 2/3 have no record.)' })
}
add({ id: 'C-SMC-mid', name: 'UCLA CS physics: DA 4A, Santa Monica PHYSCS 22 via CVC, DA 4C', file: F.lacs, taken: [...da('PHYS 4A', 'PHYS 4C'), ...smc('PHYSCS 22')],
  expect: { valid: false, unsat: [UCLA_PHYS], blocking: [UCLA_PHYS] }, why: 'A third-college piece mid-series.' })
add({ id: 'C-SMC-all', name: 'UCLA CS physics: all at Santa Monica (semester) PHYSCS 21/22/23', file: F.lacs, taken: smc('PHYSCS 21', 'PHYSCS 22', 'PHYSCS 23'),
  expect: { valid: false, sat: [UCLA_PHYS] }, why: 'The whole SMC series.' })
add({ id: 'C-SMC-plus-dup', name: 'UCLA CS physics: SMC 21/22/23 complete + a stray DA 4A', file: F.lacs, taken: [...smc('PHYSCS 21', 'PHYSCS 22', 'PHYSCS 23'), ...da('PHYS 4A')],
  expect: { valid: false, sat: [UCLA_PHYS], notSplit: [UCLA_PHYS] }, why: 'A satisfied row is never a split.' })

/* ---------- D. Berkeley ME calculus MATH 1A-1D placement ---------- */
for (let m = 0; m < 16; m++) {
  const p = (['1A', '1B', '1C', '1D'] as const).map((x, i): [string, 'DA' | 'FH'] => [x, (m >> i) & 1 ? 'FH' : 'DA'])
  const P = Object.fromEntries(p)
  const m51 = (P['1A'] === 'DA' && P['1B'] === 'DA') || P['1A'] === 'FH'
  const m52 = P['1B'] === P['1C'], m53 = P['1C'] === P['1D']
  const sat: string[] = [], unsat: string[] = [], blocking: string[] = []
  ;(m51 ? sat : unsat).push('MATH 51'); (m52 ? sat : unsat).push('MATH 52'); (m53 ? sat : unsat).push('MATH 53')
  if (!m52) blocking.push('MATH 52')
  if (!m53) blocking.push('MATH 53')
  add({ id: `D-${p.map(([, col]) => col[0]).join('')}`, name: `Berkeley ME calculus: ${p.map(([x, col]) => `MATH ${x}@${col}`).join(', ')}`, file: F.bme,
    taken: [...p.flatMap(([x, col]) => (col === 'DA' ? da(`MATH ${x}`) : fh(`MATH ${x}`))), ...da('MATH 2A', 'MATH 2B', 'PHYS 4A', 'PHYS 4B', 'PHYS 4C'), ...BME_CHEM_DA],
    expect: { valid: m51 && m52 && m53, sat, unsat, blocking, ...(m51 ? {} : { notSplit: ['MATH 51'] }) },
    why: 'MATH 51 = DA 1A+1B or FH 1A; MATH 52 = 1B+1C at one college; MATH 53 = 1C+1D at one college.' })
}

/* ---------- E. UCSD MAE PHYS 2A/2B/2C are separate rows ---------- */
for (let m = 0; m < 8; m++) {
  const p = (['4A', '4B', '4C'] as const).map((x, i): [string, 'DA' | 'FH'] => [x, (m >> i) & 1 ? 'FH' : 'DA'])
  const mixed = p.some(([, col]) => col !== p[0][1])
  add({ id: `E-${p.map(([, col]) => col[0]).join('')}`, name: `UCSD MAE physics rows: ${p.map(([x, col]) => `PHYS ${x}@${col}`).join(', ')}`, file: F.sdmae,
    taken: p.flatMap(([x, col]) => (col === 'DA' ? da(`PHYS ${x}`) : fh(`PHYS ${x}`))),
    expect: { valid: false, sat: ['PHYS 2A', 'PHYS 2B', 'PHYS 2C'], split: [] },
    why: 'UCSD articulates each quarter separately, so each row stands alone.',
    ...(mixed ? { ruleRisk: 'Plan.md: DA and FH put thermodynamics in different quarters; mixing can skip or double a topic. Correct by the agreement, but a counselor would warn.' } : {}) })
}

/* ---------- F. Honors ---------- */
add({ id: 'F1', name: 'Berkeley MATH 52: DA MATH 1BH + DA MATH 1C (DA lists an honors twin)', file: F.bme, taken: da('MATH 1BH', 'MATH 1C'), expect: { valid: false, sat: ['MATH 52'] }, why: 'ASSIST lists 1B+1C and 1BH+1CH at DA: regular and honors combine.' })
add({ id: 'F2', name: 'Berkeley MATH 52: DA MATH 1B + DA MATH 1CH', file: F.bme, taken: da('MATH 1B', 'MATH 1CH'), expect: { valid: false, sat: ['MATH 52'] }, why: 'Same twin at DA.' })
add({ id: 'F3', name: 'Berkeley MATH 52: FH MATH 1B + FH MATH 1CH (Foothill lists no honors twin)', file: F.bme, taken: fh('MATH 1B', 'MATH 1CH'), expect: { valid: false, unsat: ['MATH 52'], notSplit: ['MATH 52'] }, why: 'No honors twin at Foothill: 1CH does not stand for 1C.' })
add({ id: 'F4', name: 'Berkeley MATH 52: DA 1BH + FH 1B (same course twice, honors vs regular)', file: F.bme, taken: [...da('MATH 1BH'), ...fh('MATH 1B')], expect: { valid: false, unsat: ['MATH 52'], notSplit: ['MATH 52'] }, why: 'A duplicate, not a split.' })
add({ id: 'F5', name: 'Berkeley MATH 52: DA 1BH + FH 1C', file: F.bme, taken: [...da('MATH 1BH'), ...fh('MATH 1C')], expect: { valid: false, unsat: ['MATH 52'], split: ['MATH 52'] }, why: 'Different courses at two colleges: split.' })
add({ id: 'F6', name: 'UCSD ECE MATH 20E: DA MATH 1CH + 1D (20E lists no honors twin at DA)', file: F.sdece, taken: da('MATH 1CH', 'MATH 1D'), expect: { valid: false, unsat: ['MATH 20E'], sat: ['MATH 20C'] },
  why: '20C lists 1CH+1DH at DA so mixing is sanctioned there; 20E does not.', ruleRisk: 'HIGH-5: a counselor expects UCSD to accept honors Calc III for 20E; ASSIST just does not list it. Confirm with UCSD.' })
add({ id: 'F7', name: 'UCSD ECE MATH 20C: DA 1CH + 1DH', file: F.sdece, taken: da('MATH 1CH', 'MATH 1DH'), expect: { valid: false, sat: ['MATH 20C'], unsat: ['MATH 20E'] }, why: 'An explicit honors group.' })
add({ id: 'F8', name: 'Berkeley MATH 51: DA MATH 1AH + 1B', file: F.bme, taken: da('MATH 1AH', 'MATH 1B'), expect: { valid: false, sat: ['MATH 51'] }, why: 'DA twin 1A+1B / 1AH+1BH.' })
add({ id: 'F9', name: 'Berkeley MATH 51: FH MATH 1AH alone', file: F.bme, taken: fh('MATH 1AH'), expect: { valid: false, sat: ['MATH 51'] }, why: 'An explicit FH group.' })
add({ id: 'F10', name: 'UC Davis MAT 021A: FH MATH 1AH without 1AHP', file: F.dme, taken: fh('MATH 1AH'), expect: { valid: false, unsat: ['MAT 021A'] }, why: 'The FH honors route is 1AH+1AHP.' })
add({ id: 'F11', name: 'UC Davis MAT 021C/D: DA 1CH + 1D', file: F.dme, taken: da('MATH 1CH', 'MATH 1D'), expect: { valid: false, sat: ['MAT 021C, MAT 021D'] }, why: 'An explicit mixed group.' })
add({ id: 'F12', name: 'UCLA MATH 31B: DA 1BH + 1C', file: F.lacs, taken: da('MATH 1BH', 'MATH 1C'), expect: { valid: false, sat: ['MATH 31B'] }, why: 'Explicit.' })
add({ id: 'F13', name: 'Berkeley ME CHEM row: DA CHEM 1AH + 1B + 1CH', file: F.bme, taken: da('CHEM 1AH', 'CHEM 1B', 'CHEM 1CH'), expect: { valid: false, sat: [BME_CHEM_ROW] }, why: 'DA twin groups.' })
add({ id: 'F14', name: 'Berkeley ME CHEM row: DA CHEM 1A+1B + FH CHEM 1C', file: F.bme, taken: [...da('CHEM 1A', 'CHEM 1B'), ...fh('CHEM 1C')],
  expect: { valid: false, unsat: [BME_CHEM_ROW], notSplit: [BME_CHEM_ROW] },
  why: 'The legacy fixture has no Foothill group for this row, so FH 1C is not progress on it.', dataDependent: 'refetch',
  realWorld: { expect: { valid: false, unsat: [BME_CHEM_ROW], split: [BME_CHEM_ROW], blocking: [BME_CHEM_ROW] }, finding: 'HIGH-1',
    why: 'ASSIST articulates Foothill CHEM 1A-1C (orphaned by the old normalize, F-01): DA 1A+1B with FH 1C is a split.' } })
add({ id: 'F15', name: 'UCSD CSE BILD 1: DA BIOL 6AH + 6B + 6C', file: F.sdcse, taken: da('BIOL 6AH', 'BIOL 6B', 'BIOL 6C'), expect: { valid: false, sat: ['BILD 1'] }, why: 'DA twin.' })
add({ id: 'F16', name: 'Berkeley ME BIO 1B: DA BIOL 6AH + 6C', file: F.bme, taken: da('BIOL 6AH', 'BIOL 6C'), expect: { valid: false, sat: ['BIOLOGY 1B'] }, why: 'Explicit.' })
add({ id: 'F17', name: 'Berkeley MATH 52: DA 1BH + DA 1C + FH 1C', file: F.bme, taken: [...da('MATH 1BH', 'MATH 1C'), ...fh('MATH 1C')], expect: { valid: false, sat: ['MATH 52'], notSplit: ['MATH 52'] }, why: 'Satisfied at DA; the stray FH piece is irrelevant.' })
add({ id: 'F18', name: 'UCI MATH 2A+2B: Orange Coast MATH A182H (one honors course, two rows)', file: F.ics, taken: at(OCC)('MATH A182H'), expect: { valid: false, sat: ['MATH 2A', 'MATH 2B'] }, why: 'ASSIST lists A182H for both.' })

/* ---------- G. CVC third college ---------- */
add({ id: 'G1', name: 'Berkeley MATH 52: DA 1B + SMC MATH 8 via CVC', file: F.bme, taken: [...da('MATH 1B'), ...smc('MATH 8')], expect: { valid: false, sat: ['MATH 52'], notSplit: ['MATH 52'] }, why: 'SMC MATH 8 alone completes MATH 52.' })
add({ id: 'G2', name: 'Berkeley PHYSICS 7B: DA 4B + SMC PHYSCS 23', file: F.bme, taken: [...da('PHYS 4B'), ...smc('PHYSCS 23')], expect: { valid: false, unsat: ['PHYSICS 7B'], split: ['PHYSICS 7B'] }, why: 'DA/SMC pieces.' })
add({ id: 'G3', name: 'Berkeley PHYSICS 7A: SMC PHYSCS 21 + FH PHYS 4A', file: F.bme, taken: [...smc('PHYSCS 21'), ...fh('PHYS 4A')], expect: { valid: false, sat: ['PHYSICS 7A'] }, why: 'FH 4A alone completes 7A.' })
add({ id: 'G4', name: 'Berkeley ME: SMC PHYSCS 21/22/23 (23 shared by 7A and 7B)', file: F.bme, taken: smc('PHYSCS 21', 'PHYSCS 22', 'PHYSCS 23'), expect: { valid: false, sat: ['PHYSICS 7A', 'PHYSICS 7B'] }, why: 'SMC lists 21+23 and 22+23.' })
add({ id: 'G5', name: 'Berkeley PHYSICS 7B: DA 4B + FH 4C + SMC PHYSCS 22 (three colleges)', file: F.bme, taken: [...da('PHYS 4B'), ...fh('PHYS 4C'), ...smc('PHYSCS 22')], expect: { valid: false, split: ['PHYSICS 7B'] }, why: 'A three-college split.' })
add({ id: 'G6', name: 'Berkeley ME: split PHYS 4B/4C DA/FH, then the whole 7B pair at Diablo Valley', file: F.bme,
  taken: [...BME_MATH_DA, ...BME_CHEM_DA, ...da('PHYS 4A', 'PHYS 4B'), ...fh('PHYS 4C'), ...grp(F.bme, 'PHYSICS 7B', DVC)],
  expect: { valid: true, sat: ['PHYSICS 7B'], split: [] }, why: 'Completed at a third college: satisfied, no split.' })
add({ id: 'G7', name: 'UCLA CS physics: DA 4A+4B, then the Pasadena series complete', file: F.lacs, taken: [...da('PHYS 4A', 'PHYS 4B'), ...grp(F.lacs, UCLA_PHYS, PCC)],
  expect: { valid: false, sat: [UCLA_PHYS] }, why: 'The whole Pasadena series.' })

/* ---------- H. Retakes ---------- */
add({ id: 'H1', name: 'Berkeley 7B: DA 4B, FH 4B (retake), DA 4C', file: F.bme, taken: [...da('PHYS 4B', 'PHYS 4C'), ...fh('PHYS 4B')], expect: { valid: false, sat: ['PHYSICS 7B'] }, why: 'Complete at DA.' })
add({ id: 'H2', name: 'Berkeley 7B: DA 4B + FH 4B only', file: F.bme, taken: [...da('PHYS 4B'), ...fh('PHYS 4B')], expect: { valid: false, unsat: ['PHYSICS 7B'], notSplit: ['PHYSICS 7B'] }, why: 'A duplicate.' })
add({ id: 'H3', name: 'Berkeley 7B: DA 4B + FH 4B + FH 4C', file: F.bme, taken: [...da('PHYS 4B'), ...fh('PHYS 4B', 'PHYS 4C')], expect: { valid: false, sat: ['PHYSICS 7B'] }, why: 'Complete at FH.' })
add({ id: 'H4', name: 'UCLA physics: DA 4A,4B + FH 4A,4B,4C (retook the series at FH)', file: F.lacs, taken: [...da('PHYS 4A', 'PHYS 4B'), ...fh('PHYS 4A', 'PHYS 4B', 'PHYS 4C')], expect: { valid: false, sat: [UCLA_PHYS] }, why: 'The FH series is complete.' })
add({ id: 'H5', name: 'UCLA physics: DA 4A + FH 4A (retake) + FH 4B', file: F.lacs, taken: [...da('PHYS 4A'), ...fh('PHYS 4A', 'PHYS 4B')], expect: { valid: false, unsat: [UCLA_PHYS], split: [UCLA_PHYS] },
  why: 'By the rule: two colleges, codes {4A, 4B}: a split.', ruleRisk: 'FH 4A+4B is a clean one-college start and the DA 4A retake is harmless; "split" is alarming but the row is incomplete either way.' })
add({ id: 'H6', name: 'Berkeley MATH 51: DA MATH 1A + FH MATH 1A (retake)', file: F.bme, taken: [...da('MATH 1A'), ...fh('MATH 1A')], expect: { valid: false, sat: ['MATH 51'] }, why: 'FH 1A alone satisfies 51.' })

/* ---------- I. Everything / one college ---------- */
const GREENABLE = new Set<string>([F.bcs, F.beecs, F.bme, F.lame, F.sdece, F.ics, F.ime, F.dme])
for (const e of INDEX) add({ id: `I-all-${e.file.replace('.json', '')}`, name: `Took every articulated course at all 15 colleges: ${e.major} (${e.receivingId})`, file: e.file,
  taken: everything(e.file), expect: { valid: GREENABLE.has(e.file) },
  why: GREENABLE.has(e.file) ? 'Nothing left but UC-only rows.' : 'A required row has no ASSIST record anywhere (placeholder): it must stay open.',
  dataDependent: 'refetch' }) // which majors can turn green depends on the unrecorded rows a refetch resolves (HIGH-4)
add({ id: 'I-DA-bme', name: 'Berkeley ME entirely at De Anza', file: F.bme, taken: BME_FULL_DA, allowed: [DA], home: DA, expect: { valid: true, split: [] }, why: 'Every row at DA.' })
add({ id: 'I-DA-bcs', name: 'Berkeley CS B.A. entirely at De Anza (MATH 1A-1C, 2A-2B)', file: F.bcs, taken: da('MATH 1A', 'MATH 1B', 'MATH 1C', 'MATH 2A', 'MATH 2B'), expect: { valid: true }, why: 'MATH 51, 52, and MATH 54 for the choose-1.' })
add({ id: 'I-SMC-bme', name: 'Berkeley ME entirely at Santa Monica (semester)', file: F.bme, taken: smc('MATH 7', 'MATH 8', 'MATH 11', 'MATH 13', 'MATH 15', 'PHYSCS 21', 'PHYSCS 22', 'PHYSCS 23', 'CHEM 11', 'CHEM 12'), expect: { valid: true }, why: 'All SMC groups.' })
add({ id: 'I-FH-bme', name: 'Berkeley ME entirely at Foothill (CHEM 1A-1C)', file: F.bme, taken: fh('MATH 1A', 'MATH 1B', 'MATH 1C', 'MATH 1D', 'MATH 2A', 'MATH 2B', 'PHYS 4A', 'PHYS 4B', 'PHYS 4C', 'CHEM 1A', 'CHEM 1B', 'CHEM 1C'),
  expect: { valid: false, unsat: [BME_CHEM_ROW] }, why: 'The legacy fixture lists the Berkeley chemistry row only at DA and SMC.', dataDependent: 'refetch',
  realWorld: { expect: { valid: true, sat: [BME_CHEM_ROW] }, finding: 'HIGH-1', why: 'ASSIST articulates FH CHEM 1A-1C (F-01 orphan); the student is told to retake chemistry.' } })
add({ id: 'I-sdece', name: 'UCSD ECE: every CC row done (DA math/physics + CCSF CS 270 for ECE 30)', file: F.sdece, taken: SDECE_CC, expect: { valid: true, deferred: SDECE_DEF }, why: 'The rest is UC-only with explicit ASSIST reasons.' })
add({ id: 'I-dme', name: 'UC Davis ME: every CC row done across DA/FH/SMC/DVC', file: F.dme, taken: DME_FULL, expect: { valid: true, deferred: ['EME 050'] }, why: 'EME 050 is "Never Articulated": UC-only.', dataDependent: 'refetch',
  realWorld: { expect: { valid: true }, finding: 'HIGH-3', why: 'The legacy fixture requires all 7 composition/communication rows; the real agreement is choose-one (F-02). The verdict holds but the rows it takes change.' } })
add({ id: 'I-ics', name: 'UCI CS: every row done (Orange Coast CS A253 for ICS 53)', file: F.ics, taken: ICS_FULL, expect: { valid: true }, why: 'The choice is met by MATH 3A (DA MATH 2B).' })
add({ id: 'I-ime', name: 'UCI ME: every row done', file: F.ime, taken: IME_FULL, expect: { valid: true }, why: 'Every row, including ENGR 7A/7B at Irvine Valley.' })
add({ id: 'I-lame', name: 'UCLA ME: every required row done, physics at DA (no calculus)', file: F.lame, taken: [...LAME_REST, ...da('PHYS 4A', 'PHYS 4B', 'PHYS 4C')], expect: { valid: true }, why: 'Per the legacy fixture.', dataDependent: 'refetch',
  realWorld: { expect: { valid: false }, finding: 'CRITICAL-1', why: 'No calculus taken; UCLA requires MATH 31A-33A for ME. The fixture marks the math recommended (F-03 title shift).' } })
add({ id: 'I-lame-noupper', name: 'UCLA ME: math+chem+physics+CS+comp done, no upper-division EC ENGR 100 / MECH&AE 101/102 / MAT SCI 104', file: F.lame,
  taken: [...da('CHEM 1A', 'CHEM 1B', 'CHEM 1C', 'ENGL C1000', 'CIS 22B', 'PHYS 4A', 'PHYS 4B', 'PHYS 4C', 'MATH 1A', 'MATH 1B', 'MATH 1C', 'MATH 1D', 'MATH 2A', 'MATH 2B'), ...fh('ENGR 11')],
  expect: { valid: false, missingIncludes: ['EC ENGR 100', 'MECH&AE 101'] }, why: 'Per the legacy fixture these rows are required.', dataDependent: 'refetch',
  realWorld: { expect: { valid: true }, finding: 'HIGH-2', why: 'UCLA does not require upper-division MECH&AE 101/102 etc. for admission (recommended in the real agreement; F-03 title shift).' } })

/* ---------- J. Switching home / semester-quarter mixes ---------- */
add({ id: 'J1', name: 'Switched home DA->FH after Calc II: DA 1A,1B; FH 1C,1D (Berkeley ME)', file: F.bme, taken: [...da('MATH 1A', 'MATH 1B'), ...fh('MATH 1C', 'MATH 1D')], expect: { valid: false, sat: ['MATH 51', 'MATH 53'], split: ['MATH 52'], blocking: ['MATH 52'] }, why: 'MATH 52 bridges the switch.' })
add({ id: 'J2', name: 'Switched FH->DA after Calc I: FH 1A; DA 1B,1C,1D', file: F.bme, taken: [...fh('MATH 1A'), ...da('MATH 1B', 'MATH 1C', 'MATH 1D')], expect: { valid: false, sat: ['MATH 51', 'MATH 52', 'MATH 53'] }, why: 'FH 1A = MATH 51; DA pairs for 52 and 53.' })
add({ id: 'J3', name: 'Semester SMC MATH 7 + quarter DA 1B,1C,1D (Berkeley ME)', file: F.bme, taken: [...smc('MATH 7'), ...da('MATH 1B', 'MATH 1C', 'MATH 1D')], expect: { valid: false, sat: ['MATH 51', 'MATH 52', 'MATH 53'] }, why: 'Rows are independent.' })
add({ id: 'J4', name: 'SMC MATH 7, 8 + DA 1C (Berkeley MATH 53 needs DA 1C+1D)', file: F.bme, taken: [...smc('MATH 7', 'MATH 8'), ...da('MATH 1C')], expect: { valid: false, sat: ['MATH 51', 'MATH 52'], unsat: ['MATH 53'] }, why: '53 is incomplete.' })
add({ id: 'J5', name: 'SMC MATH 7, 8 + DA 1C + FH 1D', file: F.bme, taken: [...smc('MATH 7', 'MATH 8'), ...da('MATH 1C'), ...fh('MATH 1D')], expect: { valid: false, split: ['MATH 53'] }, why: 'A DA/FH split of 53.' })
add({ id: 'J6', name: 'UCSD MATH 20A at SMC requires MATH 7+8; SMC MATH 7 alone', file: F.sdece, taken: smc('MATH 7'), expect: { valid: false, unsat: ['MATH 20A'] }, why: 'SMC semester: 20A needs 7+8.' })
add({ id: 'J7', name: 'UCSD 20A: SMC MATH 7 + DA MATH 1A', file: F.sdece, taken: [...smc('MATH 7'), ...da('MATH 1A')], expect: { valid: false, sat: ['MATH 20A'] }, why: 'DA 1A alone.' })
add({ id: 'J8', name: 'UCSD 20A/20B: SMC MATH 7 + SMC MATH 8 (8 shared by 20A and 20B)', file: F.sdece, taken: smc('MATH 7', 'MATH 8'), expect: { valid: false, sat: ['MATH 20A', 'MATH 20B'] }, why: 'Explicit.' })
add({ id: 'J9', name: 'UCSD 20A: SMC MATH 8 + DA MATH 1AH', file: F.sdece, taken: [...smc('MATH 8'), ...da('MATH 1AH')], expect: { valid: false, sat: ['MATH 20A', 'MATH 20B'] }, why: 'DA 1AH is explicit; SMC 8 = 20B.' })
add({ id: 'J10', name: 'Berkeley EECS: quarter DA calculus + semester SMC physics + FH bio', file: F.beecs, taken: [...BME_MATH_DA, ...smc('PHYSCS 21', 'PHYSCS 22', 'PHYSCS 23'), ...fh('BIOL 1B', 'BIOL 1C')], expect: { valid: true, sat: ['PHYSICS 7A', 'PHYSICS 7B', 'BIOLOGY 1B'] }, why: 'Each row whole at one college.' })

/* ---------- K. Courses at colleges not in "allowed" + planner expectations ---------- */
add({ id: 'K1', name: 'Took FH PHYS 4B+4C earlier, now allowed only DA: must not re-plan 7B', file: F.bme, taken: fh('PHYS 4B', 'PHYS 4C'), allowed: [DA], home: DA,
  expect: { valid: false, sat: ['PHYSICS 7B'] }, plan: { validPlan: true, notPlanned: da('PHYS 4B', 'PHYS 4C') }, why: 'Completed courses count wherever they were taken.' })
add({ id: 'K2', name: 'Split DA 4B / FH 4C, allowed only Santa Monica: repair at SMC', file: F.bme, taken: [...BME_MATH_DA, ...BME_CHEM_DA, ...da('PHYS 4A', 'PHYS 4B'), ...fh('PHYS 4C')], allowed: [SMC], home: SMC,
  expect: { valid: false, blocking: ['PHYSICS 7B'] }, plan: { validPlan: true, onlyAt: [SMC] }, why: 'SMC PHYSCS 22+23 completes 7B.' })
add({ id: 'K3', name: 'Berkeley ME, Mission College only, nothing taken: chemistry not offered', file: F.bme, taken: [], allowed: [MIS], home: MIS, expect: { valid: false },
  plan: { validPlan: false, unsolvableMentions: [BME_CHEM_ROW], offeredAtIncludes: ['De Anza', 'Santa Monica'] }, why: 'The chemistry row is only at DA and SMC.' })
add({ id: 'K4', name: 'UC Davis ME, Foothill only: CHE 002A/B only at De Anza', file: F.dme, taken: [], allowed: [FH], home: FH, expect: { valid: false },
  plan: { validPlan: false, unsolvableMentions: ['CHE 002A, CHE 002B'] }, why: 'The CC route is owed and only De Anza offers it.', dataDependent: 'refetch',
  realWorld: { expect: { valid: false }, plan: { unsolvableExcludes: ['COM 001', 'COM 002', 'COM 003', 'COM 004', 'NAS 005'] }, finding: 'HIGH-3',
    why: 'Composition/communication is a single choice and FH ENGL C1000 covers UWP 001; the legacy fixture ANDs all 7 rows (F-02).' } })
add({ id: 'K5', name: 'Berkeley ME split, allowed only DA: repair at DA (4C)', file: F.bme, taken: [...BME_MATH_DA, ...BME_CHEM_DA, ...da('PHYS 4A', 'PHYS 4B'), ...fh('PHYS 4C')], allowed: [DA], home: DA,
  expect: { valid: false }, plan: { validPlan: true, mustPlan: da('PHYS 4C') }, why: 'Retake 4C at DA.' })
add({ id: 'K6', name: 'UCLA CS DA+FH: COM SCI 35L has no record -> counselor message', file: F.lacs, taken: [], allowed: [DA, FH], home: DA, expect: { valid: false, missingIncludes: ['COM SCI 35L'] },
  plan: { validPlan: false, unsolvableMentions: ['COM SCI 35L'], counselor: true }, why: 'No ASSIST record: send the student to a counselor.' })
add({ id: 'K7', name: 'UCSD ECE, DA+FH only: ECE 30 not offered (IVC/CCSF)', file: F.sdece, taken: [], allowed: [DA, FH], home: DA, expect: { valid: false },
  plan: { validPlan: false, unsolvableMentions: ['ECE 30'], offeredAtIncludes: ['CCSF', 'Irvine Valley'] }, why: 'Only two colleges allowed.' })
add({ id: 'K8', name: 'UCSD ECE, DA + CCSF: fully plannable', file: F.sdece, taken: [], allowed: [DA, CCSF], home: DA, expect: { valid: false }, plan: { validPlan: true }, why: 'Deferred rows are not planned.' })

/* ---------- L. Recommended only ---------- */
add({ id: 'L1', name: 'Berkeley ME: only recommended FH ENGR 11 (ENGIN 7) taken', file: F.bme, taken: fh('ENGR 11'), expect: { valid: false, sat: ['ENGIN 7'] }, why: 'An optional row does not help the required ones.' })
add({ id: 'L2', name: 'Berkeley ME full at DA + split in recommended MEC ENG C85 (Pasadena ENGR 011 + IVC ENGR 30)', file: F.bme, taken: [...BME_FULL_DA, ...at(PCC)('ENGR 011'), ...at(IVC)('ENGR 30')], expect: { valid: true, warn: ['MEC ENG C85'] }, why: 'A split in a recommended course is a warning.' })
add({ id: 'L3', name: 'Berkeley CS B.A.: only a recommended CS course (61B at DA), no math', file: F.bcs, taken: da('CIS 22C'), expect: { valid: false, sat: ['COMPSCI 61B'] }, why: 'Math is required.' })
add({ id: 'L4', name: 'Berkeley CS B.A. valid; recommended COMPSCI 70 (UC-only) is not deferred', file: F.bcs, taken: da('MATH 1A', 'MATH 1B', 'MATH 1C', 'MATH 2A', 'MATH 2B'), expect: { valid: true, deferred: [] }, why: 'Optional UC-only rows are not "required after transfer".' })
add({ id: 'L5', name: 'Berkeley EECS: core + science; recommended EECS 16A split (DA MATH 2A/2B/ENGR 37 vs SMC ENGR 21)', file: F.beecs, taken: [...BEECS_CORE_DA, ...da('PHYS 4D'), ...smc('ENGR 21')], expect: { valid: true, sat: ['PHYSICS 7C'] }, why: 'A recommended split is a warning at most.' })

/* ---------- M. OR / N_OF ---------- */
const SCIENCES: [string, CourseId[]][] = [['BIOLOGY 1B', fh('BIOL 1B', 'BIOL 1C')], ['BIOLOGY 1A, BIOLOGY 1AL', da('BIOL 6A', 'BIOL 6B')], ['CHEM 3A, CHEM 3AL', da('CHEM 12A', 'CHEM 12B')],
  ['CHEM 3B, CHEM 3BL', da('CHEM 12B', 'CHEM 12C')], ['PHYSICS 7C', da('PHYS 4D')], ['MCELLBI 32, MCELLBI 32L', fh('BIOL 40A', 'BIOL 40B', 'BIOL 40C')], ['ASTRON 7A', at(OCC)('ASTR A103')], [BME_CHEM_ROW, BME_CHEM_DA]]
for (const [row, cs] of SCIENCES) add({ id: `M-eecs-${row.split(',')[0].replace(/\s/g, '')}`, name: `Berkeley EECS science choose-1 via ${row}`, file: F.beecs, taken: [...BEECS_CORE_DA, ...cs], expect: { valid: true, sat: [row] }, why: 'Any one science alternative completes the choose-1.' })
add({ id: 'M-eecs-C8', name: 'Berkeley EECS: core + De Anza CIS 11 (COMPSCI C8 counts for ME science, NOT for EECS)', file: F.beecs, taken: [...BEECS_CORE_DA, ...da('CIS 11')], expect: { valid: false, missingIncludes: ['PHYSICS 7C'] }, why: 'The EECS science list has no COMPSCI C8; copying an ME friend\'s plan leaves a science short.' })
add({ id: 'M-bme-C8', name: 'Berkeley ME science choose-1 via COMPSCI C8 (DA CIS 11), CHEM row done', file: F.bme, taken: [...BME_FULL_DA, ...da('CIS 11')], expect: { valid: true, sat: ['COMPSCI C8'] }, why: 'In the ME list.' })
add({ id: 'M-eecs-split7C-alone', name: 'Berkeley EECS: core + PHYSICS 7C split (DA 4C, FH 4D) as the only science', file: F.beecs, taken: [...BEECS_CORE_DA, ...fh('PHYS 4D')], expect: { valid: false, blocking: ['PHYSICS 7C'] }, why: 'The plan still needs a science and 7C is a live alternative: blocking.' })
add({ id: 'M-eecs-split7C-bio', name: 'Berkeley EECS: core + 7C split + FH BIO 1B complete', file: F.beecs, taken: [...BEECS_CORE_DA, ...fh('PHYS 4D', 'BIOL 1B', 'BIOL 1C')], expect: { valid: true, warn: ['PHYSICS 7C'] }, why: 'Science satisfied by biology: the 7C split is a warning.' })
add({ id: 'M-dcse-route2', name: 'UC Davis CSE ECS route 2 at DA (036A/B/C)', file: F.dcse, taken: da('CIS 22A', 'CIS 22B', 'CIS 22C'), expect: { valid: false, sat: ['ECS 036A', 'ECS 036B', 'ECS 036C'] }, why: 'The choice is met; the major is invalid because MAT 067 etc. have no record.' })
add({ id: 'M-dcse-route2-mixed', name: 'UC Davis CSE route 2 at mixed colleges: DA CIS 22A, FH C S 2B, SMC CS 20A', file: F.dcse, taken: [...da('CIS 22A'), ...fh('C S 2B'), ...smc('CS 20A')], expect: { valid: false, sat: ['ECS 036A', 'ECS 036B', 'ECS 036C'] }, why: 'Three separate rows, each whole at one college.' })
add({ id: 'M-ics-or-math3a', name: 'UCI CS OR(ICS 6N no record, MATH 3A): MATH 3A via DA MATH 2B', file: F.ics, taken: ICS_FULL, expect: { valid: true, sat: ['MATH 3A'] }, why: 'The choice is met.' })
add({ id: 'M-ics-or-none', name: 'UCI CS everything except MATH 3A', file: F.ics, taken: ICS_FULL.filter((x) => x !== '113:MATH 2B'), expect: { valid: false, unsat: ['MATH 3A'], missingIncludes: ['MATH 3A'] }, why: 'The only CC route in the choice is MATH 3A; 6N has no record so it cannot be deferred.' })
add({ id: 'M-ime-chem', name: 'UCI ME N_OF(1) chemistry: DA CHEM 1A satisfies both alternatives', file: F.ime, taken: da('CHEM 1A'), expect: { valid: false, sat: ['ENGR 1A, CHEM 1LE', 'CHEM 1A, CHEM 1LE'] }, why: 'Explicit.' })
add({ id: 'M-ime-noecon', name: 'UCI ME everything except ECON 20A (ECON 23 has no record)', file: F.ime, taken: IME_FULL.filter((x) => x !== '113:ECON 2'), expect: { valid: false, unsat: ['ECON 20A'] }, why: 'ECON 23 is neither a route nor UC-only: ECON 20A is owed.' })
add({ id: 'M-sdmcs', name: 'UCSD Math/CS: OR(CSE 15L, CSE 29), neither recorded: never green', file: F.sdmcs, taken: everything(F.sdmcs), expect: { valid: false, missingIncludes: ['CSE 15L', 'CSE 29'] }, why: 'Neither alternative has a record.' })
add({ id: 'M-dme-chem-honors-uc', name: 'UC Davis ME OR(CHE 002AH+BH UC-only, CHE 002A+B at DA), chemistry not taken', file: F.dme, taken: DME_FULL.filter((x) => !['113:CHEM 1A', '113:CHEM 1B'].includes(x)), expect: { valid: false, unsat: ['CHE 002A, CHE 002B'] }, why: 'CC first: a UC-only honors chemistry route does not excuse the CC route.' })
add({ id: 'M-bme-stat20', name: 'Berkeley ME: everything but the science choose-1 and the CHEM row; STAT 20 is UC-only', file: F.bme, taken: [...BME_MATH_DA, ...da('PHYS 4A', 'PHYS 4B', 'PHYS 4C')], expect: { valid: false }, why: 'A CC science is owed first; STAT 20 cannot fill the slot.' })

/* ---------- N. UC-only vs no record ---------- */
add({ id: 'N1', name: 'UCSD ECE nothing taken: deferred = ECE 35/45/5/65/15/25', file: F.sdece, taken: [], expect: { valid: false, deferred: SDECE_DEF }, why: 'Explicit ASSIST reasons.' })
add({ id: 'N2', name: 'UC Davis ME: EME 050 deferred', file: F.dme, taken: [], expect: { valid: false, deferred: ['EME 050'] }, why: '"Never Articulated".' })
add({ id: 'N3', name: 'UCLA CS: everything but 35L -> invalid, 35L missing', file: F.lacs, taken: everything(F.lacs), expect: { valid: false, missingIncludes: ['COM SCI 35L'], deferred: [] }, why: 'A row with no record is not deferrable.',
  dataDependent: 'refetch' }) // HIGH-4: 35L is taken at UCLA; whether a refetch records it decides the real answer
add({ id: 'N4', name: 'UCSD CSE: CSE 29 and PHYS 4A/4B have no record -> invalid', file: F.sdcse, taken: everything(F.sdcse), expect: { valid: false, missingIncludes: ['CSE 29', 'PHYS 4A', 'PHYS 4B'] }, why: 'No record.', dataDependent: 'refetch',
  realWorld: { expect: { valid: false, missingIncludes: ['CSE 29'] }, finding: 'HIGH-3', why: 'Real UCSD CSE lets students choose PHYS 2A-2B or 4A-4B (and a science subset); the legacy fixture ANDs them (F-02).' } })
add({ id: 'N5', name: 'UCSD MAE: MAE 3 deferred, MAE 30B has no record', file: F.sdmae, taken: everything(F.sdmae), expect: { valid: false, deferred: ['MAE 3'], missingIncludes: ['MAE 30B'] }, why: 'Mixed.' })
add({ id: 'N6', name: 'UCSD ECE & Society: POLI 30 + ECE deferred, SOCI 30 has no record', file: F.sdeces, taken: everything(F.sdeces), expect: { valid: false, deferred: ['ECE 65', 'ECE 45', 'ECE 15', 'ECE 35', 'ECE 25', 'POLI 30'], missingIncludes: ['SOCI 30'] }, why: 'Mixed.' })
add({ id: 'N7', name: 'UCLA Ling+CS: MATH 70 + COM SCI 35L have no record', file: F.laling, taken: everything(F.laling), expect: { valid: false, missingIncludes: ['MATH 70', 'COM SCI 35L'] }, why: 'No record.' })
add({ id: 'N8', name: 'UCI EE: many upper rows have no record', file: F.iee, taken: everything(F.iee), expect: { valid: false, missingIncludes: ['EECS 1', 'EECS 22L'] }, why: 'No record.' })
add({ id: 'N9', name: 'Berkeley CS B.A.: MATH 56 has no record in the choose-1, MATH 54 done', file: F.bcs, taken: da('MATH 1A', 'MATH 1B', 'MATH 1C', 'MATH 2A', 'MATH 2B'), expect: { valid: true }, why: 'An unrecorded alternative is irrelevant once another is met.' })
add({ id: 'N10', name: 'Berkeley CS B.A.: choose-1 unmet (no MATH 54/EECS 16A)', file: F.bcs, taken: da('MATH 1A', 'MATH 1B', 'MATH 1C'), expect: { valid: false, missingIncludes: ['MATH 54', 'EECS 16A'] }, why: 'CC routes are open; MATH 56 is not deferrable.' })

/* ---------- O. Requirement ids appearing twice ---------- */
add({ id: 'O1', name: 'Berkeley ME CHEM row (listed twice): one completion satisfies both places', file: F.bme, taken: BME_FULL_DA, expect: { valid: true, sat: [BME_CHEM_ROW] }, why: 'The same row.',
  ruleRisk: 'The chemistry row counts for both the required row and the science choose-1; the tester checked this is acceptable for Berkeley ME.' })
add({ id: 'O2', name: 'Berkeley ME CHEM row split DA/SMC is reported once', file: F.bme, taken: [...da('CHEM 1A', 'CHEM 1B'), ...smc('CHEM 12')], expect: { valid: false, split: [BME_CHEM_ROW], blocking: [BME_CHEM_ROW] }, why: 'Once.' })
add({ id: 'O3', name: 'UC Davis CSE ECS 036A appears in two alternatives', file: F.dcse, taken: da('CIS 22A'), expect: { valid: false, sat: ['ECS 036A'] }, why: 'Once.' })

/* ---------- P. Nothing taken ---------- */
const DEFERRED_NOTHING: Record<string, string[]> = { [F.sdmae]: ['MAE 3'], [F.sdece]: SDECE_DEF, [F.sdeces]: ['ECE 65', 'ECE 45', 'ECE 15', 'ECE 35', 'ECE 25', 'POLI 30'], [F.dme]: ['EME 050'] }
for (const e of INDEX) add({ id: `P-${e.file.replace('.json', '')}`, name: `Nothing taken: ${e.major} (${e.receivingId})`, file: e.file, taken: [],
  expect: { valid: false, deferred: DEFERRED_NOTHING[e.file] ?? [], split: [] }, why: 'Nothing done; only explicit UC-only rows are deferred.' })

/* ---------- Q. Hostile input ---------- */
add({ id: 'Q1', name: 'Garbage ids only', file: F.bme, taken: ['999:FAKE 1', '', 'MATH 1A', '113:', ':', '113:math 1a', ' 113:MATH 1A', '113:MATH  1A'], expect: { valid: false, split: [] }, why: 'Unknown ids earn nothing and must not crash.' })
add({ id: 'Q2', name: 'Full DA Berkeley ME + 5000 garbage ids', file: F.bme, taken: [...BME_FULL_DA, ...Array.from({ length: 5000 }, (_, i) => `${i}:X ${i}`)], expect: { valid: true }, why: 'Noise is ignored.' })
add({ id: 'Q3', name: 'Lower-case / padded real ids do not count', file: F.bme, taken: ['113:math 1a', '113:MATH 1A ', '113:MATH 1b'], expect: { valid: false, unsat: ['MATH 51'] }, why: 'Exact ids only (the UI adds catalog ids).' })
add({ id: 'Q4', name: 'Another UC\'s course id (UCLA MATH 31A) in a Berkeley transcript', file: F.bme, taken: ['117:MATH 31A', '79:MATH 51'], expect: { valid: false, unsat: ['MATH 51'] }, why: 'UC courses are not CC courses.' })
add({ id: 'Q5', name: 'An honors id that does not exist (113:MATH 1AHH)', file: F.bme, taken: da('MATH 1AHH', 'MATH 1B'), expect: { valid: false, unsat: ['MATH 51'] }, why: 'Not a real course.',
  knownAppDeviation: { finding: 'LOW-5', rows: ['MATH 51'] } })
add({ id: 'Q6', name: 'Every catalog course of every agreement (union) against Berkeley ME', file: F.bme, taken: [...new Set(INDEX.flatMap((e) => everything(e.file)))], expect: { valid: true }, why: 'A huge transcript.' })

/* ---------- R. More counselor cases (beyond the tester's catalog) ---------- */
add({ id: 'R1', story: 'Plan.md Scenario 2', name: 'UCLA ME Scenario 2 repaired: retook the whole series at De Anza after the FH detour', file: F.lame,
  taken: [...LAME_REST, ...da('PHYS 4A', 'PHYS 4B', 'PHYS 4C'), ...fh('PHYS 4B')], expect: { valid: true, sat: [UCLA_PHYS], notSplit: [UCLA_PHYS] },
  why: 'The DA series is whole; the stray FH piece earns nothing and harms nothing.', dataDependent: 'refetch',
  realWorld: { expect: { valid: false, sat: [UCLA_PHYS], notSplit: [UCLA_PHYS] }, finding: 'CRITICAL-1', why: 'Still no calculus: UCLA ME needs MATH 31A-33A.' } })
add({ id: 'R2', story: 'Plan.md Scenario 1', name: 'Berkeley ME: CVC calculus at Santa Monica for MATH 53 needs SMC\'s own pairing', file: F.bme,
  taken: [...da('MATH 1A', 'MATH 1B', 'MATH 1C', 'MATH 2A', 'MATH 2B', 'PHYS 4A', 'PHYS 4B', 'PHYS 4C'), ...BME_CHEM_DA, ...smc('MATH 11')],
  expect: { valid: true, sat: ['MATH 53'] }, why: 'SMC MATH 11 alone completes MATH 53 (ASSIST lists it as a one-course group), so this online course is safe.' })
add({ id: 'R3', name: 'Berkeley ME: split 7B repaired at DA by retaking PHYS 4C there', file: F.bme,
  taken: [...BME_MATH_DA, ...BME_CHEM_DA, ...da('PHYS 4A', 'PHYS 4B', 'PHYS 4C'), ...fh('PHYS 4C')], expect: { valid: true, sat: ['PHYSICS 7B'], split: [] },
  why: 'Once the pair is whole at DA the row is satisfied; the FH copy is a duplicate.' })
add({ id: 'R4', name: 'Berkeley ME: only the science choose-1 missing, DA CHEM row done (CHEM row doubles as the science)', file: F.bme,
  taken: [...BME_MATH_DA, ...da('PHYS 4A', 'PHYS 4B', 'PHYS 4C'), ...BME_CHEM_DA], expect: { valid: true, split: [] }, why: 'The required chemistry row also completes the science choose-1 (see O1).' })
add({ id: 'R5', name: 'UCSD ECE: all CC rows except ECE 30 (CS 270 not taken)', file: F.sdece, taken: SDECE_CC.filter((c) => c !== '33:CS 270'),
  expect: { valid: false, missingIncludes: ['ECE 30'], deferred: SDECE_DEF }, why: 'ECE 30 has CC routes (CCSF, IVC), so it is owed before transfer.' })
add({ id: 'R6', name: 'Berkeley EECS: core at DA + SMC PHYSCS 21 duplicate of 7A', file: F.beecs, taken: [...BEECS_CORE_DA, ...smc('PHYSCS 21'), ...fh('BIOL 1B', 'BIOL 1C')],
  expect: { valid: true, sat: ['PHYSICS 7A'], split: [] }, why: 'A satisfied row is never a split, whatever else was taken.' })
add({ id: 'R7', name: 'Berkeley ME: CHEM row split DA 1A / SMC CHEM 12, then completed at DA', file: F.bme, taken: [...BME_FULL_DA, ...smc('CHEM 12')],
  expect: { valid: true, sat: [BME_CHEM_ROW], notSplit: [BME_CHEM_ROW] }, why: 'Satisfied at DA; the SMC course is extra.' })
add({ id: 'R8', name: 'Berkeley ME: MATH 52 via DA 1BH+1CH (both honors)', file: F.bme, taken: da('MATH 1BH', 'MATH 1CH'), expect: { valid: false, sat: ['MATH 52'] }, why: 'The honors group itself.' })

export const SCENARIOS: readonly Scenario[] = S
