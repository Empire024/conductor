import { sleep as realSleep } from './util.mjs'

/** Phases in which a conversation is still working (or waiting on something that will resolve). */
export const WORKING_PHASES = new Set(['running', 'queued', 'starting', 'interrupting', 'waiting_approval', 'waiting_input'])
export const LOCAL_SETTLED = new Set(['completed', 'failed', 'interrupted'])
export const CLAUDE_SETTLED = new Set(['completed', 'idle', 'disconnected', 'failed', 'interrupted'])

/**
 * Poll agents.status until the conversation settles after a submit. `idle` right after submit is
 * the pre-submit state, so it only counts once the turn was seen working, or after `graceMs`.
 * A terminal phase with a sequence past `baselineSequence` counts even if the whole turn fit
 * between two polls.
 */
export async function waitSettled({ call, agentSessionId, settled, baselineSequence = 0, pollMs = 5000, timeoutMs, graceMs = 90_000, now = Date.now, sleep = realSleep, onPoll }) {
  const start = now()
  let sawWorking = false
  let status = null
  for (;;) {
    status = await call('agents.status', { agentSessionId })
    onPoll?.(status)
    const phase = status?.phase
    if (WORKING_PHASES.has(phase)) sawWorking = true
    else if (settled.has(phase)) {
      const advanced = (status?.sequence ?? 0) > baselineSequence && phase !== 'idle'
      if (sawWorking || advanced || now() - start >= graceMs) return { status, timedOut: false }
    }
    if (now() - start >= timeoutMs) return { status, timedOut: true }
    await sleep(pollMs)
  }
}
