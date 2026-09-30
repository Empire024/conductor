// The meta-wizard's judgement (docs/meta-wizard.md), pure: an overview from supervisor.overview, the
// remembered state and the time in; findings, steers and owner alerts out. No effect happens here.

export const TIMINGS = {
  tickMs: 120_000,
  probeTimeoutMs: 10_000,
  recheckMs: 20_000,
  hungStrikes: 3,
  crashGraceMs: 60_000,
  restartGraceMs: 180_000,
  updateGraceMs: 600_000,
  startingGraceMs: 180_000,
  startWaitMs: 120_000,
  resumeDelayMs: 90_000,
  awaitDeadlineGraceMs: 180_000,
  awaitQuietMs: 240_000,
  awaitOverdueMs: 90 * 60_000,
  coworkerIdleMs: 600_000,
  updateHeldMs: 20 * 60_000,
  limitGraceMs: 300_000,
  steerCooldownMs: 600_000,
  steerRepeatMs: 900_000,
  maxSteersPerHour: 20,
  alertDedupMs: 3_600_000,
  restartWindowMs: 1_800_000,
  maxRestarts: 3,
  standDownMs: 1_800_000
}

/** A conversation that is not in a turn and runs nothing in the background. */
export const SETTLED = new Set(['idle', 'completed', 'failed', 'interrupted', 'disconnected'])
/** A conversation at work: a restart cuts it. */
export const BUSY = new Set(['starting', 'running', 'waiting_approval', 'waiting_input', 'interrupting', 'viewing'])
const MESSAGE_TOOL = /^(?:mcp__conductor__|conductor[./:])?(?:send_message|report)$/
const DENIAL_FENCE = /durable approval denial/i

export const HEADER = '[Meta-wizard]'
const FOOTER = 'This comes from the meta-wizard, the owner\'s supervisor outside Conductor (docs/meta-wizard.md). Act on it now: message them again, take the work over, or finish; do not wait silently. If nothing is left to do, say so in one line.'

const ms = iso => { const value = Date.parse(iso ?? ''); return Number.isFinite(value) ? value : null }
const clip = (text, limit) => { const line = String(text ?? '').replace(/\s+/g, ' ').trim(); return line.length > limit ? line.slice(0, limit) + '…' : line }
const name = tab => `"${tab.title || 'a conversation'}" (${tab.agentSessionId})`

/** One line about a conversation someone waits on: its phase, refusal and last answer. */
export function describe(tab, id) {
  if (!tab) return `- ${id}: tab closed`
  const refused = tab.lastTool?.status === 'rejected' ? `; its last tool ${tab.lastTool.name} was REFUSED${tab.lastTool.output ? `: "${clip(tab.lastTool.output, 300)}"` : ''}` : ''
  const limit = tab.limitResumeAt ? `, usage limit until ${tab.limitResumeAt}` : ''
  const answer = tab.lastAnswer ? `; last answer: "${clip(tab.lastAnswer, 300)}"` : ''
  return `- ${name(tab)}${tab.project ? ` in ${tab.project}` : ''}: ${tab.phase ?? 'unknown'}${limit}${refused}${answer}`
}

const quiet = tab => !tab || (SETTLED.has(tab.phase) && !tab.backgroundTasks && !tab.awaiting)

/**
 * Findings for one overview. Each finding: {kind, fingerprint, target (the tab to steer, or null),
 * facts (the message body), alert? ({title, body}) for what only the owner can fix}.
 * `memory` carries first-seen times between ticks and is returned updated.
 */
export function detect(overview, memory = {}, now = Date.now(), timings = TIMINGS) {
  const tabs = overview?.tabs ?? []
  const byId = new Map(tabs.map(tab => [tab.agentSessionId, tab]))
  const findings = []
  const next = { quietSince: {}, updateSeen: memory.updateSeen ?? null }

  // 1. Waits: a passed deadline the app did not act on, an overdue wait with no deadline, or
  //    everyone awaited gone quiet without messaging.
  for (const waiter of tabs) {
    const wait = waiter.awaiting
    if (!wait || !SETTLED.has(waiter.phase)) continue
    const awaited = wait.agents.map(id => ({ id, tab: byId.get(id) }))
    const lines = awaited.map(({ id, tab }) => describe(tab, id)).join('\n')
    const why = wait.reason ? ` (${clip(wait.reason, 200)})` : ''
    const deadline = ms(wait.deadline)
    if (deadline !== null && now > deadline + timings.awaitDeadlineGraceMs) {
      findings.push({ kind: 'await-deadline', fingerprint: `await-deadline:${waiter.agentSessionId}:${wait.since}`, target: waiter,
        facts: `The wait you declared at ${wait.since}${why} passed its deadline ${wait.deadline} and nobody woke you. Here is where they stand:\n${lines}` })
      continue
    }
    if (deadline === null && now - (ms(wait.since) ?? now) > timings.awaitOverdueMs) {
      findings.push({ kind: 'await-overdue', fingerprint: `await-overdue:${waiter.agentSessionId}:${wait.since}`, target: waiter,
        facts: `You have been waiting since ${wait.since}${why} with no deadline. Here is where they stand:\n${lines}` })
      continue
    }
    if (awaited.length && awaited.every(({ tab }) => quiet(tab))) {
      const key = `${wait.since}|${awaited.map(({ id, tab }) => `${id}:${tab?.phase ?? 'closed'}:${tab?.lastActivityAt ?? ''}`).join(',')}`
      const since = memory.quietSince?.[waiter.agentSessionId]?.key === key ? memory.quietSince[waiter.agentSessionId].since : now
      next.quietSince[waiter.agentSessionId] = { key, since }
      if (now - since >= timings.awaitQuietMs) {
        findings.push({ kind: 'await-quiet', fingerprint: `await-quiet:${waiter.agentSessionId}:${key}`, target: waiter,
          facts: `You are waiting${why} since ${wait.since}, but everyone you wait for has gone quiet without messaging you, so no message will wake you:\n${lines}` })
      }
    }
  }

  // 2. A refused send_message/report: whoever waits on the sender never hears it.
  const fenced = new Map()
  for (const sender of tabs) {
    const tool = sender.lastTool
    if (!tool || tool.status !== 'rejected') continue
    if (DENIAL_FENCE.test(tool.output ?? '')) fenced.set(sender.projectId, [...(fenced.get(sender.projectId) ?? []), sender])
    if (!MESSAGE_TOOL.test(tool.name)) continue
    const recipients = new Set()
    if (/report$/.test(tool.name) && sender.controller) recipients.add(sender.controller)
    if (tool.target) recipients.add(tool.target)
    for (const tab of tabs) if (tab.awaiting?.agents.includes(sender.agentSessionId)) recipients.add(tab.agentSessionId)
    recipients.delete(sender.agentSessionId)
    for (const id of recipients) {
      const target = byId.get(id)
      if (!target) continue
      findings.push({ kind: 'message-refused', fingerprint: `message-refused:${sender.agentSessionId}:${tool.at}:${id}`, target,
        facts: `${name(sender)}${sender.project ? ` in ${sender.project}` : ''} tried to ${/report$/.test(tool.name) ? 'report' : 'send a message'} to you at ${tool.at} and the call was REFUSED, so it never arrived: "${clip(tool.output || 'refused by its runtime', 400)}".\n${describe(sender, sender.agentSessionId)}` })
    }
  }

  // 3. A durable denial fencing a project: only the owner lifts it.
  for (const [projectId, senders] of fenced) {
    const project = senders[0].project || projectId
    findings.push({ kind: 'denial-fence', fingerprint: `denial-fence:${projectId}:${senders.map(tab => `${tab.agentSessionId}@${tab.lastTool.at}`).join(',')}`, target: null,
      facts: `A durable approval denial is refusing tools in project ${project}: ${senders.map(tab => `${name(tab)} ${tab.lastTool.name} at ${tab.lastTool.at}`).join('; ')}.`,
      alert: { key: `denial-fence:${projectId}`, title: `Conductor: ${project} is fenced by a denial`, body: `A durable approval denial is refusing tools in ${project} (${senders.map(tab => tab.title).join(', ')}). Only you can lift it: open the tab and review the denied card.` } })
  }

  // 4. A coworker that stopped while its controller has not acted since.
  for (const coworker of tabs) {
    const controller = coworker.controller ? byId.get(coworker.controller) : undefined
    if (!controller || !quiet(coworker) || !SETTLED.has(controller.phase) || controller.awaiting) continue
    const stopped = ms(coworker.lastActivityAt), acted = ms(controller.lastActivityAt)
    if (stopped === null || (acted !== null && acted >= stopped) || now - stopped < timings.coworkerIdleMs) continue
    findings.push({ kind: 'coworker-idle', fingerprint: `coworker-idle:${coworker.agentSessionId}:${coworker.lastActivityAt}`, target: controller,
      facts: `Your coworker stopped at ${coworker.lastActivityAt} and you have not acted since:\n${describe(coworker, coworker.agentSessionId)}` })
  }

  // 5. A downloaded, verified update nobody installs.
  const updates = overview?.updates
  if (updates?.phase === 'ready' && updates.availableVersion && (updates.source !== 'local' || overview.localBuild?.verified !== false)) {
    const seen = next.updateSeen?.version === updates.availableVersion ? next.updateSeen : { version: updates.availableVersion, since: now }
    next.updateSeen = seen
    if (now - seen.since >= timings.updateHeldMs) {
      const builder = overview.localBuild?.builder ? byId.get(overview.localBuild.builder) : undefined
      const targets = builder ? [builder] : tabs.filter(tab => tab.wizard)
      const blockers = updates.installBlockers?.length ? ` The install waits for: ${updates.installBlockers.map(tab => `${tab.title} (${tab.id})`).join(', ')}.` : ''
      const facts = `Update ${updates.availableVersion}${overview.localBuild?.commit ? ` (commit ${String(overview.localBuild.commit).slice(0, 12)})` : ''} is downloaded${updates.source === 'local' ? ' and verified' : ''} and has not been installed for ${Math.round((now - seen.since) / 60_000)} minutes.${blockers}${updates.installWhenIdle ? ' It is queued to install when idle.' : ''} Install it with app.update.install({}) once no tab is mid-turn, or tell the owner why it must wait.`
      for (const target of targets) findings.push({ kind: 'update-held', fingerprint: `update-held:${updates.availableVersion}:${target.agentSessionId}`, target, facts, persistent: true })
      if (!targets.length) findings.push({ kind: 'update-held', fingerprint: `update-held:${updates.availableVersion}`, target: null, facts, alert: { key: `update-held:${updates.availableVersion}`, title: 'Conductor: an update is waiting', body: `Update ${updates.availableVersion} is downloaded and nobody installs it.` } })
    }
  } else next.updateSeen = null

  // 6. A usage limit that reset while the conversation still sits stopped.
  for (const tab of tabs) {
    const reset = ms(tab.limitResumeAt)
    if (reset === null || now < reset + timings.limitGraceMs || !SETTLED.has(tab.phase) || tab.awaiting || tab.pending?.owner) continue
    findings.push({ kind: 'limit-reset', fingerprint: `limit-reset:${tab.agentSessionId}:${tab.limitResumeAt}`, target: tab, prompt: `${HEADER} Your provider usage limit reset at ${tab.limitResumeAt}. Continue where you left off.` })
  }

  return { findings, memory: next }
}

/**
 * The tabs to bring back after a restart: at work in the last snapshot before it, now settled with
 * no activity since the new Conductor started, and not waiting on an approval.
 */
export function resumeTargets(snapshot, overview, restart) {
  const byId = new Map((overview?.tabs ?? []).map(tab => [tab.agentSessionId, tab]))
  const startedAt = ms(restart.startedAt) ?? 0
  const targets = []
  for (const before of snapshot ?? []) {
    const tab = byId.get(before.agentSessionId)
    if (!tab || !SETTLED.has(tab.phase) || tab.pending?.owner) continue
    const acted = ms(tab.lastActivityAt)
    if (acted !== null && acted > startedAt) continue
    targets.push({ kind: 'resume', fingerprint: `resume:${tab.agentSessionId}:${restart.pid}`, target: tab,
      prompt: `${HEADER} Conductor restarted at ${restart.startedAt} (${restart.reason}) and your turn was cut while it was ${before.phase}. Continue where you left off: check what finished before the restart, then carry on. If your work is already complete, say so in one line.` })
  }
  return targets
}

/** What counts as work in progress for the next restart: tabs mid-turn (by phase) or with a live wait. */
export function workingSnapshot(overview) {
  return (overview?.tabs ?? []).filter(tab => BUSY.has(tab.phase)).map(tab => ({ agentSessionId: tab.agentSessionId, title: tab.title, projectId: tab.projectId, workspaceId: tab.workspaceId, phase: tab.phase }))
}

export const steerPrompt = finding => finding.prompt ?? `${HEADER} ${finding.facts}\n${FOOTER}`

/**
 * Which findings become steers or alerts now. A fact is steered once; if it is still there after
 * steerRepeatMs without the tab having acted since, it is steered once more, and after that it goes
 * to the owner (a held update escalates even when its builder acted). A tab hears at most
 * one steer per steerCooldownMs (the others wait for the next tick) and the supervisor sends at
 * most maxSteersPerHour. Returns the plan and the updated ledger.
 */
export function plan(findings, ledger = {}, now = Date.now(), timings = TIMINGS) {
  const steered = { ...(ledger.steered ?? {}) }
  const lastSteer = { ...(ledger.lastSteer ?? {}) }
  const alerted = { ...(ledger.alerted ?? {}) }
  let recent = (ledger.recentSteers ?? []).filter(at => now - at < 3_600_000)
  const steers = [], alerts = []
  const alert = (key, title, body) => {
    if (alerted[key] !== undefined && now - alerted[key] < timings.alertDedupMs) return
    alerted[key] = now
    alerts.push({ key, title, body })
  }
  for (const finding of findings) {
    if (finding.alert) alert(finding.alert.key, finding.alert.title, finding.alert.body)
    const target = finding.target
    if (!target) continue
    const record = steered[finding.fingerprint]
    // The tab acted after hearing it: its call now, not a stall (a held update keeps escalating).
    if (record && !finding.persistent && (ms(target.lastActivityAt) ?? 0) > record.at) continue
    if (record && now - record.at < timings.steerRepeatMs) continue
    if (record && record.count >= 2) { alert(`stuck:${finding.fingerprint}`, `Conductor: ${target.title || 'a tab'} is stuck`, `${finding.kind}: steered twice and still stuck. ${clip(finding.facts ?? finding.prompt, 300)}`); continue }
    // Two facts about one tab in the same tick travel in one message.
    const joined = steers.find(steer => steer.target.agentSessionId === target.agentSessionId)
    if (joined) {
      if (!finding.facts || joined.findings.some(other => !other.facts)) continue
      joined.findings.push(finding)
      steered[finding.fingerprint] = { at: now, count: (record?.count ?? 0) + 1 }
      continue
    }
    if (lastSteer[target.agentSessionId] !== undefined && now - lastSteer[target.agentSessionId] < timings.steerCooldownMs) continue
    if (recent.length >= timings.maxSteersPerHour) { alert('steer-cap', 'Conductor: meta-wizard steer cap reached', `${recent.length} steers in the last hour; more findings are waiting (journal: meta-wizard/journal.jsonl).`); break }
    steers.push({ target, findings: [finding] })
    steered[finding.fingerprint] = { at: now, count: (record?.count ?? 0) + 1 }
    lastSteer[target.agentSessionId] = now
    recent = [...recent, now]
  }
  for (const steer of steers) {
    steer.kind = steer.findings.map(finding => finding.kind).join('+')
    steer.fingerprints = steer.findings.map(finding => finding.fingerprint)
    steer.prompt = steer.findings.length === 1 ? steerPrompt(steer.findings[0]) : `${HEADER} ${steer.findings.map(finding => finding.facts).join('\n\n')}\n${FOOTER}`
  }
  // Forget facts older than a day.
  for (const [key, value] of Object.entries(steered)) if (now - value.at > 86_400_000) delete steered[key]
  for (const [key, at] of Object.entries(alerted)) if (now - at > 86_400_000) delete alerted[key]
  for (const [key, at] of Object.entries(lastSteer)) if (now - at > 86_400_000) delete lastSteer[key]
  return { steers, alerts, ledger: { steered, lastSteer, alerted, recentSteers: recent } }
}
