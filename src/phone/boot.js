/* Boot guard for the Conductor phone app.
 *
 * Loaded as a plain, blocking script before app.js so it is already listening when anything can
 * fail. A Home Screen app on iOS has no browser error page: when the app script throws, fails to
 * load or never finishes starting, the owner sees a black or white screen and nothing to act on.
 * This file turns each of those into a card that says what happened, where, and what to try.
 *
 * Written in ES5 on purpose: if a phone cannot even parse app.js, this still has to run and say so.
 * Every string reaches the page through textContent. The helpers on window.ConductorBoot are also
 * what app.js uses to tell Safari from Chrome, so both agree on which browser the page is in.
 */
(function (root) {
  'use strict'

  var WATCHDOG_MS = 5000
  var HEALTH_TIMEOUT_MS = 8000
  var doc = root.document
  var guard = {
    watchdog: null,
    appScript: 'idle',
    shown: '',
    strip: null,
    early: null
  }

  /* The same three steps the connection check and the service worker give. */
  var NOT_ANSWERING_STEPS = [
    'Check that the computer is on and Conductor is running, with phone access switched on in its settings.',
    'If Conductor listens only through Tailscale, open Tailscale on this phone and check that it is connected, signed in with the same account as the computer.',
    'If the address changed, scan the pairing code in Conductor\'s settings again and add the app to the Home Screen from the new address.'
  ]

  // ------------------------------------------------------------------ facts

  function isStandalone () {
    try {
      if (root.navigator && root.navigator.standalone === true) return true
    } catch (error) { /* not iOS */ }
    try {
      return Boolean(root.matchMedia && root.matchMedia('(display-mode: standalone)').matches)
    } catch (error) {
      return false
    }
  }

  function facts () {
    var nav = root.navigator || {}
    var controlled = false
    try { controlled = Boolean(nav.serviceWorker && nav.serviceWorker.controller) } catch (error) { controlled = false }
    return {
      origin: root.location ? String(root.location.origin || '') : '',
      standalone: isStandalone(),
      online: nav.onLine !== false,
      serviceWorker: controlled,
      secure: root.isSecureContext === true
    }
  }

  /* Which phone and which browser, from the user agent. Chrome, Firefox and Edge on iOS name
     themselves (CriOS, FxiOS, EdgiOS); in-app browsers mostly drop the "Version/... Safari/" pair
     Safari always sends. A browser that copies Safari's string exactly is taken for Safari, which
     is why the pages keep a plain https link next to every Safari hand-off. */
  function platform (userAgent, touchPoints) {
    var ua = String(userAgent || '')
    var ios = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && Number(touchPoints) > 1)
    var android = !ios && /Android/.test(ua)
    var browser = 'other'
    var name = 'this browser'
    if (ios) {
      if (/CriOS\//.test(ua)) { browser = 'chrome'; name = 'Chrome' }
      else if (/FxiOS\//.test(ua)) { browser = 'firefox'; name = 'Firefox' }
      else if (/EdgiOS\//.test(ua)) { browser = 'edge'; name = 'Edge' }
      else if (/OPiOS\/|OPT\/|GSA\/|DuckDuckGo|Ddg\/|YaBrowser|FBAN|FBAV|Instagram|Line\//.test(ua)) { browser = 'other'; name = 'this app\'s browser' }
      else if (/Version\/[\d.]+.*Safari\//.test(ua)) { browser = 'safari'; name = 'Safari' }
    } else if (android) {
      if (/Chrome\//.test(ua) && !/EdgA\/|SamsungBrowser|OPR\/|Firefox\//.test(ua)) { browser = 'chrome'; name = 'Chrome' }
    }
    return { ios: ios, android: android, browser: browser, name: name }
  }

  function currentPlatform () {
    var nav = root.navigator || {}
    return platform(nav.userAgent, nav.maxTouchPoints)
  }

  /* iOS opens x-safari-https:// in Safari from any other app. Apple does not document it and it
     has no feature test, so a caller always shows the plain https address beside it. */
  function safariUrl (url) {
    return String(url || '').replace(/^https:/i, 'x-safari-https:').replace(/^http:/i, 'x-safari-http:')
  }

  /* What a scanned QR has to be for this page to accept it: an https URL on this very origin
     carrying #pair=CODE. Anything else, even a Conductor on another address, is not this pairing. */
  function pairCodeFromUrl (text, origin) {
    var value = String(text || '').trim()
    var match = /^(https:\/\/[^/?#]+)[^#]*#pair=([^&#]+)$/i.exec(value)
    if (!match) return ''
    if (String(match[1]).toLowerCase() !== String(origin || '').toLowerCase()) return ''
    var code = match[2]
    try { code = decodeURIComponent(code) } catch (error) { return '' }
    code = code.toUpperCase().replace(/[^A-Z0-9]/g, '')
    return code.length >= 4 ? code : ''
  }

  // ------------------------------------------------------------------ what the card says

  function shortPlace (file, line, column) {
    var where = String(file || '')
    var origin = facts().origin
    if (origin && where.indexOf(origin) === 0) where = where.slice(origin.length) || '/'
    if (!where) return ''
    if (line) where += ':' + line
    if (line && column) where += ':' + column
    return where
  }

  function reasonText (reason) {
    if (reason === undefined || reason === null) return 'A promise was rejected without a reason.'
    if (typeof reason === 'string') return reason
    var name = reason.name ? String(reason.name) : ''
    var message = reason.message ? String(reason.message) : ''
    if (name && message) return name + ': ' + message
    try { return message || name || String(reason) } catch (error) { return 'An unreadable error.' }
  }

  /* Pure: the card as data, so it can be checked without a page. */
  function describe (kind, detail, known) {
    var info = detail || {}
    var at = known || facts()
    var model = { kind: kind, title: '', lead: '', rows: [] }
    if (kind === 'script') {
      model.title = 'Conductor\'s app did not start'
      model.lead = 'The file ' + (info.file || '/app.js') + ' could not be loaded from this computer.'
    } else if (kind === 'loading') {
      model.title = 'Conductor\'s app did not start'
      model.lead = 'Its script is still loading after 5 seconds. The connection to this computer may be slow or cut off. This card goes away by itself if the app finishes loading.'
    } else if (kind === 'watchdog') {
      model.title = 'Conductor\'s app did not start'
      model.lead = 'Its script loaded but did not finish starting within 5 seconds.'
    } else {
      model.title = 'Conductor\'s app hit an error'
      model.lead = 'Something in the app failed. The details below say what and where.'
    }
    if (info.message) model.rows.push(['What happened', String(info.message)])
    var place = shortPlace(info.file, info.line, info.column)
    if (place && kind === 'error') model.rows.push(['Where', place])
    model.rows.push(['Address', at.origin || 'unknown'])
    model.rows.push(['Opened from', at.standalone ? 'The Home Screen app' : 'A browser tab'])
    model.rows.push(['Network', at.online ? 'This phone says it is online' : 'This phone says it is offline'])
    model.rows.push(['Service worker', at.serviceWorker ? 'Controls this page' : 'Not in control of this page'])
    if (!at.secure) model.rows.push(['Certificate', 'This page is not a trusted secure page'])
    return model
  }

  // ------------------------------------------------------------------ dom

  function make (tag, className, text) {
    var node = doc.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.textContent = String(text)
    return node
  }

  function emptyNode (node) {
    while (node.firstChild) node.removeChild(node.firstChild)
  }

  function host () {
    return doc.getElementById('app') || doc.body
  }

  function whenReady (fn) {
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', fn)
    else fn()
  }

  function actionButton (className, label, onTap) {
    var node = make('button', className, label)
    node.type = 'button'
    node.addEventListener('click', onTap)
    return node
  }

  function booted () {
    return root.__conductorBooted === true
  }

  /* A small health check of its own, for when app.js never started and #diagnose cannot draw. */
  function runCheck (target) {
    emptyNode(target)
    target.hidden = false
    var origin = facts().origin
    var line = make('p', 'boot-check-line', 'Asking ' + origin + '/api/health…')
    target.appendChild(line)
    if (typeof root.fetch !== 'function') {
      line.textContent = 'This browser cannot run the check.'
      return
    }
    var controller = typeof root.AbortController === 'function' ? new root.AbortController() : null
    var timer = root.setTimeout(function () { if (controller) controller.abort() }, HEALTH_TIMEOUT_MS)
    root.fetch('/api/health', { cache: 'no-store', signal: controller ? controller.signal : undefined })
      .then(function (response) {
        return response.text().then(function (text) {
          var data = null
          try { data = JSON.parse(text) } catch (error) { data = null }
          return { status: response.status, data: data }
        })
      })
      .then(function (reply) {
        root.clearTimeout(timer)
        if (reply.status === 200 && reply.data && reply.data.ok === true) {
          line.textContent = 'Conductor ' + (reply.data.version || '') + ' answered at ' + origin + '. The computer is reachable, so the app files are the problem. Try again; if this card comes back, update Conductor on the computer.'
          return
        }
        var said = reply.data && typeof reply.data.error === 'string' ? ' It said: ' + reply.data.error : ''
        line.textContent = 'Something answered at ' + origin + ' with status ' + reply.status + ', but not the way Conductor does.' + said
      })
      .catch(function () {
        root.clearTimeout(timer)
        line.textContent = 'This computer is not answering at ' + origin + '.'
        var list = make('ol', 'steps')
        for (var index = 0; index < NOT_ANSWERING_STEPS.length; index += 1) list.appendChild(make('li', null, NOT_ANSWERING_STEPS[index]))
        target.appendChild(list)
      })
  }

  function renderCard (model) {
    var screen = make('div', 'boot-screen')
    var card = make('section', 'boot-card')
    card.setAttribute('role', 'alert')
    card.setAttribute('data-boot', model.kind)
    card.appendChild(make('h1', 'boot-title', model.title))
    card.appendChild(make('p', 'boot-lead', model.lead))
    var list = make('dl', 'boot-facts')
    for (var index = 0; index < model.rows.length; index += 1) {
      var row = make('div', 'boot-row')
      row.appendChild(make('dt', null, model.rows[index][0]))
      row.appendChild(make('dd', null, model.rows[index][1]))
      list.appendChild(row)
    }
    card.appendChild(list)
    var check = make('div', 'boot-check')
    check.hidden = true
    var actions = make('div', 'boot-actions')
    actions.appendChild(actionButton('primary', 'Try again', function () { root.location.reload() }))
    actions.appendChild(actionButton('ghost', 'Connection check', function () {
      if (booted()) { root.location.hash = '#diagnose'; return }
      runCheck(check)
    }))
    card.appendChild(actions)
    card.appendChild(check)
    screen.appendChild(card)
    var target = host()
    if (!target) return
    emptyNode(target)
    target.appendChild(screen)
  }

  /* After the app is up, an error must not take over a screen the owner is reading: it becomes a
     line at the top that opens the full card only when asked. */
  function renderStrip (model) {
    var overlay = doc.getElementById('overlay') || doc.body
    if (!overlay) return
    if (guard.strip && guard.strip.parentNode) guard.strip.parentNode.removeChild(guard.strip)
    var strip = make('div', 'boot-strip')
    strip.setAttribute('role', 'alert')
    var detail = ''
    for (var index = 0; index < model.rows.length; index += 1) if (model.rows[index][0] === 'What happened') detail = model.rows[index][1]
    strip.appendChild(make('span', 'boot-strip-text', 'Something went wrong' + (detail ? ': ' + detail : '.')))
    strip.appendChild(actionButton('boot-strip-button', 'Details', function () {
      if (strip.parentNode) strip.parentNode.removeChild(strip)
      renderCard(model)
    }))
    strip.appendChild(actionButton('error-close', '×', function () {
      if (strip.parentNode) strip.parentNode.removeChild(strip)
    }))
    guard.strip = strip
    overlay.insertBefore(strip, overlay.firstChild)
  }

  function show (kind, detail) {
    var model = describe(kind, detail)
    if (kind === 'error' && !booted() && !guard.early) guard.early = model
    whenReady(function () {
      if (booted()) { renderStrip(model); return }
      /* The first failure explains the rest; a later "did not start" says less than the error. */
      if (guard.shown === 'error' || guard.shown === 'script') return
      guard.shown = kind
      renderCard(model)
    })
    return model
  }

  function placeholder () {
    whenReady(function () {
      var target = host()
      if (!target || booted() || guard.shown || target.firstChild) return
      var screen = make('div', 'boot-screen')
      screen.setAttribute('data-boot', 'placeholder')
      screen.appendChild(make('p', 'boot-starting', 'Starting Conductor…'))
      target.appendChild(screen)
    })
  }

  // ------------------------------------------------------------------ listeners

  function isAppScript (target) {
    if (!target || String(target.tagName || '').toUpperCase() !== 'SCRIPT') return false
    return /\/app\.js(\?|$)/.test(String(target.src || ''))
  }

  /* Capture on window sees both runtime errors (an ErrorEvent at window) and resource failures
     (a plain Event at the element, which does not bubble). A blocked inline onerror is not needed. */
  function onError (event) {
    var target = event && event.target
    if (target && target !== root && target.tagName) {
      if (String(target.tagName).toUpperCase() !== 'SCRIPT') return
      var path = String(target.src || '')
      var origin = facts().origin
      if (origin && path.indexOf(origin) === 0) path = path.slice(origin.length)
      if (isAppScript(target)) guard.appScript = 'failed'
      show('script', { file: path })
      return
    }
    var error = event && event.error
    var message = (event && event.message) || (error && error.message) || 'Unknown error'
    show('error', { message: message, file: event && event.filename, line: event && event.lineno, column: event && event.colno })
  }

  function onRejection (event) {
    var reason = event ? event.reason : undefined
    /* app.js aborts its own requests when a screen closes; that is not a failure. */
    if (reason && reason.name === 'AbortError') return
    show('error', { message: reasonText(reason) })
  }

  /* A load event never reaches window, so this listens on the document, in capture, from the start:
     app.js is deferred and can finish loading before any later listener would be attached. */
  function onLoad (event) {
    if (isAppScript(event && event.target) && guard.appScript === 'idle') guard.appScript = 'loaded'
  }

  function onWatchdog () {
    guard.watchdog = null
    if (booted()) return
    if (guard.appScript === 'failed') return
    show(guard.appScript === 'loaded' ? 'watchdog' : 'loading', {})
  }

  /* Called by app.js at the end of its boot(): stops the watchdog, and anything that went wrong
     before the app was up stays visible as a line rather than being wiped by the first render. */
  function markBooted () {
    root.__conductorBooted = true
    if (guard.watchdog) { root.clearTimeout(guard.watchdog); guard.watchdog = null }
    var app = doc.getElementById('app')
    var leftovers = app ? app.querySelectorAll('.boot-screen') : []
    for (var index = 0; index < leftovers.length; index += 1) {
      if (leftovers[index].parentNode) leftovers[index].parentNode.removeChild(leftovers[index])
    }
    guard.shown = ''
    if (guard.early) renderStrip(guard.early)
    guard.early = null
  }

  root.ConductorBoot = {
    facts: facts,
    platform: platform,
    currentPlatform: currentPlatform,
    isStandalone: isStandalone,
    safariUrl: safariUrl,
    pairCodeFromUrl: pairCodeFromUrl,
    describe: describe,
    show: show,
    booted: markBooted,
    notAnsweringSteps: NOT_ANSWERING_STEPS.slice()
  }

  if (!doc || !root.addEventListener) return
  root.addEventListener('error', onError, true)
  root.addEventListener('unhandledrejection', onRejection)
  doc.addEventListener('load', onLoad, true)
  placeholder()
  guard.watchdog = root.setTimeout(onWatchdog, WATCHDOG_MS)
})(window)
