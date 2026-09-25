/** A styled native <select>. `label` is required: it is the control's accessible name (TESTER r7 H-2), since the
 *  visible field headings above these selects are not <label>s. */
export default function Select<T extends string | number>({ value, onChange, children, label }:
  { value: T; onChange: (v: string) => void; children: React.ReactNode; label: string }) {
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
