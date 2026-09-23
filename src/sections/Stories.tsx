import { useRef } from 'react'
import { gsap } from 'gsap'
import { useGSAP } from '@gsap/react'
import { useReveal } from '../motion/useReveal'

const STORIES = [
  {
    where: 'Mt. San Antonio College → UC Berkeley',
    title: 'One online calculus class, one rescinded offer.',
    body: 'Admitted to Berkeley, a student finished MATH 181 through a CVC online section at a second college. They quit their job and signed a Berkeley lease. In late summer the transcript audit found the online course only articulated when paired with a follow-up class at that same campus. Admission rescinded, one year lost.',
    tag: 'Scenario 1',
  },
  {
    where: 'De Anza College + Foothill College → UCLA',
    title: 'Two accredited colleges, fifteen minutes apart, zero physics credit.',
    body: 'Physics 2 collided with multivariable calculus at De Anza, so an engineering student took it at Foothill in the same district. De Anza covers thermodynamics in Physics 2, Foothill in Physics 3. UCLA requires the series from a single institution and invalidated both courses. Major eligibility gone, a full year of physics to retake.',
    tag: 'Scenario 2',
  },
  {
    where: 'Three semesters with a counselor → target university',
    title: 'The roadmap was approved. The degree audit disagreed.',
    body: 'A transfer applicant planned every term with an on-campus counselor. The summer pre-enrollment audit flagged that an elective used for a major prerequisite depended on an introductory course the student never took. Human error acknowledged, policy unchanged. Full-time status forfeited, aid cancelled, loan repayment triggered.',
    tag: 'Scenario 3',
  },
]

export default function Stories() {
  const ref = useReveal<HTMLElement>()
  const stack = useRef<HTMLDivElement>(null)

  useGSAP(() => {
    gsap.matchMedia().add('(prefers-reduced-motion: no-preference) and (min-width: 768px)', () => {
      const cards = gsap.utils.toArray<HTMLElement>('[data-card]', stack.current)
      cards.forEach((card, i) => {
        const next = cards[i + 1]
        if (!next) return
        gsap.to(card, {
          scale: 0.94, opacity: 0.45, filter: 'blur(2px)', ease: 'none',
          scrollTrigger: { trigger: next, start: 'top 85%', end: 'top 14%', scrub: true },
        })
      })
    })
  }, { scope: ref })

  return (
    <section id="stories" ref={ref} className="px-6 py-32 md:py-48">
      <div className="mx-auto max-w-6xl">
        <div className="max-w-3xl">
          <h2 data-reveal className="h2">This happens every year, to students who did everything right.</h2>
          <p data-reveal={0.1} className="lede mt-6">Three patterns we built Articulus to make impossible.</p>
        </div>

        <div ref={stack} className="mt-20 flex flex-col gap-6 md:gap-[18vh]">
          {STORIES.map((s, i) => (
            <article key={s.tag} data-card className="card sticky top-[12vh] origin-top p-7 will-change-transform md:p-12" style={{ zIndex: i + 1 }}>
              <div className="flex flex-col gap-8 md:flex-row md:gap-16">
                <div className="md:w-5/12">
                  <div className="text-[13px] font-medium text-ink-3">{s.where}</div>
                  <h3 className="mt-4 text-[clamp(1.6rem,2.6vw,2.4rem)] leading-[1.12] font-medium tracking-[-0.025em]">{s.title}</h3>
                </div>
                <p className="text-[17px] leading-[1.6] text-ink-2 md:w-7/12 md:pt-8">{s.body}</p>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}
