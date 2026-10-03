/** Call only after an outward action succeeds. The completed tool output itself is durable,
 * so this receipt also works when a script has no app-control credential. Never include secrets. */
export async function recordActivity(receipt, control = {}) {
  const allowed = ['email', 'deployment', 'production', 'commit', 'update', 'approval', 'task']
  if (!allowed.includes(receipt.kind) || typeof receipt.title !== 'string' || !receipt.title.trim() || typeof receipt.key !== 'string' || !receipt.key) throw new Error('Activity needs kind, title and a stable receipt key')
  const args = { kind: receipt.kind, title: receipt.title.slice(0, 240), key: receipt.key.slice(0, 200), ...(receipt.detail ? { detail: String(receipt.detail).slice(0, 600) } : {}) }
  // This single-line contract is recognized by the event-journal receipt collector.
  console.log('ACTIVITY_RECEIPT: ' + JSON.stringify(args))
  if (!control.endpoint || !control.token) return { recorded: 'tool-receipt' }
  try {
    const endpoint = new URL(control.endpoint)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) throw new Error('Activity control must be local')
    const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + control.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'activity.record', args }), signal: AbortSignal.timeout(5000) })
    if (!response.ok) throw new Error('Activity recording was refused')
    return { recorded: 'control' }
  } catch {
    // Sending succeeded already. Never turn a missing receipt acknowledgement into a resend.
    return { recorded: 'tool-receipt' }
  }
}
