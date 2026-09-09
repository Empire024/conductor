import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROJECT_IDENTITY_PATH } from '../shared/project-identity'
import { forgetProjectIdentity, projectIdentity, projectSummary, readProjectIdentity } from './project-identity'

const roots: string[] = []
const project = (name = 'Conductor'): { id: string; name: string; path: string } => {
  const path = mkdtempSync(join(tmpdir(), 'conductor-identity-'))
  roots.push(path)
  return { id: 'project-' + roots.length, name, path }
}
const identityPath = (root: string): string => join(root, ...PROJECT_IDENTITY_PATH.split('/'))

afterEach(() => {
  forgetProjectIdentity()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * The identity has to belong to the folder rather than to this machine's database, because that is
 * the only thing two machines can compare. These cover the ways that could quietly stop being true.
 */
describe('the identity a working copy carries', () => {
  it('creates one on demand and reports the same key every time afterwards', () => {
    const folder = project()
    const first = readProjectIdentity(folder.path)
    expect(first.key).toMatch(/^[0-9a-f]{32}$/)
    expect(Date.parse(first.createdAt)).toBeLessThanOrEqual(Date.now())
    forgetProjectIdentity()
    expect(readProjectIdentity(folder.path)).toEqual(first)
    expect(JSON.parse(readFileSync(identityPath(folder.path), 'utf8'))).toEqual({ key: first.key, createdAt: first.createdAt })
  })

  it('never regenerates a key that already exists, even one written by an older or newer build', () => {
    const folder = project()
    mkdirSync(join(folder.path, '.conductor'), { recursive: true })
    writeFileSync(identityPath(folder.path), JSON.stringify({ key: 'f'.repeat(32), createdAt: '2025-05-05T00:00:00.000Z', extra: 'ignored' }))
    expect(readProjectIdentity(folder.path)).toEqual({ key: 'f'.repeat(32), createdAt: '2025-05-05T00:00:00.000Z' })
    expect(JSON.parse(readFileSync(identityPath(folder.path), 'utf8')).extra).toBe('ignored')
  })

  it('gives two separate working copies two separate identities', () => {
    expect(readProjectIdentity(project().path).key).not.toBe(readProjectIdentity(project().path).key)
  })

  it('keeps the identity out of git, so a clone mints its own instead of inheriting one', () => {
    const folder = project()
    readProjectIdentity(folder.path)
    expect(readFileSync(join(folder.path, '.conductor', '.gitignore'), 'utf8')).toContain('/project.json')
  })

  it('leaves an existing ignore file in place and only adds what is missing', () => {
    const folder = project()
    mkdirSync(join(folder.path, '.conductor'), { recursive: true })
    writeFileSync(join(folder.path, '.conductor', '.gitignore'), 'notes.txt\n')
    readProjectIdentity(folder.path)
    const ignore = readFileSync(join(folder.path, '.conductor', '.gitignore'), 'utf8')
    expect(ignore).toContain('notes.txt')
    expect(ignore).toContain('/project.json')
  })

  it('refuses a corrupt identity file rather than silently minting a new identity', () => {
    const folder = project()
    mkdirSync(join(folder.path, '.conductor'), { recursive: true })
    writeFileSync(identityPath(folder.path), '{ this is not json')
    expect(() => readProjectIdentity(folder.path)).toThrow(/is not readable JSON/)
    // The refusal must not have replaced the file the owner still has to look at.
    expect(readFileSync(identityPath(folder.path), 'utf8')).toBe('{ this is not json')
  })

  it('reports the project with its identity, and reports a broken one instead of hiding it', () => {
    const good = project('Conductor')
    const summary = projectSummary(good)
    expect(summary).toMatchObject({ id: good.id, name: 'Conductor', identityError: null })
    expect(summary.identity).toEqual(projectIdentity(good))
    expect(summary.identity?.path).toBe(summary.path)

    const broken = project('Renders')
    mkdirSync(join(broken.path, '.conductor'), { recursive: true })
    writeFileSync(identityPath(broken.path), '{}')
    const failed = projectSummary(broken)
    expect(failed.identity).toBeNull()
    expect(failed.identityError).toMatch(/usable project key/)
  })

  it('reports a project whose folder is gone without throwing at the caller', () => {
    const folder = project()
    rmSync(folder.path, { recursive: true, force: true })
    const summary = projectSummary(folder)
    expect(summary.identity).toBeNull()
    expect(summary.identityError).toBeTruthy()
  })
})
