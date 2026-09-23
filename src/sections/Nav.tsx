import { useRef } from 'react'
import { gsap } from 'gsap'
import { useGSAP } from '@gsap/react'
import Button from '../ui/Button'

export default function Nav() {
  const ref = useRef<HTMLElement>(null)
  useGSAP(() => {
    gsap.from(ref.current, { y: -24, autoAlpha: 0, duration: 1, delay: 0.2 })
    // shrink the pill slightly once the hero is behind us
    gsap.to(ref.current, {
      scale: 0.96, scrollTrigger: { trigger: document.body, start: '80px top', end: '240px top', scrub: true },
    })
  }, { scope: ref })

  return (
    <header ref={ref} className="fixed top-4 left-1/2 z-50 -translate-x-1/2 will-change-transform">
      <nav className="glass flex items-center gap-1 rounded-full border border-white/60 px-2 py-1.5 shadow-[0_8px_30px_-12px_rgba(17,17,16,.25)]">
        <a href="#top" className="flex items-center gap-2 pl-3 pr-3 text-[15px] font-semibold tracking-tight">
          <Mark />
          Articulus
        </a>
        <div className="hidden items-center sm:flex">
          {[['#trap', 'The trap'], ['#stories', 'Stories'], ['#plan', 'Planner']].map(([href, label]) => (
            <a key={href} href={href} className="rounded-full px-3.5 py-2 text-[14px] text-ink-2 transition-colors hover:bg-black/5 hover:text-ink">
              {label}
            </a>
          ))}
        </div>
        <Button href="#plan" className="ml-1 h-9 px-4 text-[14px]">Plan my transfer</Button>
      </nav>
    </header>
  )
}

export function Mark({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden>
      <path d="M4 18 12 5l8 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 18h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}
