import { describeGrantRequest } from '../shared/permission-grants'
import type { Json } from '../shared/structured-agent'
import type { ReviewAction } from './approval-review'

/**
 * Session rules a worker earns from its approvals under review (review-cost-bounded, owner
 * 2026-09-26). Once a stronger review allowed one routine action, or a wizard answered one "for
 * this session", every later action of the same class in that worker's conversation is answered
 * from the rule instead of paying for another reviewer turn. A class is deliberately narrow:
 * a program and its subcommand, an edit inside the workspace, one read-only tool, one web host.
 * Only local, workspace-scoped actions ever form a class; a compound or flag-led command is its
 * own exact class, and anything the permission classifier calls shared, destructive or external
 * never does. Rules live in memory and belong to one runtime of the worker, like the
 * CLI's own session approvals (settingsForRuntime): a restarted conversation starts without them.
 */
export interface SessionRule {
  key: string
  source: 'review' | 'wizard'
  /** The journal record whose decision created the rule. */
  recordId?: string
  /** The reviewer model, or the wizard conversation, that allowed the first action of the class. */
  by: string
  at: string
  example: string
}
export type ClassifiedAction = Pick<ReviewAction, 'tool' | 'arguments' | 'paths' | 'boundary'> & { cwd?: string }

const READ_ONLY = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'WebSearch', 'TodoWrite'])
const EDIT = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
/** Chaining, redirection or substitution: such a command is only ever its own exact class. */
const COMPOUND = /[;&|<>`\r\n]|\$\(/
/** Runners whose second word only picks a script, so the script name is part of the class. */
const RUNNER = /^(?:npm|pnpm|yarn|bun|cargo|dotnet|uv|poetry)$/i
const RUNNER_VERB = /^(?:run|exec|x|run-script)$/i
const object = (value: unknown): Record<string, Json> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, Json> : {}

/** The command a shell-like request runs, with Codex's Windows PowerShell wrapper taken off. */
export function commandText(input: Json): string | undefined {
  const args = object(input), raw = args.command ?? args.cmd
  const command = typeof raw === 'string' ? raw : Array.isArray(raw) && raw.every(part => typeof part === 'string') ? raw.join(' ') : undefined
  if (!command?.trim()) return undefined
  const wrapped = /^"?(?:[a-z]:[\\/][^"]*[\\/])?(?:powershell|pwsh)(?:\.exe)?"?\s+(?:-NoProfile\s+)?-Command\s+(['"])([\s\S]*)\1\s*$/i.exec(command.trim())
  return (wrapped ? wrapped[2]! : command).trim()
}

/** The class one action belongs to, or undefined when it may only ever be decided by itself. */
export function commandClass(action: ClassifiedAction): string | undefined {
  if (action.boundary !== 'workspace-write') return undefined
  const input = object(action.arguments)
  if (input.truncatedForReview === true) return undefined
  const cwd = action.cwd ?? ''
  if (READ_ONLY.has(action.tool)) return 'tool:' + action.tool
  if (EDIT.has(action.tool)) {
    if (!action.paths.length) return undefined
    return describeGrantRequest({ tool: action.tool, input, cwd }).class === 'local' ? 'edit:workspace' : undefined
  }
  if (action.tool === 'WebFetch') {
    const described = describeGrantRequest({ tool: 'WebFetch', input, cwd })
    return described.host ? 'fetch:' + described.host.toLowerCase() : undefined
  }
  if (action.tool.startsWith('mcp__')) {
    if (describeGrantRequest({ tool: action.tool, input, cwd }).class !== 'local') return undefined
    // The conductor `control` tool reaches every app-control method, so an approved tools.list
    // must not cover a later tabs.close: its class is the method it calls.
    if (action.tool === 'mcp__conductor__control') return typeof input.method === 'string' && input.method ? `mcp:${action.tool}:${input.method}` : undefined
    return 'mcp:' + action.tool
  }
  const command = commandText(input)
  if (!command) return undefined
  const shell = action.tool === 'PowerShell' ? 'PowerShell' : 'Bash'
  if (describeGrantRequest({ tool: shell, input: { command }, cwd }).class !== 'local') return undefined
  const label = action.tool
  if (COMPOUND.test(command) || command.length > 400) return `${label}=${command}`
  const [program, second, third] = command.split(/\s+/)
  if (!second) return `${label}:${program}`
  // A flag in second place is usually inline code or a mode switch (node -e, python -c, bash -c).
  if (second.startsWith('-')) return `${label}=${command}`
  if (RUNNER.test(program!) && RUNNER_VERB.test(second)) return third && !third.startsWith('-') ? `${label}:${program} ${second} ${third}` : `${label}=${command}`
  return `${label}:${program} ${second}`
}

/** One runtime of one worker conversation. */
export interface RuleScope { workerId: string; runtimeId: string }
const scopeKey = (scope: RuleScope) => JSON.stringify([scope.workerId, scope.runtimeId])

export class SessionRules {
  private readonly byRuntime = new Map<string, { workerId: string; rules: Map<string, SessionRule> }>()
  add(scope: RuleScope, rule: SessionRule): SessionRule {
    const entry = this.byRuntime.get(scopeKey(scope)) ?? { workerId: scope.workerId, rules: new Map<string, SessionRule>() }
    if (!entry.rules.has(rule.key)) entry.rules.set(rule.key, rule)
    this.byRuntime.set(scopeKey(scope), entry)
    return entry.rules.get(rule.key)!
  }
  /** The rule that already answers this action in this runtime of the worker, if any. */
  covering(scope: RuleScope, action: ClassifiedAction): SessionRule | undefined {
    const key = commandClass(action)
    return key ? this.byRuntime.get(scopeKey(scope))?.rules.get(key) : undefined
  }
  list(scope: RuleScope): SessionRule[] { return [...this.byRuntime.get(scopeKey(scope))?.rules.values() ?? []] }
  /** Forgets one worker's rules (every runtime), or all of them. */
  clear(workerId?: string): void {
    if (!workerId) { this.byRuntime.clear(); return }
    for (const [key, entry] of this.byRuntime) if (entry.workerId === workerId) this.byRuntime.delete(key)
  }
}

/** One store for the app: the review gate learns and applies rules, a wizard's answer adds them. */
export const sessionRules = new SessionRules()
