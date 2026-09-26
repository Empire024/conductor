/**
 * One narrow owner approval for one action the claude CLI would not run by itself in Auto
 * (docs/permissions-classifier.md). A request names the exact action and resource, what kind of
 * resource it is, and the single native permission rule that would let exactly that call through;
 * the owner answers it once, and the rule is handed to that one live conversation only.
 *
 * The rule syntax follows claude 2.1.282's own parser: `Tool(content)`, content between the first
 * and the last parenthesis with `\(`, `\)` and `\\` unescaped; a `*` in a Bash rule makes it a
 * wildcard and a trailing `:*` a prefix, so a command holding either is never turned into a rule.
 * File rules are gitignore patterns over POSIX paths (Windows `C:\x` is matched as `/c/x`), and
 * `//` anchors one at the filesystem root.
 */

/** local: this machine, reversible. shared: something other people or programs also depend on.
 *  destructive: deletes or overwrites. external: reaches another machine or service. */
export type GrantClass = 'local' | 'shared' | 'destructive' | 'external'
export type GrantDecision = 'approve-once' | 'approve-session' | 'deny'
export type GrantStatus = 'pending' | 'approved-once' | 'approved-session' | 'denied' | 'used' | 'revoked' | 'expired' | 'ineffective' | 'moved'

export interface PermissionGrantRequest {
  /** Unique per conversation: the denial's notice item id, or `grant:<uuid>` for an agent's request. */
  id: string
  source: 'denial' | 'agent'
  /** The native tool name (Write, Bash, mcp__server__tool). */
  tool: string
  /** In words: "Write a file", "Run a command". */
  action: string
  /** The exact path, command or tool call. */
  resource: string
  /** The remote host, for a command that reaches one. */
  host?: string
  /** The classifier's bracketed reason, for a denial. */
  category?: string
  class: GrantClass
  /** The one native allow rule; absent when none can be narrow enough (see refusal). */
  rule?: string
  /** Why no rule is offered, in words for the owner. */
  refusal?: string
  reason?: string
  rollback?: string
  toolUseId?: string
  status: GrantStatus
  requestedAt: string
  decidedAt?: string
  decidedBy?: 'owner' | 'wizard'
  /** The conversation that holds the request now, set when a handoff moved it there from the tab
   *  that asked (agents.handoff successor). On the old tab's card the status is 'moved'. */
  holder?: { agentSessionId: string; title?: string }
}

export interface PermissionGrant {
  id: string
  agentSessionId: string
  requestId: string
  rule: string
  scope: 'once' | 'session'
  class: GrantClass
  tool: string
  resource: string
  grantedAt: string
  decidedBy: 'owner' | 'wizard'
  /** How the rule reached the conversation: applied live, or waiting for its restart. */
  delivery: 'live' | 'restart' | 'pending'
}

/** What the renderer holds: every open request and live grant, per conversation. */
export interface PermissionGrantsState {
  requests: Array<PermissionGrantRequest & { agentSessionId: string }>
  grants: PermissionGrant[]
}

export interface PermissionGrantDecisionResult {
  status: GrantStatus
  grant?: PermissionGrant
  message: string
}

export interface PermissionGrantsBridge {
  state(): Promise<PermissionGrantsState>
  decide(agentSessionId: string, requestId: string, decision: GrantDecision): Promise<PermissionGrantDecisionResult>
  revoke(agentSessionId: string, grantId: string): Promise<boolean>
  onChanged(callback: (state: PermissionGrantsState) => void): () => void
}

const GRANT_CLASSES = new Set(['local', 'shared', 'destructive', 'external'])
const GRANT_STATUSES = new Set(['pending', 'approved-once', 'approved-session', 'denied', 'used', 'revoked', 'expired', 'ineffective', 'moved'])
const payloadOf = (data: { type: string; payload?: unknown }): Record<string, unknown> | undefined =>
  data.type === 'notice' && data.payload && typeof data.payload === 'object' && !Array.isArray(data.payload) ? data.payload as Record<string, unknown> : undefined

/** An agent's own request, as its Conductor notice card carries it. */
export function permissionGrantOf(data: { type: string; payload?: unknown }): PermissionGrantRequest | undefined {
  const value = payloadOf(data)?.permissionGrant
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const request = value as Record<string, unknown>
  if (typeof request.id !== 'string' || typeof request.tool !== 'string' || typeof request.action !== 'string' || typeof request.resource !== 'string' || typeof request.class !== 'string' || !GRANT_CLASSES.has(request.class) || typeof request.status !== 'string' || !GRANT_STATUSES.has(request.status)) return undefined
  return value as PermissionGrantRequest
}

/** A notice this feature puts in a conversation for the owner to see: a classifier denial's card,
 *  an agent's request, a grant the classifier ignored, a grant that could not be delivered. */
export function isPermissionGrantNotice(data: { type: string; payload?: unknown }): boolean {
  const payload = payloadOf(data)
  return Boolean(payload && (payload.autoModeDenial || payload.permissionGrant || payload.permissionGrantIneffective || payload.permissionGrantDelivery))
}

/** The answer a denial's card was restated with, if the owner answered it. */
export function grantStatusOf(data: { type: string; payload?: unknown }): GrantStatus | undefined {
  const status = payloadOf(data)?.grantStatus
  return typeof status === 'string' && GRANT_STATUSES.has(status) ? status as GrantStatus : undefined
}

/** A native rule entry as `rules()` hands it to the adapter. */
export interface GrantRule { rule: string; once: boolean }

/** A decision a wizard tab may make for its owner: only local, reversible actions. */
export const wizardMayDecide = (request: Pick<PermissionGrantRequest, 'class' | 'rule'>): boolean => request.class === 'local' && Boolean(request.rule)

/** Production and external actions reach the owner's phone even while the turn goes on. */
export const grantNeedsPhone = (request: Pick<PermissionGrantRequest, 'class'>): boolean => request.class === 'external' || request.class === 'shared' || request.class === 'destructive'

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined

/** Content inside `Tool(...)`, escaped the way the CLI's parser unescapes it. */
export const escapeRuleContent = (content: string): string => content.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')

/** The CLI's own normalization of a Windows path (`C:\x\y` -> `/c/x/y`), and POSIX as is. */
export function posixPath(path: string): string {
  if (path.startsWith('\\\\')) return path.replaceAll('\\', '/')
  const drive = /^([A-Za-z]):[/\\]/.exec(path)
  if (drive) return '/' + drive[1]!.toLowerCase() + path.slice(2).replaceAll('\\', '/')
  return path.replaceAll('\\', '/')
}

const isAbsolute = (path: string): boolean => /^[A-Za-z]:[/\\]/.test(path) || path.startsWith('/') || path.startsWith('\\\\')
const joinPath = (cwd: string, path: string): string => isAbsolute(path) ? path : cwd.replace(/[/\\]+$/, '') + '/' + path

/** Files whose edit would let an agent widen its own permissions or instructions. */
function permissionConfig(path: string): boolean {
  const posix = posixPath(path).toLowerCase()
  return /(^|\/)\.claude(\/|$)/.test(posix) || /(^|\/)\.mcp\.json$/.test(posix) || /(^|\/)\.codex(\/|$)/.test(posix) || /(^|\/)\.git\/hooks(\/|$)/.test(posix)
}

const SYSTEM_PATH = /^\/(?:[a-z]\/(?:windows|program files(?: \(x86\))?|programdata)(?:\/|$)|etc\/|usr\/|bin\/|sbin\/|var\/|opt\/|system\/|library\/)/i

const EXTERNAL_COMMAND = /(?:^|[\s;&|(])(?:ssh|scp|sftp|rsync|curl(?:\.exe)?|wget|invoke-webrequest|invoke-restmethod|iwr|irm|gh|kubectl|helm|aws|az|gcloud|terraform|pulumi|ansible(?:-playbook)?|doctl|flyctl|vercel|netlify|heroku|mysql|psql|mongosh|redis-cli)(?=\s|$)|\bgit\s+push\b|\bnpm\s+publish\b|\bdocker\s+(?:push|login)\b/i
const DESTRUCTIVE_COMMAND = /(?:^|[\s;&|(])(?:rm\s+-[a-z]*[rf]|rmdir|del|erase|rd|remove-item|format|mkfs(?:\.\w+)?|dd|shred|diskpart|truncate)(?=\s|$)|\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f|push\s+(?:-f|--force))\b|\bdrop\s+(?:table|database|schema)\b/i
const HOST = /(?:^|\s)(?:[\w.-]+@)?((?:\d{1,3}\.){3}\d{1,3}|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)+)(?=[\s:'"]|$)/i

/** The remote host a command names after ssh/scp/rsync/sftp, if any. */
export function commandHost(command: string): string | undefined {
  const match = /(?:^|[\s;&|(])(?:ssh|scp|sftp|rsync)\s+(.*)$/i.exec(command)
  if (!match) return undefined
  const target = /(?:^|\s)[\w.-]+@([\w.-]+)/.exec(match[1]!)?.[1] ?? HOST.exec(match[1]!)?.[1]
  return target
}

export interface GrantRequestInput { tool: string; input: unknown; cwd: string; category?: string; reason?: string; rollback?: string; toolUseId?: string }

/**
 * The narrowest request for one tool call: exactly this path, exactly this command, exactly this
 * tool. A call that no rule can cover without covering more (a wildcard command, a glob path, an
 * edit to permission settings, a skill that changes configuration) is still described, but gets
 * a refusal instead of a rule, and the owner can only deny it.
 */
export function describeGrantRequest(request: GrantRequestInput): Omit<PermissionGrantRequest, 'id' | 'source' | 'status' | 'requestedAt'> {
  const { tool, cwd } = request, input = record(request.input)
  const base = { tool, ...(request.category ? { category: request.category } : {}), ...(request.reason ? { reason: request.reason.slice(0, 600) } : {}), ...(request.rollback ? { rollback: request.rollback.slice(0, 600) } : {}), ...(request.toolUseId ? { toolUseId: request.toolUseId } : {}) }
  if (EDIT_TOOLS.has(tool)) {
    const path = text(input.file_path) ?? text(input.notebook_path) ?? text(input.path)
    if (!path) return { ...base, action: 'Write a file', resource: '(no path)', class: 'shared', refusal: 'The call names no file, so no rule can be limited to one.' }
    const absolute = joinPath(cwd, path), posix = posixPath(absolute)
    const action = tool === 'Write' ? 'Write a file' : 'Edit a file'
    if (permissionConfig(absolute)) return { ...base, action, resource: absolute, class: 'shared', refusal: 'This file holds agent permissions, hooks or instructions. Conductor never grants an agent the right to change those; make that change yourself.' }
    if (/[*?[\]{}]/.test(posix)) return { ...base, action, resource: absolute, class: 'shared', refusal: 'The path holds pattern characters, so a rule for it would also match other files.' }
    return { ...base, action, resource: absolute, class: SYSTEM_PATH.test(posix) ? 'shared' : 'local', rule: `Edit(${escapeRuleContent('/' + posix)})` }
  }
  if (SHELL_TOOLS.has(tool)) {
    const command = text(input.command)?.trim()
    if (!command) return { ...base, action: 'Run a command', resource: '(no command)', class: 'shared', refusal: 'The call names no command.' }
    const host = commandHost(command)
    const kind: GrantClass = EXTERNAL_COMMAND.test(command) ? 'external' : DESTRUCTIVE_COMMAND.test(command) ? 'destructive' : 'local'
    const shaped = { ...base, action: 'Run a command', resource: command, ...(host ? { host } : {}), class: kind }
    if (command.length > 4000) return { ...shaped, refusal: 'The command is too long to show as one exact rule; put it in a script file and ask for that script.' }
    if (command.includes('*') || /:\s*$/.test(command)) return { ...shaped, refusal: 'The command holds * (or ends in :), which the CLI reads as a wildcard, so a rule for it would allow other commands too. Ask for a command without it.' }
    return { ...shaped, rule: `${tool}(${escapeRuleContent(command)})` }
  }
  if (tool === 'Skill') {
    const skill = text(input.skill) ?? text(input.name) ?? ''
    if (/config|settings|permission|hook/i.test(skill)) return { ...base, action: 'Run a skill', resource: skill, class: 'shared', refusal: 'This skill changes agent configuration or permissions. Conductor never grants that to an agent; the owner makes such changes.' }
    return { ...base, action: 'Run a skill', resource: skill || tool, class: 'local', ...(skill ? { rule: `Skill(${escapeRuleContent(skill)})` } : { refusal: 'The call names no skill.' }) }
  }
  if (tool === 'WebFetch') {
    let host = ''
    try { host = new URL(text(input.url) ?? '').hostname } catch { /* no URL */ }
    return { ...base, action: 'Fetch a web page', resource: text(input.url) ?? '(no url)', class: 'external', ...(host ? { host, rule: `WebFetch(domain:${host})` } : { refusal: 'The call names no valid URL.' }) }
  }
  if (tool.startsWith('mcp__')) {
    const server = tool.split('__')[1] ?? ''
    const summary = JSON.stringify(input).slice(0, 400)
    return { ...base, action: 'Call an MCP tool', resource: `${tool} ${summary}`, class: server.startsWith('conductor') ? 'local' : 'external', rule: tool }
  }
  return { ...base, action: `Use ${tool}`, resource: JSON.stringify(input).slice(0, 400), class: 'shared', refusal: `Conductor has no narrow rule for ${tool}; switch the conversation to Edit mode to approve it as a one-off.` }
}

/** The request as the owner reads it in one line (card title, phone body). */
export const grantRequestSummary = (request: Pick<PermissionGrantRequest, 'action' | 'resource' | 'class'>): string =>
  `${request.action} (${request.class}): ${request.resource.length > 140 ? request.resource.slice(0, 139) + '…' : request.resource}`

/** The holder as a card names it. Every link of a successor chain is titled "<first title>
 *  (continued)", so the title alone cannot tell B from C: the conversation id's last segment does. */
export const grantHolderLabel = (holder: NonNullable<PermissionGrantRequest['holder']>): string => {
  const short = holder.agentSessionId.split(/[_-]/).filter(Boolean).at(-1)?.slice(0, 8) ?? holder.agentSessionId
  return holder.title ? `${holder.title} · ${short}` : holder.agentSessionId
}

/** What the tab is told once the owner approved. */
export const grantApprovedMessage = (rule: string, scope: 'once' | 'session'): string =>
  `[Conductor] approved: ${rule}${scope === 'once' ? ' (once)' : ' (for this session)'}; retry it now. Run exactly the approved call, unchanged: the rule matches only that.`

/** What the tab is told when the owner denied. */
export const grantDeniedMessage = (request: Pick<PermissionGrantRequest, 'action' | 'resource'>): string =>
  `[Conductor] the owner denied: ${request.action} ${request.resource.length > 200 ? request.resource.slice(0, 199) + '…' : request.resource}. Do not retry it or route around it; carry on with other work or report that it is blocked.`

const parsedRule = (rule: string): { tool: string; content?: string } => {
  const open = rule.indexOf('(')
  if (open < 0 || !rule.endsWith(')')) return { tool: rule }
  const content = rule.slice(open + 1, -1).replaceAll('\\(', '(').replaceAll('\\)', ')').replaceAll('\\\\', '\\')
  return { tool: rule.slice(0, open), content }
}

/** Whether a tool call is the very call a granted rule was minted for (same tool, same exact
 *  resource), which is how an approve-once grant knows it was used. */
export function callMatchesRule(rule: string, tool: string, input: unknown, cwd: string): boolean {
  const described = describeGrantRequest({ tool, input, cwd })
  if (described.rule) return described.rule === rule
  const parsed = parsedRule(rule)
  return parsed.tool === tool && parsed.content === undefined
}
