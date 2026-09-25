import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react'

export const FALLBACK_MESSAGE =
  'Something went wrong showing this plan — nothing here is a verdict. Try again, or confirm your plan with a counselor.'
export const RETRY_LABEL = 'Try again'

/**
 * Calm, neutral fallback: no verdict colours, so a crashed section can never leave a green badge behind.
 * Top padding and scroll margin keep it clear of the fixed nav and data chip (round 7 L-1).
 */
export function ErrorFallback({ onRetry }: { onRetry?: () => void }) {
  return (
    <section role="alert" data-error-fallback className="scroll-mt-32 px-6 pt-32 pb-16">
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
export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false, attempt: 0 }
  static getDerivedStateFromError(): Partial<State> { return { failed: true } }
  componentDidCatch(error: unknown, info: ErrorInfo) { console.error('Section failed to render', error, info.componentStack) }
  retry = () => this.setState((s) => ({ failed: false, attempt: s.attempt + 1 }))
  render() {
    if (this.state.failed) return <ErrorFallback onRetry={this.retry} />
    // a new key on every retry: the children mount again from scratch, never with the state that crashed
    return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>
  }
}
