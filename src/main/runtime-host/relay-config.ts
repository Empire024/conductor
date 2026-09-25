import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RuntimeHostClient } from './client'
import type { RelayServer } from './protocol'

type Json = Record<string, unknown>
const LOOPBACK = /^http:\/\/127\.0\.0\.1:\d{1,5}\/[\w./-]*$/
const object = (value: unknown): value is Json => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** Whether this host can keep a provider's MCP servers reachable across an app restart. */
export const relaysMcp = (client: RuntimeHostClient | null | undefined): client is RuntimeHostClient => Boolean(client?.connected && client.features.includes('mcp-relay'))

/** Claude's `mcpServers` (headers) or Codex's `mcp_servers` (http_headers), from a path or inline JSON. */
function parse(config: string): { root: Json; servers: Json; headers: 'headers' | 'http_headers' } | undefined {
  let root: unknown
  try { root = JSON.parse(config.trim().startsWith('{') ? config : readFileSync(config, 'utf8')) } catch { return undefined }
  if (!object(root)) return undefined
  if (object(root.mcpServers)) return { root, servers: root.mcpServers, headers: 'headers' }
  if (object(root.mcp_servers)) return { root, servers: root.mcp_servers, headers: 'http_headers' }
  return undefined
}

/**
 * Hands every loopback MCP server in `configs` to the runtime host's relay under `key`, and
 * returns the configs rewritten to reach them through it (inline JSON), in the same order; a
 * config with nothing to relay comes back as it was. The relay address and token stay the same
 * for as long as the host runs, so a provider process that outlives this app keeps its tools:
 * the next app calls this again with its own configs to point the same routes at itself. With no
 * host that relays, or when the host refuses, the configs are returned untouched (onError).
 */
export async function relayMcpConfigs(client: RuntimeHostClient | null | undefined, key: string, configs: Array<string | undefined>, onError?: (error: Error) => void): Promise<Array<string | undefined>> {
  if (!relaysMcp(client)) return configs
  const parsed = configs.map(config => config ? parse(config) : undefined)
  const servers: RelayServer[] = []
  for (const entry of parsed) {
    for (const [name, value] of Object.entries(entry?.servers ?? {})) {
      const headers = object(value) ? value[entry!.headers] : undefined
      if (!object(value) || typeof value.url !== 'string' || !LOOPBACK.test(value.url) || !object(headers) || typeof headers.Authorization !== 'string') continue
      if (servers.some(server => server.name === name)) continue
      servers.push({ name, upstream: value.url, authorization: headers.Authorization })
    }
  }
  let routes: Awaited<ReturnType<RuntimeHostClient['relay']>>
  try { routes = await client.relay(key, servers) } catch (error) { onError?.(error instanceof Error ? error : new Error(String(error))); return configs }
  return configs.map((config, index) => {
    const entry = parsed[index]
    if (!config || !entry) return config
    let changed = false
    const rewritten = structuredClone(entry.root)
    const target = rewritten[entry.headers === 'headers' ? 'mcpServers' : 'mcp_servers'] as Json
    for (const [name, value] of Object.entries(target)) {
      const route = routes.find(candidate => candidate.name === name)
      if (!route || !object(value) || !object(value[entry.headers])) continue
      value.url = route.url
      ;(value[entry.headers] as Json).Authorization = `Bearer ${route.token}`
      changed = true
    }
    return changed ? JSON.stringify(rewritten) : config
  })
}

let directory = ''
/** A 0600 file for an inline config that carries a credential, so it never rides on a command
 *  line (the same reason BrowserMcpServer.configure hands out a path). */
export function privateConfigFile(json: string, name: string): string {
  if (!directory) directory = mkdtempSync(join(tmpdir(), 'conductor-mcp-relay-'))
  const file = join(directory, `${name.replace(/[^\w-]/g, '')}.json`)
  writeFileSync(file, json, { mode: 0o600 })
  return file
}
export function removeConfigFiles(files: readonly string[]): void {
  for (const file of files) { try { rmSync(file, { force: true }) } catch { /* already gone */ } }
}
