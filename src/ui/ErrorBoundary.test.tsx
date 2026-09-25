import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import ErrorBoundary, { ErrorFallback, FALLBACK_MESSAGE, RETRY_LABEL } from './ErrorBoundary'

// The test environment has no DOM, so drive the boundary the way React does after a child throws:
// getDerivedStateFromError, then render with the new state.
function Bomb(): never { throw new Error('agreement has no root') }
function GreenBadge() { return <span className="bg-emerald-500 text-green-700">Every requirement covered</span> }

describe('ErrorBoundary (TESTER2_REPORT M-8)', () => {
  it('renders its children while nothing has failed', () => {
    const html = renderToStaticMarkup(<ErrorBoundary><GreenBadge /></ErrorBoundary>)
    expect(html).toContain('Every requirement covered')
  })

  it('a throwing child really throws during render', () => {
    expect(() => renderToStaticMarkup(<Bomb />)).toThrow('agreement has no root')
  })

  it('after a child crash shows the calm fallback and no green verdict', () => {
    const b = new ErrorBoundary({ children: <><GreenBadge /><Bomb /></> })
    b.state = { ...b.state, ...ErrorBoundary.getDerivedStateFromError() }
    const html = renderToStaticMarkup(<>{b.render()}</>)
    expect(html).toContain(FALLBACK_MESSAGE)
    expect(html).toContain('nothing here is a verdict')
    expect(html).toContain('role="alert"')
    expect(html).not.toContain('Every requirement covered')
    expect(html).not.toMatch(/green|emerald/)
  })

  it('logs the crash', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    new ErrorBoundary({ children: null }).componentDidCatch(new Error('x'), { componentStack: '' })
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('the fallback offers "Try again", says to try again or ask a counselor, and clears the fixed nav (round 7 L-1)', () => {
    const b = new ErrorBoundary({ children: <Bomb /> })
    b.state = { ...b.state, ...ErrorBoundary.getDerivedStateFromError() }
    const html = renderToStaticMarkup(<>{b.render()}</>)
    expect(html).toMatch(/<section role="alert"/)
    expect(html).toContain(`<button type="button"`)
    expect(html).toContain(RETRY_LABEL)
    expect(FALLBACK_MESSAGE).toMatch(/Try again/)
    expect(FALLBACK_MESSAGE).toMatch(/counselor/)
    expect(html).toMatch(/scroll-mt-\d+/)
    expect(html).toMatch(/pt-(2[4-9]|3\d|4\d)\b/)
  })

  it('"Try again" resets the boundary and mounts the children again with fresh state', () => {
    const b = new ErrorBoundary({ children: <GreenBadge /> })
    let next: typeof b.state = { ...b.state, ...ErrorBoundary.getDerivedStateFromError() }
    b.state = next
    b.setState = ((u: (s: typeof next) => typeof next) => { next = { ...next, ...u(next) } }) as typeof b.setState
    const before = b.state.attempt
    b.retry()
    expect(next.failed).toBe(false)
    expect(next.attempt).toBe(before + 1)
    b.state = next
    const tree = b.render() as { props: { children: { key: string | null }[] } }
    expect(tree.props.children[1].key).toBe(String(before + 1))
    expect(renderToStaticMarkup(<>{b.render()}</>)).toContain('Every requirement covered')
  })
})

// No DOM library (jsdom / @testing-library) is installed and the environment is node, so these tests stand in a
// minimal fake document and elements and drive the boundary through the same lifecycle React runs.
interface FakeEl { tabindex: string | null; hasAttribute(n: string): boolean; setAttribute(n: string, v: string): void; focus(): void }
function fakeDom() {
  const doc = { activeElement: null as unknown, body: {} as unknown }
  doc.activeElement = doc.body
  const el = (): FakeEl => {
    const e: FakeEl = {
      tabindex: null,
      hasAttribute: (n) => n === 'tabindex' && e.tabindex !== null,
      setAttribute: (n, v) => { if (n === 'tabindex') e.tabindex = v },
      focus: () => { doc.activeElement = e },
    }
    return e
  }
  vi.stubGlobal('document', doc)
  return { doc, el }
}
/** A boundary whose setState applies synchronously and runs componentDidUpdate, like a React commit. */
function mounted(children: ReactNode, rendered: () => unknown) {
  const b = new ErrorBoundary({ children })
  b.setState = ((u: (s: typeof b.state) => Partial<typeof b.state>) => {
    const prev = b.state
    b.state = { ...prev, ...u(prev) }
    ;(b.anchor as { current: unknown }).current = b.state.attempt > 0 || b.state.failed ? { nextElementSibling: rendered() } : null
    b.componentDidUpdate({}, prev)
  }) as typeof b.setState
  return b
}
function crash(b: ErrorBoundary) {
  const prev = b.state
  b.state = { ...prev, ...ErrorBoundary.getDerivedStateFromError() }
  b.componentDidUpdate({}, prev)
}

describe('ErrorBoundary moves focus after "Try again" (fix 6)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('clicking Try again focuses the recovered section, made focusable with tabindex -1', () => {
    const { doc, el } = fakeDom()
    const section = el()
    const b = mounted(<GreenBadge />, () => section)
    crash(b)
    expect(doc.activeElement).toBe(doc.body) // no fallback rendered yet in this fake: nothing to focus
    // the fallback's button calls exactly this handler
    const fallback = b.render() as { props: { children: ReactElement[] } }
    const button = (fallback.props.children[1] as ReactElement<{ onRetry: () => void }>)
    expect(button.type).toBe(ErrorFallback)
    button.props.onRetry()
    expect(b.state.failed).toBe(false)
    expect(doc.activeElement).toBe(section)
    expect(section.tabindex).toBe('-1')
  })

  it('keeps an existing tabindex on the recovered section', () => {
    const { doc, el } = fakeDom()
    const section = el(); section.tabindex = '0'
    const b = mounted(<GreenBadge />, () => section)
    crash(b); b.retry()
    expect(doc.activeElement).toBe(section)
    expect(section.tabindex).toBe('0')
  })

  it('never moves focus on initial render or on an update that was not a retry', () => {
    const { doc } = fakeDom()
    const b = new ErrorBoundary({ children: <GreenBadge /> })
    expect((b as { componentDidMount?: unknown }).componentDidMount).toBeUndefined()
    expect(renderToStaticMarkup(<>{b.render()}</>)).not.toContain('data-error-anchor')
    b.componentDidUpdate({}, b.state)
    expect(doc.activeElement).toBe(doc.body)
  })

  it('a crash again after a retry hands lost focus to the fallback', () => {
    const { doc, el } = fakeDom()
    const section = el(), fallback = el()
    const b = mounted(<GreenBadge />, () => section)
    crash(b); b.retry()
    expect(doc.activeElement).toBe(section)
    doc.activeElement = doc.body // the section unmounted with focus in it
    ;(b.anchor as { current: unknown }).current = { nextElementSibling: fallback }
    crash(b)
    expect(doc.activeElement).toBe(fallback)
  })

  it('on the FIRST crash, lost focus goes to the fallback without scrolling; focus elsewhere is never stolen', () => {
    const { doc, el } = fakeDom()
    const fallback = el() as FakeEl & { opts?: unknown }
    fallback.focus = (o?: unknown) => { fallback.opts = o; doc.activeElement = fallback }
    const b = new ErrorBoundary({ children: <GreenBadge /> })
    ;(b.anchor as { current: unknown }).current = { nextElementSibling: fallback }
    crash(b) // focus was on <body> (lost with the unmounted section)
    expect(doc.activeElement).toBe(fallback)
    expect(fallback.tabindex).toBe('-1')
    expect(fallback.opts).toEqual({ preventScroll: true })

    const elsewhere = el(), fallback2 = el()
    const b2 = new ErrorBoundary({ children: <GreenBadge /> })
    ;(b2.anchor as { current: unknown }).current = { nextElementSibling: fallback2 }
    doc.activeElement = elsewhere
    crash(b2)
    expect(doc.activeElement).toBe(elsewhere)
  })

  it('renders the marker before the fallback on a first crash, not before the healthy first render', () => {
    const b = new ErrorBoundary({ children: <GreenBadge /> })
    expect(renderToStaticMarkup(<>{b.render()}</>)).not.toContain('data-error-anchor')
    b.state = { failed: true, attempt: 0 }
    expect(renderToStaticMarkup(<>{b.render()}</>)).toMatch(/^<span hidden="" aria-hidden="true" data-error-anchor="true"><\/span><section/)
  })

  it('renders the marker before the section only after a retry, and the fallback is focusable', () => {
    const b = new ErrorBoundary({ children: <GreenBadge /> })
    b.state = { failed: false, attempt: 1 }
    expect(renderToStaticMarkup(<>{b.render()}</>)).toMatch(/^<span hidden="" aria-hidden="true" data-error-anchor="true"><\/span><span/)
    expect(renderToStaticMarkup(<ErrorFallback onRetry={() => {}} />)).toContain('tabindex="-1"')
  })
})

describe('useReveal keeps content focusable (round 7 H-1)', () => {
  const src = readFileSync(new URL('../motion/useReveal.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
  it('animates opacity and transform only, never visibility or display', () => {
    expect(src).not.toMatch(/autoAlpha/)
    expect(src).not.toMatch(/visibility:\s*['"]hidden/)
    expect(src).not.toMatch(/display/)
    expect(src).toMatch(/visibility:\s*'visible'/)
  })
  it('reveals on focus entering a block, and keeps the reduced-motion path', () => {
    expect(src).toMatch(/'focusin'/)
    expect(src).toMatch(/prefers-reduced-motion: reduce/)
  })
})
