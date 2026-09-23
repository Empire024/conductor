import { join } from 'node:path'
import { LOCAL_SETTLED, CLAUDE_SETTLED, waitSettled } from './agent-wait.mjs'
import { scopeOf } from './control-client.mjs'
import { evaluateRun, findValidatedArtifact, projectItems, answerOf, resolveArtifactOutputs, runOracle } from './evaluate.mjs'
import { fetchAllHistory, writeEvidence } from './evidence.mjs'
import { prepareProjectFolder } from './goal.mjs'
import { writeJsonAtomic } from './util.mjs'

/**
 * One test pass of one goal in one app: prepare the folder, open it, open a worker tab, submit
 * the prompt, wait, collect history, evaluate, write evidence. Never throws for a worker failure;
 * an app/control error is returned as a failed result with `error` set.
 */
export async function runGoalOnce({ client, goal, iteration, target, projectsRoot, runDir, checkout, env, log = () => {}, pollMs = 5000, closeTab = target === 'dev', sleep, now }) {
  const evidenceDir = join(runDir, `iteration-${iteration}`, goal.id)
  const result = { goalId: goal.id, pass: false, failures: [], agentSessionId: null, tabId: null, evidenceDir, evidenceFiles: {}, status: null, evaluation: null }
  try {
    const folder = await prepareProjectFolder(goal, { target, projectsRoot })
    const project = await client.call('projects.open', { path: folder, name: goal.project.name }, null)
    const scope = scopeOf(project)
    const call = (method, args) => client.call(method, args, scope)
    const tab = await call('tabs.open', { provider: goal.worker.provider, model: goal.worker.model, title: `Overseer: ${goal.id} #${iteration}`, focus: false, projectId: scope.projectId, workspaceId: scope.workspaceId, ...(goal.worker.permission ? { permission: goal.worker.permission } : {}) })
    result.tabId = tab.id
    result.agentSessionId = tab.resourceId
    const before = await call('agents.status', { agentSessionId: tab.resourceId })
    await call('agents.submit', { agentSessionId: tab.resourceId, prompt: goal.prompt })
    log(`${goal.id} #${iteration}: submitted to ${goal.worker.model} in ${folder}`)
    let lastPhase = null
    const { status, timedOut } = await waitSettled({
      call, agentSessionId: tab.resourceId, settled: goal.worker.provider === 'local' ? LOCAL_SETTLED : CLAUDE_SETTLED,
      baselineSequence: before?.sequence ?? 0, pollMs, timeoutMs: goal.timeoutMinutes * 60_000, sleep, now,
      onPoll: value => { if (value?.phase !== lastPhase) { lastPhase = value?.phase; log(`${goal.id} #${iteration}: ${lastPhase}${value?.lastTool ? ` (last tool ${value.lastTool.name} ${value.lastTool.status})` : ''}`) } }
    })
    let finalStatus = status
    if (timedOut) {
      log(`${goal.id} #${iteration}: timed out after ${goal.timeoutMinutes} min, interrupting`)
      try { await call('agents.interrupt', { agentSessionId: tab.resourceId }) } catch (error) { log(`interrupt failed: ${error.message}`) }
      try { finalStatus = await call('agents.status', { agentSessionId: tab.resourceId }) } catch { /* keep last */ }
    }
    const events = await fetchAllHistory(call, tab.resourceId)
    const items = await resolveArtifactOutputs(projectItems(events), call, tab.resourceId)
    const artifact = findValidatedArtifact(items)
    const answer = answerOf(items, finalStatus)
    const oracle = await runOracle(goal, { projectPath: folder, answer, status: finalStatus, events, artifact: artifact?.result ?? null }, { checkout })
    const evaluation = evaluateRun({ goal, status: finalStatus, events, oracle, items })
    if (timedOut) evaluation.failures.unshift(`worker did not settle within ${goal.timeoutMinutes} minutes (interrupted)`), evaluation.pass = false
    result.status = finalStatus
    result.evaluation = evaluation
    result.pass = evaluation.pass
    result.failures = evaluation.failures
    result.evidenceFiles = await writeEvidence(evidenceDir, { status: finalStatus, events, answer, evaluation, modelId: goal.worker.model, env, checkout })
    if (closeTab) { try { await client.call('tabs.close', { tabId: tab.id }, scope) } catch (error) { log(`${goal.id}: could not close worker tab: ${error.message}`) } }
  } catch (error) {
    result.error = error?.message ?? String(error)
    result.failures = [...result.failures, `overseer could not run the goal: ${result.error}`]
    result.pass = false
    try { await writeJsonAtomic(join(evidenceDir, 'evaluation.json'), { pass: false, failures: result.failures, error: result.error }); result.evidenceFiles.evaluation = join(evidenceDir, 'evaluation.json') } catch { /* best effort */ }
  }
  return result
}

/** The compact form stored in run.json. */
export const summarizeResult = result => ({ pass: result.pass, failures: result.failures, agentSessionId: result.agentSessionId, tabId: result.tabId, evidenceDir: result.evidenceDir, counts: result.evaluation?.counts ?? null, phase: result.status?.phase ?? null, stop: result.status?.stop ? { reason: result.status.stop.reason, detail: result.status.stop.detail, rounds: result.status.stop.rounds, loopWarnings: result.status.stop.loopWarnings } : null, ...(result.error ? { error: result.error } : {}) })
