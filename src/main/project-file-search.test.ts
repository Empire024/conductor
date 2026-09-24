import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileMatchScore, isCopyPath, isHiddenPath, searchProjectFiles } from './project-file-search'
import type { ProjectRecord } from '../shared/models'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
describe('project file search', () => {
  it('ranks exact file names above prefixes, paths, and fuzzy matches', () => {
    expect(fileMatchScore('src/App.tsx', 'app.tsx')).toBeGreaterThan(fileMatchScore('src/App.tsx.test.ts', 'app.tsx'))
    expect(fileMatchScore('src/App.tsx', 'atsx')).toBeGreaterThan(0)
    expect(fileMatchScore('src/App.tsx', 'zzzz')).toBe(-1)
  })
  it('treats dotfiles and anything nested under a dot-directory as hidden', () => {
    expect(isHiddenPath('.env')).toBe(true)
    expect(isHiddenPath('.conductor/tasks/feature-list.md')).toBe(true)
    expect(isHiddenPath('src/feature-list.md')).toBe(false)
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
  it('excludes hidden files and directories by default but includes them when requested', async () => {
    const root = mkdtempSync(join(tmpdir(), 'conductor-file-search-')); roots.push(root)
    const project = { id: 'a', path: root, name: 'a' } as ProjectRecord
    writeFileSync(join(root, 'feature-list.md'), 'real')
    mkdirSync(join(root, '.conductor', 'tasks'), { recursive: true })
    writeFileSync(join(root, '.conductor', 'tasks', 'feature-list.md'), 'stale')
    writeFileSync(join(root, '.env'), 'secret')
    expect(await searchProjectFiles([project], 'feature-list')).toEqual([{ projectId: 'a', path: 'feature-list.md' }])
    const withHidden = await searchProjectFiles([project], 'feature-list', { showHidden: true })
    expect(withHidden).toEqual(expect.arrayContaining([{ projectId: 'a', path: 'feature-list.md' }, { projectId: 'a', path: '.conductor/tasks/feature-list.md', copy: true }]))
    // The stale .conductor copy is found, but after the real file.
    expect(withHidden[0]).toEqual({ projectId: 'a', path: 'feature-list.md' })
    expect((await searchProjectFiles([project], '.env')).length).toBe(0)
    expect((await searchProjectFiles([project], '.env', { showHidden: true })).length).toBe(1)
  })
  it('boosts files from the active project above equally-scored files from other projects', async () => {
    const root = mkdtempSync(join(tmpdir(), 'conductor-file-search-')); roots.push(root)
    const projects = ['a', 'b'].map((id) => { const path = join(root, id); mkdirSync(path); writeFileSync(join(path, 'widget.ts'), id); return { id, path, name: id } as ProjectRecord })
    expect(await searchProjectFiles(projects, 'widget', { activeProjectId: 'b' })).toEqual([{ projectId: 'b', path: 'widget.ts' }, { projectId: 'a', path: 'widget.ts' }])
  })
  it('boosts recently opened paths above equally-scored files that were not recently opened', async () => {
    const root = mkdtempSync(join(tmpdir(), 'conductor-file-search-')); roots.push(root)
    const projects = ['a', 'b'].map((id) => { const path = join(root, id); mkdirSync(path); writeFileSync(join(path, 'widget.ts'), id); return { id, path, name: id } as ProjectRecord })
    expect(await searchProjectFiles(projects, 'widget', { recentPaths: [{ projectId: 'a', path: 'widget.ts' }] })).toEqual([{ projectId: 'a', path: 'widget.ts' }, { projectId: 'b', path: 'widget.ts' }])
  })
  it('never lets active-project or recent bonuses push a lower match tier above a higher one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'conductor-file-search-')); roots.push(root)
    const path = join(root, 'a'); mkdirSync(path)
    writeFileSync(join(path, 'widget.ts'), 'exact')
    writeFileSync(join(path, 'w_i_d_g_e_t_._t_s_tail.txt'), 'fuzzy')
    const project = { id: 'a', path, name: 'a' } as ProjectRecord
    const results = await searchProjectFiles([project], 'widget.ts', { activeProjectId: 'a', recentPaths: [{ projectId: 'a', path: 'w_i_d_g_e_t_._t_s_tail.txt' }] })
    expect(results[0]).toEqual({ projectId: 'a', path: 'widget.ts' })
  })
  describe('active source before generated, recovery and artifact copies', () => {
    const copies = ['artifacts/delivery-snapshot/src/shared', 'artifacts/fixer/release-candidate/src/shared', '.recovery-urgent-release-20260908/src/shared', '.conductor/backup/src/shared', 'recovered-files/src/shared', 'release/win-unpacked/src/shared']
    // The G4 reproduction: every copy of usage-accounting.ts ties with the real one, and "artifacts/" and ".recovery-…" sort before "src/".
    const fixture = (extraCopies = 0): ProjectRecord => {
      const root = mkdtempSync(join(tmpdir(), 'conductor-file-search-')); roots.push(root)
      const write = (path: string): void => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), path) }
      for (const directory of copies) { write(`${directory}/usage-accounting.ts`); write(`${directory}/usage.ts`) }
      for (let index = 0; index < extraCopies; index++) write(`artifacts/run-${String(index).padStart(3, '0')}/src/shared/usage-accounting.ts`)
      write('src/shared/usage-accounting.ts'); write('src/main/usage-limit.ts'); write('src/main/index.ts')
      write('artifacts/autopilot/local-recent.json'); write('.github/workflows/release.yml')
      return { id: 'p', path: root, name: 'p' } as ProjectRecord
    }
    it('classifies artifact, recovery, backup, snapshot and generated folders as copies, not source', () => {
      for (const directory of copies) expect(isCopyPath(`${directory}/usage.ts`), directory).toBe(true)
      for (const path of ['src/shared/usage-accounting.ts', 'src/main/local-models/recovery.test.ts', '.github/workflows/release.yml', '.gitignore', 'README.md']) expect(isCopyPath(path), path).toBe(false)
    })
    it('ranks active source ahead of every copy in the same match tier', async () => {
      const results = await searchProjectFiles([fixture()], 'usage', { showHidden: true })
      const firstCopy = results.findIndex((file) => isCopyPath(file.path))
      const source = results.findIndex((file) => file.path === 'src/shared/usage-accounting.ts')
      expect(source).toBeGreaterThanOrEqual(0)
      expect(source).toBeLessThan(firstCopy)
      expect(results.slice(0, firstCopy).every((file) => !isCopyPath(file.path))).toBe(true)
      expect(results.filter((file) => isCopyPath(file.path)).every((file) => file.copy === true)).toBe(true)
    })
    it('keeps a file asked for by exact path or name in the first 100 results even among hundreds of copies', async () => {
      const project = fixture(150)
      expect((await searchProjectFiles([project], 'src/shared/usage-accounting.ts', { showHidden: true }))[0]).toMatchObject({ path: 'src/shared/usage-accounting.ts' })
      expect((await searchProjectFiles([project], 'usage-accounting.ts', { showHidden: true }))[0]).toMatchObject({ path: 'src/shared/usage-accounting.ts' })
      expect((await searchProjectFiles([project], 'shared/usage-accounting.ts', { showHidden: true }))[0]).toMatchObject({ path: 'src/shared/usage-accounting.ts' })
      // A copy asked for by its own exact path is found too, and it outranks every looser match.
      expect((await searchProjectFiles([project], 'artifacts/run-149/src/shared/usage-accounting.ts', { showHidden: true }))[0]).toMatchObject({ path: 'artifacts/run-149/src/shared/usage-accounting.ts' })
    })
    it('lets a caller filter copies out without hiding a copy that was asked for by name', async () => {
      const project = fixture()
      const sourceOnly = await searchProjectFiles([project], 'usage', { showHidden: true, excludeCopies: true })
      expect(sourceOnly.map((file) => file.path)).toEqual(['src/main/usage-limit.ts', 'src/shared/usage-accounting.ts'])
      expect(await searchProjectFiles([project], 'local-recent.json', { showHidden: true, excludeCopies: true })).toEqual([{ projectId: 'p', path: 'artifacts/autopilot/local-recent.json', copy: true }])
      // Copies still rank above nothing: a query only a copy matches returns it by default.
      expect((await searchProjectFiles([project], 'local-rec', { showHidden: true }))[0]).toMatchObject({ path: 'artifacts/autopilot/local-recent.json', copy: true })
    })
  })
})
