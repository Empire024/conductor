import type { StructuredProvider } from './structured-agent'

/**
 * Skills a conversation's runtime can run, as the composer lists them: `/skill:name` in the `/`
 * menu (docs/skill-discovery.md). Discovery only reads names and frontmatter; it never runs a
 * skill, its scripts or its prompt, and the text it reads is untrusted display data.
 *
 * Claude's catalog is read from disk by the main process (src/main/skill-discovery.ts); Codex's
 * comes from the App Server's `skills/list` in the same provider discovery call. Either way the
 * runtime invokes a chosen skill itself, in its own syntax: Claude `/name args`, Codex `$name args`.
 */
export type SkillSource = 'project' | 'user' | 'plugin' | 'system' | 'admin' | 'other'
export interface DiscoveredSkill {
  /** The name the runtime invokes: Claude's skill folder, Codex's reported name. */
  name: string
  /** Frontmatter description, whitespace-collapsed and cut to SKILL_LIMITS.description. */
  description?: string
  source: SkillSource
  /** False when a settings override turns it off (`skillOverrides: { name: "off" }`) or Codex reports it disabled. */
  enabled: boolean
  /** False for an agent-only skill (`user-invocable: false`): the model may use it, the owner cannot invoke it. */
  userInvocable: boolean
  /** False when only the owner may start it (`disable-model-invocation: true`). */
  modelInvocable: boolean
  /** Where it was read, for the owner: `.claude/skills/x/SKILL.md` or `~/.claude/skills/x/SKILL.md`. */
  location?: string
}
export interface SkillRootReport {
  source: SkillSource
  /** Display path of the root (`.claude/skills`, `~/.claude/skills`). */
  location: string
  state: 'read' | 'missing' | 'outside-project' | 'unreadable'
}
export interface SkillCatalog {
  status: 'available' | 'unavailable'
  /** Sorted by name; one entry per name, the higher-precedence source winning. */
  skills: DiscoveredSkill[]
  /** A lower-precedence skill hidden by one of the same name. */
  shadowed?: Array<{ name: string; source: SkillSource; by: SkillSource }>
  roots?: SkillRootReport[]
  /** Entries left out: malformed or oversized SKILL.md, a symlink out of its root, a bad name. */
  skipped?: number
  /** The scan stopped at a bound (SKILL_LIMITS); the list is incomplete. */
  truncated?: boolean
  message?: string
}

export const SKILL_LIMITS = {
  /** Skills kept per catalog. */
  skills: 200,
  /** Directory entries looked at per root; the rest are not read at all. */
  entriesPerRoot: 400,
  /** A SKILL.md larger than this is ignored, never read. */
  fileBytes: 64 * 1024,
  /** Settings files (skill overrides) larger than this are ignored. */
  settingsBytes: 256 * 1024,
  description: 160,
  name: 64
} as const

/** A name the composer can carry as a single token in both runtimes' syntax. */
export const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*(?::[A-Za-z0-9][A-Za-z0-9_-]*)?$/
export const isSkillName = (name: string): boolean => name.length <= SKILL_LIMITS.name && SKILL_NAME.test(name)

/** The prefix of an explicit skill command: `/skill:review-pr`. */
export const SKILL_COMMAND_PREFIX = 'skill:'
export type SkillSyntax = '/' | '$'
/** How the runtime invokes a skill, or undefined when it has none Conductor can list. */
export function skillSyntax(provider: StructuredProvider | undefined): SkillSyntax | undefined {
  return provider === 'claude' ? '/' : provider === 'codex' ? '$' : undefined
}
const SOURCE_LABELS: Record<SkillSource, string> = { project: 'Project skill', user: 'User skill', plugin: 'Plugin skill', system: 'Built-in skill', admin: 'Managed skill', other: 'Skill' }
export const skillSourceLabel = (source: SkillSource): string => SOURCE_LABELS[source]

export function cleanSkillDescription(value: string | undefined): string | undefined {
  // Control characters and bidi overrides are dropped: this is text from a file in the project.
  const text = value?.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!text) return undefined
  return text.length > SKILL_LIMITS.description ? text.slice(0, SKILL_LIMITS.description - 1).trimEnd() + '…' : text
}
