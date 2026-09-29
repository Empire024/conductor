import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * A loopback fake of a captured-mail sandbox for the M6 tests (docs/production-agent.md): the
 * Mailpit read API (`/api/v1/messages`, `/api/v1/message/{ID}`, `/api/v1/message/{ID}/headers`)
 * over an in-memory store, plus a tiny campaign sender with an opt-out endpoint so a check can
 * prove suppression end to end:
 *
 * - `GET /esp/unsubscribe?r=<recipient>&c=<campaign>` records the opt-out and answers a
 *   confirmation page; with `secondCampaign` set, the next campaign goes out `delayMs` later.
 * - `sendCampaign` delivers to every subscriber, skipping opted-out ones unless `suppress` is false
 *   (the broken sender that keeps mailing people who opted out).
 *
 * It listens on 127.0.0.1 port 0 and never reaches the network.
 */

export interface FakeMail {
  from: string
  to: string[]
  subject: string
  text: string
  html?: string | null
  headers?: Record<string, string>
}

interface StoredMail extends FakeMail { id: string; created: string }

export interface MailpitFakeOptions {
  subscribers?: string[]
  /** Skip opted-out recipients in later campaigns (default true). */
  suppress?: boolean
  /** Send one more campaign this long after the first opt-out (simulates the next scheduled send). */
  secondCampaign?: { delayMs: number; build: (recipient: string, fake: MailpitFake) => FakeMail } | null
}

export interface MailpitFake {
  origin: string
  deliver(mail: FakeMail): StoredMail
  sendCampaign(build: (recipient: string) => FakeMail): StoredMail[]
  unsubscribeUrl(recipient: string, campaign: string): string
  optOuts(): string[]
  /** Every request to the opt-out endpoint, in order. */
  optOutRequests(): Array<{ method: string; path: string }>
  messages(): StoredMail[]
  close(): Promise<void>
}

export async function createMailpitFake(options: MailpitFakeOptions = {}): Promise<MailpitFake> {
  const store: StoredMail[] = []
  const optedOut = new Set<string>()
  const optOutLog: Array<{ method: string; path: string }> = []
  const timers = new Set<NodeJS.Timeout>()
  let secondScheduled = false
  let sequence = 0
  let origin = ''

  const fake: MailpitFake = {
    get origin() { return origin },
    deliver(mail) {
      // Strictly increasing timestamps keep "after the opt-out" comparisons exact.
      const created = new Date(Math.max(Date.now(), store.length ? Date.parse(store[store.length - 1]!.created) + 1 : 0)).toISOString()
      const stored: StoredMail = { ...mail, id: `msg-${++sequence}`, created }
      store.push(stored)
      return stored
    },
    sendCampaign(build) {
      const sent: StoredMail[] = []
      for (const recipient of options.subscribers ?? []) {
        if ((options.suppress ?? true) && optedOut.has(recipient.toLowerCase())) continue
        sent.push(fake.deliver(build(recipient)))
      }
      return sent
    },
    unsubscribeUrl: (recipient, campaign) => `${origin}/esp/unsubscribe?r=${encodeURIComponent(recipient)}&c=${encodeURIComponent(campaign)}`,
    optOuts: () => [...optedOut],
    optOutRequests: () => [...optOutLog],
    messages: () => [...store],
    close: async () => {
      for (const timer of timers) clearTimeout(timer)
      await new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()) })
    },
  }

  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    const url = new URL(request.url ?? '/', 'http://fake.invalid')
    const method = (request.method ?? 'GET').toUpperCase()
    if (url.pathname === '/esp/unsubscribe') {
      optOutLog.push({ method, path: url.pathname + url.search })
      const recipient = (url.searchParams.get('r') ?? '').toLowerCase()
      if (recipient) optedOut.add(recipient)
      const second = options.secondCampaign
      if (second && !secondScheduled) {
        secondScheduled = true
        const timer = setTimeout(() => { timers.delete(timer); fake.sendCampaign(to => second.build(to, fake)) }, second.delayMs)
        timers.add(timer)
      }
      return send(response, 200, 'text/html; charset=utf-8', `<!doctype html><html lang="en"><title>Unsubscribed</title><main><h1>You have been unsubscribed</h1><p>${escapeHtml(recipient)} will receive no more marketing email from us.</p></main></html>`)
    }
    if (url.pathname === '/api/v1/messages') {
      const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') ?? 50), 500))
      const newest = [...store].reverse().slice(0, limit)
      return send(response, 200, 'application/json', JSON.stringify({
        total: store.length, count: newest.length, start: 0,
        messages: newest.map(mail => ({ ID: mail.id, From: parseAddress(mail.from), To: mail.to.map(parseAddress), Subject: mail.subject, Created: mail.created, Snippet: mail.text.slice(0, 200) })),
      }))
    }
    const detail = /^\/api\/v1\/message\/([^/]+)(\/headers)?$/.exec(url.pathname)
    if (detail) {
      const mail = store.find(item => item.id === decodeURIComponent(detail[1]!))
      if (!mail) return send(response, 404, 'text/plain', 'not found')
      if (detail[2]) {
        const headers: Record<string, string[]> = { From: [mail.from], To: [mail.to.join(', ')], Subject: [mail.subject], Date: [new Date(mail.created).toUTCString()] }
        for (const [key, value] of Object.entries(mail.headers ?? {})) headers[key] = [value]
        return send(response, 200, 'application/json', JSON.stringify(headers))
      }
      return send(response, 200, 'application/json', JSON.stringify({
        ID: mail.id, From: parseAddress(mail.from), To: mail.to.map(parseAddress), Subject: mail.subject, Date: mail.created, Text: mail.text, HTML: mail.html ?? '',
      }))
    }
    return send(response, 404, 'text/plain', 'not found')
  }

  const server: Server = createServer((request, response) => {
    request.resume()
    request.on('end', () => handle(request, response))
  })
  server.keepAliveTimeout = 1000
  await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', () => done()) })
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return fake
}

function parseAddress(value: string): { Name: string; Address: string } {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(value)
  return match ? { Name: match[1]!.replace(/^"|"$/g, ''), Address: match[2]! } : { Name: '', Address: value.trim() }
}

const escapeHtml = (text: string): string => text.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!)

function send(response: ServerResponse, status: number, type: string, body: string): void {
  response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  response.end(body)
}
