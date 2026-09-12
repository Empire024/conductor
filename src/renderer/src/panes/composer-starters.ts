import type { Json, ProviderCapabilities } from '../../../shared/structured-agent'
import { composerCommands } from './composer-commands'

export type ComposerStarterKind = 'starter' | 'configured-skill' | 'configured-command'
export interface ComposerStarterChoice { id: string; label: string; description: string; kind: ComposerStarterKind; draft: string }

/** Provider-neutral workflows are prompt scaffolds, never executable skills. They deliberately
 * ask for evidence and safe discovery while leaving the conversation's model and permissions alone. */
export const BUILT_IN_STARTERS: ComposerStarterChoice[] = [
  {
    id: 'grill-me', label: 'Grill me', kind: 'starter',
    description: 'Pressure-test a big idea through a focused interview.',
    draft: `Help me develop this idea by grilling me. Ask one incisive question at a time, adapting each question to my last answer. Challenge assumptions, surface users and constraints, test why this matters now, and distinguish evidence from hope. Do not start implementing or silently settle decisions. When the idea is concrete, summarize the strongest version, unresolved risks, and the smallest useful next experiment for my approval.\n\nThe idea:`
  },
  {
    id: 'root-cause', label: 'Find root cause', kind: 'starter',
    description: 'Reproduce a problem and separate evidence from suspects.',
    draft: `Investigate this problem to the root cause. Reproduce the relevant behavior, trace the actual data/control path, and distinguish confirmed facts from suspects. Do not make a change merely because wording could hide the symptom. Report the cause and the smallest safe fix, including regression tests, before implementation if the evidence changes scope.\n\nProblem:`
  },
  {
    id: 'map-project', label: 'Map the code', kind: 'starter',
    description: 'Read the project and explain the relevant architecture.',
    draft: `Explore this project read-only and build an evidence-backed map for the question below. Read project instructions first. Use file search and focused reads; if other visible agents may own related work, use read-only agent discovery and snapshots. Do not modify files, run arbitrary scripts, install plugins, or change permissions. Return the key files, control flow, boundaries, and open questions.\n\nQuestion:`
  },
  {
    id: 'risk-review', label: 'Risk review', kind: 'starter',
    description: 'Challenge a proposed change before code is touched.',
    draft: `Review this proposed change before implementation. Identify trust boundaries, data-loss and concurrency risks, compatibility constraints, failure recovery, and the tests or live evidence needed. Use read-only project and agent discovery where useful. Do not change files, settings, model, permissions, or external state.\n\nProposed change:`
  }
]

/** Native discovery is reused only to prepare its provider token in the draft. Selecting one does
 * not execute a command, install anything, or grant permissions. */
export function composerStarterChoices(capabilities?: ProviderCapabilities, discovery?: Json): ComposerStarterChoice[] {
  const configured = composerCommands(capabilities, discovery).flatMap(command => command.insert ? [{
    id: `configured:${command.insert.trim()}`,
    label: `${command.insert.startsWith('$') ? '$' : command.trigger ?? '/'}${command.name}`,
    description: command.description,
    kind: (command.insert.startsWith('$') ? 'configured-skill' : 'configured-command') as ComposerStarterKind,
    draft: command.insert
  }] : [])
  return [...BUILT_IN_STARTERS, ...configured]
}

export function prepareComposerDraft(current: string, choice: ComposerStarterChoice): string {
  if (!current.trim()) return choice.draft
  return `${current.replace(/\s+$/, '')}\n\n${choice.draft}`
}
