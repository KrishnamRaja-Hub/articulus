import { useReveal } from '../motion/useReveal'
import Button from '../ui/Button'
import { Mark } from './Nav'

export default function Footer() {
  const ref = useReveal<HTMLElement>()
  return (
    <footer ref={ref} className="px-6 pt-32 pb-12 md:pt-48">
      <div className="mx-auto max-w-6xl">
        <div data-reveal className="card relative overflow-hidden bg-ink p-10 text-white md:p-20">
          <div aria-hidden className="pointer-events-none absolute -top-40 -right-40 h-[520px] w-[520px] rounded-full bg-[radial-gradient(closest-side,rgba(255,214,170,.22),transparent)]" />
          <h2 className="h2 max-w-3xl text-white">Check your plan before July does.</h2>
          <p className="mt-6 max-w-xl text-[17px] text-white/70">
            Free, deterministic, built on the same public ASSIST data your university will audit against.
          </p>
          <div className="mt-10 flex flex-wrap gap-3">
            <Button href="#plan" size="lg" className="bg-white text-ink hover:bg-white/90 hover:text-ink">Open the planner</Button>
            <Button href="https://assist.org" target="_blank" rel="noreferrer" size="lg" variant="ghost" className="border-white/25 text-white hover:border-white/60 hover:bg-white/5">Browse ASSIST.org</Button>
          </div>
        </div>

        <div className="mt-12 flex flex-col items-start justify-between gap-6 text-[14px] text-ink-3 md:flex-row md:items-center">
          <div className="flex items-center gap-2 text-ink"><Mark /> <span className="font-semibold">Articulus</span></div>
          <p className="max-w-xl">
            Articulation data is fetched from public ASSIST.org endpoints for 2025-26 and cached locally. Articulus is a planning aid.
            Confirm any schedule with the receiving university before enrolling.
          </p>
        </div>
      </div>
    </footer>
  )
}
