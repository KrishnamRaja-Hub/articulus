import { useTrust } from '../data'
import { trustBanner, trustChip } from '../data-trust'

/** Full data-status banner, at the top of the planner. */
export function DataBanner({ className = '' }: { className?: string }) {
  const trust = useTrust()
  const b = trustBanner(trust)
  if (b.tone === 'quiet') return (
    <p id="data-status" role="status" data-trust={trust.level} className={`flex items-center gap-2 text-[13.5px] text-ink-3 ${className}`}>
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />{b.headline}
    </p>
  )
  const alert = b.tone === 'alert'
  return (
    <div id="data-status" role={alert ? 'alert' : 'status'} data-trust={trust.level}
      className={`flex gap-3 rounded-2xl border px-5 py-4 ${alert ? 'border-alert/30 bg-alert-soft text-alert' : 'border-warn/30 bg-warn-soft text-warn'} ${className}`}>
      <Exclaim className="mt-1 h-4 w-4 shrink-0" />
      <div className="min-w-0">
        <p className="text-[15px] font-medium [overflow-wrap:anywhere]">{b.headline}</p>
        <p className="mt-1 text-[14px] text-ink-2">{b.detail}</p>
      </div>
    </div>
  )
}

/** Compact line under the nav, so the data state is visible from every part of the page. Hidden when trusted. */
export function DataChip() {
  const trust = useTrust()
  const text = trustChip(trust)
  if (!text) return null
  const alert = trust.level === 'untrusted'
  return (
    <a href="#data-status" data-trust-chip={trust.level}
      className={`mx-auto mt-2 flex w-fit max-w-[calc(100vw-2rem)] items-center gap-1.5 rounded-full border px-3 py-1 text-[12.5px] font-medium shadow-[0_8px_30px_-12px_rgba(17,17,16,.25)] ${alert ? 'border-alert/40 bg-alert text-white' : 'border-warn/30 bg-warn-soft text-warn'}`}>
      <Exclaim className="h-3 w-3 shrink-0" /><span className="truncate">{text}</span>
    </a>
  )
}

export const Exclaim = ({ className = 'h-3.5 w-3.5' }: { className?: string }) => (
  <svg viewBox="0 0 16 16" className={className} fill="none" aria-hidden>
    <path d="M8 3.5v5.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /><circle cx="8" cy="12.25" r="1.15" fill="currentColor" />
  </svg>
)
