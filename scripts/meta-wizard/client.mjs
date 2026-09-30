/** One owner-credential app-control call. Errors carry `code`: timeout, unreachable, unauthorized or method. */
export class ControlError extends Error {
  constructor(message, code, status) { super(message); this.name = 'ControlError'; this.code = code; this.status = status }
}

export async function controlCall(credential, method, args = {}, { scope, timeoutMs = 30_000, fetchImpl = globalThis.fetch } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response
  try {
    response = await fetchImpl(credential.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${credential.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, args, ...(scope ? { scope } : {}) }),
      signal: controller.signal
    })
  } catch (error) {
    const aborted = error?.name === 'AbortError'
    throw new ControlError(aborted ? `${method}: no reply within ${Math.round(timeoutMs / 1000)} s` : `${method}: unreachable (${error?.cause?.code ?? error?.message ?? error})`, aborted ? 'timeout' : 'unreachable')
  } finally { clearTimeout(timer) }
  const text = await response.text()
  let payload
  try { payload = text ? JSON.parse(text) : {} } catch { payload = { error: text.slice(0, 400) } }
  if (response.status === 401) throw new ControlError(`${method}: owner credential rejected (401)`, 'unauthorized', 401)
  if (!response.ok || payload?.error !== undefined) throw new ControlError(`${method}: ${typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`}`, 'method', response.status)
  return payload.result
}
