import { Component, type ErrorInfo, type ReactNode } from 'react'

export const FALLBACK_MESSAGE =
  'Something went wrong showing this plan — nothing here is a verdict; please reload or confirm with a counselor.'

/** Calm, neutral fallback: no verdict colours, so a crashed section can never leave a green badge behind. */
export function ErrorFallback() {
  return (
    <section role="alert" data-error-fallback className="px-6 py-16">
      <div className="mx-auto max-w-3xl rounded-2xl border border-ink/10 bg-white p-8 text-[16px] text-ink">
        <p>{FALLBACK_MESSAGE}</p>
      </div>
    </section>
  )
}

interface State { failed: boolean }

/**
 * A render crash in one section (a bad agreement, a missing file) replaces only that section with the fallback,
 * instead of blanking the site (TESTER2_REPORT M-8). The whole failed subtree, including any verdict badge, unmounts.
 */
export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false }
  static getDerivedStateFromError(): State { return { failed: true } }
  componentDidCatch(error: unknown, info: ErrorInfo) { console.error('Section failed to render', error, info.componentStack) }
  render() { return this.state.failed ? <ErrorFallback /> : this.props.children }
}
