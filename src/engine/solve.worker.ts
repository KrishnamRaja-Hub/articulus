/* Web Worker: runs `solve` off the UI thread (TESTER2_REPORT M-4). Driven by SolveClient (solveClient.ts). */
import { solve } from './solve'
import type { SolveMessage, SolveReply } from './solveClient'

self.onmessage = (e: MessageEvent<SolveMessage>) => {
  const { id, taken, agreement, opts } = e.data
  let reply: SolveReply
  // N-2: a throwing solve answers with its message; the worker stays alive for the next request
  try { reply = { id, plan: solve(taken, agreement, opts) } } catch (err) {
    reply = { id, error: (err instanceof Error ? err.message : String(err)) || 'unknown error' }
  }
  self.postMessage(reply)
}
