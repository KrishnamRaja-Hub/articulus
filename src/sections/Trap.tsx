import { useMemo, useRef, useState } from 'react'
import { gsap } from 'gsap'
import { useGSAP } from '@gsap/react'
import { useReveal } from '../motion/useReveal'
import { agreements, byId } from '../data'
import { verifySchedule } from '../engine/verify'

const DA = 113, FH = 51

export default function Trap() {
  const ref = useReveal<HTMLElement>()
  const para = useRef<HTMLParagraphElement>(null)

  // word-level scrub: opacity 0.15 -> 1 as the paragraph passes through the viewport
  useGSAP(() => {
    gsap.matchMedia().add('(prefers-reduced-motion: no-preference)', () => {
      gsap.fromTo(gsap.utils.toArray('[data-word]', para.current), { opacity: 0.15 }, {
        opacity: 1, stagger: 0.08, ease: 'none',
        scrollTrigger: { trigger: para.current, start: 'top 75%', end: 'bottom 45%', scrub: true },
      })
    })
  }, { scope: ref })

  const text = 'Enrollment across California community colleges is one click on CVC. Articulation is not. ASSIST evaluates one college to one university at a time, and a series that looks complete on two transcripts can be worth nothing on the one that matters.'

  return (
    <section id="trap" ref={ref} className="px-6 py-32 md:py-48">
      <div className="mx-auto max-w-6xl">
        <p ref={para} className="h2 max-w-5xl">
          {text.split(' ').map((w, i) => <span key={i} data-word className="inline-block mr-[0.28em]">{w}</span>)}
        </p>

        <div className="mt-20 grid grid-flow-dense grid-cols-1 gap-4 md:grid-cols-6 md:auto-rows-[minmax(220px,auto)]">
          <div data-reveal className="card card-hover p-6 md:col-span-4 md:row-span-2 md:p-8"><LiveCheck /></div>

          <Card className="md:col-span-2" delay={0.05} title="Pairwise, by design">
            ASSIST publishes one agreement per sending college and receiving university. There is no row for De Anza plus Foothill, because nobody wrote one.
          </Card>
          <Card className="md:col-span-2" delay={0.1} title="Not transitive">
            <Chain />
          </Card>
          <Card className="md:col-span-3" delay={0.15} title="Discovered in July">
            Conditional offers are audited after spring grades post. A split series found then means a rescinded admission and a full year before you can reapply.
          </Card>
          <Card className="md:col-span-3" delay={0.2} title="Deterministic, not conversational">
            No language model guesses equivalence. Every verdict traces to an ASSIST articulation row, and the same inputs produce the same schedule every time.
          </Card>
        </div>
      </div>
    </section>
  )
}

function Card({ title, children, className = '', delay = 0 }: { title: string; children: React.ReactNode; className?: string; delay?: number }) {
  return (
    <div data-reveal={delay} className={`card card-hover flex flex-col justify-between gap-6 p-6 md:p-7 ${className}`}>
      <h3 className="h3">{title}</h3>
      <div className="text-[15.5px] leading-relaxed text-ink-2">{children}</div>
    </div>
  )
}

function Chain() {
  const row = (l: string, ok: boolean) => (
    <div className="flex items-center justify-between border-t border-line py-2.5 first:border-t-0">
      <span className="text-ink">{l}</span>
      <span className={`text-[13px] font-medium ${ok ? 'text-accent' : 'text-alert'}`}>{ok ? 'articulates' : 'zero credit'}</span>
    </div>
  )
  return <div>{row('De Anza → Berkeley', true)}{row('Foothill → Berkeley', true)}{row('De Anza + Foothill → Berkeley', false)}</div>
}

/** Runs the real engine against the real Berkeley ME agreement. */
function LiveCheck() {
  const [split, setSplit] = useState(true)
  const me = agreements.find((a) => a.receivingId === 79 && /Mechanical/.test(a.major))!
  const taken = useMemo(() => new Set(split ? [`${DA}:PHYS 4B`, `${FH}:PHYS 4C`] : [`${DA}:PHYS 4B`, `${DA}:PHYS 4C`]), [split])
  const result = useMemo(() => verifySchedule(taken, me), [taken, me])
  const v = result.splitSeriesViolations.find((x) => x.requirementId === 'PHYSICS 7B')
  const ok = !!result.satisfied['PHYSICS 7B']
  // credit in the university's own unit system: De Anza is on quarters, Berkeley on semesters (1 semester unit = 1.5 quarter)
  const sys = byId[me.receivingId].terms
  const credited = [...taken].reduce((u, c) => {
    const k = me.catalog[c]
    const from = byId[k.institutionId].terms
    return u + (from === sys ? k.units : from === 'quarter' ? k.units / 1.5 : k.units * 1.5)
  }, 0)

  const box = useRef<HTMLDivElement>(null)
  useGSAP(() => {
    gsap.fromTo(box.current, { y: 8, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.5 })
  }, { dependencies: [split] })

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="h3">Try it on the real agreement</h3>
          <p className="mt-1 text-[15px] text-ink-2">UC Berkeley · Mechanical Engineering · PHYSICS 7B</p>
        </div>
        <div role="tablist" className="inline-flex rounded-full border border-line bg-bg p-1 text-[14px]">
          {[['same', 'Both at De Anza'], ['split', 'One at each']].map(([k, l]) => (
            <button key={k} role="tab" aria-selected={split === (k === 'split')} onClick={() => setSplit(k === 'split')}
              className={`rounded-full px-4 py-1.5 transition-all duration-500 ${split === (k === 'split') ? 'bg-ink text-white shadow' : 'text-ink-2 hover:text-ink'}`}>
              {l}
            </button>
          ))}
        </div>
      </div>

      <div ref={box} className="mt-8 grid flex-1 grid-cols-1 gap-4 sm:grid-cols-2">
        <Campus name="De Anza" tone="a" courses={[['PHYS 4B', true], ['PHYS 4C', !split]]} />
        <Campus name="Foothill" tone="b" courses={[['PHYS 4B', false], ['PHYS 4C', split]]} />
      </div>

      <div className={`mt-6 flex items-center justify-between rounded-2xl px-5 py-4 ${ok ? 'bg-accent-soft text-accent' : 'bg-alert-soft text-alert'}`}>
        <div className="flex items-center gap-3">
          <span className={`grid h-7 w-7 place-items-center rounded-full ${ok ? 'bg-accent' : 'bg-alert'} text-white`}>
            {ok ? <Check /> : <Cross />}
          </span>
          <span className="font-medium">{ok ? 'PHYSICS 7B satisfied at De Anza' : 'Split series. PHYSICS 7B not satisfied.'}</span>
        </div>
        <span className="text-[14px] opacity-80">{ok ? `${Math.round(credited * 10) / 10} ${sys} units credited` : v ? '0 units credited' : ''}</span>
      </div>
    </div>
  )
}

function Campus({ name, tone, courses }: { name: string; tone: 'a' | 'b'; courses: [string, boolean][] }) {
  const c = tone === 'a' ? 'text-campus-a' : 'text-campus-b'
  const bg = tone === 'a' ? 'bg-campus-a-soft' : 'bg-campus-b-soft'
  return (
    <div className="rounded-2xl border border-line bg-bg/60 p-4">
      <div className={`text-[12px] font-semibold tracking-wider uppercase ${c}`}>{name}</div>
      <ul className="mt-3 space-y-2">
        {courses.map(([label, on]) => (
          <li key={label} className={`flex items-center justify-between rounded-xl px-3 py-2 text-[15px] transition-all duration-500 ${on ? `${bg} text-ink` : 'text-ink-3 line-through decoration-line/0'}`}>
            <span className={on ? 'font-medium' : ''}>{label}</span>
            <span className="text-[12px]">{on ? 'taken' : 'not taken'}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export const Check = () => <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden><path d="m3 8.5 3 3 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
export const Cross = () => <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
