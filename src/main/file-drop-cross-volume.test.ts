import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const faults = vi.hoisted(() => ({ forceCrossVolume: false, failStageWrite: false }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    link: async (source: string, target: string) => {
      if (faults.forceCrossVolume && !basename(source).startsWith('.conductor-move-')) {
        const error = new Error('cross-volume test boundary') as NodeJS.ErrnoException
        error.code = 'EXDEV'
        throw error
      }
      return await actual.link(source, target)
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      if (!faults.failStageWrite || !basename(String(args[0])).startsWith('.conductor-move-')) return handle
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'write') return async () => { throw new Error('simulated partial copy failure') }
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
    }
  }
})

import { moveExternalDropIntoProject } from './file-drop-move'

const roots: string[] = []
const root = (): string => { const path = mkdtempSync(join(tmpdir(), 'conductor-cross-volume-')); roots.push(path); return path }
afterEach(() => {
  faults.forceCrossVolume = false
  faults.failStageWrite = false
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})

const transactionFiles = (directory: string): string[] => readdirSync(directory).filter((name) => name.startsWith('.conductor-move-'))
const hash = (value: Buffer): string => createHash('sha256').update(value).digest('hex')

describe('cross-volume external file moves', () => {
  it('publishes a verified exact copy before removing its unchanged source', async () => {
    const base = root(), project = join(base, 'project'), outside = join(base, 'outside')
    mkdirSync(project); mkdirSync(outside)
    const source = join(outside, 'recording.mp4')
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 137)
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251
    writeFileSync(source, bytes)
    faults.forceCrossVolume = true

    const moved = await moveExternalDropIntoProject(project, source, '')

    expect(hash(readFileSync(moved.path))).toBe(hash(bytes))
    expect(existsSync(source)).toBe(false)
    expect(transactionFiles(project)).toEqual([])
  })

  it('retains source and existing destination when atomic publication collides', async () => {
    const base = root(), project = join(base, 'project'), outside = join(base, 'outside')
    mkdirSync(project); mkdirSync(outside)
    const source = join(outside, 'notes.md'), target = join(project, 'notes.md')
    writeFileSync(source, 'owner source'); writeFileSync(target, 'existing project file')
    faults.forceCrossVolume = true

    await expect(moveExternalDropIntoProject(project, source, '')).rejects.toThrow('already exists')

    expect(readFileSync(source, 'utf8')).toBe('owner source')
    expect(readFileSync(target, 'utf8')).toBe('existing project file')
    expect(transactionFiles(project)).toEqual([])
  })

  it('removes only its private stage after a partial copy failure', async () => {
    const base = root(), project = join(base, 'project'), outside = join(base, 'outside')
    mkdirSync(project); mkdirSync(outside)
    const source = join(outside, 'large.bin'), target = join(project, 'large.bin')
    writeFileSync(source, Buffer.alloc(2 * 1024 * 1024, 73))
    faults.forceCrossVolume = true
    faults.failStageWrite = true

    await expect(moveExternalDropIntoProject(project, source, '')).rejects.toThrow('simulated partial copy failure')

    const retained = readFileSync(source)
    expect(retained.length).toBe(2 * 1024 * 1024)
    expect(hash(retained)).toBe(hash(Buffer.alloc(2 * 1024 * 1024, 73)))
    expect(existsSync(target)).toBe(false)
    expect(transactionFiles(project)).toEqual([])
  })
})
