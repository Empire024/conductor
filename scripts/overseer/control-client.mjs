/**
 * Owner-level client for Conductor's loopback app-control endpoint. One client per app; its
 * calls are queued so they never overlap (the server serializes a caller's requests anyway,
 * and overlapping mutations would make timeouts ambiguous).
 */
export class ControlError extends Error {
  constructor(message, { method, status, code } = {}) {
    super(message)
    this.name = 'ControlError'
    this.method = method
    this.status = status
    this.code = code
  }
}

export function createControlClient({ endpoint, token, scope: defaultScope, fetchImpl = globalThis.fetch, timeoutMs = 130_000 } = {}) {
  if (!endpoint || !token) throw new Error('createControlClient needs endpoint and token')
  let tail = Promise.resolve()

  async function send(method, args, scope, timeout) {
    const body = { method, args: args ?? {} }
    const effective = scope === null ? undefined : (scope ?? defaultScope)
    if (effective) body.scope = effective
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    let response
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      })
    } catch (error) {
      const aborted = error?.name === 'AbortError'
      throw new ControlError(aborted ? `${method}: no reply within ${Math.round(timeout / 1000)} s` : `${method}: app unreachable (${error?.cause?.code ?? error?.message ?? error})`, { method, code: aborted ? 'timeout' : 'unreachable' })
    } finally { clearTimeout(timer) }
    const text = await response.text()
    let payload
    try { payload = text ? JSON.parse(text) : {} } catch { payload = { error: text.slice(0, 400) } }
    if (response.status === 401) throw new ControlError(`${method}: owner credential rejected (401)`, { method, status: 401, code: 'unauthorized' })
    if (!response.ok || payload?.error !== undefined) {
      throw new ControlError(`${method}: ${typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`}`, { method, status: response.status, code: 'method' })
    }
    return payload.result
  }

  /** `scope`: undefined uses the client default, null sends none, an object overrides. */
  function call(method, args = {}, scope, { timeoutMs: timeout = timeoutMs } = {}) {
    const run = tail.then(() => send(method, args, scope, timeout))
    tail = run.catch(() => {})
    return run
  }

  return { call, endpoint, withScope: scope => createScoped(call, scope) }
}

function createScoped(call, scope) {
  return { call: (method, args, override, options) => call(method, args, override === undefined ? scope : override, options), scope }
}

/** Build a client from a validated credential object. */
export const clientFromCredential = (credential, options = {}) => createControlClient({ endpoint: credential.endpoint, token: credential.token, ...options })

/** Scope for a project entry as returned by projects.list / projects.open. */
export function scopeOf(project) {
  const workspace = project?.workspaces?.[0]
  if (!project?.id || !workspace?.id) throw new Error(`project ${project?.name ?? project?.id ?? '?'} has no open workspace`)
  return { projectId: project.id, workspaceId: workspace.id }
}
