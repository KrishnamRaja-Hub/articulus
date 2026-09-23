# Articulus

California community college students can cross-enroll at any other community college in one click through the California Virtual Campus (CVC). Transfer articulation does not follow them. ASSIST.org, the state's official articulation repository, publishes agreements pairwise: one sending college to one receiving university. It never evaluates a combination of colleges. A course series started at one campus and finished at another can articulate to nothing, even though each half articulates on its own. UC audits final transcripts in July, after conditional admission, and rescinds offers that fail. The student waits a full year to reapply.

Articulus is a deterministic articulation verifier and multi-campus schedule solver. It loads the real ASSIST agreements for a target university and major, checks a set of courses taken across several colleges for split-series violations, and produces a term-by-term plan that satisfies every requirement without ever splitting a series.

## The trap in one example

UC Berkeley Mechanical Engineering requires PHYSICS 7B. Both De Anza and Foothill articulate to it, and both use the same course numbers.

```
UC Berkeley PHYSICS 7B

  De Anza   PHYS 4B + PHYS 4C   -> satisfied
  Foothill  PHYS 4B + PHYS 4C   -> satisfied

  De Anza   PHYS 4B
  Foothill          + PHYS 4C   -> zero credit (split series)
```

The two colleges divide the physics topics differently, so the university only accepts the pair from a single campus. This is verified against the live 2025-26 ASSIST agreement (`data/agreements/79-mechanical-engineering-b-s.json`), and the check runs in the browser in the "Trap" section of the app. `src/engine/engine.test.ts` asserts it.

## How it works

### Requirement tree

`src/engine/normalize.ts` turns raw ASSIST payloads into an `Agreement`. The ASSIST `templateAssets` array holds `RequirementTitle` and `RequirementGroup` entries in parallel; the k-th title labels the k-th group. Each group becomes a `ReqNode` of type `AND`, `OR`, or `N_OF` (from the `NFollowing` advisement). Rows with several cells become `OR` nodes. Titles containing "RECOMMEND" mark the subtree as optional.

Each leaf is a `Requirement`: one UC course or series (`PHYSICS 7B`, `MATH 51`) with a list of `CourseGroup`s. A group is a set of course ids tagged with a sending college (`{ institutionId: 113, courses: ["113:PHYS 4B", "113:PHYS 4C"] }`). ASSIST "Or" sending groups fan out into one group per course. Payloads from every sending college are merged into the same requirement, so one leaf lists the groups from all fifteen colleges.

### Verification

`verifySchedule(taken, agreement)` in `src/engine/verify.ts`:

- A requirement is satisfied only by one complete group from one college.
- A split series is partial progress at two or more colleges where the pieces are different courses. The same course duplicated at two colleges (PHYS 4B at both) is a duplicate, not a split.
- Optional (recommended) subtrees are evaluated for reporting but never fail their parent.
- Split-series violations are always fatal, even if the tree is satisfiable another way.

Output fields:

| Field | Meaning |
|---|---|
| `isValid` | root satisfied and no split-series violations |
| `satisfied` | requirement id -> the group that satisfied it |
| `missing` | required requirement ids (or "One of: ..." / "N of: ...") not satisfied |
| `incomplete` | requirement id -> best single-college partial progress |
| `splitSeriesViolations` | list of `{ requirementId, label, partials[] }` |

What may legitimately cross college lines: each UC requirement row is independent, so PHYSICS 7A from Foothill next to PHYSICS 7B from De Anza is valid and the requirement map shows each row's college. Within one row, ASSIST never publishes a course group that spans two colleges (0 of 5,611 groups in the fixtures), so a group is always single-college. The one sanctioned mix inside a row is ASSIST's own note "Regular and honors courses may be combined to complete this series": the engine detects a regular group with an honors twin at the same college and treats MATH 1B + MATH 1CH as complete.

### Solver

`solve(taken, agreement, options)` in `src/engine/solve.ts` is a greedy set cover over the tree:

1. Walk the tree collecting requirements that still need a group. At `OR` and `N_OF` nodes, pick the cheapest children by estimated marginal units.
2. For each such requirement, find the cheapest group at an allowed college. Cost is the units not already taken or planned. Ties prefer the home college, then fewer honors courses, then fewer courses.
3. Pick the single globally cheapest group, add its courses to the plan, and repeat. One group per iteration means a course that serves two UC requirements (De Anza MATH 1B covers both MATH 51 and MATH 52) is counted once.
4. Pack courses into terms. Order is inferred from the letter suffix (4A before 4B before 4C) within one college; the first course of a numerically higher series (2A) is gated by the C course of the series below it (1C). Respect the per-term unit cap and never silently drop a course past `maxTerms`; the UI flags overflow.
5. Re-run `verifySchedule` on taken plus planned and return `{ terms, chosen, result, totalUnits, unsolvable }`.

Units are converted between systems when the plan mixes quarter and semester colleges. Semester units are multiplied by 1.5 to quarter units. The default cap is 16 quarter units or 12 semester units per term, and terms are named for the student's `termSystem` (Fall/Winter/Spring for quarter, Fall/Spring for semester).

Everything is deterministic. There is no language model anywhere in the path. Same inputs, same plan.

## Data

### ASSIST endpoints

`scripts/fetch-assist.ts` uses only public ASSIST REST endpoints:

- `GET /api/institutions` - directory with numeric ids, names, `isCommunityCollege`, `termType`
- `GET /api/agreements?receivingInstitutionId=&sendingInstitutionId=&academicYearId=&categoryCode=major` - list of major reports with their `key`
- `GET /api/articulation/Agreements?key=` - the full articulation payload for one report

ASSIST returns 400 without an antiforgery handshake. The script first fetches `https://assist.org`, copies the `Set-Cookie` pair, and sends the cookies back with an `X-XSRF-TOKEN` header taken from the `X-XSRF-TOKEN` cookie. Rate limits are per session, so on HTTP 429 the script sleeps and starts a new session (up to five retries). Every request is followed by a 200 ms pause.

The payload's `templateAssets`, `articulations`, `academicYear`, `sendingInstitution`, and `receivingInstitution` fields are JSON-encoded strings nested inside the JSON response. `normalize.ts` parses them a second time.

### Institution ids

The original brief listed Berkeley as 118, UCLA as 121, and Foothill as 114. Those are wrong. The ids used here come from `/api/institutions`:

| Institution | id |
|---|---|
| UC Berkeley | 79 |
| UCLA | 117 |
| UC San Diego | 7 |
| UC Irvine | 120 |
| UC Davis | 89 |
| De Anza College | 113 |
| Foothill College | 51 |

Academic year id 76 is 2025-26.

### Fixtures

Fetched agreements are normalized and cached in `data/`. The app never calls ASSIST at runtime.

- `data/institutions.json` - the universities and colleges in scope, with term system
- `data/index.json` - list of `{ file, receivingId, major }`
- `data/agreements/<ucId>-<major-slug>.json` - one normalized `Agreement` per university and major, merged across all sending colleges

Agreements are loaded lazily by the UI, so adding more fixtures does not grow the initial bundle.

### Coverage

Universities: UC Berkeley (79), UCLA (117), UC San Diego (7), UC Irvine (120), UC Davis (89).

Majors: any ASSIST major report whose label matches Computer Science, Electrical Engineering (including Berkeley's Electrical Engineering & Computer Sciences), or Mechanical Engineering, B.A. or B.S.

Sending community colleges (15): De Anza, Foothill, Santa Monica, Pasadena City, Diablo Valley, Irvine Valley, Orange Coast, El Camino, Berkeley City, City College of San Francisco, San Jose City, Santa Barbara City, Saddleback, West Valley, Mission.

Fixtures on disk (`data/index.json`): 22 agreements, each merged across all 15 colleges for 2025-26 (1.8 MB total, loaded lazily per selection):

| University | Major |
|---|---|
| UC Berkeley | Computer Science, B.A. |
| UC Berkeley | Electrical Engineering & Computer Sciences, B.S. |
| UC Berkeley | Mechanical Engineering, B.S. |
| UCLA | Electrical Engineering/B.S. |
| UCLA | Mechanical Engineering/B.S. |
| UCLA | Linguistics and Computer Science/B.A. |
| UCLA | Computer Science and Engineering/B.S. |
| UCLA | Computer Science/B.S. |
| UC San Diego | MAE: Mechanical Engineering B.S. |
| UC San Diego | CSE: Computer Science with a Specialization in Bioinformatics B.S. |
| UC San Diego | ECE: Electrical Engineering and Society B.A. |
| UC San Diego | Mathematics/Computer Science B.S. |
| UC San Diego | CSE: Computer Science B.S. |
| UC San Diego | ECE: Electrical Engineering B.S. |
| UC Irvine | Computer Science and Engineering, B.S. |
| UC Irvine | Computer Science, B.S. |
| UC Irvine | Mechanical Engineering, B.S. |
| UC Irvine | Electrical Engineering, B.S. |
| UC Davis | Computer Science B.S. |
| UC Davis | Electrical Engineering B.S. |
| UC Davis | Computer Science & Engineering B.S. |
| UC Davis | Mechanical Engineering B.S. |

Run `npm run fetch` to regenerate. The major filter is a substring match, so a few adjacent programs (Linguistics and Computer Science, Bioinformatics, Electrical Engineering and Society) are included as well.

## Run it

```
npm install
npm run dev      # Vite dev server
npm test         # vitest: split-series detection, solver ordering, repair
npm run build    # tsc -b && vite build
npm run fetch    # re-pull ASSIST and rewrite data/
```

The fetch script is TypeScript executed directly by Node, so Node 22 or newer is required for `npm run fetch`. The rest works on any Node that runs Vite 8.

## Project layout

```
Plan.md                      problem statement, scenarios, original brief
index.html                   Vite entry
src/main.tsx                 React mount
src/App.tsx                  section order: Nav, Hero, Trap, Stories, Planner, Footer
src/data.ts                  loads data/ fixtures, exposes institutions, universities, colleges, majorsFor
src/engine/types.ts          Course, CourseGroup, Requirement, ReqNode, Agreement, ValidationResult, Plan
src/engine/normalize.ts      raw ASSIST payloads -> Agreement (tree + catalog)
src/engine/verify.ts         verifySchedule: tree fold, split-series detection
src/engine/solve.ts          greedy set cover + term packing
src/engine/engine.test.ts    vitest cases against the real Berkeley ME agreement
src/sections/Hero.tsx        landing
src/sections/Trap.tsx        the PHYSICS 7B example, running the live engine
src/sections/Stories.tsx     the three rescind scenarios from Plan.md
src/sections/Planner.tsx     interactive planner: pick UC, major, colleges, taken courses; shows plan
src/sections/Nav.tsx, Footer.tsx
src/ui/Button.tsx            shared button
src/motion/useReveal.ts      GSAP scroll reveal hook
src/index.css                Tailwind 4 theme
scripts/fetch-assist.ts      ASSIST fetcher and fixture writer
scripts/shots.mjs            Playwright screenshots
data/                        cached fixtures (see Data)
```

## Limitations and next steps

- The solver is greedy. It picks the cheapest marginal group per iteration and is not provably unit-minimal. An exact ILP or SAT pass over the same tree would be the upgrade.
- Course sequence order is a heuristic. ASSIST ships empty `requisites`, so ordering is inferred from letter suffixes and the 1C -> 2A gate. A course with an unconventional number can land in the wrong term.
- Only major-preparation agreements are modeled. General education, IGETC, and campus breadth requirements are not.
- Articulation notes and course attributes (grade minimums, "same as" remarks, lab requirements) are parsed out but not surfaced in the UI or used in verification.
- Semester to quarter unit conversion is the flat 1.5 factor. Individual UC departments may count units differently.
- Coverage is five UCs and three engineering majors across fifteen colleges. Other majors and CSU campuses need only a fetch, but have not been validated.
- The "Trap" section demo widget is hardcoded to De Anza and Foothill against Berkeley Mechanical Engineering. The Planner section is fully general.
- Template trees are taken from the first sending college's payload on the assumption that templates are identical across colleges for the same UC and major. This held for every agreement fetched so far but is not enforced.
