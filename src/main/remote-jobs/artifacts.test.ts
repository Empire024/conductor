import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildFetchCommand, checkArtifactPatterns, FETCH_SCRIPT, parseFetchMarks, safeEntryPath, TarExtractor } from './artifacts.ts'
import { shellWords, tarGz } from './test-fakes.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'remote-artifacts-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const unpack = (archive: Buffer, cap = 1 << 20, chunk = 0): TarExtractor => {
  const extractor = new TarExtractor(join(dir, 'out'), cap)
  const raw = gunzipSync(archive)
  if (!chunk) extractor.push(raw)
  else for (let at = 0; at < raw.length; at += chunk) extractor.push(raw.subarray(at, at + chunk))
  extractor.finish()
  return extractor
}

describe('artifact fetch', () => {
  it('the node script confines matches to the working directory and never follows links', () => {
    expect(FETCH_SCRIPT).toContain('base=$(pwd -P)')
    expect(FETCH_SCRIPT).toContain('if [ -L "$m" ]; then found=1; mark "skipped $m"')
    expect(FETCH_SCRIPT).toContain('case "$real/" in "$base/"*) ;; *) mark "skipped $m"')
    expect(FETCH_SCRIPT).toContain('COPYFILE_DISABLE=1 tar -czf - "${files[@]}"')
    expect(FETCH_SCRIPT).toContain('m=${m%/}')
    expect(FETCH_SCRIPT).not.toContain('$\\{')
    const words = shellWords(buildFetchCommand({ cwd: 'conductor-node/work/haf', capBytes: 100, nonce: 'n', patterns: ['test-results/*.png', 'my report'] }))
    expect(words.slice(3)).toEqual(['conductor-fetch', 'conductor-node/work/haf', '100', 'n', 'test-results/*.png', 'my report'])
  })

  it('patterns: relative, no .., no drive letters or backslashes, at most 20, duplicates folded', () => {
    expect(checkArtifactPatterns(['playwright-report/', 'playwright-report', 'test-results/**'])).toEqual(['playwright-report', 'test-results/**'])
    for (const bad of [['/x'], ['~/x'], ['a/../b'], ['..'], ['D:/x'], ['a\\b'], ['a\nb'], [], Array.from({ length: 21 }, (_, i) => `f${i}`)]) {
      expect(() => checkArtifactPatterns(bad)).toThrow()
    }
  })

  it('entry names are normalized or refused', () => {
    expect(safeEntryPath('./a/./b.txt')).toBe('a/b.txt')
    for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:/x', 'a\\b', 'a:b', '.', '']) expect(safeEntryPath(bad)).toBeNull()
  })

  it('unpacks files and folders in any chunking and leaves links and escapes out', () => {
    const archive = tarGz([
      { name: './r', type: '5' },
      { name: './r/a.txt', content: 'alpha' },
      { name: './r/empty.txt', content: '' },
      { name: `./r/${'x'.repeat(150)}.txt`, content: 'long' },
      { name: './r/link', type: '2', linkname: '../../../../etc/passwd' },
      { name: './r/hard', type: '1', linkname: './r/a.txt' },
      { name: '../../evil', content: 'evil' }
    ])
    const extractor = unpack(archive, 1 << 20, 7)
    expect(extractor.error).toBeNull()
    expect(extractor.files).toBe(3)
    expect(extractor.bytes).toBe(9)
    expect(extractor.skipped).toEqual(['./r/link (symbolic link)', './r/hard (hard link)', '../../evil (unsafe name)'])
    expect(readFileSync(join(dir, 'out', 'r', 'a.txt'), 'utf8')).toBe('alpha')
    expect(readFileSync(join(dir, 'out', 'r', `${'x'.repeat(150)}.txt`), 'utf8')).toBe('long')
    expect(readdirSync(join(dir, 'out', 'r')).sort()).toEqual(['a.txt', 'empty.txt', `${'x'.repeat(150)}.txt`].sort())
    expect(existsSync(join(dir, 'evil'))).toBe(false)
  })

  it('stops at the cap and reports a truncated archive', () => {
    expect(unpack(tarGz([{ name: 'big', content: Buffer.alloc(3000) }]), 1000).error).toMatch(/larger than 1000/)
    const truncated = new TarExtractor(join(dir, 't'), 1 << 20)
    truncated.push(gunzipSync(tarGz([{ name: 'f', content: Buffer.alloc(2000, 1) }])).subarray(0, 1024))
    truncated.finish()
    expect(truncated.error).toMatch(/ended early/)
  })

  it('reads the node\'s marks and keeps other stderr for the error', () => {
    const stderr = '@@conductor-job:n missing coverage\n@@conductor-job:n skipped a b\ntar: something\n@@conductor-job:n too-large bytes=12\n@@conductor-job:other none\n'
    expect(parseFetchMarks(stderr, 'n')).toEqual({
      marks: [{ kind: 'missing', pattern: 'coverage' }, { kind: 'skipped', path: 'a b' }, { kind: 'too-large', bytes: 12 }],
      other: 'tar: something\n@@conductor-job:other none'
    })
  })
})
