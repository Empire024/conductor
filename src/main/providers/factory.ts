import { resolve } from 'node:path'
import type { StructuredProvider } from '../../shared/structured-agent'
import type { AdapterOptions, ProviderAdapter } from './adapter'
import { ClaudeAdapter } from './claude'
import { CodexAdapter } from './codex'
import { LocalAdapter } from './local'
import { JsonLineTransport, type TransportOptions } from './transport'

/** Explicit offline boundary, fixed scripts only; production adapters still parse raw wire messages. */
export function createProviderAdapter(provider: StructuredProvider, options: AdapterOptions): ProviderAdapter {
  // The local runtime has no CLI to fake: it talks to llama.cpp on loopback and owns its own
  // tool dispatch, so the offline fixture transport does not apply to it.
  if (provider === 'local') return new LocalAdapter(options)
  const offline = process.env.CONDUCTOR_OFFLINE_TESTS === '1'
  if (!offline) return provider === 'claude' ? new ClaudeAdapter(options) : new CodexAdapter(options)
  const fixture = resolve(__dirname, '../../scripts/fixtures', `fake-${provider}.mjs`)
  const transport = (settings: TransportOptions): JsonLineTransport => new JsonLineTransport({ ...settings, executable: process.execPath, args: [fixture, ...settings.args], environment: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
  return provider === 'claude' ? new ClaudeAdapter(options, { version: async () => '2.1.263', createTransport: transport }) : new CodexAdapter(options, { version: async () => '0.153.4', transport })
}
