import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { ProjectRecord } from '../shared/models'

export interface FileSearchResult { projectId: string; path: string }
export interface FileSearchOptions { showHidden?: boolean; activeProjectId?: string; recentPaths?: FileSearchResult[] }
const ignored = new Set(['.git', 'node_modules', 'out', 'dist', '.next', '.cache', 'coverage', 'release'])
// Smaller than the ~2000-point gap between match tiers, so a boosted fuzzy match can never outrank an unboosted exact/prefix/contains match.
const ACTIVE_PROJECT_BONUS = 100, RECENT_PATH_BONUS = 50
const cache = new Map<string, { at: number; paths: Promise<string[]> }>()
export function invalidateProjectFiles(root: string): void { cache.delete(root) }
export function isHiddenPath(path: string): boolean { return path.split('/').some((segment) => segment.startsWith('.')) }
export function fileMatchScore(path: string, query: string): number {
  const value = path.toLowerCase(), name = value.slice(value.lastIndexOf('/') + 1)
  const needle = query.toLowerCase().trim().replaceAll('\\', '/')
  if (!needle) return 1
  if (name === needle) return 10000
  if (name.startsWith(needle)) return 8000 - name.length
  if (name.includes(needle)) return 6000 - name.length
  if (value.includes(needle)) return 4000 - value.length
  let cursor = 0, gaps = 0, previous = -1
  for (const char of needle) {
    const next = value.indexOf(char, cursor)
    if (next < 0) return -1
    if (previous >= 0) gaps += next - previous - 1
    previous = next; cursor = next + 1
  }
  return 2000 - gaps - value.length
}
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
    return paths.map((path) => ({ projectId: project.id, path, score: fileMatchScore(path, query) })).filter((item) => item.score >= 0)
      .map((item) => ({ ...item, score: item.score + (project.id === options.activeProjectId ? ACTIVE_PROJECT_BONUS : 0) + (recent.has(recentKey(item)) ? RECENT_PATH_BONUS : 0) }))
  }))
  return groups.flat().sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, 100).map(({ projectId, path }) => ({ projectId, path }))
}
