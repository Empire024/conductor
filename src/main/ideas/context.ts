import type { AgentMemory } from '../../shared/models'
import type { IdeaDetail } from '../../shared/ideas'
import { memoryTokens, scoreMemory } from '../memory'

export interface RelatedMemory { id: string; projectId: string; kind: AgentMemory['kind']; gist: string }

/**
 * Memories that relate to an idea's text, across every project, ranked with the same scoring as
 * recall but without recall's side effect (it bumps recall counts; merely looking at an idea
 * must not). Only memories sharing at least two content words qualify, so a lone common word
 * does not drag unrelated decisions into a brief.
 */
export function relatedMemories(text: string, memories: Iterable<AgentMemory>, limit = 6, now = Date.now()): RelatedMemory[] {
  const tokens = new Set(memoryTokens(text))
  if (!tokens.size) return []
  const scored: Array<{ memory: AgentMemory; score: number }> = []
  for (const memory of memories) {
    const { overlap, score } = scoreMemory(memory, tokens, now)
    if (Math.round(overlap * tokens.size) >= Math.min(2, tokens.size)) scored.push({ memory, score })
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit)
    .map(({ memory }) => ({ id: memory.id, projectId: memory.projectId, kind: memory.kind, gist: memory.gist }))
}

const bullets = (items: string[]): string => items.map(item => `- ${item}`).join('\n')

/**
 * The first message of a conversation started with "Work on this idea": everything Conductor
 * knows about the idea, so the agent does not start from zero, plus how to record what it makes.
 */
export function workOnIdeaBrief(idea: IdeaDetail, memories: RelatedMemory[]): string {
  const parts = [
    `The owner wants to work on one of their ideas (Conductor idea ${idea.id}, "${idea.title}"). Start by understanding it; ask the owner what they want from this session if it is not obvious, and keep the owner's own words as the source of truth.`,
    `## The owner's note\n\n${idea.text.trim()}`
  ]
  if (idea.originalText.trim() && idea.originalText.trim() !== idea.text.trim()) parts.push(`## As first written\n\n${idea.originalText.trim()}`)
  const brief = idea.latestBrief
  if (brief) {
    const who = brief.createdBy.model ? `${brief.createdBy.model}${brief.createdBy.machine ? ` on ${brief.createdBy.machine}` : ''}` : 'an agent'
    const structured = brief.brief
    parts.push(`## Latest brief (written by ${who}, ${brief.createdAt.slice(0, 10)}; an interpretation, not the owner's words)\n\n${structured
      ? [`Concept: ${structured.concept}`, structured.openQuestions.length ? `Open questions:\n${bullets(structured.openQuestions)}` : '', structured.nextStep ? `Next step: ${structured.nextStep}` : '', structured.observations.length ? `Observations:\n${bullets(structured.observations)}` : ''].filter(Boolean).join('\n')
      : brief.body.trim().slice(0, 4_000)}`)
  }
  if (memories.length) parts.push(`## Related memories\n\n${bullets(memories.map(memory => `[${memory.kind}] ${memory.gist}`))}`)
  const prior = idea.links.filter(link => link.kind !== 'memory')
  if (prior.length) parts.push(`## Prior work linked to this idea\n\n${bullets(prior.map(link => `${link.kind}: ${link.label}${link.kind === 'artifact' ? ` (${link.targetId})` : ''} — ${link.createdAt.slice(0, 10)}`))}`)
  const stopped = idea.explorations.filter(exploration => exploration.status === 'stopped' && exploration.note).slice(0, 3)
  if (stopped.length) parts.push(`## Earlier local explorations that stopped\n\n${bullets(stopped.map(exploration => `${exploration.startedAt.slice(0, 10)} ${exploration.model}: ${exploration.note}`))}`)
  parts.push([
    '## Keeping the idea connected',
    `This conversation is already linked to idea ${idea.id}. When you create something durable for it (a file, a document, a task, a memory), record it with Conductor app control:`,
    `{"method":"ideas.link","args":{"ideaId":"${idea.id}","kind":"artifact","targetId":"<path or URL>","label":"<what it is>"}} (kind: artifact, task, memory or project).`,
    `A short durable finding can be added with {"method":"ideas.note","args":{"ideaId":"${idea.id}","title":"...","body":"..."}}. Never rewrite the owner's note.`
  ].join('\n'))
  return parts.join('\n\n')
}
