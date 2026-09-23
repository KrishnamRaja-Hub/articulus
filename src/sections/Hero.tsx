import { useRef } from 'react'
import { gsap } from 'gsap'
import { useGSAP } from '@gsap/react'
import Button from '../ui/Button'

export default function Hero() {
  const ref = useRef<HTMLElement>(null)
  useGSAP(() => {
    const mm = gsap.matchMedia()
    mm.add('(prefers-reduced-motion: no-preference)', () => {
      const tl = gsap.timeline({ defaults: { ease: 'power3.out' } })
      tl.from('[data-line]', { yPercent: 110, autoAlpha: 0, duration: 1.1, stagger: 0.09 }, 0.1)
        .from('[data-lede]', { y: 20, autoAlpha: 0, duration: 0.9 }, 0.55)
        .from('[data-cta]', { y: 16, autoAlpha: 0, duration: 0.8, stagger: 0.08 }, 0.7)
        .from('[data-figure]', { y: 40, autoAlpha: 0, scale: 0.98, duration: 1.2 }, 0.8)
      // draw the graph
      const paths = gsap.utils.toArray<SVGPathElement>('[data-draw]')
      paths.forEach((p) => { const l = p.getTotalLength(); gsap.set(p, { strokeDasharray: l, strokeDashoffset: l }) })
      tl.to(paths, { strokeDashoffset: 0, duration: 1.4, stagger: 0.12, ease: 'power2.inOut' }, 1.3)
        .from('[data-node]', { scale: 0.85, autoAlpha: 0, transformOrigin: '50% 50%', stagger: 0.06, duration: 0.6 }, 1.2)
        .from('[data-zero]', { scale: 0.6, autoAlpha: 0, transformOrigin: '50% 50%', duration: 0.6, ease: 'back.out(2)' }, 2.6)
      // gentle parallax on scroll
      gsap.to('[data-figure]', { yPercent: -8, ease: 'none', scrollTrigger: { trigger: ref.current, start: 'top top', end: 'bottom top', scrub: true } })
    })
  }, { scope: ref })

  return (
    <section id="top" ref={ref} className="relative flex min-h-[100svh] flex-col items-center px-6 pt-36 pb-24 text-center md:pt-44">
      <h1 className="display mx-auto w-full max-w-6xl">
        <span className="block overflow-hidden"><span data-line className="block">Transfer plans that</span></span>
        <span className="block overflow-hidden"><span data-line className="block">survive the July audit.</span></span>
      </h1>
      <p data-lede className="lede mx-auto mt-7 max-w-2xl">
        Articulus checks every course against the real ASSIST articulation for every college you enroll at, together, so a
        split series never costs you your admission.
      </p>
      <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
        <span data-cta className="inline-flex"><Button href="#plan" size="lg">Plan my transfer</Button></span>
        <span data-cta className="inline-flex"><Button href="#trap" size="lg" variant="ghost">See the trap</Button></span>
      </div>

      <figure data-figure className="card mx-auto mt-20 w-full max-w-5xl p-6 md:p-10 will-change-transform">
        <SplitGraph />
        <figcaption className="mt-6 text-[14px] text-ink-3">
          Real 2025-26 data. UC Berkeley Physics 7B articulates from PHYS 4B + 4C at De Anza, or PHYS 4B + 4C at Foothill. Never one from each.
        </figcaption>
      </figure>
    </section>
  )
}

/** Three-column hypergraph: De Anza | Berkeley requirement | Foothill. */
function SplitGraph() {
  const node = (x: number, y: number, label: string, sub: string, tone: 'a' | 'b' | 'uc', w = 164) => {
    const fill = tone === 'a' ? 'var(--color-campus-a-soft)' : tone === 'b' ? 'var(--color-campus-b-soft)' : '#fff'
    const stroke = tone === 'a' ? 'var(--color-campus-a)' : tone === 'b' ? 'var(--color-campus-b)' : 'var(--color-ink)'
    return (
      <g data-node transform={`translate(${x} ${y})`}>
        <rect x={-w / 2} y="-26" width={w} height="52" rx="14" fill={fill} stroke={stroke} strokeWidth="1.25" />
        <text textAnchor="middle" y="-3" fontSize="15" fontWeight="600" fill="var(--color-ink)">{label}</text>
        <text textAnchor="middle" y="15" fontSize="11.5" fill="var(--color-ink-2)">{sub}</text>
      </g>
    )
  }
  return (
    <svg viewBox="0 0 900 340" className="w-full" role="img" aria-label="Diagram of a physics series split across De Anza and Foothill failing to articulate to UC Berkeley">
      <defs>
        <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 10 5 0 10z" fill="context-stroke" />
        </marker>
      </defs>
      <text x="130" y="40" textAnchor="middle" fontSize="12" letterSpacing="1.5" fill="var(--color-campus-a)">DE ANZA</text>
      <text x="450" y="40" textAnchor="middle" fontSize="12" letterSpacing="1.5" fill="var(--color-ink-3)">UC BERKELEY</text>
      <text x="770" y="40" textAnchor="middle" fontSize="12" letterSpacing="1.5" fill="var(--color-campus-b)">FOOTHILL</text>

      {/* valid, same-campus series */}
      <path data-draw d="M212 110 C 290 110, 290 170, 328 170" stroke="var(--color-accent)" strokeWidth="2" fill="none" markerEnd="url(#arr)" />
      <path data-draw d="M212 180 C 290 180, 290 170, 328 170" stroke="var(--color-accent)" strokeWidth="2" fill="none" />
      {/* the split */}
      <path data-draw d="M212 270 C 290 270, 300 190, 328 186" stroke="var(--color-alert)" strokeWidth="2" strokeDasharray="6 6" fill="none" />
      <path data-draw d="M688 250 C 620 250, 600 190, 572 186" stroke="var(--color-alert)" strokeWidth="2" strokeDasharray="6 6" fill="none" />

      {node(130, 110, 'PHYS 4B', 'E&M · 6 units', 'a')}
      {node(130, 180, 'PHYS 4C', 'Waves & thermo · 6 units', 'a')}
      {node(130, 270, 'PHYS 4B', 'taken here', 'a')}
      {node(770, 250, 'PHYS 4C', 'taken here', 'b')}
      {node(450, 170, 'PHYSICS 7B', 'Physics for Scientists & Engineers', 'uc', 236)}

      <g data-zero transform="translate(450 262)">
        <rect x="-92" y="-18" width="184" height="36" rx="18" fill="var(--color-alert-soft)" stroke="var(--color-alert)" />
        <text textAnchor="middle" y="5" fontSize="13" fontWeight="600" fill="var(--color-alert)">Split series · 0 units credited</text>
      </g>
      <g transform="translate(450 84)">
        <rect x="-70" y="-14" width="140" height="28" rx="14" fill="var(--color-accent-soft)" stroke="var(--color-accent)" />
        <text textAnchor="middle" y="4" fontSize="12" fontWeight="600" fill="var(--color-accent)">Same campus · credited</text>
      </g>
    </svg>
  )
}
