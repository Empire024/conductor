import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalRootError, childEnvironment, detectDrives, driveOf, layoutFor, localRoot, onSystemDrive, pointerPaths, sessionWorkspace, systemDrive } from './paths.ts'
import { modelFilePath, defaultModelConfig, QWEN_9B } from './config.ts'
import { migrateModelFile, moveFile, sha256File } from './provenance.ts'

// `paths.ts` imports `homedir` by name, so it has to be mocked at the module rather than by
// stubbing `os.homedir` on the real module (which callers would not observe). Every other test
// in this file gets the real implementation through this passthrough.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: vi.fn(actual.homedir) }
})

/** A scratch root on a real fixed non-system drive, or null when this machine has none — the
 *  relocation tests then skip rather than pretending the system drive is acceptable. */
function scratchRoot(): string | null {
  const drive = detectDrives().find(candidate => candidate.letter !== systemDrive() && candidate.freeBytes > 2 * 1024 ** 3)
  if (!drive) return null
  const root = join(drive.letter + '\\', `ConductorLocalTest-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(root, { recursive: true })
  return root
}

describe('local data root', () => {
  const previous = process.env.CONDUCTOR_LOCAL_ROOT
  const cleanup: Array<() => void> = []
  afterEach(() => {
    if (previous === undefined) delete process.env.CONDUCTOR_LOCAL_ROOT
    else process.env.CONDUCTOR_LOCAL_ROOT = previous
    for (const dispose of cleanup.splice(0)) dispose()
  })

  it('names every directory under one root', () => {
    const paths = layoutFor('D:\\ConductorLocal')
    expect(paths.models).toBe('D:\\ConductorLocal\\models')
    expect(Object.values(paths).every(value => value.startsWith('D:\\ConductorLocal'))).toBe(true)
  })

  it('refuses a root on the system drive instead of falling back to it', () => {
    process.env.CONDUCTOR_LOCAL_ROOT = join(systemDrive() + '\\', 'ConductorLocal')
    expect(() => localRoot()).toThrow(LocalRootError)
    expect(onSystemDrive(join(systemDrive() + '\\', 'anything'))).toBe(true)
    expect(driveOf('D:\\ConductorLocal\\models')).toBe('D:')
  })

  it('fails closed when nothing is configured', () => {
    // Deterministic regardless of the machine this runs on: a real checkout pointer or a real
    // user-profile pointer (from having run setup here before) would otherwise make this test
    // silently assert nothing, exactly the failure commit 8b81a98 widened the old guard to avoid
    // without ever actually forcing the "nothing configured" case to occur.
    const fakeHome = mkdtempSync(join(tmpdir(), 'conductor-fakehome-'))
    const fakeCwd = mkdtempSync(join(tmpdir(), 'conductor-fakecwd-'))
    cleanup.push(() => { rmSync(fakeHome, { recursive: true, force: true }); rmSync(fakeCwd, { recursive: true, force: true }) })
    vi.mocked(os.homedir).mockReturnValue(fakeHome)
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(fakeCwd)
    cleanup.push(() => { cwdSpy.mockRestore(); vi.mocked(os.homedir).mockRestore() })
    process.env.CONDUCTOR_LOCAL_ROOT = ' '
    // Confirms the fixture actually produced the "nothing configured" case instead of merely
    // hoping it did.
    expect(pointerPaths().some(existsSync)).toBe(false)
    expect(() => localRoot()).toThrow(LocalRootError)
  })

  it('keeps caches, temp and workspaces on the root', () => {
    const root = scratchRoot()
    if (!root) return
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    process.env.CONDUCTOR_LOCAL_ROOT = root
    const environment = childEnvironment({})
    for (const key of ['TMP', 'TEMP', 'TMPDIR', 'XDG_CACHE_HOME', 'HF_HOME', 'HF_HUB_CACHE', 'LLAMA_CACHE']) expect(environment[key], key).toContain(root)
    const workspace = sessionWorkspace('session_abc')
    expect(workspace).toBe(join(root, 'workspaces', 'session_abc'))
    // A traversal attempt never resolves to a parent: it is sanitized and then rejected.
    expect(() => sessionWorkspace('../escape')).toThrow(LocalRootError)
  })
})

describe('model relocation', () => {
  const previous = process.env.CONDUCTOR_LOCAL_ROOT
  const cleanup: Array<() => void> = []
  afterEach(() => {
    if (previous === undefined) delete process.env.CONDUCTOR_LOCAL_ROOT
    else process.env.CONDUCTOR_LOCAL_ROOT = previous
    for (const dispose of cleanup.splice(0)) dispose()
  })

  it('moves across volumes and preserves the bytes', async () => {
    const source = mkdtempSync(join(tmpdir(), 'conductor-move-'))
    const root = scratchRoot()
    cleanup.push(() => rmSync(source, { recursive: true, force: true }))
    if (!root) return
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const from = join(source, 'payload.bin')
    writeFileSync(from, 'conductor-local-model-bytes', 'utf8')
    const digest = await sha256File(from)
    const to = join(root, 'moved', 'payload.bin')
    moveFile(from, to)
    expect(existsSync(from)).toBe(false)
    expect(await sha256File(to)).toBe(digest)
  })

  it('migrates a model file off the old location and verifies it in place', async () => {
    const root = scratchRoot()
    if (!root) return
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    process.env.CONDUCTOR_LOCAL_ROOT = root
    const legacyDir = mkdtempSync(join(tmpdir(), 'conductor-legacy-'))
    cleanup.push(() => rmSync(legacyDir, { recursive: true, force: true }))
    const payload = 'pretend-gguf'
    const model = { ...defaultModelConfig(QWEN_9B), sizeBytes: Buffer.byteLength(payload), sha256: '' }
    const legacy = join(legacyDir, model.file)
    writeFileSync(legacy, payload, 'utf8')
    const result = await migrateModelFile(model, legacy)
    expect(result.to).toBe(modelFilePath(model))
    expect(result.to.startsWith(root)).toBe(true)
    expect(existsSync(legacy)).toBe(false)
    expect(result.sha256).toBe(await sha256File(result.to))
  })

  it('refuses to migrate a file whose size does not match the pinned model', async () => {
    const root = scratchRoot()
    if (!root) return
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    process.env.CONDUCTOR_LOCAL_ROOT = root
    const legacyDir = mkdtempSync(join(tmpdir(), 'conductor-legacy-'))
    cleanup.push(() => rmSync(legacyDir, { recursive: true, force: true }))
    const model = defaultModelConfig(QWEN_9B)
    const legacy = join(legacyDir, model.file)
    writeFileSync(legacy, 'truncated', 'utf8')
    await expect(migrateModelFile(model, legacy)).rejects.toThrow(/does not match/)
    expect(existsSync(legacy)).toBe(true)
  })
})
