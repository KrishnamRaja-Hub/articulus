import { useRef, type RefObject } from 'react'
import { gsap } from 'gsap'
import { useGSAP } from '@gsap/react'

/**
 * Reveal every `[data-reveal]` descendant once as it scrolls into view.
 * Only opacity and transform are animated, never visibility or display: a not-yet-revealed block stays focusable and
 * in the accessibility tree, so Tab from the top of the page reaches the Planner (round 7 H-1). index.css hides
 * `[data-reveal]` until this hook runs, so it sets `visibility: visible` inline first. When focus enters a block
 * that has not been revealed yet, it is revealed at once. Respects prefers-reduced-motion (elements simply show).
 */
export function useReveal<T extends HTMLElement>(deps: unknown[] = []): RefObject<T | null> {
  const ref = useRef<T>(null)
  useGSAP(
    () => {
      const mm = gsap.matchMedia()
      mm.add({ reduce: '(prefers-reduced-motion: reduce)', ok: '(prefers-reduced-motion: no-preference)' }, (ctx) => {
        const root = ref.current
        const items = gsap.utils.toArray<HTMLElement>('[data-reveal]', root)
        if (!root || !items.length) return
        // always visible to focus and assistive tech; only the look is animated
        gsap.set(items, { visibility: 'visible' })
        if (ctx.conditions?.reduce) { gsap.set(items, { opacity: 1, y: 0 }); return }
        const tweens = new Map(items.map((el) => [el, gsap.fromTo(el, { opacity: 0, y: 28 }, {
          opacity: 1, y: 0, duration: 1,
          delay: Number(el.dataset.reveal || 0),
          scrollTrigger: { trigger: el, start: 'top 85%', once: true },
        })]))
        // keyboard focus inside a block that has not scrolled into view yet: show it now, never a focused invisible control
        const onFocusIn = (e: FocusEvent) => {
          const target = e.target instanceof Element ? e.target : null
          for (const [el, tween] of tweens) {
            if (!target || !el.contains(target) || tween.progress() === 1) continue
            tween.scrollTrigger?.kill()
            tween.progress(1)
          }
        }
        root.addEventListener('focusin', onFocusIn)
        return () => root.removeEventListener('focusin', onFocusIn)
      })
    },
    { scope: ref, dependencies: deps, revertOnUpdate: true },
  )
  return ref
}
