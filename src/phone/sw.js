/* Service worker for the Conductor phone app. It exists for two reasons only: a push has to
   reach the phone while the app is closed, and opening the app out of range should say what is
   wrong instead of showing a blank page. A Home Screen app on iOS has no browser error page at all,
   so when neither the computer nor the cache can answer a navigation, the page below is the only
   thing the owner will see. It never caches or replays anything under /api. */

/* v2: the shell gained /boot.js, and an old cache without it must not answer for the new shell. */
const CACHE = 'conductor-phone-v2'
/* The bearer token and VAPID key the page leaves behind, so a subscription the browser rotates
   can be re-registered without a window open. Same origin-scoped exposure as localStorage. */
const AUTH_CACHE = 'conductor-phone-auth'
const AUTH_KEY = '/__push-auth'

const SHELL = [
  '/',
  '/index.html',
  '/boot.js',
  '/app.js',
  '/app.css',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-180.png',
  '/icon-192.png',
  '/icon-512.png'
]

const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])

/* Static on purpose: no script, no external file, nothing that needs the computer. Colours are the
   app's own palette, written out because app.css may not be cached either. */
const notAnsweringPage = () => {
  const origin = escapeHtml(self.location.origin)
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#090b0e">
<title>Conductor is not answering</title>
<style>
html, body { margin: 0; background: #090b0e; color: #e7e9ec; font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, Roboto, sans-serif; -webkit-text-size-adjust: 100%; }
main { box-sizing: border-box; max-width: 460px; margin: 0 auto; padding: calc(env(safe-area-inset-top) + 28px) max(18px, env(safe-area-inset-right)) calc(env(safe-area-inset-bottom) + 28px) max(18px, env(safe-area-inset-left)); }
.card { padding: 20px 18px; border: 1px solid #242a32; border-radius: 16px; background: #101419; }
h1 { margin: 0 0 8px; font-size: 21px; font-weight: 680; }
p { margin: 0 0 12px; color: #a3a9b2; }
.origin { color: #e7e9ec; overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13.5px; }
ol { margin: 0 0 18px; padding-left: 20px; color: #a3a9b2; }
li { margin-bottom: 8px; }
a.button { display: block; min-height: 46px; box-sizing: border-box; padding: 12px 18px; border-radius: 11px; background: #d6ff73; color: #10140a; font-weight: 650; text-align: center; text-decoration: none; }
.note { margin: 14px 0 0; font-size: 12.5px; color: #676f7a; }
</style>
</head>
<body>
<main>
<div class="card">
<h1>Conductor is not answering</h1>
<p>Conductor at <span class="origin">${origin}</span> did not answer, and this phone has no saved copy of the app for that address.</p>
<ol>
<li>Check that the computer is on and Conductor is running, with phone access switched on in its settings.</li>
<li>If Conductor listens only through Tailscale, open Tailscale on this phone and check that it is connected, signed in with the same account as the computer.</li>
<li>If the address changed, scan the pairing code in Conductor's settings again and add the app to the Home Screen from the new address.</li>
</ol>
<a class="button" href="/">Try again</a>
<p class="note">This page comes from the phone itself, not from the computer.</p>
</div>
</main>
</body>
</html>`
  return new Response(html, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })
}

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
      return notAnsweringPage()
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
