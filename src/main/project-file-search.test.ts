import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileMatchScore, searchProjectFiles } from './project-file-search'
import type { ProjectRecord } from '../shared/models'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
describe('project file search', () => {
  it('ranks exact file names above prefixes, paths, and fuzzy matches', () => {
    expect(fileMatchScore('src/App.tsx', 'app.tsx')).toBeGreaterThan(fileMatchScore('src/App.tsx.test.ts', 'app.tsx'))
    expect(fileMatchScore('src/App.tsx', 'atsx')).toBeGreaterThan(0)
    expect(fileMatchScore('src/App.tsx', 'zzzz')).toBe(-1)
  })
  it('searches all requested projects, excludes dependencies, and never follows junctions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'conductor-file-search-')); roots.push(root)
    const projects = ['a', 'b'].map((id) => { const path = join(root, id); mkdirSync(path); writeFileSync(join(path, 'shared.ts'), id); return { id, path, name: id } as ProjectRecord })
    mkdirSync(join(projects[0]!.path, 'node_modules')); writeFileSync(join(projects[0]!.path, 'node_modules', 'secret.ts'), 'ignored')
    const outside = join(root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'secret.ts'), 'outside')
    symlinkSync(outside, join(projects[0]!.path, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(await searchProjectFiles(projects, 'shared')).toEqual([{ projectId: 'a', path: 'shared.ts' }, { projectId: 'b', path: 'shared.ts' }])
    expect(await searchProjectFiles(projects, 'secret')).toEqual([])
  })
})
