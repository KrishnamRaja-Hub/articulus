import { useEffect, useMemo, useRef, useState } from 'react'
import { gsap } from 'gsap'
import { useGSAP } from '@gsap/react'
import { useReveal } from '../motion/useReveal'
import { byId, colleges, loadAgreement, majorsFor, unitSystems, universities, useTrust } from '../data'
import { formatDataDate } from '../data-trust'
import { nextOpenTerm, termKey, termLabel, termsFrom, type StartTerm } from '../terms'
import { has, honorsColleges, ucOnly, verifySchedule } from '../engine/verify'
import { SolveClient, type WorkerLike } from '../engine/solveClient'
import { honorsHints, honorsNote } from '../engine/hints'
import type { Agreement, CourseGroup, CourseId, Plan, ReqNode, Requirement, ValidationResult } from '../engine/types'
import Button from '../ui/Button'
import { Check, Cross } from './Trap'
import { badgeStatus, PLANNING, deferredOf, isBlocking, noMatchNote, optimalExplain, optimalNote, PREREQ_TAG, prereqOnlySet, scheduleCaveat, scheduleNote, splitUnsolvable, type ScheduleNote } from './plannerStatus'
import { DataBanner, Exclaim } from './DataStatus'

const MAX_TERMS = 6
const EMPTY_RESULT: ValidationResult = { isValid: false, satisfied: {}, missing: [], incomplete: {}, splitSeriesViolations: [], deferred: [] }
const EMPTY_PLAN: Plan = { terms: [], chosen: {}, result: EMPTY_RESULT, totalUnits: 0, unsolvable: [] }
// solve off the UI thread (TESTER2_REPORT M-4); no Worker (tests, old browsers): SolveClient solves on the main thread
const makeWorker = typeof Worker === 'undefined' ? null
  : () => new Worker(new URL('../engine/solve.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike
const capFor = (inst: number) => (byId[inst]?.terms === 'semester' ? 12 : 16)
const START_OPTIONS = 6
// one hue per selected college, assigned by position: home first
const PALETTE = [
  { chip: 'bg-campus-a-soft text-campus-a border-campus-a/20', dot: 'bg-campus-a', text: 'text-campus-a' },
  { chip: 'bg-campus-b-soft text-campus-b border-campus-b/20', dot: 'bg-campus-b', text: 'text-campus-b' },
  { chip: 'bg-[#e6f4ec] text-[#1f6f4a] border-[#1f6f4a]/20', dot: 'bg-[#1f6f4a]', text: 'text-[#1f6f4a]' },
  { chip: 'bg-[#f3e8fb] text-[#7a3ea6] border-[#7a3ea6]/20', dot: 'bg-[#7a3ea6]', text: 'text-[#7a3ea6]' },
  { chip: 'bg-[#fbecf0] text-[#b0284f] border-[#b0284f]/20', dot: 'bg-[#b0284f]', text: 'text-[#b0284f]' },
  { chip: 'bg-[#e6f2f6] text-[#1d6a7e] border-[#1d6a7e]/20', dot: 'bg-[#1d6a7e]', text: 'text-[#1d6a7e]' },
  { chip: 'bg-[#f4efe2] text-[#7a5b12] border-[#7a5b12]/20', dot: 'bg-[#7a5b12]', text: 'text-[#7a5b12]' },
  // enough for every college at once (home + 14 extras), so no selected college falls back to grey
  { chip: 'bg-[#ebe9fb] text-[#4a3fc4] border-[#4a3fc4]/20', dot: 'bg-[#4a3fc4]', text: 'text-[#4a3fc4]' },
  { chip: 'bg-[#eef4de] text-[#56701a] border-[#56701a]/20', dot: 'bg-[#56701a]', text: 'text-[#56701a]' },
  { chip: 'bg-[#f8e6f5] text-[#9c2f8f] border-[#9c2f8f]/20', dot: 'bg-[#9c2f8f]', text: 'text-[#9c2f8f]' },
  { chip: 'bg-[#def3ef] text-[#0e7466] border-[#0e7466]/20', dot: 'bg-[#0e7466]', text: 'text-[#0e7466]' },
  { chip: 'bg-[#f9e5e3] text-[#a3322a] border-[#a3322a]/20', dot: 'bg-[#a3322a]', text: 'text-[#a3322a]' },
  { chip: 'bg-[#e5ebf3] text-[#34507a] border-[#34507a]/20', dot: 'bg-[#34507a]', text: 'text-[#34507a]' },
  { chip: 'bg-[#f1e9e1] text-[#6e4a2e] border-[#6e4a2e]/20', dot: 'bg-[#6e4a2e]', text: 'text-[#6e4a2e]' },
  { chip: 'bg-[#e8f2e1] text-[#3d6b24] border-[#3d6b24]/20', dot: 'bg-[#3d6b24]', text: 'text-[#3d6b24]' },
]
const GREY = { chip: 'bg-bg text-ink-2 border-line', dot: 'bg-ink-3', text: 'text-ink-2' }
const code = (id: CourseId) => id.slice(id.indexOf(':') + 1)
const instOf = (id: CourseId) => Number(id.slice(0, id.indexOf(':')))

interface Row { req: Requirement; section: string; optional: boolean; choose?: number }
function flatten(n: ReqNode, section = '', choose?: number, acc: Row[] = []): Row[] {
  for (const c of n.children) {
    if (c.kind === 'req') acc.push({ req: c, section: n.title ?? section, optional: !n.required, choose })
    else flatten(c, c.title ?? section, c.type === 'N_OF' ? c.n : c.type === 'OR' ? 1 : undefined, acc)
  }
  return acc
}

export default function Planner() {
  const ref = useReveal<HTMLElement>()
  const [uc, setUc] = useState(universities[0].id)
  const [majorName, setMajorName] = useState(majorsFor(universities[0].id)[0]?.major ?? '')
  const [home, setHome] = useState(113)
  const [extra, setExtra] = useState<number[]>([51])
  const [taken, setTaken] = useState<Set<CourseId>>(new Set())
  const [query, setQuery] = useState('')
  const [hover, setHover] = useState<CourseId | null>(null)
  const [startPick, setStartPick] = useState<StartTerm | null>(null)
  const [today] = useState(() => new Date())
  const trust = useTrust()

  const [agreement, setAgreement] = useState<Agreement | null>(null)
  const [loadError, setLoadError] = useState<unknown>(null)
  const majors = majorsFor(uc)
  const entry = majors.find((m) => m.major === majorName) ?? majors[0]
  const load = useRef(0)
  useEffect(() => {
    const id = ++load.current
    setAgreement(null)
    loadAgreement(entry.file).then((a) => { if (load.current === id) setAgreement(a) },
      (e) => { if (load.current === id) setLoadError(e ?? new Error('Agreement failed to load')) })
  }, [entry.file])
  // a missing or unreadable agreement goes to the section's error boundary (TESTER2_REPORT M-8)
  if (loadError) throw loadError
  const terms = byId[home].terms, UNIT_CAP = capFor(home)
  // first term: the next one the student can still register for at the home college, unless they pick another
  const startOptions = termsFrom(nextOpenTerm(today, terms) ?? { season: 'Fall', year: today.getUTCFullYear() || 2026 }, terms, START_OPTIONS)
  const start = (startPick && startOptions.find((t) => termKey(t) === termKey(startPick))) || startOptions[0]
  const allowed = [home, ...extra.filter((id) => id !== home)]
  const paletteOf = (inst: number) => PALETTE[allowed.indexOf(inst)] ?? GREY
  const chip = (inst: number) => paletteOf(inst).chip
  const dot = (inst: number) => paletteOf(inst).dot
  const toggleExtra = (id: number) => setExtra((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]))

  const current = useMemo(() => (agreement ? verifySchedule(taken, agreement) : EMPTY_RESULT), [taken, agreement])
  // the newest request's id; a plan is shown only for the agreement it was solved for, and while a newer request is
  // out the badge says "Planning…" instead of a verdict on the old plan
  const [solved, setSolved] = useState<{ id: number; agreement: Agreement; plan: Plan } | null>(null)
  const [reqId, setReqId] = useState(0)
  const reqAgreement = useRef<Agreement | null>(null)
  const [client] = useState(() => new SolveClient(makeWorker, (id, plan) => setSolved({ id, agreement: reqAgreement.current!, plan })))
  useEffect(() => () => client.dispose(), [client])
  useEffect(() => {
    if (!agreement) return
    reqAgreement.current = agreement
    setReqId(client.request({ taken, agreement, opts: { allowed, home, unitCap: UNIT_CAP, maxTerms: MAX_TERMS, termSystem: terms, unitSystems, startTerm: start } }))
  }, [taken, agreement, allowed.join(), home, termKey(start)])
  const plan = agreement && solved?.agreement === agreement ? solved.plan : EMPTY_PLAN
  const planning = !!agreement && solved?.id !== reqId
  const rows = useMemo(() => (agreement ? flatten(agreement.root) : []), [agreement])
  // informational only: ASSIST lists the regular course where the student took the honors one (or the reverse)
  const hints = useMemo(() => honorsHints(rows.map((r) => r.req), taken), [rows, taken])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q || !agreement) return []
    const words = q.split(/\s+/)
    // rank: code prefix match ("phys 4") > number match ("4b") > title word match ("calculus iii": every query word
    // starts some title word); tolerate missing space ("phys4b")
    const rank = (c: { prefix: string; number: string; title: string }) => {
      const code = `${c.prefix} ${c.number}`.toLowerCase()
      if (code.startsWith(q) || code.replace(/\s+/g, '').startsWith(q.replace(/\s+/g, ''))) return 0
      if (c.number.toLowerCase().startsWith(q)) return 1
      const title = c.title.toLowerCase().split(/[\s,&/-]+/)
      if (words.every((x) => title.some((w) => w.startsWith(x)))) return 2
      return 9
    }
    return Object.values(agreement.catalog)
      .filter((c) => allowed.includes(c.institutionId) && !taken.has(c.id))
      .map((c) => ({ c, r: rank(c) }))
      .filter((x) => x.r < 9)
      .sort((a, b) => a.r - b.r || allowed.indexOf(a.c.institutionId) - allowed.indexOf(b.c.institutionId) || a.c.prefix.localeCompare(b.c.prefix) || a.c.number.localeCompare(b.c.number, undefined, { numeric: true }))
      .slice(0, 10)
      .map((x) => x.c)
  }, [query, agreement, allowed.join(), taken])

  const add = (id: CourseId) => { setTaken((s) => new Set([...s, id])); setQuery('') }
  const remove = (id: CourseId) => setTaken((s) => { const n = new Set(s); n.delete(id); return n })
  const loadScenario2 = () => {
    setUc(79); setMajorName(majorsFor(79).find((m) => /Mechanical/.test(m.major))?.major ?? majorsFor(79)[0]?.major ?? '')
    setHome(113); setExtra([51]); setTaken(new Set(['113:PHYS 4A', '113:PHYS 4B', '51:PHYS 4C']))
  }

  // animate the output whenever the plan changes
  const out = useRef<HTMLDivElement>(null)
  const planKey = plan.terms.map((t) => t.courses.join()).join('|') + current.splitSeriesViolations.length
  useGSAP(() => {
    if (!out.current) return // output not rendered yet (agreement still loading)
    gsap.matchMedia().add('(prefers-reduced-motion: no-preference)', () => {
      if (out.current?.querySelector('[data-term]'))
        gsap.fromTo('[data-term]', { y: 18, autoAlpha: 0 }, { y: 0, autoAlpha: 1, stagger: 0.07, duration: 0.7, overwrite: 'auto' })
      gsap.fromTo('[data-badge]', { scale: 0.92, autoAlpha: 0 }, { scale: 1, autoAlpha: 1, duration: 0.6, ease: 'back.out(1.6)', overwrite: 'auto' })
      if (out.current?.querySelector('[data-violation]'))
        gsap.fromTo('[data-violation]', { x: -10, autoAlpha: 0 }, { x: 0, autoAlpha: 1, stagger: 0.08, duration: 0.6, overwrite: 'auto' })
    })
  }, { scope: out, dependencies: [planKey] })

  // pin the requirement-map title while its rows scroll (desktop only)
  const map = useRef<HTMLDivElement>(null)
  useGSAP(() => {
    if (!map.current) return
    gsap.matchMedia().add('(min-width: 1024px) and (prefers-reduced-motion: no-preference)', () => {
      gsap.to('[data-pin]', { scrollTrigger: { trigger: map.current, start: 'top 112px', end: 'bottom 60%', pin: '[data-pin]', pinSpacing: false } })
    })
  }, { scope: map, dependencies: [rows.length, planKey], revertOnUpdate: true })

  const violations = current.splitSeriesViolations
  const ucShort = agreement ? byId[agreement.receivingId].short : ''
  // icon, color and title come from one status, so a red badge never claims coverage
  // untrusted data never shows green (DATA_CONTRACT.md); red verdicts still show, with a caveat
  const status = planning ? PLANNING : badgeStatus(current, plan, ucShort, trust.level)
  const ok = status.ok, unconfirmed = status.tone === 'unconfirmed'
  const hintList = Object.values(hints).flat()
  const deferred = deferredOf(current, plan)
  const reqOf = (id: string) => rows.find((r) => r.req.id === id)?.req
  // a plan that leaves requirements unmet never gets an optimality label (TESTER1_REPORT C-1: "0 units · minimum units")
  const incomplete = plan.unsolvable.length > 0 || !plan.result.isValid
  const note = incomplete ? 'does not finish the plan' : optimalNote(plan)
  const schedNote = planning ? null : scheduleNote(status, plan, trust.level)
  const caveat = scheduleCaveat(plan, trust.level, trust.fetchedAt ? formatDataDate(trust.fetchedAt) : null)
  const prereqOnly = prereqOnlySet(plan)
  const prereqWarnings = plan.prereqWarnings ?? []

  return (
    <section id="plan" ref={ref} className="px-6 py-32 md:py-48">
      <div className="mx-auto max-w-6xl">
        <DataBanner className="mb-10" />
        <div className="max-w-3xl">
          <h2 data-reveal className="h2">Plan across campuses. Verify against every agreement at once.</h2>
          <p data-reveal={0.1} className="lede mt-6">Pick a target, the colleges you can enroll at, and what you have finished. The engine runs on every change.</p>
        </div>

        {/* ---- inputs ---- */}
        <div data-reveal={0.15} className="card relative z-30 mt-14 grid grid-cols-1 gap-8 p-6 md:grid-cols-3 md:p-8">
          <Field label="Target">
            <Select value={uc} onChange={(v) => { const id = Number(v); setUc(id); setMajorName(majorsFor(id)[0]?.major ?? '') }}>
              {universities.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </Select>
            <Select value={entry.major} onChange={setMajorName}>
              {majors.map((m) => <option key={m.major} value={m.major}>{m.major}</option>)}
            </Select>
          </Field>

          <Field label="Colleges">
            <Select value={home} onChange={(v) => setHome(Number(v))} label="Home college">
              {colleges.map((c) => <option key={c.id} value={c.id}>{c.name} (home)</option>)}
            </Select>
            <div>
              <div className="mb-2 text-[13px] text-ink-3">First {terms} to plan</div>
              <Select value={termKey(start)} label={`First ${terms} to plan`} onChange={(k) => setStartPick(startOptions.find((t) => termKey(t) === k) ?? null)}>
                {startOptions.map((t, i) => <option key={termKey(t)} value={termKey(t)}>{termLabel(t)}{i === 0 ? ' (next open registration)' : ''}</option>)}
              </Select>
            </div>
            <div>
              <div className="mb-2 text-[13px] text-ink-3">Also enroll at, via CVC or district cross-enrollment</div>
              <div className="flex flex-wrap gap-1.5">
                {colleges.filter((c) => c.id !== home).map((c) => {
                  const on = extra.includes(c.id)
                  return (
                    <button key={c.id} onClick={() => toggleExtra(c.id)} aria-pressed={on}
                      className={`rounded-full border px-3 py-1 text-[13px] font-medium transition-all duration-300 ${on ? chip(c.id) : 'border-line bg-bg text-ink-2 hover:border-ink/30'}`}>
                      {c.short}
                    </button>
                  )
                })}
              </div>
            </div>
          </Field>

          <Field label="Completed courses">
            <div className="relative">
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search PHYS 4B, MATH 1A, chemistry…"
                aria-label="Search completed courses" autoComplete="off"
                onKeyDown={(e) => { if (e.key === 'Enter' && results[0]) add(results[0].id); if (e.key === 'Escape') setQuery('') }}
                className="h-12 w-full rounded-xl border border-line bg-bg px-4 text-[15px] placeholder:text-ink-3 transition-colors focus:border-ink/40" />
              {query.trim() && results.length === 0 && (
                <div className="absolute z-40 mt-2 w-full rounded-xl border border-line bg-white px-4 py-3 text-[14px] text-ink-2 shadow-[var(--shadow-card-hover)]">
                  {noMatchNote(query, agreement?.catalog ?? {}, allowed, taken, (i) => byId[i]?.short ?? String(i))}
                </div>
              )}
              {results.length > 0 && (
                <ul className="absolute z-40 mt-2 max-h-80 w-full overflow-y-auto rounded-xl border border-line bg-white shadow-[var(--shadow-card-hover)]">
                  {results.map((c) => (
                    <li key={c.id}>
                      <button onClick={() => add(c.id)} className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-[14.5px] first:rounded-t-xl hover:bg-bg">
                        <span><span className="font-medium">{c.prefix} {c.number}</span> <span className="text-ink-2">{c.title}</span></span>
                        <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11.5px] ${chip(c.institutionId)}`}>{byId[c.institutionId].short} · {c.units}u</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {results.length > 0 && <div className="-mt-1 text-[12.5px] text-ink-3">Enter adds the top result. Only courses that articulate for this major are listed.</div>}
            <div className="flex flex-wrap gap-2">
              {[...taken].map((id) => (
                <button key={id} onClick={() => remove(id)} title="Remove"
                  className={`group inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[13.5px] font-medium transition-all hover:opacity-70 ${chip(instOf(id))}`}>
                  {code(id)} <span className="opacity-60">· {byId[instOf(id)]?.short}</span><span className="ml-0.5 opacity-50 group-hover:opacity-100">×</span>
                </button>
              ))}
              {taken.size === 0 && <span className="text-[14px] text-ink-3">Nothing yet. Start from zero, or</span>}
              <Button variant="quiet" onClick={loadScenario2} className="text-[14px]">Load Scenario 2</Button>
            </div>
          </Field>
        </div>

        {/* ---- output ---- */}
        {!agreement ? <div className="card mt-8 p-6 opacity-60">Loading agreement…</div> : <div ref={out} aria-busy={planning} className="relative z-0 mt-8">
          <div data-badge data-tone={status.tone} className={`card flex flex-col gap-4 p-5 md:flex-row md:items-center md:justify-between md:p-6 ${ok || planning ? '' : unconfirmed ? 'border-warn/40' : 'border-alert/30'}`}>
            <div className="flex items-center gap-4">
              <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-full text-white ${ok ? 'bg-accent' : planning ? 'bg-ink-3' : unconfirmed ? 'bg-warn' : 'bg-alert'}`}>{ok ? <Check /> : planning ? <span aria-hidden className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" /> : unconfirmed ? <Exclaim /> : <Cross />}</span>
              <div>
                <div role="status" className={`text-[17px] font-medium ${unconfirmed ? 'text-warn' : ''}`}>{status.title}</div>
                <div className="text-[14px] text-ink-2">{agreement.major} · {ucShort} · {agreement.year} agreement</div>
                {status.details.length > 0 && <div className="text-[14px] font-medium text-ink-2">{status.details.join(' · ')}</div>}
                {status.caveat && <div data-caveat className={`mt-1 text-[13.5px] ${trust.level === 'aging' ? 'text-ink-3' : 'text-warn'}`}>{status.caveat}</div>}
              </div>
            </div>
            <dl className="grid grid-cols-3 gap-6 text-[14px] text-ink-2 md:text-right">
              <Stat n={plan.terms.length} l={plan.terms.length === 1 ? terms : `${terms}s`} />
              <Stat n={plan.totalUnits} l={incomplete ? 'units scheduled' : 'units to go'} note={note} title={incomplete ? undefined : optimalExplain(plan)} />
              <Stat n={Object.keys(plan.result.satisfied).length} l="requirements" />
            </dl>
          </div>

          {violations.length > 0 && (
            <div className="mt-4 grid gap-4">
              {violations.map((v) => {
                const fix = plan.chosen[v.requirementId]
                // honors twins count as the same course where the engine allows mixing (MATH 1BH stands in for MATH 1B)
                const req = reqOf(v.requirementId)
                const mix = req ? honorsColleges(req) : false
                const todo = fix?.courses.filter((c) => !has(taken, c, mix)) ?? []
                // this violation's own pieces that the repair does not reuse: they earn nothing toward it
                const wasted = v.partials.flatMap((p) => p.have).filter((c) => !fix || !has(new Set(fix.courses), c, mix))
                // non-blocking: the pieces earn nothing, but the plan does not depend on this requirement
                if (!isBlocking(v)) return (
                  <div key={v.requirementId} data-violation className="card border-warn/30 p-6 md:p-7">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <h3 className="h3 text-warn">{v.requirementId} is split across {v.partials.length} campuses</h3>
                      <span className="text-[14px] text-ink-2">Warning. It does not block your plan.</span>
                    </div>
                    <p className="mt-3 text-[15px] text-ink-2">
                      {fix && todo.length ? `These courses earn no credit toward it. Your plan completes it with ${todo.map(code).join(' and ')} at ${byId[fix.institutionId].name}.`
                        : "These courses earn no credit toward it, but your plan doesn't need it."}
                    </p>
                    <HintNotes hints={hints[v.requirementId]} />
                    {wasted.length > 0 && (
                      <ul className="mt-4 flex flex-wrap gap-2">
                        {wasted.map((c) => (
                          <li key={c} className="rounded-full border border-warn/25 bg-warn-soft px-3 py-1 text-[13.5px] text-warn">
                            <span className="font-medium">{code(c)}</span> at {byId[instOf(c)].short} · no credit
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )
                return (
                  <div key={v.requirementId} data-violation className="card border-alert/30 p-6 md:p-7">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <h3 className="h3 text-alert">{v.requirementId} is split across {v.partials.length} campuses</h3>
                      <span className="text-[14px] text-ink-2">{byId[agreement.receivingId].short} requires the full series from one college</span>
                    </div>
                    <div className="mt-5 grid gap-3 sm:grid-cols-2">
                      {v.partials.map((p) => (
                        <div key={p.institutionId} className="rounded-2xl border border-line bg-bg/60 p-4">
                          <div className={`text-[12px] font-semibold uppercase tracking-wider ${paletteOf(p.institutionId).text}`}>{byId[p.institutionId].name}</div>
                          <ul className="mt-2 space-y-1.5 text-[15px]">
                            {p.have.map((c) => <li key={c} className="flex justify-between"><span className="font-medium">{code(c)}</span><span className="text-ink-3">taken</span></li>)}
                            {p.missing.map((c) => <li key={c} className="flex justify-between text-ink-2"><span>{code(c)}</span><span className="text-alert">missing</span></li>)}
                          </ul>
                        </div>
                      ))}
                    </div>
                    <HintNotes hints={hints[v.requirementId]} />
                    {fix && (
                      <p className="mt-5 rounded-2xl bg-accent-soft px-5 py-4 text-[15px] text-accent">
                        <span className="font-semibold">Repair:</span> complete {todo.map(code).join(' and ')} at {byId[fix.institutionId].name}.
                        {wasted.length > 0 && <> {wasted.map((c) => `${code(c)} at ${byId[instOf(c)].short}`).join(', ')} earns no credit toward {v.requirementId}.</>}
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {plan.unsolvable.length > 0 && (
            <div className="card mt-4 border-alert/30 p-6 text-[15px]">
              <div className="font-medium text-alert">Not coverable at {allowed.map((i) => byId[i].short).join(' + ')}</div>
              <ul className="mt-3">
                {plan.unsolvable.map((u) => {
                  const { what, offeredAt } = splitUnsolvable(u)
                  return (
                    <li key={u} className="flex flex-wrap items-baseline gap-x-3 border-t border-line py-2 first:border-t-0">
                      <span className="font-medium [overflow-wrap:anywhere]">{what}</span>
                      {offeredAt && <span className="text-[14px] text-ink-2">Offered at {offeredAt}</span>}
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          {deferred.length > 0 && (
            <div className="card mt-4 p-6 text-[15px]">
              <div className="font-medium">Complete at {ucShort} after transfer</div>
              <p className="mt-1 text-[14px] text-ink-2">No community college in this agreement offers an equivalent, so these do not count against your plan.</p>
              <ul className="mt-3">
                {deferred.map((id) => {
                  const req = reqOf(id)
                  const why = Object.values(req?.noArticulation ?? {})[0]
                  return (
                    <li key={id} className="border-t border-line py-2">
                      <div className="flex flex-wrap items-baseline gap-x-3">
                        <span className="font-medium">{id}</span>
                        {req && req.label !== id && <span className="text-[14px] text-ink-2">{req.label}</span>}
                      </div>
                      {why && <div className="text-[13.5px] text-ink-3">ASSIST: {why}</div>}
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          {hintList.length > 0 && (
            <div data-hints className="card mt-4 p-6 text-[15px]">
              <div className="font-medium">Ask before you retake</div>
              <p className="mt-1 text-[14px] text-ink-2">These rows still count as missing: ASSIST lists a different version of a course you took, or lists it only together with another course. The schedule below plans what ASSIST lists.</p>
              <ul className="mt-3">
                {hintList.map((h) => (
                  <li key={`${h.requirementId}|${h.institutionId}`} className="border-t border-line py-2">
                    <div className="flex flex-wrap items-baseline gap-x-3">
                      <span className="font-medium">{h.requirementId}</span>
                      <span className="text-[14px] text-ink-2">{byId[h.institutionId]?.name}</span>
                    </div>
                    <div className="text-[14px] text-ink-2">{honorsNote(h)}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* ---- schedule ---- */}
          <div className="mt-12">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h3 className="h3">Your cross-enrollment schedule</h3>
              <span className="text-[14px] text-ink-3">Starts {termLabel(start)} · {UNIT_CAP} units per term max</span>
            </div>
            {plan.terms.length > 0 && !incomplete && note && <p data-optimal className="mt-1 max-w-3xl text-[13.5px] text-ink-3">How it is chosen: {optimalExplain(plan)}</p>}
            {caveat && <Notice note={caveat} data="schedule-caveat" />}
            {schedNote && <Notice note={schedNote} data="schedule-note" />}
            {prereqWarnings.length > 0 && (
              <div data-prereq-warnings className="mt-4 rounded-2xl border border-warn/30 bg-warn-soft px-5 py-3 text-[14px] text-warn">
                <div className="font-medium">Check these prerequisites before you enroll</div>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink-2">{prereqWarnings.map((w) => <li key={w}>{w}</li>)}</ul>
              </div>
            )}
            {plan.terms.length > 0 && (
              <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-3">
                {plan.terms.map((t, i) => (
                  <div key={t.name} data-term className={`card card-hover min-w-0 p-5 ${i >= MAX_TERMS ? 'border-alert/30' : ''}`}>
                    <div className="flex items-baseline justify-between gap-3">
                      <div className="font-medium">{t.name}</div>
                      <div className={`shrink-0 text-[13px] ${t.overCap ? 'text-alert' : 'text-ink-3'}`}>{t.units} units{t.overCap && ` · over the ${UNIT_CAP}-unit cap`}</div>
                    </div>
                    <ul className="mt-4 space-y-2">
                      {t.courses.map((c) => {
                        const course = agreement.catalog[c]
                        return (
                          <li key={c} onMouseEnter={() => setHover(c)} onMouseLeave={() => setHover(null)}
                            className={`flex items-center gap-3 rounded-xl border px-3 py-2 transition-all duration-300 ${chip(instOf(c))} ${hover === c ? 'scale-[1.02] shadow' : ''}`}>
                            <span className={`h-2 w-2 shrink-0 rounded-full ${dot(instOf(c))}`} />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[14.5px]"><span className="font-semibold">{code(c)}</span> <span className="opacity-70">{course?.title}</span></span>
                              {prereqOnly.has(c) && <span data-prereq-only className="mt-0.5 inline-block rounded-full border border-current/30 px-1.5 text-[11.5px] font-medium opacity-80" title="Needed to enroll in a later course; not a UC requirement">{PREREQ_TAG}</span>}
                            </span>
                            <span className="shrink-0 text-[12px] opacity-70">{byId[instOf(c)].short}</span>
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            )}
            {plan.terms.length > MAX_TERMS && <p className="mt-3 text-[14px] text-alert">More than {MAX_TERMS} {terms}s needed at this unit cap.</p>}
          </div>

          {/* ---- requirement map ---- */}
          <div ref={map} className="mt-24 grid grid-cols-1 gap-10 lg:grid-cols-12">
            <div className="lg:col-span-4">
              <div data-pin>
                <h3 className="h2">Every requirement, traced to a row on ASSIST.</h3>
                <p className="mt-4 text-[15.5px] text-ink-2">Hover a course in the schedule to see what it satisfies. Series are completed at one campus, always.</p>
                <div className="mt-6 flex flex-wrap gap-3 text-[13px] text-ink-2">
                  {allowed.map((id) => <span key={id} className="inline-flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${dot(id)}`} />{byId[id].name} <span className="text-ink-3">({byId[id].terms})</span></span>)}
                </div>
              </div>
            </div>
            <ul className="lg:col-span-8">
              {rows.map((r, i) => {
                const prev = rows[i - 1]
                const g: CourseGroup | undefined = plan.result.satisfied[r.req.id] ?? plan.chosen[r.req.id]
                const done = !!current.satisfied[r.req.id]
                const split = violations.find((v) => v.requirementId === r.req.id)
                const viol = !!split && isBlocking(split), warn = !!split && !viol
                const later = deferred.includes(r.req.id)
                const lit = hover && g?.courses.includes(hover)
                const noArt = r.req.groups.length === 0
                const offered = r.req.groups.some((x) => allowed.includes(x.institutionId))
                // red only when the plan actually needs it: a "choose N" alternative counts once the solver reports it
                const needed = !r.optional && (!r.choose || plan.unsolvable.some((u) => u.includes(r.req.id)))
                return (
                  <li key={r.req.id + i}>
                    {(!prev || prev.section !== r.section) && (
                      <div className="mt-8 mb-3 flex items-baseline gap-3 text-[13px] first:mt-0">
                        <span className="font-semibold uppercase tracking-wider text-ink-2">{r.section || 'Requirements'}</span>
                        {r.optional && <span className="text-ink-3">recommended</span>}
                      </div>
                    )}
                    {r.choose && (!prev || prev.section !== r.section || prev.choose !== r.choose) && (
                      <div className="mt-4 mb-2 text-[13px] text-ink-3">Choose {r.choose} of the following</div>
                    )}
                    <div className={`flex items-center gap-4 border-t border-line py-3.5 transition-colors duration-300 ${lit ? 'bg-white' : ''} ${r.optional && !g ? 'opacity-60' : ''}`}>
                      <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-white ${viol ? 'bg-alert' : warn ? 'bg-warn' : done ? 'bg-accent' : g ? 'border-2 border-ink/70 bg-transparent' : 'border border-line bg-transparent'}`}>
                        {viol || warn ? <Cross /> : done ? <Check /> : null}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-3">
                          <span className="font-medium">{r.req.id}</span>
                          <span className="truncate text-[14px] text-ink-2">{r.req.label !== r.req.id ? r.req.label : ''}</span>
                        </div>
                        {!done && hints[r.req.id]?.map((h) => (
                          <p key={h.institutionId} data-hint className="mt-1 text-[13px] text-campus-a">{honorsNote(h)}</p>
                        ))}
                      </div>
                      <div className="flex max-w-[60%] shrink-0 flex-wrap justify-end gap-1.5">
                        {g ? g.courses.map((c) => (
                          <span key={c} className={`rounded-full border px-2.5 py-0.5 text-[12.5px] font-medium transition-all duration-300 ${chip(g.institutionId)} ${hover === c ? 'ring-2 ring-ink/20' : ''}`}>{code(c)}</span>
                        )) : later ? <span className="rounded-full border border-line bg-bg px-2.5 py-0.5 text-[12.5px] font-medium text-ink-2">Take at {ucShort} after transfer</span>
                          : warn ? <span className="text-[13px] text-warn">split, not needed</span>
                          : noArt ? (ucOnly(r.req) ? <span className="text-[13px] text-ink-3">{Object.values(r.req.noArticulation ?? {})[0]}</span>
                            : <span className={`text-[13px] ${r.optional ? 'text-ink-3' : 'text-alert'}`}>No ASSIST record · confirm with a counselor</span>)
                          : <span className={`text-[13px] ${viol || offered || !needed ? 'text-ink-3' : 'text-alert'}`}>{viol ? 'split' : offered ? 'not needed for the cheapest path' : 'not articulated at the selected colleges'}</span>}
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>
        </div>}
      </div>
    </section>
  )
}

/** Informational honors note inside a split card; never changes the verdict. */
function HintNotes({ hints }: { hints?: ReturnType<typeof honorsHints>[string] }) {
  if (!hints?.length) return null
  return <>{hints.map((h) => <p key={h.institutionId} data-hint className="mt-4 rounded-2xl bg-campus-a-soft px-5 py-3 text-[14px] text-campus-a">{honorsNote(h)}</p>)}</>
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="text-[13px] font-semibold uppercase tracking-wider text-ink-2">{label}</div>
      {children}
    </div>
  )
}

function Select<T extends string | number>({ value, onChange, children, label }: { value: T; onChange: (v: string) => void; children: React.ReactNode; label?: string }) {
  return (
    <div className="relative">
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}
        className="h-12 w-full appearance-none rounded-xl border border-line bg-bg pr-10 pl-4 text-[15px] transition-colors hover:border-ink/30 focus:border-ink/40">
        {children}
      </select>
      <svg viewBox="0 0 16 16" className="pointer-events-none absolute top-1/2 right-4 h-3.5 w-3.5 -translate-y-1/2 text-ink-3" fill="none" aria-hidden><path d="m3 6 5 5 5-5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </div>
  )
}

const Stat = ({ n, l, note, title }: { n: number; l: string; note?: string | null; title?: string }) => (
  <div title={title}>
    <dt className="text-[22px] font-medium tracking-tight text-ink">{n}</dt>
    <dd>{l}{note && <span className={`block text-[12.5px] text-ink-3 ${title ? 'cursor-help underline decoration-dotted underline-offset-2' : ''}`}>{note}</span>}</dd>
  </div>
)

const NOTICE: Record<ScheduleNote['tone'], string> = {
  ok: 'text-ink-2',
  warn: 'rounded-2xl border border-warn/30 bg-warn-soft px-5 py-3 text-warn',
  alert: 'rounded-2xl border border-alert/30 bg-alert-soft px-5 py-3 text-alert',
}
/** A schedule-level message; its tone comes from the verdict, never from the number of terms. */
function Notice({ note, data }: { note: ScheduleNote; data: string }) {
  return <p {...{ [`data-${data}`]: note.tone }} role={note.tone === 'alert' ? 'note' : undefined} className={`mt-4 text-[14.5px] ${NOTICE[note.tone]}`}>{note.text}</p>
}
