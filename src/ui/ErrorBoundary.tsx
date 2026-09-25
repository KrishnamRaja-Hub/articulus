import { Component, Fragment, createRef, type ErrorInfo, type ReactNode } from 'react'

export const FALLBACK_MESSAGE =
  'Something went wrong showing this plan — nothing here is a verdict. Try again, or confirm your plan with a counselor.'
export const RETRY_LABEL = 'Try again'

/**
 * Calm, neutral fallback: no verdict colours, so a crashed section can never leave a green badge behind.
 * Top padding and scroll margin keep it clear of the fixed nav and data chip (round 7 L-1).
 */
export function ErrorFallback({ onRetry }: { onRetry?: () => void }) {
  return (
    <section role="alert" data-error-fallback tabIndex={-1} className="scroll-mt-32 px-6 pt-32 pb-16 outline-none">
      <div className="mx-auto max-w-3xl rounded-2xl border border-ink/10 bg-white p-8 text-[16px] text-ink">
        <p>{FALLBACK_MESSAGE}</p>
        {onRetry && (
          <button type="button" onClick={onRetry} data-error-retry
            className="mt-6 inline-flex h-11 items-center justify-center rounded-full border border-ink/20 px-5 text-[15px] font-medium text-ink hover:border-ink/40">
            {RETRY_LABEL}
          </button>
        )}
      </div>
    </section>
  )
}

interface State { failed: boolean; attempt: number }

/**
 * A render crash in one section (a bad agreement, a missing file) replaces only that section with the fallback,
 * instead of blanking the site (TESTER2_REPORT M-8). The whole failed subtree, including any verdict badge, unmounts.
 * "Try again" remounts the children with fresh state (round 7 L-1): around the Planner, it starts over from its
 * default major, so the student can pick another one without reloading the page.
 */
/** Moves focus to `el` (made programmatically focusable with tabindex="-1" when it is not focusable already). */
export function focusSection(el: Element | null | undefined, options?: FocusOptions): boolean {
  if (!el || !(el as HTMLElement).focus) return false
  const h = el as HTMLElement
  if (!h.hasAttribute('tabindex')) h.setAttribute('tabindex', '-1')
  h.focus(options)
  return true
}

export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false, attempt: 0 }
  /** Set only by the "Try again" button: the next commit moves focus to what replaced the fallback (never on first render). */
  private focusAfterRetry = false
  /** A hidden marker rendered just before the children once a crash or retry has happened; its next sibling is the
   *  section (or the fallback). */
  anchor = createRef<HTMLSpanElement>()
  static getDerivedStateFromError(): Partial<State> { return { failed: true } }
  componentDidCatch(error: unknown, info: ErrorInfo) { console.error('Section failed to render', error, info.componentStack) }
  retry = () => {
    this.focusAfterRetry = true
    this.setState((s) => ({ failed: false, attempt: s.attempt + 1 }))
  }
  componentDidUpdate(_: unknown, prev: State) {
    const section = () => this.anchor.current?.nextElementSibling
    if (this.focusAfterRetry) {
      this.focusAfterRetry = false
      // the button that had focus just unmounted: keyboard and screen-reader users land on the recovered section
      // (or on the fallback again, if it crashed straight away), not on <body>
      focusSection(section())
      return
    }
    // a section that crashes (first time, or again after a retry, e.g. its agreement fails to load) hands focus to
    // the fallback, but only if focus was lost with the unmounted section: focus elsewhere is never stolen. The first
    // crash does not scroll (it may happen during page load, before the student has reached the section).
    if (this.state.failed && !prev.failed && typeof document !== 'undefined') {
      const active = document.activeElement
      if (!active || active === document.body) focusSection(section(), this.state.attempt > 0 ? undefined : { preventScroll: true })
    }
  }
  render() {
    const marker = this.state.attempt > 0 || this.state.failed ? <span hidden aria-hidden="true" ref={this.anchor} data-error-anchor /> : null
    if (this.state.failed) return <>{marker}<ErrorFallback onRetry={this.retry} /></>
    // a new key on every retry: the children mount again from scratch, never with the state that crashed
    return <>{marker}<Fragment key={this.state.attempt}>{this.props.children}</Fragment></>
  }
}
