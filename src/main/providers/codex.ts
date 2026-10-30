import { randomUUID } from 'node:crypto'
import { providerEnvironment } from '../provider-environment'
import { execFile } from 'node:child_process'
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { SteeringUnavailableError, type AdapterOptions, type ProviderAdapter, type RuntimeDetachment } from './adapter'
import { captureAdapterState, restoreAdapterState, settled } from './adapter-state'
import { currentRuntimeHost, JsonLineTransport, type HostedRuntimeHandle, type TransportOptions } from './transport'
import { relayMcpConfigs, relaysMcp } from '../runtime-host/relay-config'
import { PROVIDER_AUTH_EXPIRED, PROVIDER_OVERLOADED, PROVIDER_SAFEGUARD_REFUSAL, PROVIDER_USAGE_LIMIT } from '../../shared/structured-agent'
import { isOverloadedErrorInfo, isProviderOverloadedMessage } from '../provider-overload'
import { authExpiredMessage } from '../provider-auth'
import type { ActivityStatus, AdapterEvent, ContextAttachment, FileChange, InteractionResponse, Json, PendingInteraction, ProviderCapabilities, SessionSettings } from '../../shared/structured-agent'
import type { ClientRequest } from './generated/codex/ClientRequest'
import type { InitializeResponse } from './generated/codex/InitializeResponse'
import type { ReasoningEffort } from './generated/codex/ReasoningEffort'
import type { ServerNotification } from './generated/codex/ServerNotification'
import type { ServerRequest } from './generated/codex/ServerRequest'
import type { Model } from './generated/codex/v2/Model'
import type { ModelListResponse } from './generated/codex/v2/ModelListResponse'
import type { ThreadItem } from './generated/codex/v2/ThreadItem'
import type { ThreadStartResponse } from './generated/codex/v2/ThreadStartResponse'
import type { TurnStartParams } from './generated/codex/v2/TurnStartParams'
import type { TurnStartResponse } from './generated/codex/v2/TurnStartResponse'
import type { TurnSteerResponse } from './generated/codex/v2/TurnSteerResponse'
import type { NonSteerableTurnKind } from './generated/codex/v2/NonSteerableTurnKind'
import type { FileUpdateChange } from './generated/codex/v2/FileUpdateChange'
import type { UserInput } from './generated/codex/v2/UserInput'
import type { ConfigReadResponse } from './generated/codex/v2/ConfigReadResponse'
import type { ConfigRequirementsReadResponse } from './generated/codex/v2/ConfigRequirementsReadResponse'
import type { GetAccountResponse } from './generated/codex/v2/GetAccountResponse'
import type { GetAccountRateLimitsResponse } from './generated/codex/v2/GetAccountRateLimitsResponse'
import type { ThreadForkResponse } from './generated/codex/v2/ThreadForkResponse'
import type { ThreadGoalGetResponse } from './generated/codex/v2/ThreadGoalGetResponse'
import type { SkillsListResponse } from './generated/codex/v2/SkillsListResponse'
import type { ReviewStartResponse } from './generated/codex/v2/ReviewStartResponse'
import type { ReviewTarget } from './generated/codex/v2/ReviewTarget'
import type { ThreadCompactStartResponse } from './generated/codex/v2/ThreadCompactStartResponse'
import type { NativeSlashCommand } from '../../shared/slash-commands'
import { BROWSER_MCP_SERVER_NAME } from '../../shared/browser-mcp'
import { CODEX_FALLBACK_MODEL } from '../../shared/agent-model-selection'
import { codexConductorThreadConfig, codexLocalAssistThreadConfig, mergeCodexMcpConfigs } from '../local-assist/mcp-config'
import { canonicalAction } from '../approval-review'
import { commandClass, commandText } from '../approval-review-rules'
import { aclRepairNotice, repairSandboxReadAccess, runIcacls, type IcaclsRunner } from './codex-sandbox-acl'
import { defaultApprovalPolicy, MAX_WRITABLE_ROOTS, policyNotice, writableRootPaths, writableRootProblem, type PolicyDecision, type PolicyRequest } from '../approval-policy'

export const CODEX_PROTOCOL_BASELINE = '0.164.0'
/** Exact runtimes the fixture suite covers: the baseline and the previous minors, whose wire the
 *  adapter still speaks unchanged (docs/codex-compatibility.md, "Rebaseline 0.163.0 → 0.164.0"),
 *  so the installed app keeps its Codex tabs across a global CLI upgrade in either order. */
export const CODEX_VERIFIED_RUNTIMES: readonly string[] = [CODEX_PROTOCOL_BASELINE, '0.163.0', '0.159.1', '0.155.1']
/** Codex's own classification of a lost ChatGPT login or rejected API key (HTTP 401). */
const unauthorized = (info: unknown): boolean => info === 'unauthorized'
const safeguardRefusal = (message: string): boolean => /(?:safeguards? flagged this message|safety (?:policy|classifier).*(?:blocked|refused)|request (?:was )?refused by.*safety)/i.test(message)
type WireTransport = Pick<JsonLineTransport, 'start' | 'send' | 'close' | 'connected'> & Partial<Pick<JsonLineTransport, 'closeAndWait' | 'detach' | 'detachable'>>
/** Adapter fields that hold promises, timers or callbacks, and never travel in a detachment. */
const CODEX_TRANSIENT = ['rpc', 'starting', 'mcpStartupWaiters'] as const
/** Injectable only in backend contract tests; no renderer can supply a transport. */
export interface CodexAdapterDependencies {
  transport?: (options: TransportOptions) => WireTransport
  version?: () => Promise<string>
  requestTimeoutMs?: number
  /** The icacls.exe runner for repairing .deps/.cache read access (codex-sandbox-acl.ts), and the
   *  platform it applies on; tests replace both. */
  icacls?: IcaclsRunner
  platform?: NodeJS.Platform
}
class CodexRpcError extends Error {
  constructor(readonly code: unknown, readonly data: unknown, message: string) { super(`Codex request failed (${String(code ?? 'unknown')}): ${message}`) }
}

/** What `/review` reviews, as the Codex TUI's review picker offers it: no argument reviews the
  *  uncommitted changes, `base <branch>` the diff against a branch, `commit <sha>` one commit, and
  *  anything else is custom review instructions. */
export function codexReviewTarget(args: string): ReviewTarget {
  const text = args.trim()
  const [word, value, ...rest] = text.split(/\s+/)
  if (!text) return { type: 'uncommittedChanges' }
  if (/^(base|branch)$/i.test(word!) && value && !rest.length) return { type: 'baseBranch', branch: value }
  if (/^commit$/i.test(word!) && value && /^[0-9a-f]{4,40}$/i.test(value) && !rest.length) return { type: 'commit', sha: value, title: null }
  return { type: 'custom', instructions: text }
}
type PendingRpc = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
type PendingRequest = { request: ServerRequest; interaction: PendingInteraction; blocking: boolean }
type Correlation = Pick<AdapterEvent, 'nativeSessionId' | 'turnId' | 'itemId' | 'parentId'>
type CachedItem = { name: string; status: ActivityStatus; paths?: string[] }

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value ?? null)) as Json
const requestKey = (id: string | number): string => `${typeof id}:${id}`
const asyncQuestionId = (threadId: string, itemId: string): string => `codex-async:${threadId}:${itemId}`
const textOutput = (value: unknown): string => typeof value === 'string' ? value : JSON.stringify(value, null, 2)
const isId = (id: unknown): id is string | number => typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id))
/** A provider Unix-ms stamp as sent: any finite number. Whether it is plausible is the recorder's call. */
const finiteMs = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined
/** Auto-approval reviews kept per item and items with reviews kept at once (Codex guardian, unstable). */
const MAX_REVIEWS_PER_ITEM = 16
const MAX_REVIEWED_ITEMS = 512
/** The time covered by intervals on one clock, overlaps counted once. */
export function unionMs(intervals: Iterable<readonly [number, number]>): number {
  let total = 0, end = -Infinity
  for (const [start, stop] of [...intervals].sort((a, b) => a[0] - b[0])) {
    if (stop <= end) continue
    total += stop - Math.max(start, end)
    end = stop
  }
  return total
}
/** A completed guardian review that names its target item, with a sane interval; anything else
 *  (a network review, a reshaped payload) attributes no time to any tool. */
function reviewInterval(params: unknown): { reviewId: string; targetItemId: string; interval: [number, number] } | undefined {
  if (!record(params)) return undefined
  const { reviewId, targetItemId, startedAtMs, completedAtMs } = params
  if (typeof reviewId !== 'string' || !reviewId || reviewId.length > 256 || typeof targetItemId !== 'string' || !targetItemId || targetItemId.length > 256) return undefined
  const start = finiteMs(startedAtMs), stop = finiteMs(completedAtMs)
  if (start === undefined || stop === undefined || start < 0 || stop < start || stop - start > 7 * 24 * 60 * 60 * 1000) return undefined
  return { reviewId, targetItemId, interval: [start, stop] }
}
const statusFor = (status: string, complete: boolean): ActivityStatus => status === 'failed' ? 'failed' : status === 'declined' ? 'rejected' : status === 'interrupted' ? 'interrupted' : complete ? 'completed' : status === 'inProgress' ? 'running' : 'preparing'
/**
 * Codex's own `/permissions` presets, expressed in the modes the composer offers; the composer
 * mode is the one place a conversation's Codex permissions are chosen. Ask leaves the installed
 * CLI's configuration alone; Read only inspects; Edit runs workspace work unprompted and asks
 * before leaving the workspace; Auto asks Codex-side the same way (`on-request`, the policy its
 * own automatic mode uses) and Conductor answers for the owner: enabled MCP tools are allowed,
 * a command, file change or permission grant that has to leave the workspace sandbox is allowed
 * once unless it reaches an owner-only boundary (OWNER_ONLY_ESCALATIONS), and questions always
 * reach the owner. Under a "Review coworkers" controller the same requests are review cards
 * instead, and an isolated reviewer never executes.
 * Both workspace-write modes carry the network: a download, a pip install or an API call is
 * ordinary workspace work, and without it every one was a sandbox failure followed by an
 * escalation (codex-approval-spam, owner 2026-10-17). Until then only Auto had it: the first
 * adapter (2026b43) copied Codex's own workspace-write default, network off, and the presets
 * (67651bc) kept it for the asking modes so Codex would request it per command. A project
 * switches it off with `"network": false` in .conductor/codex-sandbox.json (codexSandboxSettings).
 * `never` is deliberately not used: under it Codex refuses, rather than asks about, any MCP tool
 * not annotated read-only (verified against codex-cli 0.155.1), which is how Auto lost every
 * browser tool. `danger-full-access` is not used either: the sandbox still fails a command first,
 * so every escalation is Codex's own justified request, answered on the record one at a time.
 */
const PERMISSION_PRESETS: Record<SessionSettings['permission'], { sandbox: NonNullable<SessionSettings['sandbox']>; approvalPolicy: NonNullable<SessionSettings['approvalPolicy']>; network: boolean; unattended: boolean }> = {
  default: { sandbox: 'inherit', approvalPolicy: 'inherit', network: false, unattended: false },
  'read-only': { sandbox: 'read-only', approvalPolicy: 'untrusted', network: false, unattended: false },
  'accept-edits': { sandbox: 'workspace-write', approvalPolicy: 'on-request', network: true, unattended: false },
  auto: { sandbox: 'workspace-write', approvalPolicy: 'on-request', network: true, unattended: true }
}
/** The Codex preset a composer mode maps to. Stored per-conversation sandbox/approval overrides
 *  from earlier versions are ignored rather than silently changing what the mode says. */
export const codexPreset = (settings: Pick<SessionSettings, 'permission'>): (typeof PERMISSION_PRESETS)[SessionSettings['permission']] => PERMISSION_PRESETS[settings.permission] ?? PERMISSION_PRESETS.default

const SYSTEM_DIRECTORY = 'a Windows system directory or the hosts file'
/** Where Auto never answers for the owner, however Codex justifies the request. A native
 *  escalation whose command, paths or permission profile reach one of these stays an owner card;
 *  everything else that has to leave the workspace sandbox — a shortcut on the desktop, a file in
 *  the profile, a process or port query — is allowed once. The test is where an action reaches,
 *  not how it is worded, and a request that names nothing Auto can check is left to the owner.
 *  Every pattern names a real system context, never a word ordinary work also uses: until
 *  2026-10-17 a bare `hosts` (`--hosts 3`), `credential` (Get-Credential, credentials.md),
 *  `vault`, `format ` (`Get-Date -Format`), `shutdown` (`server.shutdown()`), any `\startup`
 *  (Blender's scripts\startup) and any `Program Files` held ordinary work for the owner, Blender's
 *  own python.exe included (feature-list codex-approval-spam). */
const OWNER_ONLY_ESCALATIONS: ReadonlyArray<readonly [string, RegExp]> = [
  ['the registry', /\bhk(?:lm|cu|cr|u|cc)\b|hkey_|\breg(?:\.exe)?\s+(?:add|delete|import|restore|load|unload|copy)\b|regedit|registry::/i],
  ['elevation', /-verb\s+runas|\bsudo\b|\bgsudo\b|\brunas(?:\.exe)?\b|start-process\b[^|;\n]*-verb\b/i],
  ['services, scheduled tasks or startup', /\bsc(?:\.exe)?\s+(?:create|config|delete|start|stop|failure)\b|\b(?:new|set|remove|start|stop|restart|suspend)-service\b|schtasks|scheduledtask|start menu[\\/]programs[\\/]startup\b|shell:(?:common )?startup\b|winlogon|\bwmic\b/i],
  ['the firewall, network configuration or Defender', /\bnetsh\b|netfirewall|new-netroute|set-dnsclient|add-mppreference|set-mppreference|\bmpcmdrun\b|\bdefender\b|\broute\s+(?:add|delete)\b/i],
  ['a credential or key store', /\.ssh\b|\.gnupg\b|\.gpg\b|\.aws\b|\.azure\b|\.kube\b|\.docker[\\/]config|\.config[\\/]gh\b|\.git-credentials|\bgit(?:\.exe)?(?:\s+-[cC]\s+\S+)*\s+credential\b|\bgit-credential|credential\.helper|credential[\s-]?manager|\bcredman\b|\bvaultcmd\b|storedcredential\b|passwordvault|[\\/]microsoft[\\/](?:credentials|protect|vault)\b|\bvault\s+(?:kv|read|write|login|token|secrets|unseal|operator)\b|\.npmrc|\.pypirc|\.netrc|_netrc|\bcmdkey\b|keychain|\bdpapi\b|\bcertutil\b|\bcertmgr\b|\bcert:\\/i],
  ['disks, boot, accounts or permissions', /(?:^|[\s;|&"'(])format(?:\.com)?\s+[a-z]:|\bformat-volume\b|\bdiskpart\b|\bbcdedit\b|\bshutdown(?:\.exe)?\s+[/-]\w|restart-computer|stop-computer|clear-disk|remove-partition|initialize-disk|\bcipher\s+\/w|\bnet\s+(?:user|localgroup|accounts)\b|(?:new|remove|set|enable|disable)-localuser|add-localgroupmember|\bicacls\b|\btakeown\b|set-acl/i],
  ['recursive deletion', /remove-item\b[^|;\n]*-rec|\brm\s+-[a-z]*r|\brd\s+\/s|\brmdir\s+\/s|\bdel\s+\/s|\bri\s+[^|;\n]*-rec|\|\s*remove-item\b/i],
  // Last on purpose: the more specific boundary above must be the one the owner is told about.
  // The Windows folder counts at a drive's root only: \Microsoft\Windows\ inside AppData is the profile's.
  [SYSTEM_DIRECTORY, /\b[a-z]:[\\/](?:windows|winnt)\b|(?:^|[\s"'=(,])[\\/][a-z][\\/](?:windows|winnt)\b|system32|syswow64|drivers[\\/]etc|[\\/]etc[\\/]hosts\b|\$\{?env:(?:windir|systemroot)\b|%(?:windir|systemroot)%/i]
]
/** Program and machine-wide data folders are owner-only where a command writes into them, not
 *  where it reads from them or runs a program installed there: Blender and its bundled Python
 *  live under Program Files. A non-elevated write there fails anyway; ProgramData is partly
 *  writable by every user. */
const WRITE_ONLY_LOCATIONS = /\b[a-z]:[\\/](?:program ?files(?: ?\(x86\))?|programdata)\b|\$\{?env:(?:programfiles(?:\(x86\))?|programw6432|programdata|allusersprofile)\b|%(?:programfiles(?:\(x86\))?|programw6432|programdata|allusersprofile)%/gi
/** A write before such a path in the same statement: a cmdlet, command or alias that creates,
 *  changes, copies, moves or deletes files, an output redirect, or an output or destination option. */
const WRITE_VERB = /(?:^|[\s;|&(){}"'`])(?:set-content|add-content|out-file|new-item|copy-item|move-item|rename-item|remove-item|clear-content|tee-object|export-csv|export-clixml|expand-archive|compress-archive|new-itemproperty|set-itemproperty|start-bitstransfer|invoke-webrequest|invoke-restmethod|iwr|irm|sc|ac|ni|ri|rni|cpi|mi|copy|cp|xcopy|robocopy|move|mv|ren|rename|rm|del|erase|rd|rmdir|md|mkdir|touch|tee|install|ln|mklink|rsync|dd|msiexec|setx|unzip|tar|7z)(?:\.exe)?(?=[\s"'`]|$)|>|(?:^|\s)-{1,2}(?:outfile|outputdirectory|destination(?:path)?|target|prefix|output|installdir|install-dir|dest|o|t|d)(?=[\s=:"']|$)|\bwrite(?:all(?:text|bytes|lines))?\s*\(|\bopen\s*\([^)]*,\s*['"][wax]/i
/** Where a request itself says a path is written: a file-change path, a grant root, a permission write list. */
const WRITE_KEY = /"(?:path|grantroot|file_path|notebook_path|move_path|cwd)"\s*:\s*\\?"$|"write"\s*:\s*\[[^\]]*$/i

/** An absolute path's root as a command names it: a drive, Git Bash's /c/, or an environment variable. */
const PATH_ROOT = String.raw`(?:[a-z]:|\/[a-z](?=[\\/])|\$\{?env:\w+\}?|%\w+%)[\\/]`
/** Where a command names the program it runs: a statement separator or PowerShell's call operator,
 *  a shell's -Command or -c, cmd's /c or /k, Start-Process, and the start of a line (when arguments
 *  follow). The line start is last: it also matches empty, and must not hide a leading `& `. */
const PROGRAM_POSITION = /[;|&][ \t]*|(?:^|[\s"'])(?:-command|-[li]?c|\/[ck])[ \t]+(?:\\?["'])?[ \t]*|\bstart-process[ \t]+(?:-filepath[ \t]+)?|(?<line>(?:^|\n)[ \t]*)/gi
/** The program's path there: JSON-escaped, double, doubled single or single quotes (spaces allowed), or bare. */
const PROGRAM_PATH = new RegExp(String.raw`^(?:"\\"(${PATH_ROOT}[^"\n]*?)\\"|\\?"(${PATH_ROOT}[^"\n]*?)\\?"|''(${PATH_ROOT}[^'\n]*?)''|'(${PATH_ROOT}[^'\n]*?)'|"?(${PATH_ROOT}[^\s"'|;&<>()]*))`, 'i')

/** The text with every program path reduced to the program's bare name: a command is judged on
 *  what its arguments reach, not on where the program it runs is installed. Codex on Windows runs
 *  everything as `"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command '…'`
 *  (live-observed 2026-09-22, codex-cli 0.155.1), and a Blender coworker as `& 'C:/Program
 *  Files/Blender Foundation/Blender 5.2/5.2/python/bin/python.exe' script.py` inside it
 *  (2026-10-17, every one held as a system directory). A path alone on its line (a file-change
 *  path, a working directory, a file argument) is what a request touches and stays whole. */
function reducePrograms(text: string): string {
  let out = '', cursor = 0
  for (const position of text.matchAll(PROGRAM_POSITION)) {
    const at = position.index + position[0].length
    if (at < cursor) continue
    const token = PROGRAM_PATH.exec(text.slice(at))
    if (!token) continue
    const path = token[1] ?? token[2] ?? token[3] ?? token[4] ?? token[5] ?? ''
    const name = /[^\\/]+$/.exec(path)?.[0].replace(/\.(?:exe|com)$/i, '')
    const end = at + token[0].length
    if (!name || position.groups?.line !== undefined && !/^[ \t]+\S/.test(text.slice(end))) continue
    out += text.slice(cursor, at) + name
    cursor = end
  }
  return out + text.slice(cursor)
}

/** The whole word or path a boundary matched inside, for the owner to read. */
function matchedText(text: string, start: number, end: number): string {
  const edge = /[\s"'`,;|()[\]{}<>]/
  let left = start, right = end
  while (left > 0 && start - left < 80 && !edge.test(text[left - 1]!)) left--
  while (right < text.length && right - end < 80 && !edge.test(text[right]!)) right++
  const matched = text.slice(left, right).replace(/\s+/g, ' ').trim()
  return matched.length > 120 ? matched.slice(0, 119) + '…' : matched
}

/** A program or machine-data folder the text writes into, judged per statement. */
function writeTarget(acted: string): string | undefined {
  for (const match of acted.matchAll(WRITE_ONLY_LOCATIONS)) {
    const head = acted.slice(0, match.index), both = head.lastIndexOf('&&')
    const before = head.slice(Math.max(head.lastIndexOf('\n'), head.lastIndexOf(';'), head.lastIndexOf('|'), both < 0 ? -1 : both + 1) + 1)
    if (/^\s*["'\\]*$/.test(before) || WRITE_KEY.test(before) || WRITE_VERB.test(before)) return matchedText(acted, match.index, match.index + match[0].length)
  }
  return undefined
}

/** An owner-only boundary a request reaches, and the text that reaches it. */
export interface OwnerOnlyReach { boundary: string; matched: string }
/** The owner-only boundary a native escalation reaches, if any, judged on where it acts. */
export function ownerOnlyReach(reach: string): OwnerOnlyReach | undefined {
  // Codex quotes its wrapper path with doubled separators (`"C:\\WINDOWS\\System32\\…"`, live-observed
  // 2026-09-23 on every escalation of a Conductor evaluation run, and again on 2026-10-17), so
  // separator runs are collapsed first; otherwise no path reads as the path it is.
  const acted = reducePrograms(reach.replace(/\\{2,}/g, '\\'))
  for (const [boundary, pattern] of OWNER_ONLY_ESCALATIONS) {
    const match = pattern.exec(acted)
    if (match) return { boundary, matched: matchedText(acted, match.index, match.index + match[0].length) }
  }
  const written = writeTarget(acted)
  return written ? { boundary: SYSTEM_DIRECTORY, matched: written } : undefined
}
/** The owner-only boundary a native escalation reaches, if any, with the text that reaches it:
 *  `a Windows system directory or the hosts file (“C:\Windows\System32\drivers\etc\hosts”)`. Every
 *  caller says "it reaches …", so the owner, a wizard and a review's reason all read what matched. */
export const ownerOnlyEscalation = (reach: string): string | undefined => {
  const found = ownerOnlyReach(reach)
  return found && `${found.boundary} (“${found.matched}”)`
}

/** The command prefix Codex offers to remember for a command approval, exactly as offered. */
export const codexExecpolicyAmendment = (decisions: readonly unknown[]): string[] | undefined => {
  for (const decision of decisions) {
    const amendment = record(decision) && record(decision.acceptWithExecpolicyAmendment) ? decision.acceptWithExecpolicyAmendment.execpolicy_amendment : undefined
    if (Array.isArray(amendment) && amendment.length && amendment.every(part => typeof part === 'string')) return amendment
  }
  return undefined
}

/** The network rule Codex offers to allow a host for a command approval, exactly as offered. A
 *  rule that denies the host is no way to allow the request and is not returned. */
export const codexNetworkAllowAmendment = (decisions: readonly unknown[]): { host: string; action: 'allow' } & Record<string, unknown> | undefined => {
  for (const decision of decisions) {
    const amendment = record(decision) && record(decision.applyNetworkPolicyAmendment) ? decision.applyNetworkPolicyAmendment.network_policy_amendment : undefined
    if (record(amendment) && typeof amendment.host === 'string' && amendment.host && amendment.action === 'allow') return amendment as { host: string; action: 'allow' } & Record<string, unknown>
  }
  return undefined
}

/** Card choices that let a Codex request run; a card without one of them is never raised. */
const CODEX_ALLOW_CHOICES = new Set(['accept', 'acceptForSession', 'acceptWithExecpolicyAmendment', 'applyNetworkPolicyAmendment'])
/** Allow choices that write something lasting or cover more than this one request. */
const CODEX_LASTING_CHOICES = new Set(['acceptForSession', 'acceptWithExecpolicyAmendment', 'applyNetworkPolicyAmendment'])

/** A project's own Codex sandbox settings, beside .conductor/delivery.json. */
export const CODEX_SANDBOX_FILE = '.conductor/codex-sandbox.json'
/** Project folders a sandboxed command writes without asking whenever they exist as real folders:
 *  dependencies installed with pip --target .deps, and tool caches. They are inside the workspace;
 *  naming them makes the Windows sandbox grant the folder itself. That grant does not reach a
 *  package a pip install moved in from %TEMP% with a protected owner-only permission list (.deps/PIL,
 *  miron 2026-10-17): repairDependencyReadAccess (codex-sandbox-acl.ts) turns its inheritance back on. */
export const CODEX_PROJECT_WRITABLE_DIRS = ['.deps', '.cache'] as const
export interface CodexSandboxSettings {
  /** Writable roots beyond the workspace, absolute existing folders, in order. */
  writableRoots: string[]
  /** false when the project switched the sandbox network off; otherwise absent. */
  network?: false
  /** What was left out and why, one notice each. */
  problems: string[]
}
const sameFolder = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path
/** Why an expanded folder cannot widen this project's sandbox, or undefined when it can. */
function extraRootProblem(path: string, cwd: string): string | undefined {
  if (!isAbsolute(path)) return 'it is not an absolute folder path'
  let real: string
  try {
    if (!statSync(path).isDirectory()) return 'it is not a folder'
    real = realpathSync.native(path)
  } catch { return 'it does not exist (create it once, then it applies from the next turn)' }
  const problem = writableRootProblem(real)
  if (problem) return problem
  const boundary = ownerOnlyEscalation(real)
  if (boundary) return `it reaches ${boundary}`
  let project = resolve(cwd)
  try { project = realpathSync.native(cwd) } catch { /* the workspace itself is checked by its session */ }
  const inside = relative(sameFolder(real), sameFolder(project))
  if (inside === '' || !inside.startsWith('..') && !isAbsolute(inside)) return 'it contains the project itself'
  return undefined
}

/**
 * The extra writable roots and network switch of a project's workspace-write Codex sandbox:
 * - the project's own .deps and .cache folders (CODEX_PROJECT_WRITABLE_DIRS);
 * - the owner's writable roots (approval-policy.ts writableRootPaths, e.g.
 *   %LOCALAPPDATA%\NVIDIA\OptixCache, where a sandboxed Blender GPU render stalled), in every mode;
 * - the project's .conductor/codex-sandbox.json `{"writableRoots": [...], "network": false}`, with
 *   %VAR%, $env:VAR and ~ expanded and absolute folders only. The agent can change that file
 *   without asking, so its roots apply only where Conductor answers such escalations anyway
 *   (`projectRoots`: Auto); in Edit they would let it widen its own sandbox. Its `"network": false`
 *   applies in every mode: a restriction is the agent's to add.
 * Every extra root must exist, must not contain the project, and must pass the policy's
 * writableRootProblem and the owner-only boundaries, also after links are followed.
 */
export function codexSandboxSettings(cwd: string, options: { projectRoots: boolean; ownerRoots?: readonly string[] }): CodexSandboxSettings {
  const writableRoots: string[] = [], problems: string[] = []
  const seen = new Set([sameFolder(resolve(cwd))])
  const add = (path: string): void => { const key = sameFolder(resolve(path)); if (!seen.has(key)) { seen.add(key); writableRoots.push(resolve(path)) } }
  for (const name of CODEX_PROJECT_WRITABLE_DIRS) {
    try { const entry = lstatSync(join(cwd, name)); if (entry.isDirectory() && !entry.isSymbolicLink()) add(join(cwd, name)) } catch { /* not there: nothing to grant */ }
  }
  for (const root of options.ownerRoots ?? []) {
    // The owner's roots include a default (approval-policy.ts DEFAULT_WRITABLE_ROOTS: the OptiX
    // cache) that a machine without an NVIDIA GPU never has: a root that is not there does not apply.
    try { statSync(root) } catch { continue }
    const problem = extraRootProblem(root, cwd)
    if (problem) problems.push(`the owner's writable root ${root} was left out: ${problem}`)
    else add(root)
  }
  let config: Record<string, unknown> | undefined
  try {
    const text = readFileSync(join(cwd, CODEX_SANDBOX_FILE), 'utf8')
    const parsed: unknown = text.length > 64 * 1024 ? undefined : JSON.parse(text)
    if (record(parsed)) config = parsed
    else problems.push(`${CODEX_SANDBOX_FILE} must hold one JSON object of at most 64 KB; it was ignored`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') problems.push(`${CODEX_SANDBOX_FILE} could not be read (${error instanceof Error ? error.message : String(error)}); it was ignored`)
  }
  if (!config) return { writableRoots, problems }
  const unknown = Object.keys(config).filter(key => key !== 'writableRoots' && key !== 'network')
  if (unknown.length) problems.push(`${CODEX_SANDBOX_FILE} has unknown key(s) ${unknown.join(', ')}; it takes writableRoots and network`)
  if (config.network !== undefined && typeof config.network !== 'boolean') problems.push(`${CODEX_SANDBOX_FILE} "network" must be true or false`)
  const listed = config.writableRoots
  if (listed !== undefined && (!Array.isArray(listed) || !listed.every(entry => typeof entry === 'string'))) problems.push(`${CODEX_SANDBOX_FILE} "writableRoots" must be a list of folder paths`)
  else if (Array.isArray(listed) && listed.length && !options.projectRoots) problems.push(`${CODEX_SANDBOX_FILE} writable roots apply in Auto only, because the agent can change that file without asking; for Edit, the owner adds them to the auto-approve policy's writable roots (approvals.policy)`)
  else if (Array.isArray(listed)) {
    if (listed.length > MAX_WRITABLE_ROOTS) problems.push(`${CODEX_SANDBOX_FILE} lists more than ${MAX_WRITABLE_ROOTS} writable roots; the rest were left out`)
    for (const root of (listed as string[]).slice(0, MAX_WRITABLE_ROOTS)) {
      const expanded = writableRootProblem(root) ? undefined : writableRootPaths({ ...defaultApprovalPolicy(), writableRoots: [root] })[0]
      const problem = expanded === undefined ? writableRootProblem(root) ?? 'it is not an absolute folder path' : extraRootProblem(expanded, cwd)
      if (problem) problems.push(`${CODEX_SANDBOX_FILE} writable root ${root} was left out: ${problem}`)
      else add(expanded!)
    }
  }
  return { writableRoots, problems, ...(config.network === false ? { network: false as const } : {}) }
}

/** What a failed Codex command says when the CLI's Windows sandbox helper could not refresh the
 *  sandbox before the command ran. Nothing in the conversation's permission mode causes it. */
const CODEX_SANDBOX_SETUP_FAILURE = /helper_unknown_error|setup refresh had errors/

/**
 * Codex asks the client about an MCP tool call through an MCP elicitation carrying this marker
 * (verified against codex-cli 0.155.1: `mcpServer/elicitation/request`, mode `form`,
 * `_meta.codex_approval_kind = "mcp_tool_call"`, `_meta.persist` naming the scopes the answer may
 * be kept for). Other elicitations — URL, verification, forms with fields — stay unsupported and
 * are answered with an explicit JSON-RPC error.
 */
export function codexMcpToolApproval(params: unknown): { serverName: string; tool: string; message: string; persist: string[] } | undefined {
  if (!record(params) || params.mode !== 'form' || typeof params.serverName !== 'string' || !record(params._meta) || params._meta.codex_approval_kind !== 'mcp_tool_call') return undefined
  const message = typeof params.message === 'string' ? params.message : ''
  const tool = /run tool "([^"]+)"/.exec(message)?.[1] ?? (typeof params._meta.tool_name === 'string' ? params._meta.tool_name : 'tool')
  const persist = Array.isArray(params._meta.persist) ? params._meta.persist.filter((value): value is string => typeof value === 'string') : []
  return { serverName: params.serverName, tool, message: message || `Allow the ${params.serverName} MCP server to run tool "${tool}"?`, persist }
}

/** Browser tools that write files into the project (captures, downloads). */
const BROWSER_WRITING_TOOLS = new Set(['browser_video_frames', 'browser_download'])

const LIVE_DISABLED_FEATURES = ['hooks', 'plugins', 'apps', 'multi_agent', 'multi_agent_v2', 'browser_use', 'browser_use_external', 'computer_use', 'memories', 'unbounded_connection_retries'] as const

/** What a lean evaluation turn (AgentSpec.profile) switches off: optional features that only add tools
 *  or context to a one-prompt text answer. Hooks stay on: Codex keeps its tools, and a hook may be a guard. */
export const EVALUATION_DISABLED_FEATURES = ['plugins', 'apps', 'multi_agent', 'multi_agent_v2', 'browser_use', 'browser_use_external', 'computer_use', 'memories'] as const

/** Process-local CLI overrides; never writes the user's configuration or changes authentication. */
export function codexLaunchArguments(environment: NodeJS.ProcessEnv, profile?: AdapterOptions['profile']): string[] {
  const args = ['app-server', '--listen', 'stdio://']
  if (environment.CONDUCTOR_LIVE_TESTS !== '1') {
    if (profile !== 'evaluation') return args
    for (const feature of EVALUATION_DISABLED_FEATURES) args.push('--disable', feature)
    args.push('-c', 'web_search="disabled"', '-c', 'memories.generate_memories=false', '-c', 'memories.use_memories=false')
    return args
  }
  if (!environment.CONDUCTOR_LIVE_MODEL_CODEX || !['cli', 'api'].includes(environment.CONDUCTOR_LIVE_AUTH_CODEX ?? '')) throw new Error('Codex live tests require an explicit approved model and authentication mode')
  const servers: unknown = JSON.parse(environment.CONDUCTOR_LIVE_OPTIONAL_MCP ?? '[]')
  if (!Array.isArray(servers) || servers.length > 128 || servers.some(server => typeof server !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(server))) throw new Error('Live optional MCP names must be an explicit bounded list of simple names without dots or quotes')
  for (const feature of LIVE_DISABLED_FEATURES) args.push('--disable', feature)
  args.push('-c', 'web_search="disabled"', '-c', 'notify=[]', '-c', 'memories.generate_memories=false', '-c', 'memories.use_memories=false')
  // Codex's dotted override-key parser is not a TOML key parser: quotes become literal name bytes.
  for (const server of servers) args.push('-c', `mcp_servers.${server}.enabled=false`)
  return args
}

export function validateCodexLiveConfiguration(config: ConfigReadResponse, requirements: ConfigRequirementsReadResponse): void {
  const effective = config.config
  const features = record(effective.features) ? effective.features : {}
  if (LIVE_DISABLED_FEATURES.some(feature => features[feature] !== false)) throw new Error('Codex live isolation could not verify disabled optional features')
  if (effective.web_search !== 'disabled' || !Array.isArray(effective.notify) || effective.notify.length) throw new Error('Codex live isolation could not verify web/notification restrictions')
  const memories = record(effective.memories) ? effective.memories : {}
  if (memories.generate_memories !== false || memories.use_memories !== false) throw new Error('Codex live isolation could not verify memory restrictions')
  const servers = record(effective.mcp_servers) ? effective.mcp_servers : {}
  if (Object.values(servers).some(server => !record(server) || server.enabled !== false)) throw new Error('Codex live isolation found an enabled MCP server; declare optional servers explicitly before testing')
  const required = requirements.requirements
  if (required?.hooks || required?.allowManagedHooksOnly || LIVE_DISABLED_FEATURES.some(feature => required?.featureRequirements?.[feature] === true) || required?.allowedWebSearchModes && !required.allowedWebSearchModes.includes('disabled')) throw new Error('Live isolation conflicts with required organizational policy; no thread was started')
  for (const layer of config.layers ?? []) {
    if (layer.disabledReason || !['mdm', 'system', 'enterpriseManaged', 'legacyManagedConfigTomlFromFile', 'legacyManagedConfigTomlFromMdm'].includes(layer.name.type) || !record(layer.config)) continue
    if (['hooks', 'plugins', 'mcp_servers', 'notify'].some(key => layer.config !== null && record(layer.config) && layer.config[key] !== undefined && JSON.stringify(layer.config[key]) !== '{}' && JSON.stringify(layer.config[key]) !== '[]')) throw new Error('Live isolation would suppress managed integrations; no thread was started')
    const managedFeatures = record(layer.config.features) ? layer.config.features : {}
    if (LIVE_DISABLED_FEATURES.some(feature => managedFeatures[feature] === true)) throw new Error('Live isolation would suppress a managed feature; no thread was started')
  }
}

/** Preserve administrator skills and existing enablement entries; disable only discovered optional paths. */
export function codexLiveSkillOverrides(discovered: SkillsListResponse, config: ConfigReadResponse): Json {
  if (!Array.isArray(discovered.data) || discovered.data.length === 0 || discovered.data.some(entry => !Array.isArray(entry.skills) || entry.errors.length > 0)) throw new Error('Live skill discovery was incomplete; optional context cannot be isolated safely')
  for (const layer of config.layers ?? []) {
    if (!layer.disabledReason && ['mdm', 'system', 'enterpriseManaged', 'legacyManagedConfigTomlFromFile', 'legacyManagedConfigTomlFromMdm'].includes(layer.name.type) && record(layer.config) && record(layer.config.skills) && Object.keys(layer.config.skills).length) throw new Error('Managed skill configuration requires preserving its policy; live isolation is blocked')
  }
  const skillConfig = record(config.config.skills) ? config.config.skills : {}
  const inherited = skillConfig.config ?? []
  if (!Array.isArray(inherited) || inherited.some(entry => !record(entry) || typeof entry.path !== 'string' || typeof entry.enabled !== 'boolean')) throw new Error('Unknown native skill enablement shape; live isolation cannot replace it safely')
  const overrides = new Map<string, { path: string; enabled: boolean }>()
  for (const entry of inherited) overrides.set((entry as { path: string }).path, entry as { path: string; enabled: boolean })
  for (const entry of discovered.data) for (const skill of entry.skills) {
    if (skill.scope === 'admin' || !skill.enabled) continue
    if (!['user', 'repo', 'system'].includes(skill.scope) || typeof skill.path !== 'string' || !skill.path || skill.path.length > 4096) throw new Error('Unknown skill scope or path; live isolation is blocked')
    overrides.set(skill.path, { path: skill.path, enabled: false })
  }
  if (overrides.size > 2048) throw new Error('Live skill inventory exceeded the bounded preflight limit')
  return { 'skills.config': [...overrides.values()] }
}

/** The thread config of a lean evaluation turn: every MCP server the owner's configuration enables and
 *  every optional (user, repo, system) skill switched off for this one thread, as dotted overrides like
 *  the verified `-c mcp_servers.<name>.enabled=false`. Best effort: what could not be read stays as it is,
 *  and a name the dotted-key parser cannot carry is left alone. Undefined when there is nothing to turn off. */
export function codexEvaluationThreadConfig(config: ConfigReadResponse | null, skills: SkillsListResponse | null): Json | undefined {
  const overrides: Record<string, Json> = {}
  const servers = config && record(config.config.mcp_servers) ? config.config.mcp_servers : {}
  for (const [name, server] of Object.entries(servers)) {
    if (/^[a-zA-Z0-9_-]{1,128}$/.test(name) && !(record(server) && server.enabled === false)) overrides[`mcp_servers.${name}.enabled`] = false
  }
  const optional = (skills?.data ?? []).flatMap(entry => Array.isArray(entry.skills) ? entry.skills : [])
    .filter(skill => skill.enabled && skill.scope !== 'admin' && typeof skill.path === 'string' && skill.path.length > 0 && skill.path.length <= 4096)
  if (optional.length) {
    const inherited = config && record(config.config.skills) && Array.isArray(config.config.skills.config) ? config.config.skills.config : []
    const entries = new Map<string, Json>()
    for (const entry of inherited) if (record(entry) && typeof entry.path === 'string' && typeof entry.enabled === 'boolean') entries.set(entry.path, { path: entry.path, enabled: entry.enabled })
    for (const skill of optional.slice(0, 2048)) entries.set(skill.path, { path: skill.path, enabled: false })
    overrides['skills.config'] = [...entries.values()]
  }
  return Object.keys(overrides).length ? overrides : undefined
}

const mergeEvaluationConfig = (base: Json | undefined, lean: Json | undefined): Json | undefined =>
  record(base) && record(lean) ? { ...base, ...lean } : lean ?? base

/** Reads only the exact loopback browser configuration minted by BrowserMcpServer. This is a
 * thread config, never a process argument, so the per-session bearer token stays out of argv. */
export function codexBrowserMcpThreadConfig(configuration: string | undefined): Json | undefined {
  if (!configuration) return undefined
  const source = configuration.trim().startsWith('{') ? configuration : readFileSync(configuration, 'utf8')
  if (source.length > 64 * 1024) throw new Error('Codex browser MCP configuration is too large')
  let parsed: unknown
  try { parsed = JSON.parse(source) } catch { throw new Error('Codex browser MCP configuration is malformed') }
  if (!record(parsed) || !record(parsed.mcp_servers) || Object.keys(parsed.mcp_servers).length !== 1) throw new Error('Codex browser MCP configuration has an invalid server set')
  const browser = parsed.mcp_servers[BROWSER_MCP_SERVER_NAME]
  if (!record(browser) || typeof browser.url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(browser.url) || !record(browser.http_headers) || typeof browser.http_headers.Authorization !== 'string' || !/^Bearer [a-f0-9]{64}$/.test(browser.http_headers.Authorization)) throw new Error('Codex browser MCP configuration is not a scoped loopback credential')
  return json(parsed)
}

/** Counts only actual unified-diff hunk lines, never headers or prose. */
export function codexDiffCounts(patch: string): { additions: number; deletions: number } | undefined {
  let inHunk = false
  let additions = 0
  let deletions = 0
  let foundHunk = false
  for (const line of patch.split('\n')) {
    if (/^@@(?: |$)/.test(line)) { inHunk = true; foundHunk = true; continue }
    if (/^(diff --git |--- |\+\+\+ )/.test(line)) { inHunk = false; continue }
    if (!inHunk) continue
    if (line.startsWith('+')) additions++
    if (line.startsWith('-')) deletions++
  }
  return foundHunk ? { additions, deletions } : undefined
}

export function codexChanges(changes: FileUpdateChange[], status: FileChange['status']): FileChange[] {
  return changes.map(change => {
    const moved = change.kind.type === 'update' ? change.kind.move_path : null
    return {
      path: moved || change.path,
      ...(moved ? { oldPath: change.path } : {}),
      kind: moved ? 'rename' : change.kind.type,
      patch: change.diff,
      ...codexDiffCounts(change.diff),
      status,
      limitation: 'Provider patch supplied; full versions and undo require verified reconstruction by the artifact store.'
    }
  })
}

export function codexInput(text: string, attachments: ContextAttachment[] = []): UserInput[] {
  const input: UserInput[] = [{ type: 'text', text, text_elements: [] }]
  for (const attachment of attachments) {
    if (attachment.kind === 'image') {
      if (!attachment.path) throw new Error('Codex image attachments require a validated local path')
      input.push({ type: 'localImage', path: attachment.path })
      continue
    }
    const range = attachment.startLine ? `:${attachment.startLine}${attachment.endLine ? `-${attachment.endLine}` : ''}` : ''
    const label = `${attachment.kind}: ${attachment.path ?? attachment.name}${range}`
    input.push({ type: 'text', text: `[Attached ${label}]${attachment.content === undefined ? '' : `\n${attachment.content}`}`, text_elements: [] })
  }
  return input
}

/** One App Server process per backend-owned session; views never construct this class. */
export class CodexAdapter implements ProviderAdapter {
  readonly provider = 'codex' as const
  private readonly providerCapabilities: ProviderCapabilities = {
    provider: 'codex', runtimeVersion: 'unknown', adapterVersion: 1, authentication: 'cli',
    steering: false, textStreaming: true, toolInputStreaming: false, toolOutputStreaming: true,
    // Pre-discovery ladder: the union the installed CLI advertised on 2026-09-21 (no model offers
    // `minimal`); model/list replaces it per model once the thread starts.
    approvals: true, questions: true, resume: true, fork: true, plans: false, imageAttachments: true, effort: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], models: [], permissions: ['default', 'read-only', 'accept-edits', 'auto'],
    sandboxModes: ['inherit', 'read-only', 'workspace-write'], approvalPolicies: ['inherit', 'untrusted', 'on-request', 'never'],
    limitations: [
      'Command output combines stdout and stderr in the App Server item protocol.',
      'Before/after bytes are not exposed; undo is available only when the artifact store verifies complete immutable versions against the provider patch.',
      'App Server processes end when the Conductor backend exits. Resume is explicit and never resends a turn.',
      'Plan mode requires CONDUCTOR_CODEX_EXPERIMENTAL=1 and the tested runtime version.',
      'Cloud delegation, browser sessions, MCP elicitation forms, and plugin management have no native Conductor control yet.'
    ]
  }
  private transport?: WireTransport
  private starting?: Promise<void>
  private disposed = false
  private failed = false
  /** Set once the first account allowance report of this runtime has been recorded. */
  private accountBaseline = false
  private requestId = 0
  private rpc = new Map<string, PendingRpc>()
  private pending = new Map<string, PendingRequest>()
  private items = new Map<string, CachedItem>()
  private childParents = new Map<string, string>()
  private threadId?: string
  private turnId?: string
  private turnKind?: NonSteerableTurnKind
  private dispatching = false
  private interrupted = false
  private liveRetryStopped = false
  /** Retains both completion identity and its terminal phase. A very fast turn can complete
   * before the turn/start response arrives; that later acknowledgement still confirms the
   * accepted request settings, but must re-emit the exact terminal phase rather than `running`. */
  private completedTurns = new Map<string, 'completed' | 'failed' | 'interrupted'>()
  private completedItems = new Set<string>()
  /** Completed auto-approval review intervals by target item and reviewId, until that item completes. */
  private reviews = new Map<string, Map<string, [number, number]>>()
  private defaults?: ThreadStartResponse
  private models: Model[] = []
  private experimental = false
  /** Names this conversation's MCP routes in the runtime host's relay (runtime-host/relay.ts). */
  private relayKey = randomUUID()
  /** The App Server reaches Conductor's MCP servers through the relay, so a reattaching app re-points them. */
  private mcpRelayed = false
  /** Auto answers enabled MCP requests; other native approvals remain pending. */
  private unattended = false
  /** The current turn runs in Read only: the browser tools that write files keep their cards. */
  private readOnly = false
  /** A changed payload cannot reuse its old card identity again in this runtime. */
  private invalidApprovalRequests = new Set<string>()
  /** Requests Auto answered itself, by canonical arguments: a repeated delivery gets no second
   *  response, and a reused identity with other arguments is refused like a reused card. */
  private autoAnswered = new Map<string, string>()
  /** Command classes (sessionClassOf) the owner or a wizard allowed for this session in this
   *  runtime, with the request title that was allowed: a later command of the same class is
   *  answered without a card, as Codex's own session grant would. */
  private sessionClasses = new Map<string, string>()
  /** Sandbox setting problems already told in this runtime, and the extra writable roots last announced. */
  private sandboxNotices = new Set<string>()
  private sandboxRoots = ''
  /** Project dependency folder → the modification time its permissions were last checked at. */
  private aclChecked = new Map<string, number>()
  private sandboxSetupNoticed = false
  /** MCP servers Codex reported for this thread and their latest startup state. */
  private mcpStartup = new Map<string, string>()
  private mcpStartupWaiters: Array<() => void> = []

  constructor(private options: AdapterOptions, private dependencies: CodexAdapterDependencies = {}) {}

  get capabilities(): ProviderCapabilities {
    this.providerCapabilities.steering = Boolean(this.turnId && !this.turnKind && !this.dispatching && !this.interrupted && !this.failed && !this.disposed && this.transport?.connected)
    return this.providerCapabilities
  }

  start(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Codex adapter has been disposed'))
    return this.starting ??= this.options.attach ? this.attachRunning(this.options.attach) : this.initialize()
  }

  private createTransport(attach?: HostedRuntimeHandle): WireTransport {
    const factory = this.dependencies.transport ?? (options => new JsonLineTransport(options))
    return factory({
      executable: this.options.executable, args: codexLaunchArguments(this.options.environment ?? process.env, this.options.profile),
      cwd: this.options.cwd, environment: this.options.environment, ...(attach ? { attach } : {}),
      onMessage: message => this.receive(message),
      onStderr: output => this.emit({ data: { type: 'notice', message: 'Codex process diagnostic (stderr)', payload: output }, native: { method: 'process/stderr' } }),
      onError: error => this.disconnect(error.message),
      onExit: (code, signal) => this.disconnect(`Codex App Server exited (${signal ?? code ?? 'unknown'}). Any unfinished execution is uncertain.`)
    })
  }

  /** Lets the runtime host keep this App Server running for the next app process (docs/runtime-host.md). */
  async detach(): Promise<RuntimeDetachment | null> {
    const transport = this.transport
    if (this.disposed || this.failed || !this.threadId || !transport?.detachable || !transport.detach) return null
    if (!await settled(() => this.rpc.size === 0 && !this.dispatching) || this.disposed || this.failed || !transport.detachable) return null
    // Detaching stops delivery synchronously, so the state below is exactly what the next process
    // continues from: the first frame it handles is the first one this process did not.
    const handle = transport.detach()
    const state = captureAdapterState(this, CODEX_TRANSIENT)
    this.disposed = true
    const detached = await handle
    return detached ? { state, transport: detached } : null
  }

  private relayNotice(error: Error): void {
    this.emit({ data: { type: 'notice', message: `Conductor's MCP servers could not be relayed through the runtime host: ${error.message}` } })
  }

  private async attachRunning(detachment: RuntimeDetachment): Promise<void> {
    restoreAdapterState(this, detachment.state)
    this.disposed = false
    // The App Server still calls the relay it was given; its routes now lead to this app's servers.
    if (this.mcpRelayed) await relayMcpConfigs(currentRuntimeHost(), this.relayKey, [this.options.mcpConfig, this.options.localAssistMcpConfig, this.options.conductorMcpConfig], error => this.relayNotice(error))
    this.transport = this.createTransport(detachment.transport)
    this.transport.start()
    // The store closed this conversation's open work when it loaded (an app that stopped is
    // assumed to have ended its turn), so the adapter restates what is still live.
    for (const [key, item] of this.items) {
      if (item.status !== 'preparing' && item.status !== 'running' && item.status !== 'awaiting_approval') continue
      const [nativeSessionId, turnId, itemId] = JSON.parse(key) as [string | undefined, string | undefined, string | undefined]
      if (itemId) this.emit({ nativeSessionId: nativeSessionId ?? undefined, turnId: turnId ?? undefined, itemId, data: { type: 'tool', name: item.name, status: item.status } })
    }
    for (const pending of this.pending.values()) this.emitInteraction(pending.request, pending.interaction)
    this.emitPhase(true)
  }

  private async initialize(): Promise<void> {
    this.emit({ data: { type: 'session', phase: 'starting' } })
    this.unattended = codexPreset(this.options.settings).unattended
    this.readOnly = codexPreset(this.options.settings).sandbox === 'read-only'
    try {
      const version = await (this.dependencies.version?.() ?? new Promise<string>((resolve, reject) => {
        execFile(this.options.executable, ['--version'], { cwd: this.options.cwd, env: providerEnvironment(this.options.environment ?? process.env), windowsHide: true, timeout: 10_000, maxBuffer: 4096 }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()))
      }))
      this.capabilities.runtimeVersion = version.replace(/^codex-cli\s+/, '')
      if (!/^0\.(?:155|159|163|164)\./.test(this.capabilities.runtimeVersion)) throw new Error(`Codex ${this.capabilities.runtimeVersion} is outside the tested 0.155.x/0.159.x/0.163.x/0.164.x protocol baseline; regenerate and verify the adapter before connecting`)
      const verified = CODEX_VERIFIED_RUNTIMES.includes(this.capabilities.runtimeVersion)
      if (!verified) this.capabilities.limitations.push(`Runtime ${this.capabilities.runtimeVersion} is not fixture-verified; baseline is ${CODEX_PROTOCOL_BASELINE}. Experimental features are disabled.`)
      this.experimental = (this.options.environment ?? process.env).CONDUCTOR_CODEX_EXPERIMENTAL === '1' && verified
      this.capabilities.plans = this.experimental
      this.transport = this.createTransport()
      this.transport.start()
      // No initialized notification, metadata request, or thread request may precede this response.
      const initialized = await this.request<InitializeResponse>('initialize', {
        clientInfo: { name: 'conductor', title: 'Conductor', version: '1' },
        capabilities: { experimentalApi: this.experimental, requestAttestation: false }
      })
      if (!record(initialized) || typeof initialized.userAgent !== 'string') throw new Error('Malformed Codex initialize response')
      this.transport.send({ method: 'initialized' })
      const liveEnvironment = this.options.environment ?? process.env
      // Conductor's MCP servers get a new port and credential every launch; an App Server kept by the
      // runtime host calls them through the host's relay, whose address never changes. The app's own
      // configs are validated first, then the relayed ones again below.
      const host = currentRuntimeHost()
      const own = [codexBrowserMcpThreadConfig(this.options.mcpConfig) ? this.options.mcpConfig : undefined, codexLocalAssistThreadConfig(this.options.localAssistMcpConfig) ? this.options.localAssistMcpConfig : undefined, codexConductorThreadConfig(this.options.conductorMcpConfig) ? this.options.conductorMcpConfig : undefined]
      const mcp = this.transport.detachable && relaysMcp(host) && own.some(Boolean) ? await relayMcpConfigs(host, this.relayKey, own, error => this.relayNotice(error)) : own
      this.mcpRelayed = mcp.some((config, index) => config !== own[index])
      let threadConfig = mergeCodexMcpConfigs(codexBrowserMcpThreadConfig(mcp[0]), codexLocalAssistThreadConfig(mcp[1]), codexConductorThreadConfig(mcp[2]))
      if (liveEnvironment.CONDUCTOR_LIVE_TESTS === '1') {
        if (threadConfig) throw new Error('Codex live isolation cannot enable the Conductor browser MCP')
        const requirements = await this.request<ConfigRequirementsReadResponse>('configRequirements/read')
        const config = await this.request<ConfigReadResponse>('config/read', { cwd: this.options.cwd, includeLayers: true })
        validateCodexLiveConfiguration(config, requirements)
        const discoveredSkills = await this.request<SkillsListResponse>('skills/list', { cwds: [this.options.cwd], forceReload: true })
        threadConfig = codexLiveSkillOverrides(discoveredSkills, config)
        const account = await this.request<GetAccountResponse>('account/read', { refreshToken: false })
        const expectedType = liveEnvironment.CONDUCTOR_LIVE_AUTH_CODEX === 'api' ? 'apiKey' : 'chatgpt'
        if (account.account?.type !== expectedType || config.config.model_provider && config.config.model_provider !== 'openai') throw new Error('Configured Codex authentication/billing route does not match the approved live connection')
        const catalog = await this.request<ModelListResponse>('model/list', { limit: 100, includeHidden: false })
        if (!catalog.data.some(model => model.model === liveEnvironment.CONDUCTOR_LIVE_MODEL_CODEX && model.supportedReasoningEfforts.some(effort => effort.reasoningEffort === 'low'))) throw new Error('The approved Codex live model with low effort is unavailable; no substitution is allowed')
        this.emit({ data: { type: 'notice', message: 'Codex live fixture isolation verified before thread creation', payload: { authentication: expectedType, model: liveEnvironment.CONDUCTOR_LIVE_MODEL_CODEX!, disabledOptionalFeatures: [...LIVE_DISABLED_FEATURES] } } })
      }
      // A lean evaluation turn (AgentSpec.profile) also leaves the owner's own MCP servers and optional skills off.
      if (this.options.profile === 'evaluation' && liveEnvironment.CONDUCTOR_LIVE_TESTS !== '1') threadConfig = mergeEvaluationConfig(threadConfig, await this.evaluationThreadConfig())
      const method = this.options.nativeSessionId ? 'thread/resume' : 'thread/start'
      const params = this.options.nativeSessionId
        ? { threadId: this.options.nativeSessionId, cwd: this.options.cwd, excludeTurns: true, ...(threadConfig ? { config: threadConfig } : {}) }
        : { cwd: this.options.cwd, ...(threadConfig ? { config: threadConfig } : {}), ...(liveEnvironment.CONDUCTOR_LIVE_TESTS === '1' ? { model: liveEnvironment.CONDUCTOR_LIVE_MODEL_CODEX } : this.options.settings.model ? { model: this.options.settings.model } : {}) }
      let result: ThreadStartResponse
      try { result = await this.request<ThreadStartResponse>(method, json(params)) } catch (error) {
        // A conversation that never completed a turn has no rollout on disk, so the CLI cannot
        // resume it — and the browser toggle reconnects exactly such fresh conversations. Nothing
        // durable is lost by starting a new native thread; the session event records its identity.
        if (method !== 'thread/resume' || !(error instanceof CodexRpcError) || !/no rollout found/i.test(error.message)) throw error
        this.emit({ data: { type: 'notice', message: 'Codex had no saved history for this conversation yet, so a new native conversation was started in its place.', payload: { threadId: this.options.nativeSessionId ?? null } }, native: { method, payload: { error: error.message } } })
        result = await this.request<ThreadStartResponse>('thread/start', json({ cwd: this.options.cwd, ...(threadConfig ? { config: threadConfig } : {}), ...(this.options.settings.model ? { model: this.options.settings.model } : {}) }))
      }
      if (!record(result) || !record(result.thread) || typeof result.thread.id !== 'string') throw new Error('Malformed Codex thread response')
      this.threadId = result.thread.id
      this.defaults = result
      this.capabilities.effectiveSettings = json({ model: result.model, effort: result.reasoningEffort, approvalPolicy: result.approvalPolicy, sandbox: result.sandbox, unattended: this.unattended })
      // Historical hydration belongs to durable local replay. Never replay old items as new work.
      const active = result.thread.turns?.find(turn => turn.status === 'inProgress')
      if (active) {
        this.turnId = active.id
        if (active.items.some(item => item.type === 'enteredReviewMode')) this.turnKind = 'review'
        else if (active.items.some(item => item.type === 'contextCompaction')) this.turnKind = 'compact'
      }
      else if (record(result.thread.status) && result.thread.status.type === 'active') {
        throw new Error('The resumed Codex thread is active but its turn identity is unavailable. No prompt was sent; reconnect explicitly after it stops.')
      }
      this.emit({ data: { type: 'notice', message: 'Codex effective thread settings', payload: json({ model: result.model, reasoningEffort: result.reasoningEffort, approvalPolicy: result.approvalPolicy, sandbox: result.sandbox, approvalsReviewer: result.approvalsReviewer, instructionSources: result.instructionSources }) }, native: { method, payload: json({ threadId: this.threadId, modelProvider: result.modelProvider }) } })
      try {
        const catalog = await this.request<ModelListResponse>('model/list', { limit: 100, includeHidden: false })
        this.models = Array.isArray(catalog.data) ? catalog.data : []
        this.capabilities.models = this.models.map(model => ({ id: model.model, label: model.displayName, effort: model.supportedReasoningEfforts.map(option => option.reasoningEffort), defaultEffort: model.defaultReasoningEffort, isDefault: model.isDefault }))
        this.capabilities.effort = [...new Set(this.models.flatMap(model => model.supportedReasoningEfforts.map(option => option.reasoningEffort)))]
      } catch { this.capabilities.limitations.push('Model discovery failed; model and effort availability are unknown until the runtime accepts a turn.') }
      // The first message often follows this connection within milliseconds, and a turn that starts
      // before the thread's MCP servers finished starting simply does not see their tools. Wait,
      // bounded, for the servers Codex reported as starting; a thread without any waits ~0.4s.
      await this.awaitMcpStartup()
      this.emit({ data: { type: 'session', phase: this.turnId ? 'running' : 'idle', nativeSessionId: this.threadId, capabilities: this.capabilities } })
    } catch (error) {
      this.disconnect(error instanceof Error ? error.message : 'Codex connection failed')
      this.transport?.close()
      throw error
    }
  }

  /** Reads what the owner's configuration would add to a lean evaluation thread (codexEvaluationThreadConfig).
   *  A read that fails leaves that part as configured and says so; the evaluation still runs. */
  private async evaluationThreadConfig(): Promise<Json | undefined> {
    const read = async <T>(method: ClientRequest['method'], params: Json): Promise<T | null> => {
      try { return await this.request<T>(method, params) } catch (error) {
        this.emit({ data: { type: 'notice', message: `Evaluation profile: ${method} failed, so its part of the owner's Codex configuration stays on: ${error instanceof Error ? error.message : String(error)}` } })
        return null
      }
    }
    const config = await read<ConfigReadResponse>('config/read', { cwd: this.options.cwd, includeLayers: false })
    const skills = await read<SkillsListResponse>('skills/list', { cwds: [this.options.cwd], forceReload: false })
    return codexEvaluationThreadConfig(config, skills)
  }

  async submit(text: string, settings: SessionSettings, attachments?: ContextAttachment[]): Promise<void> {
    await this.start()
    // Before the turn guards, so no await sits between them and `dispatching`.
    await this.repairDependencyReadAccess()
    if (this.disposed || this.failed || !this.threadId || !this.defaults || !this.transport?.connected) throw new Error('Codex session is disconnected; resume explicitly')
    if (this.turnId || this.dispatching || this.pending.size) throw new Error('A Codex turn or interaction is already active')
    if (settings.plan && !this.experimental) throw new Error('Codex plan mode requires the explicitly enabled experimental protocol')
    // A conversation opened before discovery carries the stand-in CODEX_FALLBACK_MODEL. A CLI too
    // old to be served it (gpt-6.1-sol needs codex-cli 0.159) runs its own default instead.
    const standIn = settings.model === CODEX_FALLBACK_MODEL && this.models.length > 0 && !this.models.some(candidate => candidate.model === CODEX_FALLBACK_MODEL)
    const model = (standIn ? undefined : settings.model) || this.defaults.model
    const modelInfo = this.models.find(candidate => candidate.model === model)
    if (settings.effort && modelInfo && !modelInfo.supportedReasoningEfforts.some(option => option.reasoningEffort === settings.effort)) throw new Error(`Reasoning effort ${settings.effort} is not offered for ${model}`)
    if (settings.effort && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(settings.effort)) throw new Error('Unsupported Codex reasoning effort')
    // The composer mode is the one place Codex permissions are chosen; stored per-conversation
    // sandbox/approval overrides from earlier versions no longer take part.
    const preset = codexPreset(settings)
    const { sandbox, approvalPolicy } = preset
    // A workspace-write turn carries the project's extra writable roots and its network switch,
    // read again every turn so a changed setting applies from the next message (codexSandboxSettings).
    const workspace = sandbox === 'workspace-write' ? codexSandboxSettings(this.options.cwd, { projectRoots: preset.unattended, ownerRoots: writableRootPaths() }) : undefined
    for (const problem of workspace?.problems ?? []) this.sandboxNotice(problem)
    const roots = (workspace?.writableRoots ?? []).join(', ')
    if (workspace && roots !== this.sandboxRoots) {
      this.sandboxRoots = roots
      if (roots) this.emit({ data: { type: 'notice', message: `Codex sandbox: besides the workspace, these folders are writable without asking: ${roots}.`, payload: { writableRoots: workspace.writableRoots } } })
    }
    const networkAccess = preset.network && workspace?.network !== false
    this.unattended = preset.unattended
    this.readOnly = preset.sandbox === 'read-only'
    if (!this.capabilities.sandboxModes!.includes(sandbox) || !this.capabilities.approvalPolicies!.includes(approvalPolicy)) throw new Error('Unsupported Codex sandbox or approval policy')
    const params: TurnStartParams = {
      threadId: this.threadId, input: codexInput(text, attachments), cwd: this.options.cwd, model,
      effort: (settings.effort as ReasoningEffort | undefined) ?? (modelInfo ? modelInfo.supportedReasoningEfforts.length ? modelInfo.defaultReasoningEffort : null : model === this.defaults.model ? this.defaults.reasoningEffort : null),
      approvalPolicy: approvalPolicy === 'inherit' ? this.defaults.approvalPolicy : approvalPolicy,
      // Auto's requests are answered by Conductor, so they are routed to this client rather than
      // to an approvals reviewer the CLI configuration may name.
      ...(preset.unattended ? { approvalsReviewer: 'user' as const } : {}),
      sandboxPolicy: sandbox === 'inherit' ? this.defaults.sandbox : sandbox === 'read-only'
        ? { type: 'readOnly', networkAccess: false }
        : { type: 'workspaceWrite', writableRoots: [this.options.cwd, ...workspace?.writableRoots ?? []], networkAccess, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
    }
    // Native collaboration mode survives adapter reconstruction/resume. Always
    // apply the selected mode when this version-gated surface is enabled.
    if (this.experimental) params.collaborationMode = {
      mode: settings.plan ? 'plan' : 'default',
      settings: { model, reasoning_effort: params.effort ?? null, developer_instructions: null }
    }
    this.turnKind = undefined
    this.dispatching = true
    this.interrupted = false
    this.liveRetryStopped = false
    this.items.clear()
    this.completedItems.clear()
    try {
      const result = await this.request<TurnStartResponse>('turn/start', json(params))
      if (!result.turn || typeof result.turn.id !== 'string') throw new Error('Malformed Codex turn response; execution state is uncertain')
      const completedPhase = this.completedTurns.get(result.turn.id)
      this.capabilities.effectiveSettings = json({ model: params.model, effort: params.effort, approvalPolicy: params.approvalPolicy, sandbox: params.sandboxPolicy, unattended: this.unattended })
      if (!completedPhase) {
        this.turnId = result.turn.id
        this.emit({ data: { type: 'session', phase: 'running', capabilities: this.capabilities } })
      } else this.emit({ data: { type: 'session', phase: completedPhase, capabilities: this.capabilities } })
    } catch (error) {
      // A lost acknowledgement is not permission to retry or claim that nothing executed.
      this.disconnect(error instanceof Error ? error.message : 'Codex turn dispatch failed')
      throw error
    } finally { this.dispatching = false; if (this.turnId) this.emitPhase(true) }
  }

  private steeringInputs = new Map<string, string>()

  private inputDelivery(inputId: string, status: 'accepted' | 'delivered' | 'cancelled' | 'uncertain', native?: AdapterEvent['native']): void {
    const turnId = this.steeringInputs.get(inputId)
    if (!turnId) return
    if (status !== 'accepted') this.steeringInputs.delete(inputId)
    this.emit({ turnId, data: { type: 'input_delivery', inputId, status }, native })
  }

  async steer(text: string, _settings: SessionSettings, attachments?: ContextAttachment[], inputId: string = randomUUID()): Promise<void> {
    if (this.disposed || this.failed || !this.threadId || !this.transport?.connected) throw new SteeringUnavailableError('Codex runtime is disconnected')
    if (this.dispatching) throw new SteeringUnavailableError('Codex turn acknowledgement is pending; steering is not yet addressable')
    if (!this.turnId) throw new SteeringUnavailableError('There is no active Codex turn to steer')
    if (this.turnKind || this.interrupted) throw new SteeringUnavailableError('Codex ' + (this.turnKind ?? 'interrupting') + ' turns cannot be steered')
    const turnId = this.turnId
    this.steeringInputs.set(inputId, turnId)
    try {
      const result = await this.request<TurnSteerResponse>('turn/steer', { threadId: this.threadId, clientUserMessageId: inputId, input: codexInput(text, attachments), expectedTurnId: turnId })
      if (result?.turnId !== turnId) throw new Error('Malformed Codex steer response; delivery is uncertain')
      this.inputDelivery(inputId, 'accepted', { method: 'turn/steer', payload: json(result) })
    } catch (error) {
      if (error instanceof CodexRpcError) {
        this.steeringInputs.delete(inputId)
        const info = record(error.data) ? error.data.codexErrorInfo : undefined
        const refusal = record(info) && record(info.activeTurnNotSteerable) ? info.activeTurnNotSteerable : undefined
        if (refusal?.turnKind === 'review' || refusal?.turnKind === 'compact') {
          if (this.turnId === turnId) { this.turnKind = refusal.turnKind; this.emitPhase(true) }
          throw new SteeringUnavailableError(error.message)
        }
        if ([-32600, -32601, -32602].includes(Number(error.code))) throw new SteeringUnavailableError(error.message)
      }
      // A lost acknowledgement cannot authorize a second delivery through the queue.
      this.disconnect(error instanceof Error ? error.message : 'Codex steering delivery is uncertain')
      throw error
    }
  }

  async respond(response: InteractionResponse): Promise<void> {
    if (response.runtimeId !== this.options.runtimeId || this.failed || this.disposed || !this.transport?.connected) throw new Error('This Codex interaction belongs to a stale runtime')
    const pending = this.pending.get(response.requestId)
    if (!pending || this.invalidApprovalRequests.has(response.requestId)) throw new Error('Codex interaction has expired or was already answered')
    const { request, interaction } = pending
    let result: Json
    if (request.method === 'item/tool/requestUserInput') {
      const answers = response.answers
      if (!answers || Object.keys(answers).some(key => !request.params.questions.some(question => question.id === key))) throw new Error('Question answers must match the pending Codex question IDs')
      for (const question of request.params.questions) {
        const values = answers[question.id]
        if (!values || values.length !== 1 || typeof values[0] !== 'string' || !values[0].trim() || values[0].length > 16_384) throw new Error('Every Codex question requires one non-empty answer')
        if (question.options?.length && !question.isOther && !question.options.some(option => option.label === values[0])) throw new Error('Select one of the options offered by Codex')
      }
      result = { answers: Object.fromEntries(Object.entries(answers).map(([key, values]) => [key, { answers: values }])) }
    } else {
      if (!response.decision || !interaction.choices.some(choice => choice.id === response.decision)) throw new Error('That decision is not offered by this Codex request')
      result = this.decisionResult(request, response.decision)
    }
    // Reserve the response synchronously; a second pane cannot submit the same request.
    this.pending.delete(response.requestId)
    try { this.transport.send({ id: request.id, result }) } catch (error) {
      this.emitInteraction(request, { ...interaction, status: 'expired', outcome: 'Delivery uncertain after disconnect' })
      this.disconnect('Codex interaction response delivery is uncertain')
      throw error
    }
    this.emitInteraction(request, { ...interaction, status: 'resolved', outcome: response.decision ?? 'answered' })
    // Allowed for this session, by Codex's own session grant or its lasting rule: a later command of
    // the same kind in this runtime is answered without a card (sessionClasses).
    if (response.decision === 'acceptForSession' || response.decision === 'acceptWithExecpolicyAmendment') this.rememberSessionClass(request, interaction.title)
    this.emitPhase()
  }

  async interrupt(): Promise<void> {
    if (this.disposed || this.failed || !this.transport?.connected) throw new Error('Codex runtime is disconnected')
    if (!this.turnId) {
      if (this.dispatching) throw new Error('Codex turn acknowledgement is pending; interruption is not yet addressable')
      return
    }
    this.interrupted = true
    this.emit({ data: { type: 'session', phase: 'interrupting' } })
    // Success is only the later turn/completed event, never this acknowledgement.
    await this.request('turn/interrupt', { threadId: this.threadId!, turnId: this.turnId })
  }

  async fork(): Promise<string> {
    await this.start()
    if (this.failed || this.disposed || !this.threadId || this.turnId || this.dispatching || this.pending.size) throw new Error('Only a connected idle Codex conversation can be forked')
    const goal = await this.request<ThreadGoalGetResponse>('thread/goal/get', { threadId: this.threadId })
    if (goal.goal && goal.goal.status !== 'complete') throw new Error('Forking a native goal could start automatic work. Complete the goal before creating a history-only fork.')
    const response = await this.request<ThreadForkResponse>('thread/fork', { threadId: this.threadId, excludeTurns: true })
    if (!response.thread?.id || response.thread.id === this.threadId) throw new Error('Codex did not return a distinct fork identity')
    // The new backend session will explicitly resume this native conversation.
    await this.request('thread/unsubscribe', { threadId: response.thread.id })
    return response.thread.id
  }

  /** `/compact` and `/review` from the composer, run the way the Codex TUI runs them: their own
   *  App Server requests, which start a compaction or review turn on this thread
   *  (docs/slash-commands.md). The turn then reports itself like any other. */
  async slashCommand(command: NativeSlashCommand, args: string): Promise<void> {
    await this.start()
    if (this.disposed || this.failed || !this.threadId || !this.transport?.connected) throw new Error('Codex session is disconnected; resume explicitly')
    if (this.turnId || this.dispatching || this.pending.size) throw new Error(`Wait for the current Codex turn to finish before /${command}`)
    if (command === 'compact' && args) throw new Error('Codex /compact takes no instructions; send /compact on its own')
    const target: ReviewTarget | undefined = command !== 'review' ? undefined : codexReviewTarget(args)
    this.turnKind = undefined
    this.dispatching = true
    this.interrupted = false
    this.liveRetryStopped = false
    this.items.clear()
    this.completedItems.clear()
    try {
      if (command === 'compact') await this.request<ThreadCompactStartResponse>('thread/compact/start', { threadId: this.threadId })
      else {
        const result = await this.request<ReviewStartResponse>('review/start', json({ threadId: this.threadId, target: target!, delivery: 'inline' }))
        if (result.turn?.id && !this.completedTurns.get(result.turn.id)) {
          this.turnId = result.turn.id
          this.turnKind = 'review'
          this.emit({ data: { type: 'session', phase: 'running', capabilities: this.capabilities } })
        }
      }
    } catch (error) {
      // A refusal (not a git repository, nothing to compact) leaves the thread as it was; a lost
      // acknowledgement is not permission to claim nothing started.
      if (!(error instanceof CodexRpcError)) this.disconnect(error instanceof Error ? error.message : `Codex /${command} dispatch failed`)
      throw error
    } finally { this.dispatching = false; if (this.turnId) this.emitPhase(true) }
  }

  async rename(title: string): Promise<void> {
    await this.start()
    if (!this.threadId || this.failed || this.disposed) throw new Error('Codex runtime is disconnected')
    if (!title.trim() || title.length > 200) throw new Error('Codex conversation names must be 1-200 characters')
    await this.request('thread/name/set', { threadId: this.threadId, name: title.trim() })
  }

  async archive(archived: boolean): Promise<void> {
    await this.start()
    if (!this.threadId || this.failed || this.disposed || this.turnId || this.dispatching || this.pending.size) throw new Error('Only a connected idle Codex conversation can be archived')
    await this.request(archived ? 'thread/archive' : 'thread/unarchive', { threadId: this.threadId })
  }

  async discover(): Promise<Json> {
    await this.start()
    if (this.failed || this.disposed) throw new Error('Codex runtime is disconnected')
    if ((this.options.environment ?? process.env).CONDUCTOR_LIVE_TESTS === '1') throw new Error('Optional discovery is disabled during the capped live fixture suite')
    const requests = [
      { label: 'skills', method: 'skills/list' as const, params: { cwds: [this.options.cwd], forceReload: true } },
      { label: 'mcpServers', method: 'mcpServerStatus/list' as const, params: { threadId: this.threadId!, limit: 100, detail: 'toolsAndAuthOnly' } },
      { label: 'plugins', method: 'plugin/list' as const, params: { cwds: [this.options.cwd], marketplaceKinds: ['local'], forceRefetch: false } }
    ]
    const results = await Promise.allSettled(requests.map(request => this.request(request.method, json(request.params))))
    return json(Object.fromEntries(results.map((result, index) => [requests[index]!.label, result.status === 'fulfilled' ? { status: 'available', payload: result.value } : { status: 'unavailable', message: result.reason instanceof Error ? result.reason.message : 'Provider discovery failed' }])))
  }

  async refreshUsage(): Promise<void> {
    await this.start()
    if (this.failed || this.disposed || !this.transport?.connected) throw new Error('Codex runtime is disconnected')
    const response = await this.request<GetAccountRateLimitsResponse>('account/rateLimits/read', undefined)
    if (!record(response) || !record(response.rateLimits)) throw new Error('Malformed Codex account rate-limit response')
    const reportedBuckets = record(response.rateLimitsByLimitId) ? response.rateLimitsByLimitId : undefined
    const fallbackKey = typeof response.rateLimits.limitId === 'string' && response.rateLimits.limitId ? response.rateLimits.limitId : 'default'
    const rateLimitsByLimitId = reportedBuckets && Object.keys(reportedBuckets).length
      ? reportedBuckets
      : { [fallbackKey]: response.rateLimits }
    this.emitAccountLimits({ rateLimits: response.rateLimits, rateLimitsByLimitId }, { method: 'account/rateLimits/read', payload: json(response) })
  }

  async history(): Promise<import('../native-history').NativeHistoryItem[]> {
    if (!this.threadId) return []
    const result = await this.request<import('./generated/codex/v2/ThreadReadResponse').ThreadReadResponse>('thread/read', { threadId: this.threadId, includeTurns: true })
    const items: import('../native-history').NativeHistoryItem[] = []
    for (const turn of result.thread.turns ?? []) for (const item of turn.items) {
      const base = { id: turn.id + ':' + item.id, turnId: turn.id }
      if (item.type === 'userMessage') items.push({ ...base, data: { type: 'text', role: 'user', mode: 'snapshot', text: item.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n') } })
      else if (item.type === 'agentMessage') items.push({ ...base, data: { type: 'text', role: 'assistant', mode: 'snapshot', text: item.text } })
      else if (item.type === 'commandExecution') items.push({ ...base, data: { type: 'tool', name: 'Command', input: { command: item.command, cwd: item.cwd }, status: item.exitCode ? 'failed' : item.status === 'completed' ? 'completed' : 'interrupted', output: item.aggregatedOutput ?? undefined, exitCode: item.exitCode ?? undefined } })
      else if (item.type === 'fileChange') items.push({ ...base, data: { type: 'changes', changes: codexChanges(item.changes, item.status === 'completed' ? 'applied' : 'failed') } })
    }
    return items.slice(-2000)
  }
  async stop(): Promise<void> { this.dispose(); await this.transport?.closeAndWait?.() }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.disconnect('Conductor closed its owned Codex runtime. Historical events remain readable; unfinished execution may be uncertain.')
    this.transport?.close()
  }

  private request<T = Json>(method: ClientRequest['method'], params?: Json): Promise<T> {
    if (!this.transport?.connected) return Promise.reject(new Error('Codex transport is disconnected'))
    const id = ++this.requestId
    return new Promise<T>((resolve, reject) => {
      const key = requestKey(id)
      const timer = setTimeout(() => {
        this.rpc.delete(key)
        reject(new Error(`Codex ${method} acknowledgement timed out; do not automatically retry`))
      }, this.dependencies.requestTimeoutMs ?? 20_000)
      this.rpc.set(key, { resolve: value => resolve(value as T), reject, timer })
      try { this.transport!.send({ id, method, ...(params === undefined ? {} : { params }) }) }
      catch (error) { clearTimeout(timer); this.rpc.delete(key); reject(error) }
    })
  }

  private receive(message: Json): void {
    if (!record(message) || this.disposed) return
    if (isId(message.id) && typeof message.method !== 'string') {
      const pending = this.rpc.get(requestKey(message.id))
      if (!pending) return this.unknown('rpc/unmatched', message)
      clearTimeout(pending.timer)
      this.rpc.delete(requestKey(message.id))
      if (record(message.error)) pending.reject(new CodexRpcError(message.error.code, message.error.data, String(message.error.message ?? 'Unknown provider error')))
      else if ('result' in message) pending.resolve(message.result)
      else pending.reject(new Error('Malformed Codex RPC response'))
      return
    }
    if (typeof message.method !== 'string' || !record(message.params)) return this.unknown('protocol/unknown', message)
    if (this.failed) return this.unknown(message.method, message.params, 'Late provider event after disconnect; retained without changing live state')
    try {
      if (isId(message.id)) this.serverRequest(message as unknown as ServerRequest)
      else this.notification(message as unknown as ServerNotification)
    } catch {
      this.unknown(message.method, message.params, 'Malformed or unsupported Codex event retained for inspection')
      if (isId(message.id)) this.transport?.send({ id: message.id, error: { code: -32602, message: 'Conductor cannot safely handle this request shape' } })
    }
  }

  private correlation(params: unknown): Correlation {
    const value = record(params) ? params : {}
    const nativeSessionId = typeof value.threadId === 'string' ? value.threadId : this.threadId
    return {
      nativeSessionId, turnId: typeof value.turnId === 'string' ? value.turnId : undefined,
      itemId: typeof value.itemId === 'string' ? value.itemId : undefined,
      ...(nativeSessionId && this.childParents.has(nativeSessionId) ? { parentId: this.childParents.get(nativeSessionId) } : {})
    }
  }

  private notification(message: ServerNotification): void {
    const { method, params } = message
    const context = this.correlation(params)
    const native = { method, payload: json(params) }
    const send = (data: AdapterEvent['data'], extra: Partial<AdapterEvent> = {}): void => this.emit({ ...context, data, native, ...extra })
    switch (method) {
      case 'thread/started':
        if (!this.threadId && !params.thread.parentThreadId) this.threadId = params.thread.id
        if (params.thread.parentThreadId) {
          const parent = this.childParents.get(params.thread.id)
          send({ type: 'subagent', name: params.thread.agentNickname ?? params.thread.agentRole ?? 'Codex agent', nativeSessionId: params.thread.id, status: 'running',
            ...(params.thread.model ? { model: params.thread.model } : {}), ...(params.thread.reasoningEffort ? { effort: params.thread.reasoningEffort } : {}), modelProvider: params.thread.modelProvider
          }, { nativeSessionId: params.thread.id, itemId: `thread:${params.thread.id}`, parentId: parent })
        }
        return
      case 'turn/started':
        if (params.threadId === this.threadId) {
          if (this.turnId !== params.turn.id) this.turnKind = undefined
          this.turnId = params.turn.id
          send({ type: 'session', phase: 'running' }, { turnId: params.turn.id })
        }
        return
      case 'turn/completed': {
        const completedPhase = params.turn.status === 'failed' ? 'failed' : params.turn.status === 'interrupted' ? 'interrupted' : 'completed'
        this.completedTurns.set(params.turn.id, completedPhase)
        if (this.completedTurns.size > 128) this.completedTurns.delete(this.completedTurns.keys().next().value!)
        // Completion contains authoritative item snapshots where available.
        for (const item of params.turn.items ?? []) this.item(item, { ...context, turnId: params.turn.id }, true, native)
        this.expireRequests('Turn completed', params.threadId, params.turn.id)
        if (params.threadId === this.threadId && (!this.turnId || this.turnId === params.turn.id)) {
          // Interrupted turns discard their remaining turn-local input queue. Item
          // snapshots above reconcile any input already consumed before cancellation.
          for (const [id, turnId] of this.steeringInputs) if (turnId === params.turn.id) this.inputDelivery(id, params.turn.status === 'interrupted' ? 'cancelled' : 'uncertain', native)
          this.turnId = undefined
          if (params.turn.error) { this.sandboxSetupNotice(params.turn.error.message, context); send(unauthorized(params.turn.error.codexErrorInfo) ? { type: 'error', message: authExpiredMessage('codex', params.turn.error.message), code: PROVIDER_AUTH_EXPIRED } : { type: 'error', message: params.turn.error.message, ...(safeguardRefusal(params.turn.error.message) ? { code: PROVIDER_SAFEGUARD_REFUSAL } : params.turn.error.codexErrorInfo === 'usageLimitExceeded' ? { code: PROVIDER_USAGE_LIMIT } : isOverloadedErrorInfo(params.turn.error.codexErrorInfo) || isProviderOverloadedMessage(params.turn.error.message) ? { code: PROVIDER_OVERLOADED } : {}) }) }
          send({ type: 'session', phase: completedPhase }, { turnId: params.turn.id })
        }
        return
      }
      case 'item/started': case 'item/completed':
        // Each frame's own stamp only: a completion never implies when the item started.
        this.item(params.item, context, method === 'item/completed', native, method === 'item/completed' ? { providerCompletedAtMs: finiteMs((params as { completedAtMs?: unknown }).completedAtMs) } : { providerStartedAtMs: finiteMs((params as { startedAtMs?: unknown }).startedAtMs) })
        return
      case 'item/autoApprovalReview/completed': {
        const review = reviewInterval(params)
        if (review) {
          const key = this.itemKey({ ...context, itemId: review.targetItemId })
          let intervals = this.reviews.get(key)
          if (!intervals && !this.completedItems.has(key)) {
            if (this.reviews.size >= MAX_REVIEWED_ITEMS) this.reviews.delete(this.reviews.keys().next().value!)
            this.reviews.set(key, intervals = new Map())
          }
          // A repeated reviewId replaces its own interval; beyond the cap a review is not counted.
          if (intervals && (intervals.has(review.reviewId) || intervals.size < MAX_REVIEWS_PER_ITEM)) intervals.set(review.reviewId, review.interval)
        }
        // Still shown as before: the payload is unstable, and only its interval is used here.
        this.unknown(method, params)
        return
      }
      case 'item/agentMessage/delta':
        if (typeof params.delta !== 'string') throw new Error('Invalid text delta')
        if (this.completedItems.has(this.itemKey(context))) return this.unknown(method, params, 'Late text after the authoritative item snapshot')
        send({ type: 'text', role: 'assistant', text: params.delta, mode: 'delta' })
        return
      case 'item/reasoning/summaryTextDelta':
        send({ type: 'text', role: 'status', text: params.delta, mode: 'delta' }, { itemId: `${params.itemId}:summary:${params.summaryIndex}` })
        return
      case 'item/reasoning/textDelta':
        // Raw reasoning is not requested or presented. Only provider-exposed readable summaries above.
        return
      case 'item/plan/delta':
        send({ type: 'text', role: 'status', text: params.delta, mode: 'delta' })
        return
      case 'item/commandExecution/outputDelta': case 'item/fileChange/outputDelta': {
        if (typeof params.delta !== 'string') throw new Error('Invalid output delta')
        if (this.completedItems.has(this.itemKey(context))) return this.unknown(method, params, 'Late output after the authoritative item snapshot')
        const item = this.items.get(this.itemKey(context))
        send({ type: 'tool', name: item?.name ?? (method.includes('fileChange') ? 'File change' : 'Command'), status: item?.status === 'completed' || item?.status === 'failed' ? item.status : 'running', output: params.delta, outputMode: 'delta' })
        return
      }
      case 'item/fileChange/patchUpdated':
        send({ type: 'changes', changes: codexChanges(params.changes, 'proposed') })
        return
      case 'turn/diff/updated':
        // Turn aggregates must not be added to per-tool totals or interpreted as a second file edit.
        send({ type: 'notice', message: 'Current turn diff (provider aggregate)', payload: params.diff }, { itemId: `turn-diff:${params.turnId}` })
        return
      case 'turn/plan/updated':
        send({ type: 'plan', steps: params.plan.map(step => ({ text: step.step, status: step.status === 'inProgress' ? 'in_progress' : step.status })), ...(params.explanation ? { explanation: params.explanation } : {}) }, { itemId: `plan:${params.turnId}` })
        return
      case 'thread/tokenUsage/updated':
        send({ type: 'usage', scope: 'session', inputTokens: params.tokenUsage.total.inputTokens, outputTokens: params.tokenUsage.total.outputTokens, cachedTokens: params.tokenUsage.total.cachedInputTokens, cacheCreationTokens: params.tokenUsage.total.cacheWriteInputTokens, totalTokens: params.tokenUsage.total.totalTokens, reasoningTokens: params.tokenUsage.total.reasoningOutputTokens, source: 'provider', limits: json({ modelContextWindow: params.tokenUsage.modelContextWindow, contextCapacityTokens: params.tokenUsage.modelContextWindow, contextUsedTokens: params.tokenUsage.last?.totalTokens ?? null, workingOutputTokens: params.tokenUsage.last?.outputTokens ?? null }) }, { itemId: `usage:${params.threadId}`, turnId: undefined })
        return
      case 'thread/settings/updated':
        if (params.threadId === this.threadId) {
          const settings = params.threadSettings
          this.capabilities.effectiveSettings = json({ model: settings.model, effort: settings.effort, approvalPolicy: settings.approvalPolicy, sandbox: settings.sandboxPolicy, unattended: this.unattended })
          send({ type: 'notice', message: 'Native Codex settings updated', payload: this.capabilities.effectiveSettings })
          this.emitPhase(true)
        }
        return
      case 'account/rateLimits/updated':
        this.emitAccountLimits(params, { method, payload: json(params) })
        return
      case 'serverRequest/resolved': {
        const key = requestKey(params.requestId)
        const pending = this.pending.get(key)
        if (pending && 'threadId' in pending.request.params && pending.request.params.threadId === params.threadId) {
          this.pending.delete(key)
          this.emitInteraction(pending.request, { ...pending.interaction, status: 'expired', outcome: 'Resolved or cleared by Codex' })
          this.emitPhase()
        }
        return
      }
      case 'mcpServer/startupStatus/updated':
        if (!params.threadId || params.threadId === this.threadId) {
          this.mcpStartup.set(params.name, String(params.status))
          for (const waiter of [...this.mcpStartupWaiters]) waiter()
        }
        if (params.status === 'failed') send({ type: 'notice', message: `MCP server ${params.name} failed to start${params.error ? ': ' + params.error : ''}` })
        return
      case 'item/mcpToolCall/progress':
        send({ type: 'tool', name: this.items.get(this.itemKey(context))?.name ?? 'MCP tool', status: 'running', output: params.message, outputMode: 'delta' })
        return
      case 'error':
        this.sandboxSetupNotice(params.error.message, context)
        send(unauthorized(params.error.codexErrorInfo) && !params.willRetry ? { type: 'error', message: authExpiredMessage('codex', params.error.message), code: PROVIDER_AUTH_EXPIRED }
          : { type: 'error', message: params.error.message, ...(safeguardRefusal(params.error.message) ? { code: PROVIDER_SAFEGUARD_REFUSAL } : params.error.codexErrorInfo === 'usageLimitExceeded' && !params.willRetry ? { code: PROVIDER_USAGE_LIMIT } : !params.willRetry && (isOverloadedErrorInfo(params.error.codexErrorInfo) || isProviderOverloadedMessage(params.error.message)) ? { code: PROVIDER_OVERLOADED } : {}) })
        if (params.willRetry && (this.options.environment ?? process.env).CONDUCTOR_LIVE_TESTS === '1' && !this.liveRetryStopped) {
          this.liveRetryStopped = true
          this.interrupted = true
          send({ type: 'notice', message: 'Live retry stopped: requesting native interruption. An already in-flight retry may not be preventable.' })
          send({ type: 'session', phase: 'interrupting' })
          void this.request('turn/interrupt', { threadId: params.threadId, turnId: params.turnId }).catch(() => this.disconnect('Live retry interruption failed; execution is uncertain'))
        }
        if (!params.willRetry && params.threadId === this.threadId) send({ type: 'session', phase: 'failed' })
        return
      case 'thread/closed':
        if (params.threadId === this.threadId) this.disconnect('Codex closed the thread; resume explicitly')
        return
      default:
        this.unknown(method, params)
    }
  }

  private item(item: ThreadItem, context: Correlation, complete: boolean, native: AdapterEvent['native'], at: { providerStartedAtMs?: number; providerCompletedAtMs?: number } = {}): void {
    if (!record(item) || typeof item.id !== 'string' || typeof item.type !== 'string') throw new Error('Malformed Codex item')
    if (context.nativeSessionId === this.threadId && context.turnId === this.turnId) {
      if (item.type === 'enteredReviewMode') { this.turnKind = 'review'; this.emitPhase(true) }
      if (item.type === 'contextCompaction') { this.turnKind = complete ? undefined : 'compact'; this.emitPhase(true) }
    }
    const correlation = { ...context, itemId: item.id }
    // The compacted thread keeps a summary of what Conductor told it, not the text; the host
    // restates its briefing with the next message when it sees this marker.
    // Under its own item id: the generic `Codex contextCompaction` notice below shares item.id,
    // and the projection keeps one event per item id, so the owner would otherwise never see this one.
    if (item.type === 'contextCompaction' && complete && context.nativeSessionId === this.threadId) this.emit({ ...correlation, itemId: `${item.id}:compacted`, data: { type: 'notice', message: 'Codex compacted this conversation; Conductor restates its briefing with the next message.', payload: { contextReset: true } }, native })
    if (complete) {
      if (this.completedItems.size >= 2048) this.completedItems.delete(this.completedItems.values().next().value!)
      this.completedItems.add(this.itemKey(correlation))
    }
    const send = (data: AdapterEvent['data'], extra: Partial<AdapterEvent> = {}): void => this.emit({ ...correlation, data, native, ...extra })
    const tool = (name: string, data: Omit<Extract<AdapterEvent['data'], { type: 'tool' }>, 'type' | 'name'>): void => {
      if (this.items.size >= 2048) this.items.delete(this.items.keys().next().value!)
      const key = this.itemKey(correlation)
      this.items.set(key, { name, status: data.status, ...(item.type === 'fileChange' ? { paths: item.changes.map(change => change.path) } : {}) })
      const reviews = complete ? this.reviews.get(key) : undefined
      if (complete) this.reviews.delete(key)
      send({ type: 'tool', name, ...data,
        ...(at.providerStartedAtMs !== undefined ? { providerStartedAtMs: at.providerStartedAtMs } : {}),
        ...(at.providerCompletedAtMs !== undefined ? { providerCompletedAtMs: at.providerCompletedAtMs } : {}),
        ...(reviews?.size ? { providerReviewMs: unionMs(reviews.values()) } : {}) })
    }
    switch (item.type) {
      case 'userMessage':
        if (correlation.nativeSessionId === this.threadId && item.clientId) this.inputDelivery(item.clientId, 'delivered', native)
        return // Host persists its captured input only after the matching native receipt.
      case 'agentMessage':
        send({ type: 'text', role: 'assistant', text: item.text, mode: 'snapshot' })
        // request_user_input_async is an agent message with question metadata, not an
        // item/tool/requestUserInput server request. Its answer is a later user message.
        if (item.questions?.length && correlation.nativeSessionId === this.threadId) {
          const id = asyncQuestionId(this.threadId!, item.id)
          send({ type: 'interaction', interaction: {
            id, kind: 'question', title: 'Codex asked you', status: 'pending', choices: [],
            input: { protocol: 'codex-async-question', threadId: this.threadId!, itemId: item.id },
            questions: item.questions.map((question, index) => ({
              id: `${item.id}:${index}`, question: question.title,
              options: (question.options ?? []).map(label => ({ label })), allowCustom: true
            }))
          } }, { requestId: id })
        }
        return
      case 'reasoning':
        item.summary.forEach((summary, index) => send({ type: 'text', role: 'status', text: summary, mode: 'snapshot' }, { itemId: `${item.id}:summary:${index}` }))
        return
      case 'plan':
        send({ type: 'text', role: 'status', text: item.text, mode: 'snapshot' })
        return
      case 'commandExecution': {
        const name = /(?:^|[\\/\s"'])(?:pwsh|powershell)(?:\.exe)?(?:[\s"']|$)/i.test(item.command) ? 'PowerShell' : /(?:^|[\\/\s"'])bash(?:\.exe)?(?:[\s"']|$)/i.test(item.command) ? 'Bash' : 'Command'
        const actions = item.commandActions ?? []
        const action = actions[0]
        const description = action?.type === 'read' ? `Read ${action.name}` : action?.type === 'search' ? `Search ${action.query ?? action.path ?? ''}` : `Run ${item.command.split(/\r?\n/, 1)[0]!.slice(0, 120)}`
        const status = item.exitCode !== null && item.exitCode !== undefined && item.exitCode !== 0 ? 'failed' : !complete && item.status === 'inProgress' && !item.processId && !item.aggregatedOutput ? 'preparing' : statusFor(item.status, complete)
        if (status === 'failed') this.sandboxSetupNotice(item.aggregatedOutput, correlation)
        tool(name, { description, input: json({ command: item.command, cwd: item.cwd, actions }), status, ...(item.aggregatedOutput !== null && item.aggregatedOutput !== undefined ? { output: item.aggregatedOutput, outputMode: 'snapshot' as const } : {}), ...(item.exitCode !== null && item.exitCode !== undefined ? { exitCode: item.exitCode } : {}), ...(item.durationMs !== null && item.durationMs !== undefined ? { durationMs: item.durationMs } : {}) })
        return
      }
      case 'fileChange':
        tool('File change', { description: item.changes.map(change => change.path).join(', '), status: statusFor(item.status, complete), input: json(item.changes.map(change => ({ path: change.path, kind: change.kind }))) })
        send({ type: 'changes', changes: codexChanges(item.changes, complete ? item.status === 'completed' ? 'applied' : item.status === 'declined' ? 'rejected' : 'failed' : 'proposed') })
        return
      case 'mcpToolCall':
        tool(`${item.server}/${item.tool}`, { input: json(item.arguments), status: statusFor(item.status, complete), ...(item.result ? { output: textOutput(item.result.structuredContent ?? item.result.content), outputMode: 'snapshot' as const } : {}), ...(item.error ? { output: item.error.message, outputMode: 'snapshot' as const } : {}), ...(item.durationMs !== null ? { durationMs: item.durationMs } : {}) })
        return
      case 'dynamicToolCall':
        tool(item.namespace ? `${item.namespace}/${item.tool}` : item.tool, { input: json(item.arguments), status: item.success === false ? 'failed' : statusFor(item.status, complete), ...(item.contentItems ? { output: textOutput(item.contentItems), outputMode: 'snapshot' as const } : {}), ...(item.durationMs !== null ? { durationMs: item.durationMs } : {}) })
        return
      case 'collabAgentToolCall':
        tool(item.tool, { input: json({ prompt: item.prompt, receiverThreadIds: item.receiverThreadIds, model: item.model, effort: item.reasoningEffort }), status: statusFor(item.status, complete) })
        for (const child of item.receiverThreadIds) {
          if (this.childParents.size >= 2048) this.childParents.delete(this.childParents.keys().next().value!)
          this.childParents.set(child, item.id)
          const state = item.agentsStates[child]
          send({ type: 'subagent', name: 'Codex agent', nativeSessionId: child, status: state?.status === 'completed' ? 'completed' : state?.status === 'errored' || state?.status === 'notFound' ? 'failed' : state?.status === 'interrupted' || state?.status === 'shutdown' ? 'interrupted' : state?.status === 'pendingInit' ? 'preparing' : 'running',
            // Requested at spawn time; the child's own thread/started (if it arrives) can refine this further.
            ...(item.model ? { model: item.model } : {}), ...(item.reasoningEffort ? { effort: item.reasoningEffort } : {})
          }, { itemId: `thread:${child}`, parentId: item.id })
        }
        return
      case 'subAgentActivity':
        if (item.agentThreadId === this.threadId) return // Root activity is already represented by the session status.
        send({ type: 'subagent', name: item.agentPath, nativeSessionId: item.agentThreadId, status: item.kind === 'completed' ? 'completed' : item.kind === 'interrupted' ? 'interrupted' : 'running' }, { parentId: this.childParents.get(item.agentThreadId) })
        return
      default:
        // Future/bespoke items remain inspectable and never authorize host tool execution.
        send({ type: 'notice', message: `Codex ${item.type}`, payload: json(item) })
    }
  }

  private serverRequest(request: ServerRequest): void {
    const params = request.params
    const mcpApproval = request.method === 'mcpServer/elicitation/request' ? codexMcpToolApproval(params) : undefined
    const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput', 'item/permissions/requestApproval'].includes(request.method) || Boolean(mcpApproval)
    if (!supported) {
      this.unknown(request.method, params, 'Codex requested an unsupported client action; no tool or credential action was executed')
      this.transport?.send({ id: request.id, error: { code: -32601, message: 'This Conductor client does not implement this method' } })
      return
    }
    if (!('threadId' in params) || typeof params.threadId !== 'string') throw new Error('Missing request identity')
    // An MCP approval is correlated to a turn by app-server on a best-effort basis; every other
    // request names its turn and item.
    if (!mcpApproval && (!('turnId' in params) || typeof params.turnId !== 'string' || !('itemId' in params) || typeof params.itemId !== 'string')) throw new Error('Missing request identity')
    if (params.threadId !== this.threadId && !this.childParents.has(params.threadId)) throw new Error('Request belongs to an unrelated thread')
    const turnId = 'turnId' in params && typeof params.turnId === 'string' ? params.turnId : undefined
    if (turnId && this.completedTurns.has(turnId)) {
      this.transport?.send({ id: request.id, error: { code: -32602, message: 'Turn is already complete' } })
      return
    }
    const id = requestKey(request.id)
    if (this.invalidApprovalRequests.has(id) || this.invalidApprovalRequests.size >= 128) throw new Error('Provider approval identity was invalidated; a fresh native request is required')
    const previous = this.pending.get(id)
    if (previous) {
      // Repeated delivery of the same live request needs neither a second card nor a response.
      if (previous.request.method === request.method && canonicalAction(previous.request.params) === canonicalAction(params)) return
      // An old view must not approve a replacement action under the same request identity.
      this.pending.delete(id)
      this.invalidApprovalRequests.add(id)
      this.emitInteraction(previous.request, { ...previous.interaction, status: 'expired', outcome: 'Native approval arguments changed; the old choice is invalid. A fresh request is required.' })
      this.emitPhase()
      throw new Error('Provider approval identity was reused with changed arguments')
    }
    if (this.pending.size >= 128) throw new Error('Too many pending provider requests')
    // A request this adapter already answered itself (Auto, a session class, the owner's policy): a
    // repeated delivery gets no second answer, and a reused identity with other arguments is refused
    // like a reused card.
    const answered = this.autoAnswered.get(id)
    if (answered !== undefined) {
      if (answered === canonicalAction(params)) return
      this.autoAnswered.delete(id)
      this.invalidApprovalRequests.add(id)
      throw new Error('Provider approval identity was reused with changed arguments')
    }
    let choices: PendingInteraction['choices'] = [{ id: 'accept', label: 'Allow once' }, { id: 'acceptForSession', label: 'Allow for this session' }, { id: 'decline', label: 'Deny' }, { id: 'cancel', label: 'Cancel turn' }]
    let title = 'Approve file changes'
    if (request.method === 'item/commandExecution/requestApproval') {
      title = request.params.networkApprovalContext ? `Allow network access: ${request.params.networkApprovalContext.host}` : request.params.reason ?? 'Approve command execution'
      if (request.params.availableDecisions) {
        choices = choices.filter(choice => request.params.availableDecisions!.some(decision => decision === choice.id))
        // Codex's own "don't ask again" for a command prefix. It writes a lasting Codex rule, so it is
        // only ever the owner's (or a wizard's) answer and never an Auto one. On Windows Codex offers
        // no session grant for a command, only this rule (accept / acceptWithExecpolicyAmendment /
        // cancel, live-observed 2026-09-22 and on every miron request of 2026-10-17), so there the
        // rule is the session choice: "for this session" on the card, or agents.approve with scope
        // "session", answers with it (decisionResult). Beside a session grant of Codex's own it stays
        // a separate "Always allow".
        const amendment = codexExecpolicyAmendment(request.params.availableDecisions)
        const shown = amendment?.join(' ') ?? ''
        const afterAccept = choices.some(choice => choice.id === 'accept') ? 1 : 0
        if (amendment && choices.some(choice => choice.id === 'acceptForSession')) choices.splice(afterAccept, 0, { id: 'acceptWithExecpolicyAmendment', label: `Always allow \`${shown}\``, description: 'Codex saves this prefix as a rule and runs matching commands without asking again, in this and later conversations.' })
        else if (amendment) choices.splice(afterAccept, 0, { id: 'acceptForSession', label: 'Allow for this session', description: `Codex saves \`${shown.length > 160 ? shown.slice(0, 159) + '…' : shown}\` as an allow rule and runs it again without asking, in this and later conversations; Conductor also allows commands of the same kind for the rest of this conversation.` })
        // Codex's network rule for a host (an object decision the string filter above drops). Where
        // the card has no session choice yet it is that choice, so a wizard, the phone and
        // agents.approve with scope "session" can give it (decisionResult answers with the rule).
        const network = codexNetworkAllowAmendment(request.params.availableDecisions)
        if (network) {
          const rule = { label: `Always allow network access to ${network.host}`, description: `Codex saves ${network.host} as an allowed network host and stops asking for it, in this and later conversations.` }
          const at = choices.findIndex(choice => !CODEX_ALLOW_CHOICES.has(choice.id))
          choices.splice(at < 0 ? choices.length : at, 0, { id: choices.some(choice => choice.id === 'acceptForSession') ? 'applyNetworkPolicyAmendment' : 'acceptForSession', ...rule })
        }
      }
    } else if (request.method === 'item/permissions/requestApproval') {
      title = request.params.reason ?? 'Grant requested permissions'
      choices = [{ id: 'accept', label: 'Grant for this turn' }, { id: 'acceptForSession', label: 'Grant for this session' }, { id: 'decline', label: 'Deny' }]
    } else if (mcpApproval) {
      title = mcpApproval.message
      choices = [{ id: 'accept', label: 'Allow once' }, ...(mcpApproval.persist.includes('session') ? [{ id: 'acceptForSession', label: 'Allow for this session' }] : []), { id: 'decline', label: 'Deny' }]
    }
    const isQuestion = request.method === 'item/tool/requestUserInput'
    // Owner rule 2026-10-20: never a card whose only buttons are Deny / Cancel turn, or none. A
    // request Codex offers no way to allow (availableDecisions ['decline', 'cancel'], or []) is
    // declined here, or cancelled when decline is not on offer, with an informational notice; the
    // session never waits on it, and no phone push, Needs attention or wizard wake follows.
    if (!isQuestion && !choices.some(choice => CODEX_ALLOW_CHOICES.has(choice.id))) {
      const decision = choices.some(choice => choice.id === 'decline') || !choices.some(choice => choice.id === 'cancel') ? 'decline' : 'cancel'
      const offered = request.method === 'item/commandExecution/requestApproval' && Array.isArray(request.params.availableDecisions)
        ? request.params.availableDecisions.map(entry => typeof entry === 'string' ? entry : Object.keys(entry)[0] ?? 'unknown').join(', ') : ''
      this.answerItself(request, id, decision, { message: `Conductor ${decision === 'decline' ? 'declined' : 'cancelled'} “${title}” without asking you: Codex offered no way to allow it (${offered ? `only ${offered}` : 'no decisions at all'}).` })
      return
    }
    // The project browser's own tools act only on this project's isolated browser and write only new
    // files inside the project; the owner asked for them to run without cards (Read only keeps the
    // cards of the two that write files).
    if (mcpApproval?.serverName === BROWSER_MCP_SERVER_NAME && !this.options.approvalReviewer && !(this.readOnly && BROWSER_WRITING_TOOLS.has(mcpApproval.tool))) {
      const decision = mcpApproval.persist.includes('session') ? 'acceptForSession' : 'accept'
      if (choices.some(choice => choice.id === decision)) {
        this.answerItself(request, id, decision, { message: `Conductor allowed ${mcpApproval.serverName}/${mcpApproval.tool} without asking: project-browser tools run without approval.` })
        return
      }
    }
    // What the request reaches. An owner-only boundary is never answered here, never offered for a
    // session, never forms a session class, and its card says it is the owner's (required).
    const check = isQuestion || mcpApproval ? undefined : this.ownerOnlyEscalation(request)
    const ownerOnly = Boolean(check?.boundary)
    // A controller's "Review coworkers" opt-in never turns Auto off for a worker: it runs unattended
    // as configured, and only the isolated reviewer itself keeps every request pending.
    if (this.unattended && !isQuestion && !this.options.approvalReviewer) {
      // Auto answers for the owner: an enabled MCP tool for the session when Codex offers that,
      // and a command, file change or permission grant that has to leave the workspace sandbox
      // once, for this request only, unless it reaches an owner-only boundary. The host review
      // gate and an isolated reviewer keep their pending cards, and so does a request that
      // offers no plain accept. Nothing here is an owner denial or a turn cancellation.
      const decision = mcpApproval?.persist.includes('session') ? 'acceptForSession' : 'accept'
      if (!choices.some(choice => choice.id === decision)) this.emit({ ...this.correlation(params), data: { type: 'notice', message: `Auto could not approve “${title}”: Codex offered no plain accept for it. The native request is pending; review it and choose an offered action.` } })
      else if (check) this.emit({ ...this.correlation(params), data: { type: 'notice', message: `Auto left “${title}” to you: ${check.held}. The native request is pending; review it and choose an offered action.` } })
      else {
        const subject = mcpApproval ? `${mcpApproval.serverName}/${mcpApproval.tool}`
          : request.method === 'item/commandExecution/requestApproval' && request.params.networkApprovalContext ? `network access to ${request.params.networkApprovalContext.host}`
            : request.method === 'item/fileChange/requestApproval' ? 'file changes outside the workspace sandbox'
              : request.method === 'item/permissions/requestApproval' ? `the requested permissions for this turn (${title})` : `“${title}” outside the workspace sandbox`
        this.answerItself(request, id, decision, { message: `Auto allowed ${subject} without asking.` })
        return
      }
    }
    if (!isQuestion && !mcpApproval && request.method !== 'item/permissions/requestApproval' && !this.options.approvalReviewer && choices.some(choice => choice.id === 'accept')) {
      // A command of a kind the owner or a wizard already allowed for this session in this runtime.
      const sessionClass = ownerOnly ? undefined : this.sessionClassOf(request)
      const allowedAs = sessionClass ? this.sessionClasses.get(sessionClass) : undefined
      if (sessionClass && allowedAs !== undefined) {
        this.answerItself(request, id, 'accept', { message: `Allowed “${title}” for this session without asking: a command of the same kind (${sessionClass}) was allowed for this session (“${allowedAs}”).`, payload: { sessionClass } })
        return
      }
      // The owner's auto-approve policy (approval-policy.ts) answers what it covers with no card and
      // no review, before the stronger review, a wizard or the owner would be asked; the host
      // journals it with answeredBy "policy". An owner-only boundary is never its to allow.
      const policy = this.policyRequest(request, ownerOnly)
      let verdict: PolicyDecision = null
      try { verdict = policy && this.options.approvalPolicy ? this.options.approvalPolicy(policy, { requestId: id, tool: this.toolName(request), input: json(params) }) : null } catch { verdict = null }
      if (verdict?.decision === 'allow' && !ownerOnly) {
        this.answerItself(request, id, 'accept', policyNotice(this.policySubject(request, title), verdict.rule))
        return
      }
    }
    // An owner-only boundary is one exact action in every mode, and so is an isolated reviewer's or
    // an Auto request held for the owner: never a session grant or a lasting Codex rule, unless that
    // rule is the only way Codex offers to allow it (a card is never Deny-only).
    if (!isQuestion && !mcpApproval && (ownerOnly || this.unattended || this.options.approvalReviewer)) {
      const exact = choices.filter(choice => !CODEX_LASTING_CHOICES.has(choice.id))
      if (exact.some(choice => CODEX_ALLOW_CHOICES.has(choice.id))) choices = exact
    }
    const interaction: PendingInteraction = {
      id, kind: isQuestion ? 'question' : 'approval', title: isQuestion ? 'Codex needs your input' : title,
      input: json(params), choices: isQuestion ? [] : choices, status: 'pending', ...(ownerOnly ? { required: true } : {}),
      ...(isQuestion ? { questions: request.params.questions.map(question => ({ id: question.id, header: question.header, question: question.question, options: question.options ?? [], isSecret: question.isSecret, allowCustom: question.isOther || !question.options?.length })) } : {})
    }
    this.pending.set(id, { request, interaction, blocking: !isQuestion || request.params.isBlocking !== false })
    this.emitInteraction(request, interaction)
    if (!isQuestion && !mcpApproval) this.emit({ ...this.correlation(params), data: { type: 'tool', name: this.toolName(request), status: 'awaiting_approval' } })
    this.emitPhase()
  }

  /** Answers a native request in place of a card (Auto, a session class, the owner's policy), once
   *  per request identity: a repeated delivery finds it in autoAnswered and gets no second answer. */
  private answerItself(request: ServerRequest, id: string, decision: string, notice: { message: string; payload?: Json }): void {
    if (this.autoAnswered.size >= 128) this.autoAnswered.delete(this.autoAnswered.keys().next().value!)
    this.autoAnswered.set(id, canonicalAction(request.params))
    this.transport?.send({ id: request.id, result: this.decisionResult(request, decision) })
    this.emit({ ...this.correlation(request.params), data: { type: 'notice', message: notice.message, ...(notice.payload !== undefined ? { payload: notice.payload } : {}) }, native: { method: request.method, payload: json(request.params) } })
  }

  /** The tool row a native request belongs to, as the timeline names it. */
  private toolName(request: ServerRequest): string {
    return this.items.get(this.itemKey(this.correlation(request.params)))?.name ?? (request.method.includes('fileChange') ? 'File change' : 'Command')
  }

  /** The paths a file-change request names: its grant root and the paths its item reported. */
  private requestPaths(request: Extract<ServerRequest, { method: 'item/fileChange/requestApproval' }>): string[] {
    return [...(request.params.grantRoot ? [request.params.grantRoot] : []), ...(this.items.get(this.itemKey(this.correlation(request.params)))?.paths ?? [])]
  }

  /** The kind of command a session allowance covers: the program and its subcommand or script, for
   *  a local, workspace-scoped command only (approval-review-rules.ts commandClass, the classes the
   *  review gate's session rules use). Undefined for anything else, a network request included. */
  private sessionClassOf(request: ServerRequest): string | undefined {
    if (request.method !== 'item/commandExecution/requestApproval' || !request.params.command || request.params.networkApprovalContext) return undefined
    return commandClass({ tool: request.method, arguments: { command: request.params.command }, paths: [], boundary: 'workspace-write', cwd: request.params.cwd ?? this.options.cwd })
  }

  /** After an answer "for this session" (Codex's own session grant or its lasting rule): later
   *  commands of the same class in this runtime are answered without a card. Never an owner-only one. */
  private rememberSessionClass(request: ServerRequest, title: string): void {
    if (request.method !== 'item/commandExecution/requestApproval' || this.ownerOnlyEscalation(request)?.boundary) return
    const sessionClass = this.sessionClassOf(request)
    if (!sessionClass) return
    if (this.sessionClasses.size >= 256) this.sessionClasses.delete(this.sessionClasses.keys().next().value!)
    this.sessionClasses.set(sessionClass, title)
  }

  /** What the owner's auto-approve policy is asked about a request (approval-policy.ts), or
   *  undefined when it names nothing the policy reads. Permission grants and MCP tools are not asked. */
  private policyRequest(request: ServerRequest, nativeOwner: boolean): PolicyRequest | undefined {
    const base = { provider: 'codex', projectRoot: this.options.cwd, ...(nativeOwner ? { nativeOwner: true } : {}) }
    if (request.method === 'item/commandExecution/requestApproval') {
      if (!request.params.command) return undefined
      return { ...base, kind: request.params.networkApprovalContext ? 'network' : 'command', command: request.params.command, cwd: request.params.cwd ?? this.options.cwd }
    }
    if (request.method === 'item/fileChange/requestApproval') {
      const paths = this.requestPaths(request)
      return paths.length ? { ...base, kind: 'file-write', paths, cwd: this.options.cwd } : undefined
    }
    return undefined
  }

  /** One line naming what a policy-allowed request does, for its notice. */
  private policySubject(request: ServerRequest, title: string): string {
    if (request.method === 'item/commandExecution/requestApproval' && request.params.command) return commandText({ command: request.params.command }) ?? request.params.command
    if (request.method === 'item/fileChange/requestApproval') return `file changes to ${this.requestPaths(request).join(', ')}`
    return title
  }

  /** Why Auto leaves a native escalation to the owner (`held`), or undefined when it may answer it:
   *  the request must name what it reaches, and none of it may be an owner-only boundary
   *  (`boundary`, with the text that reaches it). */
  private ownerOnlyEscalation(request: ServerRequest): { held: string; boundary?: OwnerOnlyReach } | undefined {
    let reach: string
    if (request.method === 'item/commandExecution/requestApproval') {
      if (!request.params.command) return { held: 'it names no command Auto can check' }
      reach = [request.params.command, request.params.cwd ?? '', request.params.networkApprovalContext?.host ?? ''].join('\n')
    } else if (request.method === 'item/fileChange/requestApproval') {
      const paths = this.requestPaths(request)
      if (!paths.length) return { held: 'it names no paths Auto can check' }
      reach = paths.join('\n')
    } else if (request.method === 'item/permissions/requestApproval') reach = JSON.stringify(request.params.permissions)
    else return { held: 'it is not a request Auto answers' }
    const boundary = ownerOnlyReach(reach)
    return boundary ? { held: `it reaches ${boundary.boundary} (“${boundary.matched}”)`, boundary } : undefined
  }

  /** The exact response Codex expects for a decision on this request. */
  private decisionResult(request: ServerRequest, decision: string): Json {
    if (request.method === 'item/commandExecution/requestApproval') {
      // Where Codex offers no session grant of its own, the session choice is its execpolicy rule.
      // Failing that, the session choice is its network rule for the host (see the card's choices).
      const offered = request.params.availableDecisions
      const sessionRule = decision === 'acceptForSession' && Array.isArray(offered) && !offered.includes('acceptForSession')
      const execpolicy = codexExecpolicyAmendment(offered ?? [])
      if (decision === 'acceptWithExecpolicyAmendment' || sessionRule && execpolicy) {
        if (!execpolicy) throw new Error('Codex offered no command prefix rule for this request')
        return { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: execpolicy } } }
      }
      if (decision === 'applyNetworkPolicyAmendment' || sessionRule) {
        const network = codexNetworkAllowAmendment(offered ?? [])
        if (!network) throw new Error(sessionRule ? 'Codex offered no command prefix or network rule for this request' : 'Codex offered no network rule for this request')
        return { decision: { applyNetworkPolicyAmendment: { network_policy_amendment: json(network) } } }
      }
    }
    const granted = decision === 'accept' || decision === 'acceptForSession'
    if (request.method === 'item/permissions/requestApproval') {
      return { permissions: granted ? json(Object.fromEntries(Object.entries(request.params.permissions).filter(([, value]) => value !== null))) : {}, scope: decision === 'acceptForSession' ? 'session' : 'turn' }
    }
    if (request.method === 'mcpServer/elicitation/request') {
      // "session" keeps the answer for this thread only; "always" would write the owner's config.
      return granted ? { action: 'accept', content: {}, _meta: decision === 'acceptForSession' ? { persist: 'session' } : null } : { action: 'decline', content: null, _meta: null }
    }
    return { decision }
  }

  /** Resolves once every MCP server Codex reported as starting has finished (ready or failed),
   *  after `graceMs` when none was reported at all, or after `limitMs` regardless. */
  private awaitMcpStartup(limitMs = 8000, graceMs = 400): Promise<void> {
    return new Promise(resolve => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(limit)
        this.mcpStartupWaiters = this.mcpStartupWaiters.filter(waiter => waiter !== check)
        resolve()
      }
      const check = (): void => { if (this.mcpStartup.size && [...this.mcpStartup.values()].every(status => status !== 'starting')) finish() }
      const limit = setTimeout(finish, limitMs)
      this.mcpStartupWaiters.push(check)
      setTimeout(() => { if (!this.mcpStartup.size) finish() }, graceMs)
      check()
    })
  }

  /** On Windows, before a sandboxed turn: the project's .deps and .cache entries a pip install left
   *  with an owner-only permission list get inheritance back, so the sandbox can read them
   *  (codex-sandbox-acl.ts). Checked again only when the folder changed; never throws. */
  private async repairDependencyReadAccess(): Promise<void> {
    if ((this.dependencies.platform ?? process.platform) !== 'win32') return
    for (const name of CODEX_PROJECT_WRITABLE_DIRS) {
      const root = join(this.options.cwd, name)
      let stamp: number
      try { const entry = lstatSync(root); if (!entry.isDirectory() || entry.isSymbolicLink()) continue; stamp = entry.mtimeMs } catch { continue }
      if (this.aclChecked.get(root) === stamp) continue
      this.aclChecked.set(root, stamp)
      try {
        const result = await repairSandboxReadAccess(root, this.dependencies.icacls ?? runIcacls)
        if (result.repaired.length) this.emit({ data: { type: 'notice', message: `Codex sandbox: ${aclRepairNotice(root, result.repaired)}.`, payload: { repaired: result.repaired } } })
        for (const problem of result.problems) this.sandboxNotice(problem)
      } catch (error) {
        this.sandboxNotice(`the permissions of ${root} could not be checked (${error instanceof Error ? error.message : String(error)})`)
      }
    }
  }

  /** Once per runtime and problem: a sandbox setting that was left out, and why. */
  private sandboxNotice(problem: string): void {
    if (this.sandboxNotices.has(problem) || this.sandboxNotices.size >= 64) return
    this.sandboxNotices.add(problem)
    this.emit({ data: { type: 'notice', message: `Codex sandbox: ${problem}.` } })
  }

  /** Once per runtime: a command that failed before it ran because Codex's Windows sandbox helper
   *  could not refresh the sandbox is a CLI/host condition, not a conversation setting. The bare
   *  failed command would otherwise send the owner looking at permission modes. */
  private sandboxSetupNotice(text: string | null | undefined, correlation: Correlation): void {
    if (this.sandboxSetupNoticed || !text || !CODEX_SANDBOX_SETUP_FAILURE.test(text)) return
    this.sandboxSetupNoticed = true
    this.emit({ ...correlation, itemId: 'codex-sandbox-setup', data: { type: 'notice', message: 'Codex could not refresh its Windows sandbox (helper_unknown_error: setup refresh had errors), so its shell and file tools fail before they run. This is the Codex CLI\'s sandbox helper, not this conversation\'s permission mode. The precise cause is logged in %USERPROFILE%\\.codex\\.sandbox\\sandbox.<date>.log; see docs/codex-windows-sandbox-repair.md.' } })
  }

  private emitInteraction(request: ServerRequest, interaction: PendingInteraction): void {
    this.emit({ ...this.correlation(request.params), requestId: interaction.id, data: { type: 'interaction', interaction }, native: { method: request.method, payload: json(request.params) } })
  }

  private emitPhase(includeCapabilities = false): void {
    if (this.failed || this.disposed) return
    const requests = [...this.pending.values()].filter(request => request.blocking)
    const phase = this.interrupted ? 'interrupting' : requests.some(request => request.interaction.kind === 'approval') ? 'waiting_approval' : requests.length ? 'waiting_input' : this.turnId || this.dispatching ? 'running' : 'idle'
    this.emit({ data: { type: 'session', phase, ...(includeCapabilities ? { capabilities: this.capabilities } : {}) } })
  }

  private expireRequests(reason: string, threadId?: string, turnId?: string): void {
    for (const [id, pending] of this.pending) {
      const context = this.correlation(pending.request.params)
      if (threadId && context.nativeSessionId !== threadId || turnId && context.turnId !== turnId) continue
      this.pending.delete(id)
      this.emitInteraction(pending.request, { ...pending.interaction, status: 'expired', outcome: reason })
    }
  }

  private disconnect(message: string): void {
    for (const id of this.steeringInputs.keys()) this.inputDelivery(id, 'uncertain')
    if (this.failed) return
    this.failed = true
    for (const pending of this.rpc.values()) { clearTimeout(pending.timer); pending.reject(new Error(message)) }
    this.rpc.clear()
    this.expireRequests('Runtime disconnected')
    this.emit({ data: { type: 'session', phase: 'disconnected', message } })
  }

  private itemKey(context: Correlation): string { return JSON.stringify([context.nativeSessionId, context.turnId, context.itemId]) }
  private emitAccountLimits(limits: unknown, native: { method: string; payload?: Json }): void {
    // One rolling item is the current account snapshot. A separate first observation is the
    // only baseline used for movement; a read refresh never starts a turn or changes settings.
    if (!this.accountBaseline) {
      this.accountBaseline = true
      this.emit({ itemId: 'account-rate-limits:first', data: { type: 'usage', source: 'provider', limits: json(limits) }, native: { ...native, method: native.method + '/first' } })
    }
    this.emit({ itemId: 'account-rate-limits', data: { type: 'usage', source: 'provider', limits: json(limits) }, native })
  }

  private emit(event: AdapterEvent): void { this.options.emit({ nativeSessionId: this.threadId, turnId: this.turnId, ...event, data: event.data.type === 'session' ? { ...event.data, capabilities: { ...this.capabilities } } : event.data }) }
  private unknown(method: string, payload: unknown, message = `Codex event: ${method}`): void {
    this.emit({ ...this.correlation(payload), data: { type: 'notice', message, payload: json(payload) }, native: { method, payload: json(payload) } })
  }
}
