import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const POLICY_PATH = resolve(here, '..', 'docs', 'tailscale-policy.hujson')

// Must match DEFAULT_REMOTE_PORT in src/shared/remote-control.ts. Not imported from
// there because this file runs under plain `node --test`, with no TypeScript build
// step of its own; the policy doc explains the same requirement to the reader.
const CONDUCTOR_PORT = 51840

/**
 * Strips HuJSON down to plain JSON: block comments, line comments, and trailing
 * commas before a closing `}` or `]`. Comment markers inside a quoted string are
 * left alone, since HuJSON (like JSONC) only treats `//` and `/* … *\/` as comments
 * outside of strings.
 */
function stripHuJSON(text) {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const next = text[i + 1]
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; out += ch; continue }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i++ // land on the trailing '/'
      continue
    }
    out += ch
  }
  // Trailing commas: a comma followed by only whitespace/newlines before } or ]
  out = out.replace(/,(\s*[}\]])/g, '$1')
  return out
}

function loadPolicy() {
  const raw = readFileSync(POLICY_PATH, 'utf8')
  const stripped = stripHuJSON(raw)
  return { raw, policy: JSON.parse(stripped) }
}

function acceptRules(policy) {
  const acls = Array.isArray(policy.acls) ? policy.acls : []
  return acls.filter(rule => rule && rule.action === 'accept')
}

test('parses as valid JSON once comments and trailing commas are stripped', () => {
  const { policy } = loadPolicy()
  assert.equal(typeof policy, 'object')
  assert.ok(policy)
})

test('declares tagOwners for the two Conductor tags', () => {
  const { policy } = loadPolicy()
  assert.ok(policy.tagOwners && typeof policy.tagOwners === 'object', 'tagOwners must be present')
  assert.ok(Array.isArray(policy.tagOwners['tag:conductor-main']) && policy.tagOwners['tag:conductor-main'].length > 0)
  assert.ok(Array.isArray(policy.tagOwners['tag:conductor-laptop']) && policy.tagOwners['tag:conductor-laptop'].length > 0)
})

test('has exactly one accept rule, for the Conductor port only', () => {
  const { policy } = loadPolicy()
  const rules = acceptRules(policy)
  assert.equal(rules.length, 1, 'expected exactly one accept rule')
  const [rule] = rules
  assert.deepEqual(rule.src, ['tag:conductor-laptop'])
  assert.deepEqual(rule.dst, [`tag:conductor-main:${CONDUCTOR_PORT}`])
})

test('the rule is scoped to TCP only', () => {
  const { policy } = loadPolicy()
  const [rule] = acceptRules(policy)
  assert.equal(rule.proto, 'tcp')
})

test('dst is limited to the MAIN tag and the Conductor port - never a wildcard host or port', () => {
  const { policy } = loadPolicy()
  for (const rule of (policy.acls || [])) {
    for (const dst of (rule.dst || [])) {
      assert.notEqual(dst, '*')
      const [host, port] = String(dst).split(':')
      assert.notEqual(host, '*')
      if (port !== undefined) assert.notEqual(port, '*')
    }
    for (const src of (rule.src || [])) {
      assert.notEqual(src, '*')
    }
  }
})

test('no rule anywhere uses "*" for a host or a port', () => {
  const { policy } = loadPolicy()
  const acls = Array.isArray(policy.acls) ? policy.acls : []
  assert.ok(acls.length > 0, 'expected at least one rule to check')
  for (const rule of acls) {
    for (const key of ['src', 'dst']) {
      for (const entry of (rule[key] || [])) {
        assert.notEqual(entry, '*', `${key} must not be "*"`)
        assert.ok(!String(entry).endsWith(':*'), `${key} must not use a wildcard port`)
      }
    }
  }
})

test('grants no route to the open internet', () => {
  // Checked against the parsed, comment-free structure rather than the raw file: the
  // policy's own prose is allowed to name "autogroup:internet" as something to avoid
  // (it does, for the reader's benefit); only its presence as live config would matter.
  const { policy } = loadPolicy()
  assert.ok(!JSON.stringify(policy).includes('autogroup:internet'), 'autogroup:internet must not appear as active configuration')
  for (const rule of (policy.acls || [])) {
    for (const key of ['src', 'dst']) {
      for (const entry of (rule[key] || [])) {
        assert.notEqual(entry, 'autogroup:internet')
      }
    }
  }
})

test('does not enable Funnel, Serve, subnet routes, exit nodes or autoApprovers', () => {
  const { policy } = loadPolicy()
  assert.equal(policy.autoApprovers, undefined, 'autoApprovers (routes/exit nodes) must be absent')
  assert.equal(policy.nodeAttrs, undefined, 'nodeAttrs (which is where Funnel is enabled) must be absent')
  for (const rule of (policy.acls || [])) {
    assert.notEqual(rule.action, 'funnel')
  }
})

test('the active policy uses tags rather than the commented-out device-name alternative', () => {
  const { raw } = loadPolicy()
  assert.match(raw, /tag:conductor-laptop.*tag:conductor-main:51840/s)
})
