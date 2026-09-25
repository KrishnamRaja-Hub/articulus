import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import ErrorBoundary, { FALLBACK_MESSAGE, RETRY_LABEL } from './ErrorBoundary'

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
    const tree = b.render() as { key: string | null }
    expect(tree.key).toBe(String(before + 1))
    expect(renderToStaticMarkup(<>{b.render()}</>)).toContain('Every requirement covered')
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
