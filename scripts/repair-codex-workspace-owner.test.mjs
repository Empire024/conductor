import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const windows = process.platform === 'win32'
const script = path.resolve('scripts/repair-codex-workspace-owner.ps1')
const run = (...args) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script, ...args], { encoding: 'utf8', windowsHide: true, timeout: 15_000 })
const fixture = () => fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-owner-guard-'))
const cleanup = directory => {
  const actual = fs.realpathSync(directory)
  const prefix = path.join(fs.realpathSync(os.tmpdir()), 'conductor-owner-guard-')
  assert.ok(actual.toLowerCase().startsWith(prefix.toLowerCase()), 'Cleanup must stay inside the explicitly created temporary fixture')
  fs.rmSync(actual, { recursive: true, force: true })
}

test('diagnostic mode reads both directory owners without changing either ACL', { skip: !windows }, () => {
  const directory = fixture()
  try {
    fs.mkdirSync(path.join(directory, '.git'))
    const first = run('-WorkspacePath', directory)
    assert.equal(first.status, 0, first.stderr)
    const before = JSON.parse(first.stdout)
    assert.deepEqual(before.map(entry => entry.Path), [directory, path.join(directory, '.git')])
    assert.ok(before.every(entry => entry.OwnerSid && entry.Dacl))
    const second = run('-WorkspacePath', directory)
    assert.equal(second.status, 0, second.stderr)
    assert.deepEqual(JSON.parse(second.stdout), before)
  } finally { cleanup(directory) }
})

test('refuses filesystem roots before any ownership operation', { skip: !windows }, () => {
  const result = run('-WorkspacePath', path.parse(process.cwd()).root, '-Repair')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /never a filesystem root/)
})

test('refuses a workspace reached through a junction', { skip: !windows }, () => {
  const directory = fixture()
  try {
    fs.mkdirSync(path.join(directory, 'actual'))
    fs.symlinkSync(path.join(directory, 'actual'), path.join(directory, 'linked'), 'junction')
    const result = run('-WorkspacePath', path.join(directory, 'linked'), '-Repair')
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /reparse-point path/)
    assert.ok(fs.existsSync(path.join(directory, 'actual')))
  } finally { cleanup(directory) }
})

test('does not follow a linked .git directory', { skip: !windows }, () => {
  const directory = fixture()
  const gitTarget = fixture()
  try {
    fs.symlinkSync(gitTarget, path.join(directory, '.git'), 'junction')
    const result = run('-WorkspacePath', directory)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /reparse-point path/)
  } finally {
    cleanup(directory)
    cleanup(gitTarget)
  }
})

test('a worktree .git pointer is left untouched', { skip: !windows }, () => {
  const directory = fixture()
  try {
    fs.writeFileSync(path.join(directory, '.git'), 'gitdir: ../other/worktrees/test\n')
    const result = run('-WorkspacePath', directory)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).Path, directory)
    assert.equal(fs.readFileSync(path.join(directory, '.git'), 'utf8'), 'gitdir: ../other/worktrees/test\n')
  } finally { cleanup(directory) }
})

test('inheritance repair refuses filesystem roots before reading native state', { skip: !windows }, () => {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.resolve('scripts/repair-codex-workspace-inheritance.ps1'), '-WorkspacePath', path.parse(process.cwd()).root, '-Repair'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /never a filesystem root/)
})

test('inheritance repair refuses a junction workspace before reading native state', { skip: !windows }, () => {
  const directory = fixture()
  try {
    fs.mkdirSync(path.join(directory, 'actual'))
    fs.symlinkSync(path.join(directory, 'actual'), path.join(directory, 'linked'), 'junction')
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.resolve('scripts/repair-codex-workspace-inheritance.ps1'), '-WorkspacePath', path.join(directory, 'linked'), '-Repair'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /reparse-point ancestor/)
  } finally { cleanup(directory) }
})
