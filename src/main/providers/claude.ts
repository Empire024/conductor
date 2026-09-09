import { readClaudeTaskOutput } from './claude-task-output'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { open } from 'node:fs/promises'
import { workspacePath } from '../agent-artifacts'
import { InteractionResponseRejectedError, SteeringUnavailableError, type AdapterOptions, type ProviderAdapter } from './adapter'
import { JsonLineTransport, type TransportOptions } from './transport'
import { settingsForRuntime } from '../../shared/structured-agent'
import type { AdapterEvent, ContextAttachment, InteractionResponse, Json, PendingInteraction, ProviderCapabilities, SessionSettings } from '../../shared/structured-agent'

/** The local CLI bridge is checked against the official CLI/extension 2.1.263. */
export const CLAUDE_COMPATIBILITY = '2.1.263'
const parseClaudeVersion = (value: string): [number, number, number] | undefined => {
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(value.trim())
  return parts ? [Number(parts[1]), Number(parts[2]), Number(parts[3])] : undefined
}
/** The control protocol is additive within a major line, so a newer CLI keeps the launch flags
 *  and control subtypes this bridge sends. Only the exact baseline is fixture-verified: a newer
 *  patch/minor connects and records the gap, while an older or different-major CLI is refused
 *  because it may predate flags such as --permission-prompts. */
export function claudeCompatibility(version: string): { supported: boolean; verified: boolean } {
  if (version === CLAUDE_COMPATIBILITY) return { supported: true, verified: true }
  const runtime = parseClaudeVersion(version), baseline = parseClaudeVersion(CLAUDE_COMPATIBILITY)!
  if (!runtime || runtime[0] !== baseline[0]) return { supported: false, verified: false }
  const newer = runtime[1] > baseline[1] || (runtime[1] === baseline[1] && runtime[2] >= baseline[2])
  return { supported: newer, verified: false }
}
type ObjectValue = { [key: string]: Json }
const object = (value: Json | undefined): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const string = (value: Json | undefined): string | undefined => typeof value === 'string' ? value : undefined
const number = (value: Json | undefined): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined
const array = (value: Json | undefined): Json[] => Array.isArray(value) ? value : []
const display = (value: Json | undefined): string => typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value, null, 2)
interface Transport { start(): void; send(message: Json): void; close(): void; closeAndWait?(): Promise<void>; readonly connected: boolean }
interface Dependencies { createTransport?(options: TransportOptions): Transport; version?(executable: string): Promise<string> }
interface Tool { name: string; input: Json; parentId?: string; status: 'preparing' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'rejected' | 'interrupted'; captured?: boolean }
interface Block { id: string; kind: string; input: string; text: string }
class ClaudeControlRejectedError extends Error {}
interface Request { interaction: PendingInteraction; input: ObjectValue; toolId?: string; submitting: boolean; permissionUpdates?: Json[] }

function readVersion(executable: string): Promise<string> {
  return new Promise((resolve, reject) => execFile(executable, ['--version'], { windowsHide: true, timeout: 10_000, maxBuffer: 4096 }, (error, stdout) => {
    if (error) reject(new Error('Unable to read Claude Code version'))
    else resolve(stdout.match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? 'unknown')
  }))
}

/** Preserves native Claude Code authentication/configuration; never creates an API client. */
export class ClaudeAdapter implements ProviderAdapter {
  readonly provider = 'claude' as const
  private readonly providerCapabilities: ProviderCapabilities = {
    provider: 'claude', runtimeVersion: 'unknown', adapterVersion: 1, authentication: 'cli',
    steering: false, textStreaming: true, toolInputStreaming: true, toolOutputStreaming: false,
    approvals: true, questions: true, resume: true, fork: false, plans: true, imageAttachments: true, permissions: ['default', 'accept-edits', 'auto'],
    effort: ['low', 'medium', 'high', 'xhigh', 'max'], models: [],
    limitations: [
      'CLI authentication is inherited; subscription quota and API billing are not inferred from cost telemetry.',
      'Command output arrives with the tool result; token streaming does not imply command-output streaming.',
      'Read-only sandbox, native checkpoint/fork controls, cloud delegation and extension-only dialogs are not exposed.',
      'Conductor snapshots cover observed Edit/Write/NotebookEdit hooks only; shell edits and concurrent external changes cannot be attributed.',
      'Effort changes apply to the next turn through the native settings control; available levels depend on the selected model.'
    ]
  }
  private transport?: Transport
  private nativeSessionId?: string
  private turnId?: string
  private settings: SessionSettings
  private phase: Extract<AdapterEvent['data'], { type: 'session' }>['phase'] = 'idle'
  private ready = false
  private disposed = false
  private active = false
  private stopRequested = false
  private hasAssistantText = false
  private requests = new Map<string, Request>()
  private controls = new Map<string, { resolve(value: ObjectValue): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  private tools = new Map<string, Tool>()
  private streams = new Map<string, { messageId: string; blocks: Map<number, Block>; textBlocks: number }>()
  /** Backgrounded task id to its launch description; later events omit both facts. */
  private backgroundTasks = new Map<string, string>()
  private taskOutputRevision = new Map<string, number>()
  private seen = new Set<string>()
  private hookRequests = new Set<string>()
  private completedBlocks = new Set<string>()
  private replies = new Map<string, ObjectValue>()
  private messageUsage = new Map<string, ObjectValue>()
  private initializedMetadata: Json = {}
  private configurationMetadata: Json = {}
  private cumulativeCostUsd = 0
  /** Set once the first account allowance report of this runtime has been recorded. */
  private accountBaseline = false
  private contextTokens?: number
  private contextWindow?: number
  private maxOutputTokens?: number

  constructor(private options: AdapterOptions, private dependencies: Dependencies = {}) {
    this.nativeSessionId = options.nativeSessionId
    this.settings = { ...settingsForRuntime(options.settings, options.runtimeId) }
  }

  get capabilities(): ProviderCapabilities {
    this.providerCapabilities.steering = Boolean(this.ready && this.active && !this.stopRequested && !this.disposed && this.transport?.connected)
    return this.providerCapabilities
  }

  async start(): Promise<void> {
    if (this.transport || this.disposed) throw new Error('Claude runtime already started or disposed')
    this.validateSettings(this.settings)
    const version = await (this.dependencies.version ?? readVersion)(this.options.executable)
    this.capabilities.runtimeVersion = version
    // Control protocol is not promised stable across arbitrary CLI releases.
    const compatibility = claudeCompatibility(version)
    if (!compatibility.supported) throw new Error(`Claude Code ${version} is below the tested ${CLAUDE_COMPATIBILITY} bridge baseline; update Claude Code to ${CLAUDE_COMPATIBILITY} or newer`)
    if (!compatibility.verified) this.capabilities.limitations.push(`Runtime ${version} is newer than the fixture-verified ${CLAUDE_COMPATIBILITY} baseline; protocol changes in this release are not covered by Conductor's tests.`)
    const args = ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--permission-prompt-tool', 'stdio', '--permission-prompts', 'host',
      '--forward-subagent-text', '--permission-mode', this.permissionMode(this.settings)]
    if (this.settings.model) args.push('--model', this.settings.model)
    if (this.settings.effort) args.push('--effort', this.settings.effort)
    if (this.nativeSessionId) args.push(this.options.newNativeSession ? '--session-id' : '--resume', this.nativeSessionId)
    // No --bare, --system-prompt, --setting-sources, or environment auth mutation:
    // CLI defaults retain the coding-agent prompt, user/project/local configuration and policy.
    this.transport = (this.dependencies.createTransport ?? ((options) => new JsonLineTransport(options)))({
      executable: this.options.executable, args, cwd: this.options.cwd, environment: this.options.environment,
      onMessage: (message) => { void this.receive(message).catch((error: unknown) => this.fail(error)) },
      onStderr: (text) => this.emit({ data: { type: 'notice', message: 'Claude process diagnostic', payload: { stderr: text } }, native: { method: 'stderr' } }),
      onError: (error) => this.fail(error),
      onExit: (code, signal) => this.disconnected(`Claude runtime exited${code === null ? '' : ` (${code})`}${signal ? `: ${signal}` : ''}`)
    })
    this.emit({ data: { type: 'session', phase: 'starting', capabilities: this.capabilities } })
    this.transport.start()
    try {
      const initialized = await this.control({ subtype: 'initialize', hooks: {
        PreToolUse: [{ hookCallbackIds: ['conductor_before'], timeout: 15 }],
        PostToolUse: [{ hookCallbackIds: ['conductor_after'], timeout: 15 }],
        PostToolUseFailure: [{ hookCallbackIds: ['conductor_failed'], timeout: 15 }]
      }, forwardSubagentText: true, promptSuggestions: false, agentProgressSummaries: false })
      this.capabilities.models = array(initialized.models).flatMap((entry) => {
        const model = object(entry)
        const id = string(model.value) ?? string(model.id)
        const effort = model.supportsEffort === false ? [] : Array.isArray(model.supportedEffortLevels)
          ? model.supportedEffortLevels.filter((value): value is string => typeof value === 'string' && this.capabilities.effort.includes(value))
          : model.supportsEffort === true ? this.capabilities.effort : []
        return id ? [{ id, label: string(model.displayName) ?? string(model.name) ?? id, effort, ...(string(model.defaultEffort) ? { defaultEffort: string(model.defaultEffort) } : {}), ...(model.isDefault === true ? { isDefault: true } : {}) }] : []
      })
      this.ready = true
      this.initializedMetadata = initialized
      this.emit({ data: { type: 'notice', message: 'Claude runtime capabilities and discovered configuration', payload: initialized }, native: { method: 'initialize', payload: initialized } })
      this.emit({ data: { type: 'session', phase: 'idle', nativeSessionId: this.nativeSessionId, capabilities: this.capabilities } })
    } catch (error) {
      this.fail(error)
      this.transport.close()
      throw error
    }
  }

  async submit(text: string, settings: SessionSettings, attachments: ContextAttachment[] = []): Promise<void> {
    if (!this.ready || !this.transport?.connected || this.disposed) throw new Error('Claude runtime is disconnected')
    if (this.active || this.requests.size) throw new Error('Claude is already processing a turn')
    settings = settingsForRuntime(settings, this.options.runtimeId)
    this.validateSettings(settings)
    const messageId = randomUUID()
    const message = await this.userMessage(text, attachments, messageId)
    if (settings.effort !== this.settings.effort) await this.control({ subtype: 'apply_flag_settings', settings: { effortLevel: settings.effort ?? null } })
    if (settings.model !== this.settings.model) await this.control({ subtype: 'set_model', model: settings.model ?? null })
    if (this.permissionMode(settings) !== this.permissionMode(this.settings)) await this.control({ subtype: 'set_permission_mode', mode: this.permissionMode(settings) })
    this.settings = { ...settings }
    this.capabilities.effectiveSettings = { ...object(this.capabilities.effectiveSettings), ...(settings.model ? { model: settings.model } : {}), effort: settings.effort ?? null, permissionMode: this.permissionMode(settings) }
    this.turnId = messageId
    this.hasAssistantText = false
    this.stopRequested = false
    this.active = true
    try {
      this.transport.send(message)
      this.emit({ data: { type: 'session', phase: 'running', capabilities: this.capabilities } })
    } catch (error) { this.active = false; throw error }
  }

  private async userMessage(text: string, attachments: ContextAttachment[], messageId: string): Promise<Json> {
    if (/^\/(clear|reset|new)(?:\s|$)/i.test(text.trim())) throw new Error('Conversation reset requires a new Conductor session; the existing native conversation is preserved')
    const imageBlocks: Json[] = []
    let encodedImageBytes = 0
    for (const image of attachments.filter((item) => item.kind === 'image')) {
      const block = await this.imageInput(image)
      encodedImageBytes += Buffer.byteLength(JSON.stringify(block))
      if (encodedImageBytes > 4 * 1024 * 1024) throw new Error('Claude image attachments exceed the 4 MiB combined message limit')
      imageBlocks.push(block)
    }
    // Only explicitly selected context is included. The host validates/loads file bytes.
    const context = attachments.filter((item) => item.kind !== 'image').map((item) => `\n\n--- Attached ${item.kind}: ${item.name}${item.path ? ` (${item.path})` : ''}${item.startLine ? ` lines ${item.startLine}-${item.endLine ?? item.startLine}` : ''} ---\n${item.content ?? ''}`)
    const content: Json = imageBlocks.length ? [...imageBlocks, { type: 'text', text: text + context.join('') }] : text + context.join('')
    const message: Json = { type: 'user', uuid: messageId, session_id: this.nativeSessionId ?? '', parent_tool_use_id: null, message: { role: 'user', content } }
    if (imageBlocks.length && Buffer.byteLength(JSON.stringify(message)) > 4 * 1024 * 1024) throw new Error('Claude image attachments exceed the 4 MiB combined message limit')
    return message
  }

  private steeringInputs = new Map<string, string | undefined>()

  async steer(text: string, _settings: SessionSettings, attachments: ContextAttachment[] = [], inputId: string = randomUUID()): Promise<void> {
    if (!this.ready || !this.transport?.connected || this.disposed) throw new SteeringUnavailableError('Claude runtime is disconnected')
    if (!this.active || this.stopRequested) throw new SteeringUnavailableError('There is no active Claude turn to steer')
    const turnId = this.turnId
    const message = await this.userMessage(text, attachments, inputId)
    if (!this.capabilities.steering || this.turnId !== turnId) throw new SteeringUnavailableError('The Claude turn stopped before steering could be sent')
    // Native 'next' priority folds the input alongside the next tool result.
    this.steeringInputs.set(inputId, turnId)
    try { this.transport.send({ ...object(message), priority: 'next' }) }
    catch (error) { this.steeringInputs.delete(inputId); throw error }
  }

  private inputDelivery(inputId: string, status: 'accepted' | 'delivered' | 'cancelled' | 'uncertain', native?: AdapterEvent['native']): void {
    if (!this.steeringInputs.has(inputId)) return
    const turnId = this.steeringInputs.get(inputId)
    if (status !== 'accepted') this.steeringInputs.delete(inputId)
    this.emit({ turnId, data: { type: 'input_delivery', inputId, status }, native })
  }

  async respond(response: InteractionResponse): Promise<void> {
    if (response.runtimeId !== this.options.runtimeId) throw new Error('Approval belongs to an expired runtime')
    const pending = this.requests.get(response.requestId)
    if (!pending || pending.submitting || !this.transport?.connected) throw new Error('Approval is stale, disconnected, or already resolved')
    const decision = response.decision ?? (response.answers ? 'allow' : '')
    if (!pending.interaction.choices.some(choice => choice.id === decision && !choice.disabled)) throw new Error('Unsupported Claude permission decision')
    const allowed = decision === 'allow' || decision === 'allow-session' || decision === 'auto-mode'
    let input: Json = pending.input
    if (pending.interaction.kind === 'question' && decision === 'allow') {
      const answers: ObjectValue = {}
      for (const question of pending.interaction.questions ?? []) {
        const values = response.answers?.[question.id]
        if (!values?.length || values.some((value) => typeof value !== 'string' || value.length > 10_000)) throw new Error('Every question requires an answer')
        if (!question.multiSelect && values.length !== 1) throw new Error('Question accepts only one answer')
        answers[question.question] = question.multiSelect ? values : values[0]!
      }
      input = { ...pending.input, answers }
    }
    pending.submitting = true // claim synchronously across every pane before sending
    try {
      const sessionEditMode = decision === 'allow-session' && pending.permissionUpdates?.some(update => object(update).type === 'setMode' && object(update).mode === 'acceptEdits')
      if (decision === 'auto-mode' || sessionEditMode) {
        const mode = sessionEditMode ? 'acceptEdits' : 'auto'
        // Change the real provider mode first. A managed-policy refusal must leave
        // the request unanswered so the owner can still allow once or deny it.
        try { await this.control({ subtype: 'set_permission_mode', mode }) }
        catch (error) {
          if (error instanceof ClaudeControlRejectedError) throw new InteractionResponseRejectedError(`Claude could not switch to ${sessionEditMode ? 'session Edit mode' : 'auto-mode'}: ${error.message}`)
          throw error
        }
        if (this.disposed || !this.transport?.connected) throw new Error('Claude disconnected while switching permission mode')
        const { temporaryPermission, ...current } = this.settings
        this.settings = sessionEditMode
          ? { ...current, permission: 'accept-edits', plan: false, temporaryPermission: { runtimeId: this.options.runtimeId, restore: temporaryPermission?.restore ?? current.permission } }
          : { ...current, permission: 'auto', plan: false }
        this.capabilities.effectiveSettings = { ...object(this.capabilities.effectiveSettings), permissionMode: mode }
        this.emit({ data: { type: 'session', phase: this.phase, settings: { ...this.settings } } })
        // The provider may cancel/reissue permission requests while changing mode.
        // Never send a stale allow or resurrect a cancelled/finished request.
        if (this.requests.get(response.requestId) !== pending) return
      }
      this.reply(response.requestId, allowed
        ? { behavior: 'allow', updatedInput: input, ...(decision === 'allow-session' ? { updatedPermissions: pending.permissionUpdates ?? [] } : {}), ...(pending.toolId ? { toolUseID: pending.toolId } : {}) }
        : { behavior: 'deny', message: decision === 'abort' ? 'User cancelled this turn' : 'User denied this operation', interrupt: decision === 'abort', ...(pending.toolId ? { toolUseID: pending.toolId } : {}) })
      this.requests.delete(response.requestId)
      this.emit({ requestId: response.requestId, itemId: pending.toolId, data: { type: 'interaction', interaction: { ...pending.interaction, status: 'resolved', outcome: decision } } })
      if (pending.toolId) this.updateTool(pending.toolId, { status: allowed ? 'preparing' : decision === 'abort' ? 'interrupted' : 'rejected' })
      if (decision === 'abort') {
        this.stopRequested = true
        this.interruptWaitingTools()
        this.expireRequests('Cancelled turn')
      }
      this.emitWaiting()
    } catch (error) { pending.submitting = false; throw error }
  }

  async interrupt(): Promise<void> {
    if (!this.active || !this.transport?.connected) return
    this.stopRequested = true
    this.interruptWaitingTools()
    this.expireRequests('Interrupted by user')
    this.emit({ data: { type: 'session', phase: 'interrupting' } })
    // Cancellation goes through the supported full-duplex control channel.
    // An ACK is not a completion event; await the final result or disconnect.
    const receipt = await this.control({ subtype: 'interrupt', cancel_queued: true })
    // Only the exact native cancellation receipt authorizes replay after Escape.
    for (const id of array(receipt.cancelled)) if (typeof id === 'string') this.inputDelivery(id, 'cancelled', { method: 'interrupt', payload: receipt })
  }

  async stop(): Promise<void> { this.dispose(); await this.transport?.closeAndWait?.() }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.disconnected('Claude runtime stopped; history remains available and resume is explicit')
    this.transport?.close()
  }

  async discover(): Promise<Json> {
    return structuredClone({ connection: 'local-cli', runtimeVersion: this.capabilities.runtimeVersion, initialize: this.initializedMetadata, configuration: this.configurationMetadata })
  }

  private emit(event: AdapterEvent): void {
    if (event.data.type === 'session') this.phase = event.data.phase
    this.options.emit({ nativeSessionId: this.nativeSessionId, turnId: this.turnId, ...event, data: event.data.type === 'session' ? { ...event.data, capabilities: { ...this.capabilities } } : event.data })
  }
  private validateSettings(settings: SessionSettings): void {
    if (settings.permission === 'read-only') throw new Error('Claude CLI has no Conductor read-only sandbox; use explicit permissions or plan mode')
    if (settings.effort && !this.capabilities.effort.includes(settings.effort)) throw new Error('Unsupported Claude effort level')
  }
  private permissionMode(settings: SessionSettings): string { return settings.plan ? 'plan' : settings.permission === 'accept-edits' ? 'acceptEdits' : settings.permission === 'auto' ? 'auto' : 'manual' }
  private async imageInput(attachment: ContextAttachment): Promise<Json> {
    if (!attachment.path) throw new Error('Claude image attachment requires a local workspace path')
    const path = await workspacePath(this.options.cwd, attachment.path)
    const file = await open(path, 'r')
    try {
      const metadata = await file.stat(), maximum = 3 * 1024 * 1024
      if (!metadata.isFile() || metadata.size > maximum) throw new Error('Claude image attachment must be a file no larger than 3 MiB')
      // Bounded descriptor read protects memory even if the source grows after stat.
      const buffer = Buffer.alloc(metadata.size + 1)
      let offset = 0
      while (offset < buffer.length) {
        const read = await file.read(buffer, offset, buffer.length - offset, offset)
        if (!read.bytesRead) break
        offset += read.bytesRead
      }
      if (offset > metadata.size) throw new Error('Image changed while preparing attachment; attach it again')
      const bytes = buffer.subarray(0, offset)
      const mediaType = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
        : bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
        : ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii')) ? 'image/gif'
        : bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP' ? 'image/webp' : undefined
      if (!mediaType) throw new Error('Claude images must contain PNG, JPEG, GIF, or WebP bytes')
      return { type: 'image', source: { type: 'base64', media_type: mediaType, data: bytes.toString('base64') } }
    } finally { await file.close() }
  }
  private control(request: ObjectValue): Promise<ObjectValue> {
    const id = `${this.options.runtimeId}:control:${randomUUID()}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.controls.delete(id); reject(new Error(`Claude control request timed out (${string(request.subtype) ?? 'unknown'})`)) }, 30_000)
      this.controls.set(id, { resolve, reject, timer })
      try { this.transport!.send({ type: 'control_request', request_id: id, request }) }
      catch (error) { clearTimeout(timer); this.controls.delete(id); reject(error) }
    })
  }
  private reply(requestId: string, response: ObjectValue): void {
    this.transport!.send({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })
    this.replies.set(requestId, response)
    if (this.replies.size > 2048) this.replies.delete(this.replies.keys().next().value!)
  }
  private replyError(requestId: string, error: string): void {
    this.transport!.send({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error } })
  }

  private async receive(value: Json): Promise<void> {
    if (this.disposed) return
    const message = object(value)
    const type = string(message.type)
    if (type === 'control_response') {
      const response = object(message.response), id = string(response.request_id)
      const pending = id ? this.controls.get(id) : undefined
      if (!pending || !id) return
      clearTimeout(pending.timer); this.controls.delete(id)
      if (response.subtype === 'success') pending.resolve(object(response.response))
      else pending.reject(new ClaudeControlRejectedError(string(response.error) ?? 'Claude control request failed'))
      return
    }
    if (type === 'control_request') return this.runtimeRequest(message)
    if (type === 'control_cancel_request') {
      const id = string(message.request_id)
      if (id) { this.expireRequest(id, 'Provider cancelled request'); this.emitWaiting() }
      return
    }
    const uuid = string(message.uuid)
    if (uuid) {
      if (this.seen.has(uuid)) return
      this.seen.add(uuid)
      if (this.seen.size > 8192) this.seen.delete(this.seen.values().next().value!)
    }
    const parentId = string(message.parent_tool_use_id)
    const sessionId = string(message.session_id)
    if (sessionId && !parentId) {
      if (this.nativeSessionId && sessionId !== this.nativeSessionId) throw new Error('Claude changed native conversation identity unexpectedly')
      this.nativeSessionId = sessionId
    }
    if (type === 'command_lifecycle' && !parentId) {
      const inputId = string(message.command_uuid)
      if (!inputId || !this.steeringInputs.has(inputId)) return
      const native = { method: 'command_lifecycle', payload: message }
      if (message.state === 'queued') this.inputDelivery(inputId, 'accepted', native)
      else if (message.state === 'started') {
        // A command may start a fresh native turn after the preceding result.
        if (!this.active) { this.turnId = inputId; this.active = true; this.stopRequested = false; this.hasAssistantText = false; this.emit({ data: { type: 'session', phase: 'running' } }) }
        this.inputDelivery(inputId, 'delivered', native)
      } else if (message.state === 'discarded' || message.state === 'refused') this.inputDelivery(inputId, 'cancelled', native)
      // 'cancelled' also describes an already absorbed message in an aborted turn.
      // Interrupt's per-uuid receipt, rather than that ambiguous frame, permits replay.
      else if (message.state === 'completed' || message.state === 'cancelled' && !this.stopRequested) this.inputDelivery(inputId, 'uncertain', native)
      return
    }
    if (type === 'stream_event') return this.stream(message, parentId)
    if (type === 'assistant' || type === 'user') {
      const body = object(message.message), messageId = string(body.id) ?? uuid
      if (type === 'assistant' && !parentId && typeof body.model === 'string') {
        this.resetContextForModel(body.model)
        this.capabilities.effectiveSettings = { ...object(this.capabilities.effectiveSettings), model: body.model }
        this.emit({ data: { type: 'session', phase: this.active ? 'running' : 'idle', capabilities: this.capabilities } })
      }
      if (type === 'assistant' && messageId) this.usage(object(body.usage), `usage:message:${messageId}`, 'message', parentId)
      let textIndex = 0
      for (const content of array(body.content)) {
        const block = object(content)
        if (block.type === 'text' && type === 'assistant' && messageId) {
          const id = `${messageId}:text:${textIndex++}`, text = this.visibleText(string(block.text) ?? '')
          this.completedBlocks.add(id)
          if (this.completedBlocks.size > 8192) this.completedBlocks.delete(this.completedBlocks.values().next().value!)
          if (text && !parentId) this.hasAssistantText = true
          this.emit({ itemId: id, parentId, data: { type: 'text', role: 'assistant', text, mode: 'snapshot' } })
        } else if (block.type === 'tool_use' && typeof block.id === 'string') {
          this.declareTool(block.id, string(block.name) ?? 'Unknown tool', block.input ?? {}, parentId)
        } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          const id = block.tool_use_id
          const output = Array.isArray(block.content) ? block.content.map((entry) => string(object(entry).text) ?? display(entry)).join('\n') : display(block.content)
          const details = object(message.tool_use_result)
          const priorStatus = this.tools.get(id)?.status
          this.updateTool(id, { status: priorStatus === 'rejected' || priorStatus === 'interrupted' || priorStatus === 'failed' ? priorStatus : block.is_error === true || (number(details.exitCode) ?? 0) !== 0 ? 'failed' : 'completed' }, {
            output: string(details.stdout) ?? output, outputMode: 'snapshot', ...(typeof details.stderr === 'string' ? { stderr: details.stderr } : {}),
            ...(number(details.exitCode) !== undefined ? { exitCode: number(details.exitCode) } : {})
          })
        }
        // Hidden thinking/signatures are intentionally not presented as readable reasoning.
      }
      return
    }
    if (type === 'tool_progress' && typeof message.tool_use_id === 'string') {
      const id = message.tool_use_id
      if (!this.tools.has(id)) this.declareTool(id, string(message.tool_name) ?? 'Tool', {}, parentId)
      this.updateTool(id, { status: 'running' })
      return
    }
    if (type === 'result') {
      const failure = message.is_error === true || (typeof message.subtype === 'string' && message.subtype !== 'success')
      const resultText = this.visibleText(string(message.result) ?? '')
      if (!this.hasAssistantText && resultText && !failure && !this.stopRequested) {
        this.hasAssistantText = true
        this.emit({ itemId: `result:${this.turnId ?? uuid}`, data: { type: 'text', role: 'assistant', mode: 'snapshot', text: resultText } })
      }
      const usage = object(message.usage)
      this.usage(usage, `usage:turn:${this.turnId ?? uuid ?? randomUUID()}`, 'turn', parentId)
      if (!parentId) {
        const model = string(object(this.capabilities.effectiveSettings).model)
        const models = object(message.modelUsage)
        const metadata = object(model ? models[model] : Object.keys(models).length === 1 ? Object.values(models)[0] : undefined)
        this.contextWindow = number(metadata.contextWindow) ?? this.contextWindow
        this.maxOutputTokens = number(metadata.maxOutputTokens) ?? this.maxOutputTokens
        this.emitContext()
      }
      const cumulativeCost = number(message.total_cost_usd)
      // CLI stream-input results contain per-turn tokens but runtime-cumulative estimated cost.
      // Cost is computed from the CLI price table, not authoritative account billing/quota.
      if (cumulativeCost !== undefined && cumulativeCost >= this.cumulativeCostUsd) {
        if (cumulativeCost > this.cumulativeCostUsd || cumulativeCost === 0) this.emit({ itemId: `usage:cost:${this.turnId ?? uuid ?? randomUUID()}`, parentId, data: { type: 'usage', scope: 'turn', source: 'estimate', costUsd: cumulativeCost - this.cumulativeCostUsd }, native: { method: 'result/estimated_cost', payload: { total_cost_usd: cumulativeCost, scope: 'runtime_cumulative' } } })
        this.cumulativeCostUsd = cumulativeCost
      } else if (cumulativeCost !== undefined) {
        this.emit({ data: { type: 'notice', message: 'Claude reported a lower cumulative cost; this turn cost estimate is unknown', payload: { total_cost_usd: cumulativeCost } } })
      }
      this.active = false
      this.expireRequests('Turn ended')
      if (failure && !this.stopRequested) this.emit({ data: { type: 'error', message: this.visibleText(array(message.errors).map(display).join('\n')) || resultText || string(message.subtype) || 'Claude turn failed' } })
      for (const [id, tool] of this.tools) if (['preparing', 'running', 'awaiting_approval'].includes(tool.status)) this.updateTool(id, { status: this.stopRequested ? 'interrupted' : 'failed' })
      this.emit({ data: { type: 'session', phase: this.stopRequested ? 'interrupted' : failure ? 'failed' : 'completed', nativeSessionId: this.nativeSessionId }, native: { method: 'result', payload: message } })
      return
    }
    if (type === 'rate_limit_event') {
      this.accountWindows(object(object(message.rate_limit_info).unifiedWindows), message)
      return
    }
    if (type === 'system' && message.subtype === 'compact_boundary' && !parentId) {
      this.contextTokens = undefined
      this.emitContext()
      return
    }
    if (type === 'system' && message.subtype === 'init') {
      this.configurationMetadata = message
      if (typeof message.model === 'string') this.resetContextForModel(message.model)
      if (typeof message.model === 'string') this.capabilities.effectiveSettings = { model: message.model, effort: this.settings.effort ?? string(message.effort) ?? null, permissionMode: string(message.permissionMode) ?? this.permissionMode(this.settings) }
      if (typeof message.claude_code_version === 'string') this.capabilities.runtimeVersion = message.claude_code_version
      this.emit({ data: { type: 'session', phase: this.active ? 'running' : 'idle', nativeSessionId: this.nativeSessionId, capabilities: this.capabilities }, native: { method: 'system/init', payload: message } })
      return
    }
    if (type === 'system' && ['task_started', 'task_progress', 'task_notification'].includes(string(message.subtype) ?? '')) {
      const id = string(message.task_id) ?? string(message.tool_use_id)
      const status: Extract<import('../../shared/structured-agent').AgentEventData, { type: 'subagent' }>['status'] = message.status === 'failed' ? 'failed' : message.status === 'stopped' ? 'interrupted' : message.status === 'completed' ? 'completed' : 'running'
      const native = { method: `system/${String(message.subtype)}`, payload: message }
      const description = string(message.description)
      // Only task_started carries is_backgrounded; later events for the same task are
      // matched by id, and a completion naming an output file is backgrounded by itself.
      if (message.is_backgrounded === true && id) this.backgroundTasks.set(id, description ?? '')
      const backgrounded = Boolean(id && this.backgroundTasks.has(id)) || Boolean(string(message.output_file))
      // A foreground task is the lifecycle of a tool call that is already on the timeline.
      // Repeating it as a subagent invents children that never existed.
      if (!backgrounded) {
        this.emit({ parentId: string(message.tool_use_id) ?? parentId, data: { type: 'notice', message: 'Claude task lifecycle', payload: message }, native })
        return
      }
      // Completions carry only a summary ("... completed (exit code 0)"), so the launch
      // description is kept as the name rather than being overwritten by it.
      const name = (id ? this.backgroundTasks.get(id) : '') || description || string(message.summary) || 'Background activity'
      if (id && status !== 'running') this.backgroundTasks.delete(id)
      // Backgrounded work keeps running after the turn ends, so the roster must not
      // treat a finished parent turn as evidence that its status went stale.
      const outputFile = string(message.output_file) || undefined
      const task = { itemId: id ? `task:${id}` : undefined, parentId: string(message.tool_use_id) ?? parentId, data: { type: 'subagent' as const, name, status, detached: true, outputFile }, native }
      this.emit(task)
      if (id) {
        const revision = (this.taskOutputRevision.get(id) ?? 0) + 1
        this.taskOutputRevision.set(id, revision)
        if (outputFile) {
          const output = await readClaudeTaskOutput(outputFile, id, this.nativeSessionId)
          if (!this.disposed && this.taskOutputRevision.get(id) === revision) this.emit({ ...task, data: { ...task.data, ...output } })
        }
      }
      return
    }
    this.emit({ parentId, data: { type: 'notice', message: `Claude ${type ?? 'unknown'}${message.subtype ? ` / ${String(message.subtype)}` : ''}`, payload: message }, native: { method: type ?? 'unknown', payload: message } })
  }

  private stream(message: ObjectValue, parentId?: string): void {
    const event = object(message.event), key = parentId ?? 'main'
    if (event.type === 'message_start') {
      const body = object(event.message), id = string(body.id)
      if (id) {
        this.streams.set(key, { messageId: id, blocks: new Map(), textBlocks: 0 })
        if (!parentId && typeof body.model === 'string') {
          this.resetContextForModel(body.model)
          this.capabilities.effectiveSettings = { ...object(this.capabilities.effectiveSettings), model: body.model, ...(this.settings.effort ? { effort: this.settings.effort } : {}) }
          this.emit({ data: { type: 'session', phase: this.active ? 'running' : 'idle', capabilities: this.capabilities } })
        }
        this.usage(object(body.usage), `usage:message:${id}`, 'message', parentId)
      }
      return
    }
    const stream = this.streams.get(key), index = number(event.index)
    if (!stream) return
    if (event.type === 'message_stop') { this.streams.delete(key); return }
    if (event.type === 'message_delta') { this.usage(object(event.usage), `usage:message:${stream.messageId}`, 'message', parentId); return }
    if (index === undefined) return
    if (event.type === 'content_block_start') {
      const block = object(event.content_block), kind = string(block.type) ?? 'unknown'
      const id = kind === 'tool_use' ? string(block.id) : kind === 'text' ? `${stream.messageId}:text:${stream.textBlocks++}` : `${stream.messageId}:${index}`
      if (!id) return
      stream.blocks.set(index, { id, kind, input: '', text: string(block.text) ?? '' })
      if (kind === 'tool_use') this.declareTool(id, string(block.name) ?? 'Unknown tool', block.input ?? {}, parentId)
      else if (kind === 'text' && typeof block.text === 'string' && block.text && !this.completedBlocks.has(id)) {
        const text = this.visibleText(block.text, true)
        if (text) { if (!parentId) this.hasAssistantText = true; this.emit({ itemId: id, parentId, data: { type: 'text', role: 'assistant', mode: 'snapshot', text } }) }
      }
      return
    }
    const block = stream.blocks.get(index)
    if (!block || this.completedBlocks.has(block.id)) return
    if (event.type === 'content_block_delta') {
      const delta = object(event.delta)
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        const previous = this.visibleText(block.text, true)
        block.text += delta.text
        const text = this.visibleText(block.text, true)
        if (text && !parentId) this.hasAssistantText = true
        if (text !== previous) this.emit({ itemId: block.id, parentId, data: { type: 'text', role: 'assistant', ...(text.startsWith(previous) ? { mode: 'delta' as const, text: text.slice(previous.length) } : { mode: 'snapshot' as const, text }) } })
      } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        block.input += delta.partial_json
        if (Buffer.byteLength(block.input) > 1024 * 1024) throw new Error('Claude tool input exceeds 1 MiB preview limit')
        this.updateTool(block.id, {}, { inputDelta: delta.partial_json })
      }
    } else if (event.type === 'content_block_stop' && block.kind === 'tool_use' && block.input) {
      try { this.updateTool(block.id, { input: JSON.parse(block.input) as Json }) }
      catch { this.emit({ itemId: block.id, data: { type: 'notice', message: 'Incomplete tool input JSON; awaiting the authoritative complete message' } }) }
      // Tool declaration completed, not execution. Only native progress/result proves execution.
    }
  }

  private visibleText(text: string, partial = false): string {
    return text.split('\n').filter(line => !/^\s*\[ede_diagnostic\]/.test(line)).filter((line, index, lines) => {
      const candidate = line.trimStart()
      return !(partial && index === lines.length - 1 && candidate.length > 0 && '[ede_diagnostic]'.startsWith(candidate))
    }).join('\n')
  }
  private usage(update: ObjectValue, itemId: string, scope: 'message' | 'turn', parentId?: string): void {
    const previous = this.messageUsage.get(itemId) ?? {}, usage = { ...previous, ...Object.fromEntries(Object.entries(update).filter(([, value]) => value !== null)) }
    this.messageUsage.set(itemId, usage)
    if (this.messageUsage.size > 4096) this.messageUsage.delete(this.messageUsage.keys().next().value!)
    const uncached = number(usage.input_tokens), cachedTokens = number(usage.cache_read_input_tokens), cacheCreationTokens = number(usage.cache_creation_input_tokens), outputTokens = number(usage.output_tokens)
    const inputTokens = uncached === undefined ? undefined : uncached + (cachedTokens ?? 0) + (cacheCreationTokens ?? 0)
    if ([inputTokens, cachedTokens, cacheCreationTokens, outputTokens].every(value => value === undefined)) return
    if (scope === 'message' && !parentId && inputTokens !== undefined && outputTokens !== undefined) { this.contextTokens = inputTokens + outputTokens; this.emitContext() }
    this.emit({ itemId, parentId, data: { type: 'usage', scope, source: 'provider', inputTokens, cachedTokens, cacheCreationTokens, outputTokens, ...(inputTokens !== undefined && outputTokens !== undefined ? { totalTokens: inputTokens + outputTokens } : {}) } })
  }

  /**
   * Claude reports account allowance as `rate_limit_event.rate_limit_info.unifiedWindows`,
   * keyed by window with `utilization` on a 0-1 scale and an epoch-second `resetsAt`.
   * Only reported windows are forwarded, rescaled to the same 0-100 `usedPercent` shape
   * Codex reports, so the app has one account-allowance vocabulary. Window durations are
   * the fixed meaning of Claude's own key names, not a guess about the owner's plan.
   */
  private accountWindows(windows: ObjectValue, native: ObjectValue): void {
    const durations: Record<string, number> = { five_hour: 300, seven_day: 10_080, seven_day_overage_included: 10_080 }
    const rateLimits: ObjectValue = {}
    for (const [key, value] of Object.entries(windows)) {
      const utilization = number(object(value).utilization)
      if (utilization === undefined || utilization < 0) continue
      const resetsAt = number(object(value).resetsAt)
      rateLimits[key] = {
        usedPercent: utilization * 100,
        ...(durations[key] !== undefined ? { windowDurationMins: durations[key]! } : {}),
        ...(resetsAt !== undefined ? { resetsAt } : {})
      }
    }
    if (!Object.keys(rateLimits).length) return
    // The rolling item keeps one current level per runtime; the timeline reconciles it in
    // place. Recording the first reported level separately is what makes "this run consumed
    // N points" a difference between two provider reports rather than an assumption.
    if (!this.accountBaseline) {
      this.accountBaseline = true
      this.emit({ itemId: 'usage:account-rate-limits:first', data: { type: 'usage', source: 'provider', limits: { rateLimits } }, native: { method: 'rate_limit_event/first', payload: native } })
    }
    this.emit({ itemId: 'usage:account-rate-limits', data: { type: 'usage', source: 'provider', limits: { rateLimits } }, native: { method: 'rate_limit_event', payload: native } })
  }

  private resetContextForModel(model: string): void {
    const previous = string(object(this.capabilities.effectiveSettings).model)
    if (!previous || previous === model) return
    this.contextTokens = undefined; this.contextWindow = undefined; this.maxOutputTokens = undefined
    this.emitContext()
  }

  private emitContext(): void {
    // Claude VS Code 2.1.263 reserves maximum output plus 13k for compaction.
    const capacity = this.contextWindow !== undefined && this.maxOutputTokens !== undefined ? this.contextWindow - this.maxOutputTokens - 13_000 : undefined
    this.emit({ itemId: 'usage:context', data: { type: 'usage', source: 'provider', limits: {
      contextUsedTokens: this.contextTokens ?? null, modelContextWindow: this.contextWindow ?? null,
      contextCapacityTokens: capacity !== undefined && capacity > 0 ? capacity : null
    } } })
  }

  private declareTool(id: string, name: string, input: Json, parentId?: string): void {
    const existing = this.tools.get(id)
    this.tools.set(id, { ...existing, name, input, parentId: parentId ?? existing?.parentId, status: existing?.status ?? 'preparing' })
    this.updateTool(id, {})
    if (this.tools.size > 4096) for (const [key, tool] of this.tools) {
      if (['completed', 'failed', 'rejected', 'interrupted'].includes(tool.status)) this.tools.delete(key)
      if (this.tools.size <= 3072) break
    }
  }
  private updateTool(id: string, update: Partial<Tool>, data: Partial<Extract<AdapterEvent['data'], { type: 'tool' }>> = {}): void {
    const tool = { ...(this.tools.get(id) ?? { name: 'Unknown tool', input: {}, status: 'preparing' as const }), ...update }
    this.tools.set(id, tool)
    const description = string(object(tool.input).description)
    this.emit({ itemId: id, parentId: tool.parentId, data: { type: 'tool', name: tool.name, ...(data.inputDelta !== undefined ? {} : { input: tool.input }), status: tool.status, ...(description ? { description } : {}), ...data } })
  }
  private async runtimeRequest(message: ObjectValue): Promise<void> {
    const id = string(message.request_id), request = object(message.request)
    if (!id) throw new Error('Malformed Claude control request without identity')
    const replied = this.replies.get(id)
    if (replied) { this.reply(id, replied); return }
    if (this.requests.has(id) || this.hookRequests.has(id)) return
    if (request.subtype === 'hook_callback') {
      this.hookRequests.add(id)
      try { await this.hook(request); if (!this.disposed && this.transport?.connected) this.reply(id, {}) }
      catch (error) { if (this.transport?.connected) this.replyError(id, error instanceof Error ? error.message : 'Conductor hook failed') }
      finally { this.hookRequests.delete(id) }
      return
    }
    if (request.subtype !== 'can_use_tool') {
      this.emit({ requestId: id, data: { type: 'notice', message: `Unsupported Claude control request: ${string(request.subtype) ?? 'unknown'}`, payload: request } })
      this.replyError(id, 'This Claude control capability is not implemented by Conductor')
      return
    }
    const input = object(request.input), toolId = string(request.tool_use_id), name = string(request.tool_name) ?? 'Unknown tool'
    if (toolId) {
      if (!this.tools.has(toolId)) this.declareTool(toolId, name, input, string(request.parent_tool_use_id))
      this.updateTool(toolId, { status: 'awaiting_approval' })
    }
    const question = name === 'AskUserQuestion'
    // Only native tool-specific suggestions may become reusable grants. Claude
    // evaluates these rules itself, preserving ask rules and mandatory approvals.
    // Edit rules also govern Write/NotebookEdit in the provider permission engine.
    const ruleNames = new Set([name, ...(['Write', 'NotebookEdit', 'MultiEdit'].includes(name) ? ['Edit'] : [])])
    const requiredApproval = request.matched_ask_rule != null || /requires? (?:user )?approval|requires? user interaction/i.test(string(request.decision_reason) ?? '')
    const permissionUpdates: ObjectValue[] = requiredApproval || this.settings.plan ? [] : array(request.permission_suggestions ?? request.permissionSuggestions ?? request.suggestions).flatMap(value => {
      const update = object(value), rules = array(update.rules)
      // The CLI offers its native session Edit mode on Write/Edit requests.
      // It covers all edits, so describe that explicitly and restore on resume.
      if (update.type === 'setMode' && update.mode === 'acceptEdits' && update.destination === 'session' && ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'].includes(name)) return [update]
      return update.type === 'addRules' && update.behavior === 'allow' && rules.length && rules.every(rule => ruleNames.has(string(object(rule).toolName) ?? ''))
        ? [{ ...update, destination: 'session' }] : []
    })
    const sessionScope = permissionUpdates.flatMap(update => update.type === 'setMode' ? ['all file edits and filesystem operations Claude permits in Edit mode'] : array(update.rules).map(value => {
      const rule = object(value)
      return `${string(rule.toolName)}${string(rule.ruleContent) ? `(${string(rule.ruleContent)})` : ' (all inputs)'}`
    })).join(', ')
    const sessionDescription = sessionScope
      ? `Scope: ${sessionScope}. Only this running Claude session; cleared when it restarts or resumes. Required approvals still apply.`
      : requiredApproval ? 'Claude requires an individual approval for this request; a session grant cannot replace it.'
        : this.settings.plan ? 'Plan mode requires individual approval for writes. Switch modes to change that behavior.'
          : 'Claude did not offer a reusable permission scope for this request. You can allow it once.'
    const autoMode = this.settings.permission === 'auto' && !this.settings.plan
    const interaction: PendingInteraction = {
      id, kind: question ? 'question' : 'approval', status: 'pending', title: string(request.title) ?? (question ? 'Claude needs your input' : `Allow ${name}?`),
      input, choices: [{ id: 'allow', label: question ? 'Submit answers' : 'Allow once' }, ...(!question ? [
        { id: 'allow-session', label: 'Allow for this session', description: sessionDescription, disabled: !permissionUpdates.length },
        { id: 'auto-mode', label: 'Switch to auto-mode', disabled: autoMode,
          description: autoMode ? 'Auto-mode is already active. Claude still requires approval for this request.' : 'Allow this request once, then let Claude review future actions automatically. Required approvals still apply.' }
      ] : []), { id: 'deny', label: 'Deny' }, { id: 'abort', label: 'Cancel turn' }],
      ...(question ? { questions: array(input.questions).map((value, index) => {
        const entry = object(value)
        return { id: `question:${index}`, question: string(entry.question) ?? '', header: string(entry.header), multiSelect: entry.multiSelect === true,
          options: array(entry.options).map((option) => ({ label: string(object(option).label) ?? '', description: string(object(option).description) })) }
      }) } : {})
    }
    this.requests.set(id, { interaction, input, toolId, submitting: false, permissionUpdates })
    this.emit({ requestId: id, itemId: toolId, data: { type: 'interaction', interaction }, native: { method: 'can_use_tool', payload: request } })
    this.emitWaiting()
  }
  private async hook(request: ObjectValue): Promise<void> {
    const input = object(request.input), callback = string(request.callback_id)
    const id = string(request.tool_use_id) ?? string(input.tool_use_id)
    const name = string(input.tool_name) ?? 'Unknown tool', args = object(input.tool_input)
    if (!id || !['conductor_before', 'conductor_after', 'conductor_failed'].includes(callback ?? '')) throw new Error('Unknown Claude lifecycle hook callback')
    if (!this.tools.has(id)) this.declareTool(id, name, args)
    const paths = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'].includes(name) ? [string(args.file_path) ?? string(args.notebook_path)].filter((path): path is string => Boolean(path)) : []
    if (callback === 'conductor_before') {
      // PreToolUse also runs on automatically allowed operations, before execution.
      if (paths.length && !this.tools.get(id)?.captured) {
        await this.options.beforeTool?.(id, paths)
        const tool = this.tools.get(id)
        if (tool) tool.captured = true
      }
      return
    }
    const response = object(input.tool_response), success = callback === 'conductor_after' && response.interrupted !== true && (number(response.exitCode) ?? 0) === 0
    if (paths.length) await this.options.afterTool?.(id, paths, success)
    const stdout = string(response.stdout), stderr = string(response.stderr)
    const priorStatus = this.tools.get(id)?.status
    this.updateTool(id, { status: priorStatus === 'rejected' || priorStatus === 'interrupted' ? priorStatus : success ? 'completed' : input.is_interrupt === true || response.interrupted === true ? 'interrupted' : 'failed' }, {
      ...(stdout !== undefined ? { output: stdout, outputMode: 'snapshot' as const } : {}), ...(stderr !== undefined ? { stderr } : {}),
      ...(number(response.exitCode) !== undefined ? { exitCode: number(response.exitCode) } : {})
    })
    if (success && name === 'TodoWrite') this.emit({ itemId: `plan:${id}`, data: { type: 'plan', steps: array(args.todos).map((value) => {
      const todo = object(value)
      return { text: string(todo.content) ?? '', status: todo.status === 'completed' ? 'completed' : todo.status === 'in_progress' ? 'in_progress' : 'pending' }
    }) } })
  }
  private interruptWaitingTools(): void {
    for (const request of this.requests.values()) if (request.toolId) this.updateTool(request.toolId, { status: 'interrupted' })
  }
  private emitWaiting(): void {
    const pending = [...this.requests.values()]
    this.emit({ data: { type: 'session', phase: this.stopRequested ? 'interrupting' : pending.some((item) => item.interaction.kind === 'question') ? 'waiting_input' : pending.length ? 'waiting_approval' : this.active ? 'running' : 'idle' } })
  }
  private expireRequest(id: string, reason: string): void {
    const pending = this.requests.get(id)
    if (!pending) return
    this.requests.delete(id)
    this.emit({ requestId: id, itemId: pending.toolId, data: { type: 'interaction', interaction: { ...pending.interaction, status: 'expired', outcome: reason } } })
  }
  private expireRequests(reason: string): void { for (const id of this.requests.keys()) this.expireRequest(id, reason) }
  private disconnected(message: string): void {
    for (const id of this.steeringInputs.keys()) this.inputDelivery(id, 'uncertain')
    this.ready = false
    this.expireRequests(message)
    for (const request of this.controls.values()) { clearTimeout(request.timer); request.reject(new Error(message)) }
    this.controls.clear()
    this.emit({ data: { type: 'session', phase: 'disconnected', message: this.active ? `${message}. Turn execution may be incomplete; it will not be retried automatically.` : message } })
  }
  private fail(error: unknown): void {
    const message = error instanceof Error ? error.message : 'Claude provider failure'
    this.emit({ data: { type: 'error', message } })
    this.disconnected(message)
    this.transport?.close()
  }
}
