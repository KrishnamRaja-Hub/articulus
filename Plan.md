What the Product Is
Articulus is a deterministic multi-source course schedule optimizer and articulation verifier for college transfer students.
Instead of treating transfer planning like a static checklist at a single school, it operates like a flight routing engine across multiple colleges. It takes a student’s target university major and their accessible community colleges, queries the state's official public articulation data, models the non-transitive transfer agreements as a directed hypergraph, and outputs a schedule that fulfills every prerequisite while guaranteeing zero unarticulated units or broken course sequences.
The Problem in Concrete Terms
1. The Logistical Setup: In California, over 100 community colleges share a state-run portal called the California Virtual Campus (CVC.edu). A student at De Anza College can click "Add Course" on CVC.edu and instantly enroll in an online Calculus or Physics class at Foothill College or Mt. San Antonio College without filling out a separate college application.
2. The Data Disconnect: While enrollment is unified, course articulation is not. The official state repository (ASSIST.org) only evaluates courses pairwise—one sending college to one receiving university. It never evaluates combinations of courses taken across multiple colleges.
3. The Non-Transitive Articulation Trap ("The Split Series"):
    * College A covers a requirement across a 2-course sequence (Course 1A + Course 1B).
    * College B covers the same requirement across a 3-course sequence (Course 21 + Course 22 + Course 23).
    * If a student takes Course 1A at College A and Course 22 at College B, the receiving university gives zero credit. The student assumes they completed their requirements, but the syllabi do not align.
4. The Catastrophic Consequence: Transfer admissions to top universities (like UC Berkeley or UCLA) are conditional. If an applicant completes their coursework in spring and admissions auditors discover in July that a course sequence was split across two campuses, the university automatically rescinds the acceptance. The student cannot reapply for a full calendar year.
Three Real-World Scenarios
Scenario 1: The Mt. SAC Online Course Rescind at UC Berkeley
A California community college student completed their associate coursework at Mt. San Antonio College (Mt. SAC) and was accepted to UC Berkeley. Needing to complete their calculus requirement (MATH 181 at Mt. SAC), they used the state’s CVC exchange to take an online equivalent course at another California community college during their final term. The student gave up their job, signed a lease on an apartment in Berkeley, and prepared for fall classes. In late summer, UC Berkeley audited the final transcript and rescinded their admission. The online course from the second college only articulated to UC Berkeley if paired with a second follow-up class from that same campus. The student lost their admission, their job, and their deposit, and was forced to wait an entire year to reapply.
Scenario 2: The Multi-District Engineering Physics Split
An engineering student at De Anza College needed the 3-quarter Physics sequence (Mechanics, Electricity & Magnetism, Waves & Heat) to qualify for UCLA Mechanical Engineering. Due to an impacted schedule, Physics 2 conflicted with Multivariable Calculus at De Anza. The student enrolled in Physics 2 at neighboring Foothill College (same district, 15 minutes away). Both colleges are accredited and articulate to UCLA. However, Foothill and De Anza divide the physics curriculum differently: De Anza includes thermodynamics in Physics 2, while Foothill teaches it in Physics 3. UCLA's articulation agreement mandates that the series must be completed at a single institution. Because the student split the series, UCLA invalidated both courses. The student was disqualified from major transfer eligibility and had to spend an extra full year retaking physics.
Scenario 3: The Automated Advisor Audit Blunder
A transfer applicant planned their course roadmap with an on-campus academic counselor over three semesters. The counselor confirmed that their elective and prerequisite selections fulfilled the general education and major transfer pathway. During the final summer pre-enrollment audit, the automated degree-audit system flagged that an elective course used to satisfy a major prerequisite required an uncompleted introductory prerequisite at the target university. The college apologized for the human error, but could not alter university admissions policy. The transfer fell through, full-time student status was forfeited, financial aid was canceled, and student loan repayment triggered immediately.
What We Are Building at the Build Day
A lightweight, deterministic web application that:
1. Ingests structured JSON articulation data directly from ASSIST.org's public REST endpoints ([https://assist.org/api/](https://assist.org/api/)...).
2. Lets a user define:
    * Target Goal: Target University + Target Major (e.g., UC Berkeley — Computer Science).
    * Accessible Colleges: Primary CC (e.g., De Anza) + Secondary CCs / Online CVC Colleges (e.g., Foothill, Santa Monica College).
    * Current State: Courses already completed with passing grades.
3. Runs a Boolean Satisfiability (SAT) / Hypergraph traversal engine that:
    * Maps every university requirement node (represented as boolean logic: [A AND B] OR [C AND D]).
    * Evaluates available course offerings across all selected campuses.
    * Flags split-sequence violations where taking an individual course across campus lines invalidates sequence requirements.
    * Emits an optimal multi-campus course schedule that satisfies 100% of the target requirements with minimal semesters and units.
Copy-Paste Prompt for Fable 5.1
Copy and paste the text block below directly into Fable 5.1 to start system architecture, data modeling, and code generation:
MISSION CONTEXT & SPECIFICATION: ARTICULUS
1. THE PROBLEM DOMAIN
In California, over 2.1 million community college (CCC) students attempt to transfer to 4-year public universities (University of California / California State University).
Because STEM and major prerequisite courses are severely impacted (full within minutes), students routinely cross-enroll across multiple community colleges simultaneously using the state's official California Virtual Campus (cvc.edu) exchange and multi-campus college districts.
However, transfer articulation agreements (stored on the state repository ASSIST.org) are strictly PAIRWISE and NON-TRANSITIVE:
* College A has an agreement with UC Berkeley.
* College B has an agreement with UC Berkeley.
* ASSIST.org does NOT compute agreements for College A + College B combined.
THE FATAL TRAP: Many course series (e.g., Calculus-based Physics, Organic Chemistry, Linear Algebra/DiffEq) require completing the entire sequence at ONE institution because curriculum topic splits vary. If a student takes Physics 1 at College A and Physics 2 at College B, UC admissions evaluators treat the series as broken/unarticulated. Every year, students receive conditional admission offers to UC Berkeley, UCLA, or UCSD, uproot their lives, and then have their admissions RESCINDED in July after transcripts are audited, delaying their degree completion by an entire academic year.
Existing tools (like Plan My Transfer or TransferAI) act either as static backward-looking audits for a single home campus or as conversational LLM wrappers that hallucinate course equivalence. None solve multi-campus forward schedule pathfinding deterministically.
2. THE PRODUCT: ARTICULUS
Articulus is a standalone deterministic optimization engine and verification dashboard. It owns a specific computational primitive: A Directed Acyclic Hypergraph (DAH) Multi-Source Path Optimizer with Boolean Satisfiability (SAT) Resolution.
Workflow:
1. User Inputs:
    * Target Receiving University & Major (e.g., UC Berkeley - Electrical Engineering & Computer Sciences).
    * Home College (e.g., De Anza College).
    * Allowed Cross-Enrollment Colleges (e.g., Foothill College, San Jose City College, or CVC online).
    * Already completed courses (with terms/grades).
2. The Engine:
    * Evaluates the target university major preparation requirements as a boolean expression in Conjunctive Normal Form (CNF): Target = (Req_1) AND (Req_2) AND ... AND (Req_N) where each Req_i can be: (Course_A) OR (Course_B AND Course_C).
    * Identifies series-completion constraints (rules specifying that a subset of requirements must share a single institutional source ID).
    * Solves the constrained multi-campus set-cover problem to compute a conflict-free semester roadmap.
    * Deterministically detects and flags "Split-Series Violations" with red alert diagnostics.
3. User Output:
    * An interactive semester-by-semester cross-enrollment schedule.
    * Visual verification badge ("100% Articulation Integrity Guaranteed").
    * Detailed per-course mapping showing which target requirement is satisfied by which campus course.
3. DATA ACQUISITION & SCHEMAS (ZERO-SCRAPING, PUBLIC REST APIs)
ASSIST.org runs on open, unauthenticated REST API endpoints that return structured JSON:
* Institutions Directory: [https://assist.org/api/institutions](https://assist.org/api/institutions) (Returns list of all CCCs, CSUs, and UCs with their numeric institutionId).
* Available Agreements Matrix: [https://assist.org/api/institutions/](https://assist.org/api/institutions/){sendingId}/agreements (Returns target receiving institutions and available agreement years).
* Major Agreements: [https://assist.org/api/agreements?receivingInstitutionId=](https://assist.org/api/agreements?receivingInstitutionId=){ucId}&sendingInstitutionId={cccId}&academicYearId={yearId}&categoryCode=major (Returns major list with key identifiers).
* Articulation Payload: [https://assist.org/api/articulation/Agreements?receivingInstitutionId=](https://assist.org/api/articulation/Agreements?receivingInstitutionId=){ucId}&sendingInstitutionId={cccId}&academicYearId={yearId}&categoryCode=major&key={agreementKey} (Returns the structured JSON tree detailing requirement sections, course conjunctions [AND], disjunctions [OR], and requirement notes).
4. MVP SCOPE FOR BUILD DAY (3 TO 5 HOURS)
To make the MVP rock-solid within hours, constrain the pre-seeded demo dataset while building the generic engine:
* Receiving Target: University of California, Berkeley (Institution ID: 118) and UCLA (Institution ID: 121).
* Target Majors: Computer Science (B.A. & B.S.) and Mechanical Engineering.
* Sending Feeder Colleges: De Anza College (ID: 113) and Foothill College (ID: 114) (the two most common Silicon Valley cross-enrollment sister colleges).
* Seed data should either be fetched live via a lightweight server proxy (to handle CORS) or stored as cached local JSON fixtures in /data.
5. ARCHITECTURAL REQUIREMENTS
* Frontend: High-velocity React / Next.js or Vite application styled with Tailwind CSS. Clean, responsive, and visual (using simple column-based semester cards or React Flow for DAG requirement mapping).
* Backend / Computational Core: TypeScript or Python algorithm module.
    * Model course nodes: { institutionId, courseCode, courseTitle, units, seriesGroup }
    * Model requirement rules: Boolean trees containing { type: 'AND' | 'OR', children: [...] }
    * Verification Engine: Function verifySchedule(selectedCourses: Course[], agreement: Agreement): ValidationResult that returns { isValid: boolean, missingRequirements: string[], splitSeriesViolations: Violation[] }.
    * Solver Engine: Greedy or SAT-based traversal that selects the minimal-unit course set satisfying all constraints across the user-selected institutions.
6. WHAT YOU NEED TO DO NOW
Act as our Lead Software Architect.
1. Define the exact TypeScript data interfaces for:
    * Course
    * RequirementNode
    * ArticulationRule
    * ValidationResult
2. Write the core verification and constraint-satisfaction algorithm that traverses the boolean requirement tree and evaluates multi-campus series constraints.
3. Structure the step-by-step project directory and build plan for our engineering team to implement the UI, the mock/live API ingestion layer, and the demo scenario in under 3 hours.
4. For the UI, we need a clean UI, minimalist like Notion, Stripe, Anthropic's website and apple's fluidity.
