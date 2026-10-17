import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { aclRepairNotice, protectedEntries, repairSandboxReadAccess, runIcacls, type IcaclsResult } from './codex-sandbox-acl'

// feature-list conductor-task:codex-deps-exec-deny (miron, 2026-10-17): pip --target .deps on
// Python 3.13 moves packages in from a tempfile.mkdtemp() folder with a protected owner-only DACL,
// and Codex's Windows sandbox could not list .deps/PIL nor import PIL.Image.

const roots: string[] = []
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })) })
const temp = (): string => { const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'conductor-acl-'))); roots.push(root); return root }
const windows = process.platform === 'win32'

// Verbatim shape of `icacls C:\Claude\miron\.deps\*` on 2026-10-17 (fitz, PIL protected), plus a
// name with a space and a name that prefixes another.
const ROOT = 'C:\\Claude\\miron\\.deps'
const LISTING = [
  'C:\\Claude\\miron\\.deps\\fitz NT AUTHORITY\\SYSTEM:(OI)(CI)(F)',
  '                           BUILTIN\\Administrators:(OI)(CI)(F)',
  '                           OWNER RIGHTS:(OI)(CI)(F)',
  '',
  'C:\\Claude\\miron\\.deps\\PIL NT AUTHORITY\\SYSTEM:(OI)(CI)(F)',
  '                          BUILTIN\\Administrators:(OI)(CI)(F)',
  '                          OWNER RIGHTS:(OI)(CI)(F)',
  '',
  'C:\\Claude\\miron\\.deps\\PIL extra E-Box\\CodexSandboxUsers:(I)(OI)(CI)(M)',
  '                                BUILTIN\\Users:(I)(OI)(CI)(RX)',
  '',
  'C:\\Claude\\miron\\.deps\\requests S-1-5-21-1661135652-2263332316-643334861-2170435950:(OI)(CI)(M)',
  '                               E-Box\\CodexSandboxUsers:(I)(OI)(CI)(M)',
  '',
  'Successfully processed 4 files; Failed processing 0 files'
].join('\r\n')

describe('protectedEntries', () => {
  it('finds the entries whose permission list inherits nothing, by name', () => {
    expect(protectedEntries(LISTING, ROOT, ['fitz', 'PIL', 'PIL extra', 'requests'])).toEqual(['fitz', 'PIL'])
    // Case and a trailing separator on the root do not matter; an unlisted name is not protected.
    expect(protectedEntries(LISTING, 'c:\\claude\\MIRON\\.deps\\', ['pil', 'PIL extra', 'absent'])).toEqual(['pil'])
    expect(protectedEntries('', ROOT, ['PIL'])).toEqual([])
  })
})

describe('repairSandboxReadAccess', () => {
  const fake = (listing: string, fail: string[] = []) => {
    const calls: string[][] = []
    const run = async (args: string[]): Promise<IcaclsResult> => {
      calls.push(args)
      if (args.length === 1) return { code: 0, stdout: listing, stderr: '' }
      return fail.some(name => args[0]!.endsWith(name)) ? { code: 5, stdout: '', stderr: `${args[0]}: Access is denied.` } : { code: 0, stdout: 'Successfully processed 1 files', stderr: '' }
    }
    return { run, calls }
  }
  const project = (): { root: string; listing: string } => {
    const root = join(temp(), '.deps')
    for (const name of ['PIL', 'fitz', 'requests']) mkdirSync(join(root, name), { recursive: true })
    const listing = ['PIL', 'fitz', 'requests'].map(name => `${join(root, name)} ${name === 'requests' ? 'BUILTIN\\Users:(I)(OI)(CI)(RX)' : 'OWNER RIGHTS:(OI)(CI)(F)'}\n`).join('\n')
    return { root, listing }
  }

  it('turns inheritance back on for the protected entries only, one icacls call each', async () => {
    const { root, listing } = project()
    const { run, calls } = fake(listing)
    const result = await repairSandboxReadAccess(root, run)
    expect(result).toEqual({ repaired: [join(root, 'fitz'), join(root, 'PIL')], problems: [] })
    expect(calls).toEqual([[join(root, '*')], [join(root, 'fitz'), '/inheritance:e', '/C', '/Q'], [join(root, 'PIL'), '/inheritance:e', '/C', '/Q']])
    expect(aclRepairNotice(root, result.repaired)).toMatch(/^fitz, PIL in .+\.deps had an owner-only permission list .+ Conductor turned inheritance from .+ back on$/)
  })

  it('names the one owner command when an entry cannot be repaired or the list cannot be read', async () => {
    const { root, listing } = project()
    const failed = await repairSandboxReadAccess(root, fake(listing, ['fitz']).run)
    expect(failed.repaired).toEqual([join(root, 'PIL')])
    expect(failed.problems).toEqual([expect.stringContaining(`fitz (${join(root, 'fitz')}: Access is denied.) in ${root} keep an owner-only permission list`)])
    expect(failed.problems[0]).toContain(`run once: icacls "${join(root, '*')}" /inheritance:e /C`)
    const unreadable = await repairSandboxReadAccess(root, async () => ({ code: 1, stdout: '', stderr: 'icacls.exe not found' }))
    expect(unreadable).toEqual({ repaired: [], problems: [expect.stringContaining('could not be read (icacls.exe not found)')] })
  })

  it('never touches a link, a missing folder or an empty one', async () => {
    const { root, listing } = project()
    const target = temp()
    let link = true
    try { symlinkSync(target, join(root, 'linked'), 'junction') } catch { link = false }
    const { run, calls } = fake(`${listing}\n${join(root, 'linked')} OWNER RIGHTS:(OI)(CI)(F)\n`)
    await repairSandboxReadAccess(root, run)
    if (link) expect(calls.flat()).not.toContain(join(root, 'linked'))
    expect(await repairSandboxReadAccess(join(root, 'missing'), run)).toEqual({ repaired: [], problems: [] })
    mkdirSync(join(root, 'empty'))
    const none = fake('')
    expect(await repairSandboxReadAccess(join(root, 'empty'), none.run)).toEqual({ repaired: [], problems: [] })
    expect(none.calls).toEqual([])
    const outerLink = join(temp(), '.deps')
    try { symlinkSync(root, outerLink, 'junction') } catch { return }
    const outer = fake(listing)
    expect(await repairSandboxReadAccess(outerLink, outer.run)).toEqual({ repaired: [], problems: [] })
    expect(outer.calls).toEqual([])
  })

  it.runIf(windows)('repairs a real owner-only folder the way Python 3.13 mkdtemp leaves it, files inside included', async () => {
    const root = join(temp(), '.deps')
    mkdirSync(join(root, 'PIL'), { recursive: true })
    mkdirSync(join(root, 'requests'))
    writeFileSync(join(root, 'PIL', 'Image.py'), '')
    // tempfile.mkdtemp() on 3.13: D:P(A;OICI;FA;;;OW)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)
    execFileSync('icacls.exe', [join(root, 'PIL'), '/inheritance:r', '/grant:r', '*S-1-3-4:(OI)(CI)F', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '/Q'], { windowsHide: true })
    const before = await runIcacls([join(root, '*')])
    expect(protectedEntries(before.stdout, root, ['PIL', 'requests'])).toEqual(['PIL'])
    const aces = async (path: string): Promise<number> => (await runIcacls([path])).stdout.split(/\r?\n/).filter(line => line.includes(':(')).length
    const fileBefore = await aces(join(root, 'PIL', 'Image.py'))
    expect(await repairSandboxReadAccess(root)).toEqual({ repaired: [join(root, 'PIL')], problems: [] })
    // The file inside now carries the parent's ACEs too, as every other project file does.
    expect(await aces(join(root, 'PIL', 'Image.py'))).toBeGreaterThan(fileBefore)
    expect(protectedEntries((await runIcacls([join(root, '*')])).stdout, root, ['PIL', 'requests'])).toEqual([])
  })
})
