/* Web Worker: runs `solve` off the UI thread (TESTER2_REPORT M-4). Driven by SolveClient (solveClient.ts). */
import { solve } from './solve'
import type { SolveMessage } from './solveClient'

self.onmessage = (e: MessageEvent<SolveMessage>) => {
  const { id, taken, agreement, opts } = e.data
  self.postMessage({ id, plan: solve(taken, agreement, opts) })
}
