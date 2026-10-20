import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { contentDispositionName, cropRect, planFrameTimes, projectTarget, safeFileName, uniquePath } from './browser-media'

describe('browser download targets stay inside the project', () => {
  let base: string, root: string
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'conductor-browser-media-'))
    root = join(base, 'project')
    mkdirSync(root)
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  it('defaults to refs/<name> and accepts project-relative files and folders', () => {
    expect(projectTarget(root, undefined, 'clip.mp4', 'refs')).toEqual({ absolute: join(root, 'refs', 'clip.mp4'), relative: 'refs/clip.mp4' })
    expect(projectTarget(root, 'media/reel.mp4', 'clip.mp4', 'refs').relative).toBe('media/reel.mp4')
    expect(projectTarget(root, 'media/', 'clip.mp4', 'refs').relative).toBe('media/clip.mp4')
    mkdirSync(join(root, 'existing'))
    expect(projectTarget(root, 'existing', 'clip.mp4', 'refs').relative).toBe('existing/clip.mp4')
    expect(projectTarget(root, join(root, 'abs', 'x.mp4'), 'clip.mp4', 'refs').relative).toBe('abs/x.mp4')
    expect(projectTarget(root, '.', 'clip.mp4', 'refs').relative).toBe('clip.mp4')
  })

  it('refuses traversal, absolute paths elsewhere, drives and alternate data streams', () => {
    for (const path of ['../outside.mp4', 'refs/../../outside.mp4', '..\\outside.mp4', join(base, 'outside.mp4'), 'refs/clip.mp4:hidden', 'C:evil.mp4']) {
      expect(() => projectTarget(root, path, 'clip.mp4', 'refs'), path).toThrow(/outside the project|alternate data stream/)
    }
  })

  it('refuses protected folders and names', () => {
    for (const path of ['.git/hooks/pre-commit', '.claude/settings.json', '.github/workflows/x.yml', 'node_modules/a/index.js', 'AGENTS.md', 'sub/.env.local', 'keys/server.pem', '.conductor/x.mp4']) {
      expect(() => projectTarget(root, path, 'clip.mp4', 'refs'), path).toThrow(/protected location/)
    }
  })

  it('never replaces a file: an explicit path that exists is refused, a default name is numbered', () => {
    mkdirSync(join(root, 'refs'))
    writeFileSync(join(root, 'refs', 'clip.mp4'), 'x')
    expect(() => projectTarget(root, 'refs/clip.mp4', 'clip.mp4', 'refs')).toThrow(/already exists/)
    expect(projectTarget(root, undefined, 'clip.mp4', 'refs').relative).toBe('refs/clip-1.mp4')
    expect(projectTarget(root, 'refs/', 'clip.mp4', 'refs').relative).toBe('refs/clip-1.mp4')
    writeFileSync(join(root, 'refs', 'clip-1.mp4'), 'x')
    expect(uniquePath(join(root, 'refs', 'clip.mp4'))).toBe(join(root, 'refs', 'clip-2.mp4'))
  })

  it('refuses a link inside the project that leads outside it', () => {
    const outside = join(base, 'elsewhere')
    mkdirSync(outside)
    symlinkSync(outside, join(root, 'linked'), 'junction')
    expect(() => projectTarget(root, 'linked/clip.mp4', 'clip.mp4', 'refs')).toThrow(/outside the project through a link/)
    expect(() => projectTarget(root, 'linked/new/deeper/clip.mp4', 'clip.mp4', 'refs')).toThrow(/through a link/)
  })

  it('refuses a project with no local folder', () => {
    expect(() => projectTarget('', undefined, 'clip.mp4', 'refs')).toThrow(/no folder on this machine/)
    expect(() => projectTarget('relative/root', undefined, 'clip.mp4', 'refs')).toThrow(/no folder on this machine/)
  })
})

describe('browser download file names', () => {
  it('makes one safe name with an extension from the content type', () => {
    expect(safeFileName('/media/v/reel%20one.mp4')).toBe('reel one.mp4')
    expect(safeFileName('/watch', 'video/mp4; codecs=avc1')).toBe('watch.mp4')
    expect(safeFileName('', 'image/png', 'video')).toBe('video.png')
    expect(safeFileName('..\\..\\evil.bat')).toBe('evil.bat')
    expect(safeFileName('a<b>c:d"e|f?g*.txt')).toBe('a_b_c_d_e_f_g_.txt')
    expect(safeFileName('CON.mp4')).toBe('_CON.mp4')
    expect(safeFileName('...')).toBe('download')
    const long = safeFileName('x'.repeat(400) + '.webm')
    expect(long.length).toBe(120)
    expect(long.endsWith('.webm')).toBe(true)
  })

  it('reads RFC 6266 names, filename* first', () => {
    expect(contentDispositionName('attachment; filename="clip.mp4"')).toBe('clip.mp4')
    expect(contentDispositionName("attachment; filename=plain.mp4; filename*=UTF-8''r%C3%A9el.mp4")).toBe('réel.mp4')
    expect(contentDispositionName('attachment; filename=bare.webm')).toBe('bare.webm')
    expect(contentDispositionName('inline')).toBeUndefined()
    expect(contentDispositionName(undefined)).toBeUndefined()
  })
})

describe('video frame planning', () => {
  it('visits start..end at fps and caps the count at maxFrames, saying where to continue', () => {
    expect(planFrameTimes({ start: 0, end: 2, fps: 1, maxFrames: 20 })).toEqual({ times: [0, 1, 2] })
    expect(planFrameTimes({ start: 1, end: 2, fps: 4, maxFrames: 20 }).times).toEqual([1, 1.25, 1.5, 1.75, 2])
    const capped = planFrameTimes({ start: 0, end: 600, fps: 30, maxFrames: 300 })
    expect(capped.times).toHaveLength(300)
    expect(capped.times.at(-1)).toBe(9.967)
    expect(capped.truncated).toMatch(/maxFrames 300 reached .*continue with start=10/)
    expect(planFrameTimes({ start: 3, end: 3, fps: 1, maxFrames: 5 })).toEqual({ times: [3] })
  })

  it('crops a page rectangle out of the viewport image at its pixel ratio, clipped to the viewport', () => {
    expect(cropRect({ x: 10, y: 20, width: 100, height: 50 }, { width: 1000, height: 500 }, { width: 2000, height: 1000 })).toEqual({ x: 20, y: 40, width: 200, height: 100 })
    expect(cropRect({ x: -50, y: 400, width: 200, height: 300 }, { width: 1000, height: 500 }, { width: 1000, height: 500 })).toEqual({ x: 0, y: 400, width: 150, height: 100 })
    expect(cropRect({ x: 0, y: 900, width: 100, height: 100 }, { width: 1000, height: 500 }, { width: 1000, height: 500 })).toBeUndefined()
    expect(cropRect({ x: 0, y: 0, width: 10, height: 10 }, { width: 0, height: 0 }, { width: 10, height: 10 })).toBeUndefined()
  })
})
