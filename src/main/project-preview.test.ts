import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectPreviewServer } from './project-preview'
import type { ProjectRecord } from '../shared/models'
describe('project browser preview', () => {
  it('serves file and relative assets through a loopback capability URL and rejects escapes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'conductor-file-preview-')), server = new ProjectPreviewServer()
    try {
      const projectPath = join(root, 'project'); mkdirSync(projectPath)
      writeFileSync(join(projectPath, 'index.html'), '<link rel="stylesheet" href="style.css">hello')
      writeFileSync(join(projectPath, 'style.css'), 'body { color: red }')
      const outside = join(root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'private.txt'), 'outside')
      symlinkSync(outside, join(projectPath, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
      const project = { id: 'project', path: projectPath } as ProjectRecord
      const url = await server.url(project, 'index.html')
      expect(new URL(url).hostname).toBe('127.0.0.1')
      expect(await (await fetch(url)).text()).toContain('hello')
      expect(await (await fetch(new URL('style.css', url))).text()).toContain('color: red')
      expect((await fetch(new URL('linked/private.txt', url))).status).toBe(404)
      expect((await fetch(new URL('./', url))).status).toBe(404)
      expect((await fetch(new URL('/wrong/index.html', url))).status).toBe(404)
      await expect(server.url(project, '../outside/private.txt')).rejects.toThrow('outside')
      await expect(server.url(project, 'linked/private.txt')).rejects.toThrow('outside')
    } finally { server.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5 }) }
  })
})
