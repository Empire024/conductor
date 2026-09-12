import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

const windows = process.platform === 'win32'
const nativeType = `Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class ProbeErrorMode { [DllImport("kernel32.dll")] public static extern uint GetErrorMode(); [DllImport("kernel32.dll")] public static extern uint SetErrorMode(uint mode); [DllImport("ntdll.dll")] public static extern int NtQueryInformationProcess(System.IntPtr process, int kind, out uint mode, uint size, out uint returned); public static uint ForProcess(int id) { uint mode, returned; using (var process = System.Diagnostics.Process.GetProcessById(id)) { int status = NtQueryInformationProcess(process.Handle, 12, out mode, 4, out returned); if (status != 0) throw new System.Exception("Query failed: " + status); } return mode ^ 1u; } }'`
const quote = value => "'" + value.replaceAll("'", "''") + "'"
const ps = command => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 20000 })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'conductor-smoke-wrapper-'))
  const scripts = join(root, 'scripts')
  mkdirSync(scripts)
  const wrapper = join(scripts, 'run-smoke-background.ps1')
  copyFileSync(resolve('scripts/run-smoke-background.ps1'), wrapper)
  const probe = join(scripts, 'smoke-probe.mjs')
  // No Electron here. A real Node child launches a real PowerShell grandchild to inspect the
  // Node process mode directly: CLR startup can alter a PowerShell grandchild own mode.
  // Querying the parent avoids confusing that runtime policy with inherited Node state.
  writeFileSync(probe, `import { spawnSync } from 'node:child_process';
const child = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ${JSON.stringify(nativeType + '; [ProbeErrorMode]::ForProcess(')} + process.pid + ')' ], {encoding:'utf8', windowsHide:true});
if (child.status !== 0) throw new Error(child.stderr);
console.log(JSON.stringify({ mode: Number(child.stdout.trim()), background: process.env.CONDUCTOR_BACKGROUND_WINDOWS, args: process.argv.slice(2), cwd: process.cwd() }));
process.stderr.write('probe diagnostic\\n');
process.exit(Number(process.argv[2] || 0));`)
  return { root, wrapper, probe, cleanup() {
    const actual = realpathSync(root)
    assert.ok(actual.toLowerCase().startsWith(join(realpathSync(tmpdir()), 'conductor-smoke-wrapper-').toLowerCase()))
    rmSync(actual, { recursive: true, force: true })
  } }
}

test('inherits all dialog suppression flags through Node, preserves arguments and nonzero exit, and restores process state', { skip: !windows }, () => {
  const f = fixture()
  try {
    const result = ps(`${nativeType}; [void][ProbeErrorMode]::SetErrorMode(2); if ([ProbeErrorMode]::ForProcess($PID) -ne [ProbeErrorMode]::GetErrorMode()) { throw 'Native query must agree with GetErrorMode' }; $env:CONDUCTOR_BACKGROUND_WINDOWS='0'; $before=(Get-Location).Path; & ${quote(f.wrapper)} -SmokeScript ${quote(f.probe)} -SmokeArgs @('23', 'two words'); $code=$LASTEXITCODE; @{ restoredMode=[ProbeErrorMode]::GetErrorMode(); restoredBackground=$env:CONDUCTOR_BACKGROUND_WINDOWS; restoredLocation=((Get-Location).Path -eq $before); childExit=$code } | ConvertTo-Json -Compress`)
    assert.equal(result.status, 0, result.stderr)
    const [child, restored] = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line))
    assert.equal(child.mode & 0x8003, 0x8003)
    assert.equal(child.background, '1')
    assert.deepEqual(child.args, ['23', 'two words'])
    assert.equal(realpathSync(child.cwd), realpathSync(f.root))
    assert.deepEqual(restored, { restoredMode: 2, restoredBackground: '0', restoredLocation: true, childExit: 23 })
  } finally { f.cleanup() }
})

test('preserves Node exit as the wrapper process exit and restores an absent environment variable', { skip: !windows }, () => {
  const f = fixture()
  try {
    const direct = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f.wrapper, '-SmokeScript', f.probe, '-SmokeArgs', '17'], { encoding: 'utf8', windowsHide: true, timeout: 20000 })
    assert.equal(direct.status, 17, direct.stderr)
    const unset = ps(`Remove-Item Env:CONDUCTOR_BACKGROUND_WINDOWS -ErrorAction SilentlyContinue; & ${quote(f.wrapper)} -SmokeScript ${quote(f.probe)}; @{ absent=(-not (Test-Path Env:CONDUCTOR_BACKGROUND_WINDOWS)); childExit=$LASTEXITCODE } | ConvertTo-Json -Compress`)
    assert.equal(unset.status, 0, unset.stderr)
    assert.deepEqual(JSON.parse(unset.stdout.trim().split(/\r?\n/).at(-1)), { absent: true, childExit: 0 })
  } finally { f.cleanup() }
})

test('rejects non-smokes and paths outside scripts before launching Node', { skip: !windows }, () => {
  const f = fixture()
  try {
    for (const target of [join(f.root, 'smoke-outside.mjs'), join(f.root, 'scripts', 'ordinary.mjs')]) {
      writeFileSync(target, "throw new Error('must never run')")
      const result = ps(`& ${quote(f.wrapper)} -SmokeScript ${quote(target)}`)
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /Choose one smoke-\*\.mjs file/)
      assert.doesNotMatch(result.stderr, /must never run/)
    }
  } finally { f.cleanup() }
})
