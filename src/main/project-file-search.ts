import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { ProjectRecord } from '../shared/models'

/** `copy` marks a generated, recovery or artifact copy rather than active source. */
export interface FileSearchResult { projectId: string; path: string; copy?: true }
/** `excludeCopies` drops copies, except one matched by its exact path or name: the filter never hides a file that was asked for. */
export interface FileSearchOptions { showHidden?: boolean; activeProjectId?: string; recentPaths?: FileSearchResult[]; excludeCopies?: boolean }
const ignored = new Set(['.git', 'node_modules', 'out', 'dist', '.next', '.cache', 'coverage', 'release'])
// Bonuses only order files inside one match tier; the tier is compared first, so a boosted fuzzy match never outranks an exact/prefix/contains match.
const ACTIVE_PROJECT_BONUS = 100, RECENT_PATH_BONUS = 50
const cache = new Map<string, { at: number; paths: Promise<string[]> }>()
export function invalidateProjectFiles(root: string): void { cache.delete(root) }
export function isHiddenPath(path: string): boolean { return path.split('/').some((segment) => segment.startsWith('.')) }
// Folders that hold build output, evidence, or earlier copies of the tree rather than the project's own source.
const COPY_DIRECTORIES = new Set(['artifacts', 'out', 'dist', 'release', 'coverage', '.conductor', '.next', '.cache', 'node_modules'])
const COPY_DIRECTORY_NAME = /recover|snapshot|backup/i
// Dot-directories that are checked-in project configuration; every other one (profiles, smoke trees, worktrees) is scratch.
const SOURCE_DOT_DIRECTORIES = new Set(['.github', '.gitlab', '.vscode', '.devcontainer', '.husky', '.storybook', '.changeset', '.circleci', '.config'])
/** Whether a path lives in a generated, recovery or artifact copy rather than the active source. Only folders count: a file named recovery.test.ts is source. */
export function isCopyPath(path: string): boolean {
  return path.split('/').slice(0, -1).some((segment) => COPY_DIRECTORIES.has(segment.toLowerCase()) || COPY_DIRECTORY_NAME.test(segment) || (segment.startsWith('.') && !SOURCE_DOT_DIRECTORIES.has(segment.toLowerCase())))
}
/** Match tiers, strongest first. Ranking compares the tier before anything else, so neither a bonus nor being a copy moves a file across tiers. */
export const MATCH_TIER = { exactPath: 6, exactName: 5, namePrefix: 4, nameContains: 3, pathContains: 2, fuzzy: 1 } as const
export function fileMatch(path: string, query: string): { tier: number; score: number } | undefined {
  const value = path.toLowerCase(), name = value.slice(value.lastIndexOf('/') + 1)
  const needle = query.toLowerCase().trim().replaceAll('\\', '/').replace(/^\.\//, '')
  if (!needle) return { tier: MATCH_TIER.fuzzy, score: 1 }
  if (value === needle) return { tier: MATCH_TIER.exactPath, score: 12000 }
  // A trailing part of the path ("shared/usage-accounting.ts") names the file as precisely as its name does.
  if (name === needle || (needle.includes('/') && value.endsWith('/' + needle))) return { tier: MATCH_TIER.exactName, score: 10000 }
  if (name.startsWith(needle)) return { tier: MATCH_TIER.namePrefix, score: 8000 - name.length }
  if (name.includes(needle)) return { tier: MATCH_TIER.nameContains, score: 6000 - name.length }
  if (value.includes(needle)) return { tier: MATCH_TIER.pathContains, score: 4000 - value.length }
  let cursor = 0, gaps = 0, previous = -1
  for (const char of needle) {
    const next = value.indexOf(char, cursor)
    if (next < 0) return undefined
    if (previous >= 0) gaps += next - previous - 1
    previous = next; cursor = next + 1
  }
  const score = 2000 - gaps - value.length
  return score >= 0 ? { tier: MATCH_TIER.fuzzy, score } : undefined
}
export function fileMatchScore(path: string, query: string): number { return fileMatch(path, query)?.score ?? -1 }
async function indexProject(root: string): Promise<string[]> {
  const found: string[] = [], directories = ['']
  // Ignore links and junctions: search never follows a project entry outside its root.
  for (let index = 0; index < directories.length && index < 10000 && found.length < 50000; index++) {
    const directory = directories[index]!
    const entries = await fs.readdir(join(root, directory), { withFileTypes: true }).catch(() => [])
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.isSymbolicLink() || ignored.has(entry.name)) continue
      const path = directory ? directory + '/' + entry.name : entry.name
      if (entry.isDirectory()) directories.push(path)
      else if (entry.isFile()) found.push(path)
      if (found.length >= 50000) break
    }
  }
  return found
}
const recentKey = (file: FileSearchResult): string => JSON.stringify([file.projectId, file.path])
export async function searchProjectFiles(projects: ProjectRecord[], query: string, options: FileSearchOptions = {}): Promise<FileSearchResult[]> {
  const recent = new Set((options.recentPaths ?? []).map(recentKey))
  const groups = await Promise.all(projects.map(async (project) => {
    const cached = cache.get(project.path)
    const entry = cached && Date.now() - cached.at < 10000 ? cached : { at: Date.now(), paths: indexProject(project.path) }
    cache.set(project.path, entry)
    const paths = options.showHidden ? await entry.paths : (await entry.paths).filter((path) => !isHiddenPath(path))
    return paths.flatMap((path) => {
      const match = fileMatch(path, query)
      if (!match) return []
      const copy = isCopyPath(path)
      if (copy && options.excludeCopies && match.tier < MATCH_TIER.exactName) return []
      const bonus = (project.id === options.activeProjectId ? ACTIVE_PROJECT_BONUS : 0) + (recent.has(recentKey({ projectId: project.id, path })) ? RECENT_PATH_BONUS : 0)
      return [{ projectId: project.id, path, copy, tier: match.tier, score: match.score + bonus }]
    })
  }))
  // Within a tier, active source comes before copies of it, so a tree full of artifacts never pushes the real file past the cut.
  return groups.flat().sort((a, b) => b.tier - a.tier || Number(a.copy) - Number(b.copy) || b.score - a.score || a.path.localeCompare(b.path)).slice(0, 100)
    .map(({ projectId, path, copy }) => (copy ? { projectId, path, copy: true as const } : { projectId, path }))
}
