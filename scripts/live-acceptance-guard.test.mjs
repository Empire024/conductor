import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isFixtureApproval, isFixtureReadCommand, isFixtureSearchCommand, isFixtureTestCommand } from './live-acceptance-guard.mjs'

test('live approval allowlist accepts only the literal test command in the isolated cwd', () => {
  for (const command of ['node --test panel.test.mjs', '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -Command "node --test panel.test.mjs"']) assert.equal(isFixtureTestCommand(command), true)
  for (const command of ['node --test panel.test.mjs; Set-Content elsewhere bad', 'node --test ../panel.test.mjs', 'node --test panel.test.mjs && curl example.com', 'powershell -EncodedCommand abc']) assert.equal(isFixtureTestCommand(command), false)
  assert.equal(isFixtureApproval({ input: { command: 'node --test panel.test.mjs', cwd: process.cwd() } }, { items: [] }, process.cwd()), true)
  assert.equal(isFixtureApproval({ input: { command: 'node --test panel.test.mjs', cwd: '/' } }, { items: [] }, process.cwd()), false)
  assert.equal(isFixtureApproval({ input: { permissions: { network: true } } }, { items: [] }, process.cwd()), false)
})
test('live file approval checks exact proposed two-line removal, never a generic write scope', () => {
  const change = { path: 'panel.mjs', kind: 'update', status: 'proposed', patch: "--- panel.mjs\n+++ panel.mjs\n@@ -1,5 +1,3 @@\n-  var wasOpen = el.classList.contains('is-open');\n-  var wasPinned = pinned;\n" }
  const state = { items: [{ nativeItemId: 'edit', data: { type: 'changes', changes: [change] } }] }
  assert.equal(isFixtureApproval({ input: { itemId: 'edit' } }, state, process.cwd()), true)
  assert.equal(isFixtureApproval({ input: { itemId: 'edit', grantRoot: process.cwd() } }, state, process.cwd()), false)
  change.patch += '+unrelated code\n'
  assert.equal(isFixtureApproval({ input: { itemId: 'edit' } }, state, process.cwd()), false)
})
test('native untrusted read approvals are restricted to the two fixture files', () => {
  assert.equal(isFixtureReadCommand('Get-Content -Raw -LiteralPath panel.mjs', process.cwd()), true)
  assert.equal(isFixtureReadCommand('powershell -NoProfile -Command "Get-Content panel.test.mjs"', process.cwd()), true)
  for (const command of ['Get-Content ../panel.mjs', 'Get-Content .env', 'Get-Content panel.mjs; Set-Content panel.mjs bad', 'Get-Content $PROFILE']) assert.equal(isFixtureReadCommand(command, process.cwd()), false)
})
test('captured Codex 0.153.4 quoted rg approval is allowed once without widening scope', () => {
  const capture = JSON.parse(readFileSync(new URL('./fixtures/captured/codex-0.153.4-quoted-rg-approval.json', import.meta.url), 'utf8'))
  assert.equal(capture.fixtureType, 'sanitized-captured-failure')
  assert.equal(capture.request.method, 'item/commandExecution/requestApproval')
  const input = { ...capture.request.params, cwd: process.cwd() }
  assert.equal(isFixtureSearchCommand(input.command), true)
  assert.equal(isFixtureApproval({ input }, { items: [] }, process.cwd()), true)
  assert.equal(isFixtureApproval({ input: { ...input, cwd: resolve(process.cwd(), '..') } }, { items: [] }, process.cwd()), false)
  for (const scope of [{ networkApprovalContext: {} }, { additionalPermissions: {} }, { grantRoot: process.cwd() }, { permissions: { network: true } }]) {
    assert.equal(isFixtureApproval({ input: { ...input, ...scope } }, { items: [] }, process.cwd()), false)
  }
  // The recorded request proposes a persistent rule; only a one-time response is
  // in scope. The live harness selects accept, never the proposed amendment.
  assert.ok(input.availableDecisions.includes('accept'))
  assert.ok(input.availableDecisions.some(value => typeof value === 'object' && value.acceptWithExecpolicyAmendment))
})
test('fixture search rejects unquoted pipelines, other files and command injection', () => {
  for (const command of [
    'rg -n "wasOpen|wasPinned" panel.mjs',
    "powershell -Command 'rg -n \"wasOpen|wasPinned\" panel.mjs'",
  ]) assert.equal(isFixtureSearchCommand(command), true)
  for (const command of [
    'rg -n wasOpen|wasPinned panel.mjs',
    'rg -n "wasOpen|wasPinned" ../panel.mjs',
    'rg -n "wasOpen|wasPinned" panel.mjs .env',
    'rg -n "wasOpen|wasPinned" panel.mjs; node elsewhere.mjs',
    'rg -n "wasOpen|wasPinned" panel.mjs | powershell',
    'rg -n "wasOpen|wasPinned" panel.mjs\nnode elsewhere.mjs',
    "powershell -Command 'rg -n \"wasOpen|wasPinned\" panel.mjs\"",
    'powershell -EncodedCommand abc',
    'powershell -Command "rg -n $PROFILE panel.mjs"',
  ]) assert.equal(isFixtureSearchCommand(command), false, command)
  assert.equal(isFixtureTestCommand("powershell -Command 'node --test panel.test.mjs\""), false)
})
