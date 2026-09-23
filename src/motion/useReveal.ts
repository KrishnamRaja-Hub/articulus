import { useRef, type RefObject } from 'react'
import { gsap } from 'gsap'
import { useGSAP } from '@gsap/react'

/**
 * Reveal every `[data-reveal]` descendant once as it scrolls into view.
 * Respects prefers-reduced-motion (elements simply show).
 */
export function useReveal<T extends HTMLElement>(deps: unknown[] = []): RefObject<T | null> {
  const ref = useRef<T>(null)
  useGSAP(
    () => {
      const mm = gsap.matchMedia()
      mm.add({ reduce: '(prefers-reduced-motion: reduce)', ok: '(prefers-reduced-motion: no-preference)' }, (ctx) => {
        const items = gsap.utils.toArray<HTMLElement>('[data-reveal]', ref.current)
        if (!items.length) return
        if (ctx.conditions?.reduce) { gsap.set(items, { autoAlpha: 1 }); return }
        items.forEach((el) => {
          gsap.fromTo(el, { autoAlpha: 0, y: 28 }, {
            autoAlpha: 1, y: 0, duration: 1,
            delay: Number(el.dataset.reveal || 0),
            scrollTrigger: { trigger: el, start: 'top 85%', once: true },
          })
        })
      })
    },
    { scope: ref, dependencies: deps, revertOnUpdate: true },
  )
  return ref
}
