import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'

const attack = vi.hoisted(() => ({ path: '', run: undefined as (() => Promise<void>) | undefined }))
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, lstat: async (...args: Parameters<typeof fs.lstat>) => {
    if (String(args[0]) === attack.path && attack.run) {
      const run = attack.run; attack.run = undefined; await run()
    }
    return fs.lstat(...args)
  } }
})
import { moveExternalDropIntoProject } from './file-drop-move'

const roots: string[] = []
afterEach(async () => {
  attack.path = ''; attack.run = undefined
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it('does not delete another writer\'s replacement when rolling back a dropped-file move', async () => {
  const root = await mkdtemp(join(tmpdir(), 'conductor-drop-boundary-')); roots.push(root)
  const project = join(root, 'project'), folder = join(project, 'folder'), source = join(root, 'source.md')
  await mkdir(folder, { recursive: true }); await writeFile(source, 'original source')
  const target = join(folder, 'source.md')
  attack.path = target
  attack.run = async () => { await rename(target, join(folder, 'moved-link.md')); await writeFile(target, 'another writer owns this') }
  await expect(moveExternalDropIntoProject(project, source, 'folder')).rejects.toThrow(/changed/)
  expect(await readFile(source, 'utf8')).toBe('original source')
  expect(await readFile(target, 'utf8')).toBe('another writer owns this')
})
