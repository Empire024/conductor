import { resolve } from 'node:path'

const normalizedPath = value => resolve(value).toLocaleLowerCase()
function fixtureCommandBody(command, allowQuotedSearch = false) {
  if (typeof command !== 'string' || /[\r\n`$;&<>]/.test(command) || (!allowQuotedSearch && command.includes('|'))) return null
  const wrapper = /^(?:"[A-Za-z]:\\[^"\r\n]*\\(?:powershell|pwsh)\.exe"|(?:powershell|pwsh)(?:\.exe)?)\s+(?:-NoProfile\s+)?(?:-NonInteractive\s+)?-Command\s+(["'])(.*)\1$/i.exec(command.trim())
  return wrapper ? wrapper[2] : command.trim()
}
export function isFixtureSearchCommand(command) {
  // This is a literal fixture search, not a shell parser. In the captured native
  // request the pipe is inside the quoted rg expression, not a command pipeline.
  // Accept no other expressions, flags, paths, substitutions or extra commands.
  const body = fixtureCommandBody(command, true)
  return body === 'rg -n "wasOpen|wasPinned" panel.mjs' || body === "rg -n 'wasOpen|wasPinned' panel.mjs"
}
export function isFixtureReadCommand(command, cwd) {
  const body = fixtureCommandBody(command)
  if (!body) return false
  const match = /^Get-Content\s+(?:-Raw\s+)?(?:(?:-Path|-LiteralPath)\s+)?(?:"([^"]+)"|'([^']+)'|([^\s]+))(?:\s+-Raw)?$/i.exec(body)
  if (!match) return false
  const path = resolve(cwd, match[1] ?? match[2] ?? match[3])
  return ['panel.mjs', 'panel.test.mjs'].some(name => normalizedPath(path) === normalizedPath(resolve(cwd, name)))
}
export function isFixtureTestCommand(command) {
  // Accept only a literal shell wrapper around the exact test. No shell interpolation,
  // command separators, encoded commands, profile files or additional arguments.
  return fixtureCommandBody(command) === 'node --test panel.test.mjs'
}

export function isFixtureApproval(interaction, state, cwd) {
  const input = interaction?.input
  if (!input || typeof input !== 'object' || input.networkApprovalContext || input.additionalPermissions || input.grantRoot || input.permissions) return false
  if (typeof input.command === 'string') return typeof input.cwd === 'string' && normalizedPath(input.cwd) === normalizedPath(cwd) && (isFixtureTestCommand(input.command) || isFixtureReadCommand(input.command, cwd) || isFixtureSearchCommand(input.command))
  const changes = state.items.flatMap(item => item.nativeItemId === input.itemId && item.data.type === 'changes' ? item.data.changes : [])
  if (changes.length !== 1) return false
  const change = changes[0]
  if (normalizedPath(resolve(cwd, change.path)) !== normalizedPath(resolve(cwd, 'panel.mjs')) || change.status !== 'proposed' || change.kind !== 'update' || typeof change.patch !== 'string') return false
  const lines = change.patch.split(/\r?\n/)
  const added = lines.filter(line => line.startsWith('+') && !line.startsWith('+++'))
  const removed = lines.filter(line => line.startsWith('-') && !line.startsWith('---')).map(line => line.slice(1))
  return added.length === 0 && removed.length === 2 && removed[0] === "  var wasOpen = el.classList.contains('is-open');" && removed[1] === '  var wasPinned = pinned;'
}
