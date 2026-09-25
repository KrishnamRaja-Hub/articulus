import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import Select from './Select'

describe('Select (TESTER r7 H-2)', () => {
  it('gives the native select its label as accessible name', () => {
    const html = renderToStaticMarkup(<Select value="a" label="Target university" onChange={() => {}}><option value="a">A</option></Select>)
    expect(html).toMatch(/<select[^>]*aria-label="Target university"/)
  })
})
