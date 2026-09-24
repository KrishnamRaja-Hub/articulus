import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import ErrorBoundary, { FALLBACK_MESSAGE } from './ErrorBoundary'

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
})
