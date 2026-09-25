import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { hostRuntimeFor, quoteWindowsArgument } from './launcher'

describe('runtime host launch', () => {
  it('copies the runtime out of the install folder on Windows and runs a macOS bundle in place', () => {
    const windows = 'C:\\Program Files\\Conductor\\Conductor.exe'
    expect(hostRuntimeFor('win32', windows, () => true)).toEqual({ executable: windows, copy: true })
    const app = '/Applications/Conductor.app/Contents/MacOS/Conductor'
    const helper = '/Applications/Conductor.app/Contents/Frameworks/Conductor Helper.app/Contents/MacOS/Conductor Helper'
    const seen: string[] = []
    expect(hostRuntimeFor('darwin', app, path => { seen.push(path); return true })).toEqual({ executable: helper, copy: false })
    expect(seen).toEqual([helper])
    expect(hostRuntimeFor('darwin', app, () => false)).toEqual({ executable: app, copy: false })
  })

  it('quotes arguments the way Windows splits them back', () => {
    expect(quoteWindowsArgument('plain')).toBe('plain')
    expect(quoteWindowsArgument('C:\\with space\\')).toBe('"C:\\with space\\\\"')
    if (process.platform !== 'win32') return
    const args = ['C:\\Users\\o w\\AppData\\Roaming\\Conductor\\runtime-host\\host-1.js', '--user-data', 'C:\\Users\\o w\\AppData\\Roaming\\Conductor', 'plain', 'trailing space\\', 'say "hi"', '']
    // A real child process splits the verbatim command line back into the same arguments.
    const script = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))'
    const echoed = spawnSync(process.execPath, ['-e', script, ...args].map(quoteWindowsArgument), { encoding: 'utf8', windowsVerbatimArguments: true, windowsHide: true, argv0: quoteWindowsArgument(process.execPath) }).stdout
    expect(JSON.parse(echoed)).toEqual(args)
  })
})
