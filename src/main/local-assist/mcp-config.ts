import { readFileSync } from 'node:fs'
import type { Json } from '../../shared/structured-agent'
import { LOCAL_ASSIST_MCP_SERVER_NAME } from './contract.ts'

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** Reads only the exact loopback configuration one of Conductor's MCP servers mints for a Codex
 *  session, as a thread config (never a process argument, so the bearer token stays out of argv). */
function codexLoopbackThreadConfig(configuration: string | undefined, server: string, label: string): Record<string, Json> | undefined {
  if (!configuration) return undefined
  const source = configuration.trim().startsWith('{') ? configuration : readFileSync(configuration, 'utf8')
  if (source.length > 16 * 1024) throw new Error(`Codex ${label} MCP configuration is too large`)
  let parsed: unknown
  try { parsed = JSON.parse(source) } catch { throw new Error(`Codex ${label} MCP configuration is malformed`) }
  if (!record(parsed) || !record(parsed.mcp_servers) || Object.keys(parsed.mcp_servers).length !== 1) throw new Error(`Codex ${label} MCP configuration has an invalid server set`)
  const entry = parsed.mcp_servers[server]
  if (!record(entry) || typeof entry.url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(entry.url) || !record(entry.http_headers) || typeof entry.http_headers.Authorization !== 'string' || !/^Bearer [a-f0-9]{64}$/.test(entry.http_headers.Authorization) || (entry.tool_timeout_sec !== undefined && (typeof entry.tool_timeout_sec !== 'number' || entry.tool_timeout_sec < 1 || entry.tool_timeout_sec > 7200))) throw new Error(`Codex ${label} MCP configuration is not a scoped loopback credential`)
  return JSON.parse(source) as Record<string, Json>
}

/** The `conductor-local` server LocalAssistMcpServer mints for a Codex session. */
export const codexLocalAssistThreadConfig = (configuration: string | undefined): Record<string, Json> | undefined =>
  codexLoopbackThreadConfig(configuration, LOCAL_ASSIST_MCP_SERVER_NAME, 'local assist')

/** The `conductor` server (control, send_message, report, ...) ConductorMcpServer mints for a Codex
 *  session. The name is spelled out rather than imported so this module stays free of the server. */
export const codexConductorThreadConfig = (configuration: string | undefined): Record<string, Json> | undefined =>
  codexLoopbackThreadConfig(configuration, 'conductor', 'Conductor control')

/** One Codex thread config holding every Conductor MCP server the session was given. */
export function mergeCodexMcpConfigs(...configs: Array<Json | undefined>): Json | undefined {
  const present = configs.filter((config): config is Record<string, Json> => record(config))
  if (!present.length) return undefined
  const servers: Record<string, Json> = {}
  for (const config of present) if (record(config.mcp_servers)) Object.assign(servers, config.mcp_servers)
  return { ...Object.assign({}, ...present), mcp_servers: servers } as Json
}
