import { randomUUID } from 'node:crypto'
import type { AgentConfirmOutcome, AgentConfirmRequest } from '../shared/agent-confirm'

/** The window that can show an agent's request to the owner, as the broker needs it. */
export interface AgentConfirmSurface {
  /** False when there is no live renderer to send to. */
  send(channel: 'agent-confirm:request' | 'agent-confirm:cancel', payload: AgentConfirmRequest | string): boolean
  /** Brings the window forward, or at least signals it where the OS refuses a background app focus. */
  reveal(): void
}

interface Pending {
  request: AgentConfirmRequest
  key: string
  promise: Promise<AgentConfirmOutcome>
  resolve(outcome: AgentConfirmOutcome): void
  answerTimer: ReturnType<typeof setTimeout>
  deliveryTimer?: ReturnType<typeof setTimeout>
}

export interface AgentConfirmBrokerOptions {
  answerMs?: number
  /** How long the renderer has to acknowledge a request before it counts as never shown. */
  deliveryMs?: number
}

/**
 * Holds every agent request that waits on the owner. A request used to be one fire-and-forget IPC
 * send plus a two-minute timer, so a renderer that reloaded, or a window Windows would not bring
 * forward, left the agent waiting on a dialog nobody could see and then told it the owner had
 * declined — and the dead dialog stayed on screen afterwards, ahead of the next real one. Here the
 * renderer must acknowledge each request, can fetch the ones still waiting after a reload, and is
 * told to drop a request once it no longer counts; the caller learns which of those happened.
 */
export class AgentConfirmBroker {
  private readonly pending = new Map<string, Pending>()
  private readonly answerMs: number
  private readonly deliveryMs: number

  constructor(private readonly surface: () => AgentConfirmSurface | null, options: AgentConfirmBrokerOptions = {}) {
    this.answerMs = options.answerMs ?? 120_000
    this.deliveryMs = options.deliveryMs ?? 15_000
  }

  /** An identical request from the same caller that is still waiting is answered once, not asked twice. */
  request(key: string, message: string, title = 'Agent request'): Promise<AgentConfirmOutcome> {
    const existing = [...this.pending.values()].find(entry => entry.key === key && entry.request.message === message)
    if (existing) {
      this.surface()?.reveal()
      return existing.promise
    }
    const surface = this.surface()
    if (!surface) return Promise.resolve('unavailable')
    const request: AgentConfirmRequest = { id: randomUUID(), title, message }
    let resolve!: (outcome: AgentConfirmOutcome) => void
    const promise = new Promise<AgentConfirmOutcome>(done => { resolve = done })
    const entry: Pending = {
      request, key, promise, resolve,
      answerTimer: setTimeout(() => this.finish(request.id, 'timeout'), this.answerMs),
      deliveryTimer: setTimeout(() => this.finish(request.id, 'undelivered'), this.deliveryMs)
    }
    this.pending.set(request.id, entry)
    if (!surface.send('agent-confirm:request', request)) { this.finish(request.id, 'unavailable'); return promise }
    surface.reveal()
    return promise
  }

  /** The renderer has the request queued, so from now on only the owner's answer or the timeout ends it. */
  received(id: string): void {
    const entry = this.pending.get(id)
    if (!entry?.deliveryTimer) return
    clearTimeout(entry.deliveryTimer)
    entry.deliveryTimer = undefined
  }

  respond(id: string, allow: boolean): void {
    this.finish(id, allow ? 'allowed' : 'declined', false)
  }

  /** What a freshly loaded renderer should show: its earlier queue went with the old page. */
  list(): AgentConfirmRequest[] {
    return [...this.pending.values()].map(entry => entry.request)
  }

  private finish(id: string, outcome: AgentConfirmOutcome, cancel = true): void {
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    clearTimeout(entry.answerTimer)
    if (entry.deliveryTimer) clearTimeout(entry.deliveryTimer)
    if (cancel) this.surface()?.send('agent-confirm:cancel', id)
    entry.resolve(outcome)
  }
}

/** The error an agent gets back, naming what actually happened instead of calling every miss a refusal. */
export function agentConfirmFailure(outcome: Exclude<AgentConfirmOutcome, 'allowed'>, action: string): string {
  switch (outcome) {
    case 'declined': return `The owner declined to ${action}`
    case 'timeout': return `The owner did not answer the request to ${action} within two minutes, so nothing was done. The owner did not decline it; say in your tab what you need before asking again`
    case 'undelivered': return `Conductor could not show the owner the request to ${action}: the window never acknowledged it, so nothing was done and the owner was not asked`
    case 'unavailable': return `No Conductor main window is open to ask the owner to ${action}, so nothing was done and the owner was not asked`
  }
}
