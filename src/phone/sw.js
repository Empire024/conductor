/* Service worker for the Conductor phone app. It exists for two reasons only: a push has to
   reach the phone while the app is closed, and opening the app out of range should say "offline"
   instead of showing a browser error page. It never caches or replays anything under /api. */

const CACHE = 'conductor-phone-v1'
/* The bearer token and VAPID key the page leaves behind, so a subscription the browser rotates
   can be re-registered without a window open. Same origin-scoped exposure as localStorage. */
const AUTH_CACHE = 'conductor-phone-auth'
const AUTH_KEY = '/__push-auth'

const SHELL = [
  '/',
  '/index.html',
  '/app.js',
  '/app.css',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-180.png',
  '/icon-192.png',
  '/icon-512.png'
]

/* Network first: the desktop can ship a new app at any time and a phone must never be stuck on
   a stale shell. The cache is only the answer for "the computer is unreachable right now". */
const networkFirst = async request => {
  try {
    const response = await fetch(request)
    if (response && response.ok) {
      const cache = await caches.open(CACHE)
      await cache.put(request, response.clone())
    }
    return response
  } catch (error) {
    const cached = await caches.match(request, { ignoreSearch: true })
    if (cached) return cached
    if (request.mode === 'navigate') {
      const shell = (await caches.match('/index.html')) || (await caches.match('/'))
      if (shell) return shell
    }
    return new Response('Conductor is offline.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
  }
}

const hashOf = url => {
  try { return new URL(url).hash } catch (error) { return '' }
}

/* The app already renders a toast for a conversation it is showing, so a system notification on
   top of it would be noise. Anything else - another conversation, a backgrounded app - shows. */
const alreadyOnScreen = async sessionId => {
  if (!sessionId) return false
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  return clients.some(client => client.visibilityState === 'visible' && hashOf(client.url) === '#/session/' + sessionId)
}

const showPush = async event => {
  let payload = null
  try { payload = event.data ? event.data.json() : null } catch (error) { payload = null }
  if (!payload || typeof payload !== 'object') return
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : null
  if (await alreadyOnScreen(sessionId)) return
  const title = typeof payload.title === 'string' && payload.title ? payload.title : 'Conductor'
  await self.registration.showNotification(title, {
    body: typeof payload.body === 'string' ? payload.body : '',
    tag: sessionId || (typeof payload.id === 'string' ? payload.id : 'conductor'),
    renotify: true,
    data: { url: typeof payload.url === 'string' && payload.url ? payload.url : '/#/' },
    icon: '/icon-192.png',
    badge: '/icon-192.png'
  })
}

const openNotification = async url => {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  for (const client of clients) {
    if (new URL(client.url).origin !== self.location.origin) continue
    /* Tell the window where to go before focusing it: a phone that was already on another
       screen should land on the conversation the notification is about. */
    client.postMessage({ type: 'navigate', url })
    if (typeof client.focus === 'function') {
      try { await client.focus() } catch (error) { /* focus can be refused; the message landed */ }
    }
    return
  }
  if (self.clients.openWindow) await self.clients.openWindow(url)
}

const base64ToBytes = value => {
  const padded = String(value).replace(/-/g, '+').replace(/_/g, '/')
  const full = padded + '='.repeat((4 - (padded.length % 4)) % 4)
  const binary = self.atob(full)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/* Best effort only: if the page never stored a key, or the POST fails, the phone re-subscribes
   the next time its owner opens the app. Never let this reject - it would log an error nobody
   can see and change nothing. */
const resubscribe = async () => {
  const cache = await caches.open(AUTH_CACHE)
  const stored = await cache.match(AUTH_KEY)
  if (!stored) return
  const auth = await stored.json()
  if (!auth || !auth.key) return
  const subscription = await self.registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64ToBytes(auth.key)
  })
  if (!auth.token) return
  await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + auth.token },
    body: JSON.stringify({ subscription: subscription.toJSON() })
  })
}

self.addEventListener('install', event => {
  self.skipWaiting()
  /* Per-file so one missing icon cannot fail the whole install. */
  event.waitUntil(caches.open(CACHE)
    .then(cache => Promise.all(SHELL.map(path => cache.add(path).catch(() => undefined))))
    .catch(() => undefined))
})

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys()
    await Promise.all(names.map(name => (name === CACHE || name === AUTH_CACHE ? undefined : caches.delete(name))))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', event => {
  const request = event.request
  if (request.method !== 'GET') return
  let url = null
  try { url = new URL(request.url) } catch (error) { return }
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/')) return
  if (!SHELL.includes(url.pathname)) return
  event.respondWith(networkFirst(request))
})

self.addEventListener('push', event => {
  event.waitUntil(showPush(event).catch(() => undefined))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const data = event.notification.data || {}
  const url = typeof data.url === 'string' && data.url ? data.url : '/#/'
  event.waitUntil(openNotification(url).catch(() => undefined))
})

self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil(resubscribe().catch(() => undefined))
})
