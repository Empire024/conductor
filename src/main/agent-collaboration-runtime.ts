import type { AgentSpec, NormalizedAgentEvent } from '../shared/models'
import type { FileWorkIntent } from '../shared/agent-collaboration'
import type { AgentCollaborationStore } from './agent-collaboration-store'
import { normalizeCollaborationPath } from './agent-collaboration-store'

export interface ExtractedFileWorkSignal {
  path: string
  intent: FileWorkIntent
  detail: string
}

const intentRank: Record<FileWorkIntent, number> = {
  view: 0,
  execute: 1,
  edit: 2,
  create: 3,
  delete: 4
}

const inferIntent = (context: string): FileWorkIntent => {
  if (/\b(delete|deleted|deleting|remove|removed|unlink)\b/i.test(context)) return 'delete'
  if (/\b(add file|added|create|created|creating|new file)\b/i.test(context)) return 'create'
  if (/\b(edit|edited|editing|update|updated|write|wrote|writing|modify|modified|patch|apply_patch)\b/i.test(context)) return 'edit'
  if (/\b(run|running|execute|executing|command|test|build|lint|compile)\b/i.test(context)) return 'execute'
  return 'view'
}

const trimMention = (value: string): string => value
  .trim()
  .replace(/^['"`(<[]+/, '')
  .replace(/['"`)>\],;.!?]+$/, '')

/**
 * Extract conservative file signals from normalized PTY text, including patch
 * headers, provider file-tool prose, git status, and shell command output.
 */
export const extractFileWorkSignals = (text: string, projectRoot: string): ExtractedFileWorkSignal[] => {
  const signals = new Map<string, ExtractedFileWorkSignal>()
  const add = (reportedPath: string, intent: FileWorkIntent, detail: string): void => {
    try {
      const path = normalizeCollaborationPath(projectRoot, trimMention(reportedPath))
      if (/^(?:node_modules|\.git|out|dist)\//i.test(path)) return
      const key = path.toLowerCase()
      const existing = signals.get(key)
      if (!existing || intentRank[intent] > intentRank[existing.intent]) {
        signals.set(key, { path, intent, detail: detail.replace(/\s+/g, ' ').trim().slice(0, 500) })
      }
    } catch {
      // PTY output contains URLs and prose that resemble paths; ignore paths outside the project.
    }
  }

  const lines = text.replace(/\r/g, '').split('\n').slice(-160)
  for (const line of lines) {
    const compact = line.trim()
    if (!compact) continue

    const patch = compact.match(/^\*\*\*\s+(Update|Add|Delete) File:\s*(.+)$/i)
    if (patch?.[1] && patch[2]) {
      const intent: FileWorkIntent = patch[1].toLowerCase() === 'add'
        ? 'create'
        : patch[1].toLowerCase() === 'delete' ? 'delete' : 'edit'
      add(patch[2], intent, compact)
      continue
    }

    const gitStatus = compact.match(/^(?:modified|new file|deleted|renamed):\s+(.+)$/i)
    if (gitStatus?.[1]) {
      add(gitStatus[1], inferIntent(compact), compact)
      continue
    }

    const explicit = compact.match(
      /\b(?:read|reading|opened?|inspect(?:ed|ing)?|edit(?:ed|ing)?|writ(?:e|ing|ten)|wrote|updat(?:e|ed|ing)|creat(?:e|ed|ing)|delet(?:e|ed|ing)|remov(?:e|ed|ing))\s+(?:the\s+)?(?:file\s+)?[`'"]?([^`'"\s]+)[`'"]?/i
    )
    if (explicit?.[1]) add(explicit[1], inferIntent(compact), compact)

    const mentions = compact.matchAll(
      /(?:[A-Za-z]:[\\/]|\.{0,2}[\\/])?[\w@.-]+(?:[\\/][\w@().-]+)+\.[A-Za-z0-9_-]{1,12}(?::\d+(?::\d+)?)?/g
    )
    for (const mention of mentions) add(mention[0], inferIntent(compact), compact)
  }
  return [...signals.values()].slice(0, 16)
}

export const signalsFromNormalizedEvent = (
  event: NormalizedAgentEvent,
  projectRoot: string
): ExtractedFileWorkSignal[] => {
  const metadataPaths: string[] = []
  const rawPath = event.metadata?.path
  const rawPaths = event.metadata?.paths
  if (typeof rawPath === 'string') metadataPaths.push(rawPath)
  if (Array.isArray(rawPaths)) {
    metadataPaths.push(...rawPaths.filter((item): item is string => typeof item === 'string'))
  }
  const metadataIntent: FileWorkIntent = event.type === 'file_change'
    ? inferIntent(String(event.metadata?.operation ?? event.message))
    : event.type === 'shell_command' ? 'execute' : inferIntent(event.message)
  const metadataSignals = metadataPaths.flatMap((path) => {
    try {
      return [{ path: normalizeCollaborationPath(projectRoot, path), intent: metadataIntent, detail: event.message }]
    } catch {
      return []
    }
  })
  const textSignals = extractFileWorkSignals(event.message, projectRoot)
  const merged = new Map<string, ExtractedFileWorkSignal>()
  for (const signal of [...metadataSignals, ...textSignals]) {
    const key = signal.path.toLowerCase()
    const existing = merged.get(key)
    if (!existing || intentRank[signal.intent] > intentRank[existing.intent]) merged.set(key, signal)
  }
  return [...merged.values()]
}

/**
 * Thin adapter intended for AgentManager. It heartbeats leases for every
 * normalized event and rate-limits durable activity messages to avoid PTY spam.
 */
export class AgentCollaborationRuntime {
  private readonly publishedAt = new Map<string, number>()

  constructor(private readonly store: AgentCollaborationStore) {}

  observeEvent(spec: AgentSpec, event: NormalizedAgentEvent): void {
    if (event.type === 'task_complete') {
      this.store.postMessage({
        projectId: spec.projectId,
        sessionId: spec.sessionId,
        agentSessionId: spec.id,
        kind: 'completion',
        body: event.message
      })
      this.store.releasePresence(spec.id)
      return
    }

    const signals = signalsFromNormalizedEvent(event, spec.cwd)
    if (signals.length === 0) return
    const reported: ExtractedFileWorkSignal[] = []
    for (const signal of signals) {
      const announcement = this.store.announcePresence({
        projectId: spec.projectId,
        sessionId: spec.sessionId,
        agentSessionId: spec.id,
        path: signal.path,
        intent: signal.intent,
        detail: signal.detail,
        ttlSeconds: 90
      })
      reported.push(signal)
      if (!announcement.granted) {
        this.store.postMessage({
          projectId: spec.projectId,
          sessionId: spec.sessionId,
          agentSessionId: spec.id,
          kind: 'warning',
          body: announcement.conflicts.map((conflict) => conflict.reason).join('; '),
          paths: [signal.path],
          metadata: { conflicts: announcement.conflicts.map((conflict) => conflict.presence.agentSessionId) }
        })
      }
    }

    const signature = `${spec.id}:${reported.map((signal) => `${signal.intent}:${signal.path}`).sort().join('|')}`
    const previous = this.publishedAt.get(signature) ?? 0
    if (Date.now() - previous < 15_000) return
    this.publishedAt.set(signature, Date.now())
    this.store.postMessage({
      projectId: spec.projectId,
      sessionId: spec.sessionId,
      agentSessionId: spec.id,
      kind: 'intent',
      body: reported.map((signal) => `${signal.intent} ${signal.path}`).join(', '),
      paths: reported.map((signal) => signal.path),
      metadata: { sourceEventId: event.id, sourceEventType: event.type }
    })
  }

  briefingFor(agentSessionId: string): string {
    return this.store.buildBriefing(agentSessionId)
  }

  releaseAgent(agentSessionId: string): void {
    this.store.releasePresence(agentSessionId)
  }
}
