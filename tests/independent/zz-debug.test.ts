import { writeFileSync } from 'node:fs'
import { it } from 'vitest'
import type { Agreement, ReqNode, Requirement } from '../../src/engine/types'
import { verifySchedule } from '../../src/engine/verify.ts'
import { oracle } from './oracle.ts'
import { randomAgreement, rng } from './synth.ts'

/** Smallest subtree whose deferred list disagrees. */
it('dbg', () => {
  const out: string[] = []
  const r = rng(12345 + 2)
  let found = 0
  for (let i = 0; i < 2500 && found < 3; i++) {
    const a = randomAgreement(r, { inherit: false })
    const pool = Object.keys(a.catalog)
    for (const p of [0.15, 0.4, 0.7, 0.9]) {
      const taken = new Set(pool.filter(() => r.next() < p))
      const o = oracle(a, taken), v = verifySchedule(new Set(taken), a)
      const same = (x: string[], y: string[]) => x.length === y.length && x.every((z) => y.includes(z))
      if (same(v.deferred, [...o.deferred]) || same(v.deferred, [...oracle(a, taken, { defer: 'app-low3' }).deferred])) continue
      // shrink: try each subtree as the root
      let best: ReqNode = a.root
      const sub = (n: ReqNode | Requirement): void => {
        if (n.kind === 'req') return
        const b: Agreement = { ...a, root: { ...n, required: true } }
        const o2 = oracle(b, taken), v2 = verifySchedule(new Set(taken), b)
        if (!same(v2.deferred, [...o2.deferred]) && !same(v2.deferred, [...oracle(b, taken, { defer: 'app-low3' }).deferred]) && JSON.stringify(n).length < JSON.stringify(best).length) best = { ...n, required: true }
        n.children.forEach(sub)
      }
      a.root.children.forEach(sub)
      const b: Agreement = { ...a, root: best }
      out.push(JSON.stringify(best), JSON.stringify([...taken]), JSON.stringify({ app: verifySchedule(new Set(taken), b).deferred, oracle: [...oracle(b, taken).deferred], low3: [...oracle(b, taken, { defer: 'app-low3' }).deferred], appValid: verifySchedule(new Set(taken), b).isValid, oValid: oracle(b, taken).isValid, appMiss: verifySchedule(new Set(taken), b).missing, oMiss: [...oracle(b, taken).missing] }), '')
      found++
      break
    }
  }
  writeFileSync('/tmp/claude-0/-home-user-articulus/7831a9bf-5b6f-5531-9068-823767bea7ba/scratchpad/dbg.txt', out.join('\n'))
}, 600_000)
