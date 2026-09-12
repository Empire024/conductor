import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { moveExternalDropIntoProject, moveProjectDropWithinProject } from './file-drop-move'

const roots: string[] = []
const root = (): string => { const path = mkdtempSync(join(tmpdir(), 'conductor-drop-move-')); roots.push(path); return path }
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })

describe('external explorer file drop move', () => {
  it('moves exact bytes once into an existing project folder', async () => {
    const base = root(), project = join(base, 'project'), outside = join(base, 'outside')
    mkdirSync(join(project, 'media'), { recursive: true }); mkdirSync(outside)
    const source = join(outside, 'clip.mp4'), bytes = Buffer.from([0, 255, 17, 32, 99])
    writeFileSync(source, bytes)
    const moved = await moveExternalDropIntoProject(project, source, 'media')
    expect(moved).toEqual({ path: join(project, 'media', 'clip.mp4'), name: 'clip.mp4' })
    expect(readFileSync(moved.path)).toEqual(bytes)
    expect(() => readFileSync(source)).toThrow()
  })

  it('never overwrites a collision and retains both originals', async () => {
    const base = root(), project = join(base, 'project'), outside = join(base, 'outside')
    mkdirSync(project); mkdirSync(outside)
    const source = join(outside, 'notes.md'), target = join(project, 'notes.md')
    writeFileSync(source, 'outside'); writeFileSync(target, 'project')
    await expect(moveExternalDropIntoProject(project, source, '')).rejects.toThrow('already exists')
    expect(readFileSync(source, 'utf8')).toBe('outside')
    expect(readFileSync(target, 'utf8')).toBe('project')
  })

  it('rejects source and destination symlink ambiguity without moving bytes', async () => {
    const base = root(), project = join(base, 'project'), outside = join(base, 'outside'), escape = join(base, 'escape')
    mkdirSync(project); mkdirSync(outside); mkdirSync(escape)
    const realSource = join(outside, 'real.txt'), linkedOutside = join(base, 'linked-outside')
    writeFileSync(realSource, 'safe')
    symlinkSync(outside, linkedOutside, 'junction')
    await expect(moveExternalDropIntoProject(project, join(linkedOutside, 'real.txt'), '')).rejects.toThrow('Symbolic-link')
    symlinkSync(escape, join(project, 'linked-folder'), 'junction')
    await expect(moveExternalDropIntoProject(project, realSource, 'linked-folder')).rejects.toThrow('existing project folder')
    expect(readFileSync(realSource, 'utf8')).toBe('safe')
  })

  it('refuses an in-project or non-file source as the wrong drop intent', async () => {
    const base = root(), project = join(base, 'project'), outsideDirectory = join(base, 'outside-folder')
    mkdirSync(project); mkdirSync(outsideDirectory)
    const inside = join(project, 'inside.txt'); writeFileSync(inside, 'inside')
    await expect(moveExternalDropIntoProject(project, inside, '')).rejects.toThrow('project file drag action')
    await expect(moveExternalDropIntoProject(project, outsideDirectory, '')).rejects.toThrow('regular files')
  })
})

describe('internal explorer file drop move', () => {
  it('moves a regular project file without an overwrite window', async () => {
    const project = root(), source = join(project, 'draft.md'), folder = join(project, 'notes')
    mkdirSync(folder); writeFileSync(source, 'exact draft')
    const moved = await moveProjectDropWithinProject(project, 'draft.md', 'notes')
    expect(moved).toEqual({ path: join(folder, 'draft.md'), name: 'draft.md' })
    expect(readFileSync(moved.path, 'utf8')).toBe('exact draft')
    expect(() => readFileSync(source)).toThrow()
  })

  it('retains both files on collision and rejects redirected routes', async () => {
    const base = root(), project = join(base, 'project'), outside = join(base, 'outside')
    mkdirSync(join(project, 'notes'), { recursive: true }); mkdirSync(outside)
    writeFileSync(join(project, 'draft.md'), 'source')
    writeFileSync(join(project, 'notes', 'draft.md'), 'existing')
    await expect(moveProjectDropWithinProject(project, 'draft.md', 'notes')).rejects.toThrow('already exists')
    expect(readFileSync(join(project, 'draft.md'), 'utf8')).toBe('source')
    expect(readFileSync(join(project, 'notes', 'draft.md'), 'utf8')).toBe('existing')
    symlinkSync(outside, join(project, 'redirect'), 'junction')
    await expect(moveProjectDropWithinProject(project, 'draft.md', 'redirect')).rejects.toThrow(/Symbolic-link|inside the project/)
    expect(readFileSync(join(project, 'draft.md'), 'utf8')).toBe('source')
  })
})
