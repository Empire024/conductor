import { summarizeResult } from './runner.mjs'

export const EXIT = { pass: 0, fail: 1, blocked: 2 }

/**
 * The overseer loop, with every effect behind `deps` so it runs against fakes in tests:
 *   ensureTarget()                 -> ready the app the goals run in (throws if unreachable)
 *   runGoal(goal, n)               -> full result (see runner.mjs)
 *   dispatchFixer(goal, n, result) -> {result:'fixed'|'blocked'|'no-change', summary, ...}
 *   build(n)                       -> {ok, exitCode, tail, logPath}
 *   reloadTarget(n)                -> {ok, reason?}: make the target run the rebuilt checkout
 *   deliver()                      -> {ok, reason?, ...}  (only with options.deliver)
 *   writeRun(state), log(message)
 * Goals run one at a time (one local model at a time); fixers run in parallel up to options.fixers.
 */
export async function runLoop({ goals, options, deps }) {
  const { iterations = 5, fixers = 4, noFix = false, deliver = false, target = 'dev', fixerTarget = 'auto' } = options
  const log = deps.log ?? (() => {})
  const state = { goals: goals.map(goal => goal.id), target, fixerTarget, startedAt: new Date().toISOString(), options: { iterations, fixers, noFix, deliver }, iterations: [], outcome: null, exitCode: null, summary: null }
  const save = async () => { try { await deps.writeRun(state) } catch (error) { log(`could not write run.json: ${error.message}`) } }
  const finish = async (outcome, exitCode, summary) => {
    state.outcome = outcome
    state.exitCode = exitCode
    state.summary = summary
    state.finishedAt = new Date().toISOString()
    await save()
    return { outcome, exitCode, summary, state }
  }

  try {
    await save()
    try { await deps.ensureTarget() } catch (error) { return await finish('unreachable', EXIT.blocked, `target app unreachable: ${error.message}`) }

    let pending = goals
    let carried = null // a build/reload failure that stands in for the next test pass
    for (let n = 1; n <= iterations; n++) {
      const iteration = { n, startedAt: new Date().toISOString(), results: {}, fixers: [], build: null, reload: null }
      state.iterations.push(iteration)
      const full = {}
      for (const goal of pending) {
        if (carried) full[goal.id] = { goalId: goal.id, pass: false, failures: [carried.reason], error: carried.reason, evidenceDir: carried.evidenceDir ?? null, evidenceFiles: carried.logPath ? { buildLog: carried.logPath } : {}, status: null, evaluation: null }
        else {
          log(`iteration ${n}: testing ${goal.id}`)
          full[goal.id] = await deps.runGoal(goal, n)
        }
        iteration.results[goal.id] = summarizeResult(full[goal.id])
        log(`iteration ${n}: ${goal.id} ${full[goal.id].pass ? 'PASS' : `FAIL (${full[goal.id].failures.slice(0, 3).join('; ')})`}`)
        await save()
      }
      carried = null
      const failed = pending.filter(goal => !full[goal.id].pass)
      if (!failed.length) {
        if (deliver) {
          log('all goals pass; delivering to the installed app')
          let delivery
          try { delivery = await deps.deliver() } catch (error) { delivery = { ok: false, reason: error.message } }
          const { client, ...recorded } = delivery ?? {}
          state.delivery = recorded
          if (!delivery?.ok) return await finish('delivery-failed', EXIT.blocked, `goals pass, but delivery failed: ${delivery?.reason ?? 'unknown'}`)
        }
        return await finish('pass', EXIT.pass, `${goals.length} goal(s) pass after ${n} iteration(s)`)
      }
      if (noFix) return await finish('fail', EXIT.fail, `${failed.length} goal(s) fail: ${failed.map(goal => goal.id).join(', ')} (--no-fix)`)
      if (n === iterations) return await finish('exhausted', EXIT.blocked, `iteration budget (${iterations}) exhausted; still failing: ${failed.map(goal => goal.id).join(', ')}`)

      for (let start = 0; start < failed.length; start += Math.max(1, fixers)) {
        const batch = failed.slice(start, start + Math.max(1, fixers))
        const verdicts = await Promise.all(batch.map(async goal => {
          try { return await deps.dispatchFixer(goal, n, full[goal.id]) } catch (error) { return { goalId: goal.id, result: 'blocked', summary: `fixer dispatch failed: ${error.message}` } }
        }))
        for (const verdict of verdicts) {
          iteration.fixers.push(verdict)
          log(`fixer ${verdict.goalId}: ${verdict.result} ${verdict.summary ?? ''}`)
        }
        await save()
      }
      const blocked = iteration.fixers.filter(verdict => verdict.result === 'blocked')
      if (blocked.length) return await finish('blocked', EXIT.blocked, `fixer blocked: ${blocked.map(verdict => `${verdict.goalId}: ${verdict.summary}`).join(' | ')}`)

      if (iteration.fixers.some(verdict => verdict.result === 'fixed')) {
        log(`iteration ${n}: building the checkout`)
        iteration.build = await deps.build(n)
        await save()
        if (!iteration.build.ok) carried = { reason: `build failed (exit ${iteration.build.exitCode}): ${iteration.build.tail ?? ''}`.slice(0, 4000), logPath: iteration.build.logPath }
        else {
          iteration.reload = await deps.reloadTarget(n)
          await save()
          if (!iteration.reload.ok) {
            if (iteration.reload.fatal) return await finish('blocked', EXIT.blocked, iteration.reload.reason)
            carried = { reason: `app did not come back after the rebuild: ${iteration.reload.reason}` }
          }
        }
      } else log(`iteration ${n}: no fixer changed the checkout; retesting unchanged code`)
      pending = failed
    }
    return await finish('exhausted', EXIT.blocked, 'iteration budget exhausted')
  } catch (error) {
    state.error = error?.stack ?? String(error)
    return await finish('error', EXIT.blocked, `overseer crashed: ${error?.message ?? error}`)
  }
}
