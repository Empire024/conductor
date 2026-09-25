import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { quoteWindowsArgument } from './launcher'

describe('runtime host launch', () => {
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
