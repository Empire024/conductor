import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { open, opendir, realpath, stat } from 'node:fs/promises'
import { cleanSkillDescription, isSkillName, SKILL_LIMITS, type DiscoveredSkill, type SkillCatalog, type SkillRootReport, type SkillSource } from '../shared/skill-catalog'

/**
 * Claude Code's skills, read from disk for the composer's `/skill:name` list (docs/skill-discovery.md,
 * after t3code's Drivers/ClaudeSkills.ts at dd148481). Claude's own init reports only bare command
 * names, so descriptions and sources come from the files themselves.
 *
 * Only names and frontmatter are read. Nothing in a skill folder is executed, imported or sent to
 * a model, and every read is bounded: a fixed number of directory entries per root, SKILL.md files
 * up to SKILL_LIMITS.fileBytes (a larger one is skipped unread), a fixed number of skills. A skill
 * folder or SKILL.md that is a symlink out of its root is ignored, and a project `.claude/skills`
 * that resolves outside the project is not read.
 *
 * Roots, in Claude Code's precedence (a name is taken by the first root that has it):
 * the user's `<CLAUDE_CONFIG_DIR or ~/.claude>/skills`, then the project's `.claude/skills`.
 * Plugin skills are namespaced (`plugin:skill`) and come from the CLI's own report instead.
 */
export interface ClaudeSkillDiscoveryOptions {
  cwd: string
  environment?: NodeJS.ProcessEnv
  home?: string
}

type Frontmatter =
  | { kind: 'missing' }
  | { kind: 'malformed' }
  | { kind: 'parsed'; name?: string; description?: string; disableModelInvocation?: boolean; userInvocable?: boolean }

const yamlBoolean = (value: string | undefined): boolean | undefined => {
  switch (value?.trim().toLowerCase()) {
    case 'true': case 'yes': case 'on': case 'y': case '1': return true
    case 'false': case 'no': case 'off': case 'n': case '0': return false
    default: return undefined
  }
}
const scalar = (raw: string): string | undefined => {
  const value = raw.trim()
  if (value.startsWith('"')) {
    const end = value.lastIndexOf('"')
    if (end <= 0) return undefined
    try { return JSON.parse(value.slice(0, end + 1)) as string } catch { return value.slice(1, end) }
  }
  if (value.startsWith("'")) {
    const end = value.lastIndexOf("'")
    return end <= 0 ? undefined : value.slice(1, end).replaceAll("''", "'")
  }
  // A plain scalar ends at a comment.
  return value.replace(/\s+#.*$/, '')
}

/**
 * The few frontmatter keys the menu needs, from the YAML subset SKILL.md files use: `key: value`
 * scalars (plain, quoted, or `|`/`>` blocks and indented continuations). An opening `---` with no
 * closing one, or a top-level line that is not a key, is malformed and the skill is left out.
 */
export function parseSkillFrontmatter(contents: string): Frontmatter {
  const lines = contents.replace(/^﻿/, '').split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return { kind: 'missing' }
  const close = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line))
  if (close < 0) return { kind: 'malformed' }
  const values = new Map<string, string>()
  let index = 1
  while (index < close) {
    const line = lines[index]!
    if (!line.trim() || /^\s*#/.test(line)) { index++; continue }
    const match = /^([A-Za-z_][\w-]*)\s*:(?:\s+(.*)|\s*)$/.exec(line)
    if (!match) return { kind: 'malformed' }
    const key = match[1]!.toLowerCase(), head = (match[2] ?? '').trim()
    const continuation: string[] = []
    index++
    while (index < close && (/^\s/.test(lines[index]!) || !lines[index]!.trim())) continuation.push(lines[index++]!)
    const block = /^([|>])[+-]?\d*\s*(#.*)?$/.exec(head)
    if (block) {
      const body = continuation.map(text => text.trim())
      values.set(key, block[1] === '|' ? body.join('\n') : body.filter(Boolean).join(' '))
    } else {
      const first = head ? scalar(head) : ''
      if (first === undefined) return { kind: 'malformed' }
      values.set(key, [first, ...continuation.map(text => text.trim())].filter(Boolean).join(' '))
    }
  }
  return {
    kind: 'parsed',
    ...(values.get('name')?.trim() ? { name: values.get('name')!.trim() } : {}),
    ...(values.get('description')?.trim() ? { description: values.get('description')!.trim() } : {}),
    ...(yamlBoolean(values.get('disable-model-invocation')) === true ? { disableModelInvocation: true } : {}),
    ...(yamlBoolean(values.get('user-invocable')) === false ? { userInvocable: false } : {})
  }
}

const inside = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}
const realOrUndefined = async (path: string): Promise<string | undefined> => { try { return await realpath(path) } catch { return undefined } }

/** At most `limit` bytes of a regular file, or undefined when it is larger or not a file. */
async function readBounded(path: string, limit: number): Promise<string | undefined> {
  const file = await open(path, 'r')
  try {
    const metadata = await file.stat()
    if (!metadata.isFile() || metadata.size > limit) return undefined
    const buffer = Buffer.alloc(limit + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    // Grown past the bound since stat: still too large.
    return offset > limit ? undefined : buffer.subarray(0, offset).toString('utf8')
  } finally { await file.close() }
}

type Override = { enabled: boolean; modelInvocable: boolean }
/** `skillOverrides` from the settings layers Claude Code reads, later layers winning. A file that
 *  does not parse, or holds a value Claude does not accept, contributes nothing (Claude drops it too). */
async function skillOverrides(configDir: string, cwd: string): Promise<Map<string, Override>> {
  const overrides = new Map<string, Override>()
  for (const path of [join(configDir, 'settings.json'), join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json')]) {
    let parsed: unknown
    try { parsed = JSON.parse(await readBounded(path, SKILL_LIMITS.settingsBytes) ?? 'null') } catch { continue }
    const map = parsed && typeof parsed === 'object' ? (parsed as { skillOverrides?: unknown }).skillOverrides : undefined
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue
    const entries = Object.entries(map as Record<string, unknown>)
    if (!entries.every(([, value]) => value === 'on' || value === 'off' || value === 'name-only' || value === 'user-invocable-only')) continue
    for (const [name, value] of entries) overrides.set(name, { enabled: value !== 'off', modelInvocable: value !== 'user-invocable-only' })
  }
  return overrides
}

export function claudeConfigDirectory(environment: NodeJS.ProcessEnv, cwd: string, home = homedir()): string {
  const configured = environment.CLAUDE_CONFIG_DIR?.trim()
  return configured ? resolve(cwd, configured) : join(home, '.claude')
}

export async function discoverClaudeSkills(options: ClaudeSkillDiscoveryOptions): Promise<SkillCatalog> {
  const environment = options.environment ?? process.env
  const home = options.home ?? homedir()
  const configDir = claudeConfigDirectory(environment, options.cwd, home)
  const userLocation = configDir === join(home, '.claude') ? '~/.claude/skills' : join(configDir, 'skills')
  const roots: Array<{ directory: string; source: SkillSource; location: string; containedIn?: string }> = [
    { directory: join(configDir, 'skills'), source: 'user', location: userLocation },
    { directory: join(options.cwd, '.claude', 'skills'), source: 'project', location: '.claude/skills', containedIn: options.cwd }
  ]
  const overrides = await skillOverrides(configDir, options.cwd)
  const skills = new Map<string, DiscoveredSkill>()
  const shadowed: NonNullable<SkillCatalog['shadowed']> = []
  const reports: SkillRootReport[] = []
  let skipped = 0, truncated = false
  for (const root of roots) {
    const realRoot = await realOrUndefined(root.directory)
    if (!realRoot || !(await stat(realRoot).then(value => value.isDirectory(), () => false))) { reports.push({ source: root.source, location: root.location, state: 'missing' }); continue }
    if (root.containedIn) {
      const project = await realOrUndefined(root.containedIn)
      if (!project || !inside(project, realRoot)) { reports.push({ source: root.source, location: root.location, state: 'outside-project' }); continue }
    }
    // Entries are collected up to the bound, then sorted, so the result does not depend on the
    // order the file system lists them in.
    const names: string[] = []
    try {
      const directory = await opendir(realRoot)
      try {
        for await (const entry of directory) {
          if (names.length >= SKILL_LIMITS.entriesPerRoot) { truncated = true; break }
          if (!entry.name.startsWith('.')) names.push(entry.name)
        }
      } finally { await directory.close().catch(() => undefined) }
    } catch { reports.push({ source: root.source, location: root.location, state: 'unreadable' }); continue }
    reports.push({ source: root.source, location: root.location, state: 'read' })
    for (const name of names.sort()) {
      if (skills.size >= SKILL_LIMITS.skills) { truncated = true; break }
      // A symlinked folder or SKILL.md that leaves the root (or a dangling one) is not this root's skill.
      const folder = await realOrUndefined(join(realRoot, name))
      if (!folder || folder === realRoot || !inside(realRoot, folder)) { skipped++; continue }
      if (!(await stat(folder).then(value => value.isDirectory(), () => false))) continue
      if (!isSkillName(name) || name.includes(':')) { skipped++; continue }
      const file = await realOrUndefined(join(folder, 'SKILL.md'))
      if (!file) continue
      if (!inside(realRoot, file)) { skipped++; continue }
      let contents: string | undefined
      try { contents = await readBounded(file, SKILL_LIMITS.fileBytes) } catch { contents = undefined }
      if (contents === undefined || contents.includes('\u0000')) { skipped++; continue }
      const frontmatter = parseSkillFrontmatter(contents)
      if (frontmatter.kind === 'malformed') { skipped++; continue }
      const existing = skills.get(name)
      if (existing) { shadowed.push({ name, source: root.source, by: existing.source }); continue }
      const override = overrides.get(name)
      const parsed = frontmatter.kind === 'parsed' ? frontmatter : undefined
      const description = cleanSkillDescription(parsed?.description)
      skills.set(name, {
        name,
        ...(description ? { description } : {}),
        source: root.source,
        enabled: override?.enabled ?? true,
        userInvocable: parsed?.userInvocable !== false,
        modelInvocable: parsed?.disableModelInvocation !== true && override?.modelInvocable !== false,
        location: `${root.location}/${name}/SKILL.md`
      })
    }
  }
  return {
    status: 'available',
    skills: [...skills.values()].sort((left, right) => left.name.localeCompare(right.name)),
    ...(shadowed.length ? { shadowed } : {}),
    roots: reports,
    ...(skipped ? { skipped } : {}),
    ...(truncated ? { truncated: true } : {})
  }
}

/** The catalog, or why there is none; discovery never fails the provider call it is part of. */
export async function claudeSkillCatalog(options: ClaudeSkillDiscoveryOptions & { isolated?: boolean }): Promise<SkillCatalog> {
  if (options.isolated) return { status: 'unavailable', skills: [], message: 'This runtime is started without skills.' }
  try { return await discoverClaudeSkills(options) } catch (error) {
    return { status: 'unavailable', skills: [], message: 'Skill discovery failed: ' + (error instanceof Error ? error.message : String(error)) }
  }
}
