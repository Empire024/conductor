import { resolve } from 'node:path'
import type { StructuredProvider } from '../../shared/structured-agent'
import type { AdapterOptions, ProviderAdapter } from './adapter'
import { ClaudeAdapter, CLAUDE_COMPATIBILITY } from './claude'
import { CodexAdapter, CODEX_PROTOCOL_BASELINE } from './codex'
import { GrokAdapter, GROK_BASELINE } from './grok'
import { LocalAdapter } from './local'
import { JsonLineTransport, type TransportOptions } from './transport'

/** Where an offline run finds `fake-<provider>.mjs`: the repository fixtures unless a smoke points
 *  `CONDUCTOR_TEST_FIXTURE_DIR` at its own folder. Packaged builds clear `CONDUCTOR_OFFLINE_TESTS`,
 *  so this never applies in production. */
export function offlineFixtureDirectory(): string {
  return process.env.CONDUCTOR_TEST_FIXTURE_DIR?.trim() ? resolve(process.env.CONDUCTOR_TEST_FIXTURE_DIR.trim()) : resolve(__dirname, '../../scripts/fixtures')
}

/** Explicit offline boundary, fixed scripts only; production adapters still parse raw wire messages. */
export function createProviderAdapter(provider: StructuredProvider, options: AdapterOptions): ProviderAdapter {
  // The local runtime has no CLI to fake: it talks to llama.cpp on loopback and owns its own
  // tool dispatch, so the offline fixture transport does not apply to it.
  if (provider === 'local') return new LocalAdapter(options)
  const offline = process.env.CONDUCTOR_OFFLINE_TESTS === '1'
  if (!offline) return provider === 'claude' ? new ClaudeAdapter(options) : provider === 'grok' ? new GrokAdapter(options) : new CodexAdapter(options)
  const fixture = resolve(offlineFixtureDirectory(), `fake-${provider}.mjs`)
  const transport = (settings: TransportOptions): JsonLineTransport => new JsonLineTransport({ ...settings, executable: process.execPath, args: [fixture, ...settings.args], environment: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
  // The offline runtime reports the fixture-verified baseline itself, so raising the baseline never
  // turns the fixtures into an "unverified" or refused runtime.
  if (provider === 'grok') return new GrokAdapter(options, { version: async () => GROK_BASELINE, transport })
  return provider === 'claude' ? new ClaudeAdapter(options, { version: async () => CLAUDE_COMPATIBILITY, createTransport: transport }) : new CodexAdapter(options, { version: async () => CODEX_PROTOCOL_BASELINE, transport })
}
