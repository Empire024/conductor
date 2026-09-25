/* Conductor, small enough to hold in one hand.
 *
 * This file is served verbatim by the desktop app: no build step, no framework, no imports. It
 * is one classic script so it also runs on an iPhone that opened the page from the Home Screen
 * with a self-signed certificate and no network beyond the Wi-Fi it is on.
 *
 * Two rules run through everything below:
 *   - agent output is untrusted text, so every string reaches the page through textContent;
 *   - the phone never holds state the desktop owns, it re-reads it from /api/stream.
 */
(function () {
  'use strict'

  // ------------------------------------------------------------------ constants

  const TOKEN_KEY = 'conductor.phone.token'
  const FILTER_KEY = 'conductor.phone.filter'
  /* The service worker cannot read localStorage, so a re-subscription after the browser rotates
     the push endpoint reads the key (and token) from here instead. */
  const AUTH_CACHE = 'conductor-phone-auth'
  const AUTH_KEY = '/__push-auth'

  const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000]
  const REFETCH_DEBOUNCE_MS = 300
  const METRICS_INTERVAL_MS = 5000
  /* iOS suspends a backgrounded fetch stream without ending it; a silent minute means dead. */
  const STREAM_STALE_MS = 75000
  const MAX_COMPOSER_LINES = 6
  /* The unlock token rides on every call once the phone is unlocked (src/main/phone-lock.ts). */
  const UNLOCK_HEADER = 'X-Conductor-Unlock'
  const LOCK_TOUCH_MS = 20000

  const STATE_WORDS = {
    attention: 'Needs you',
    working: 'Working',
    limited: 'Limited',
    failed: 'Failed',
    disconnected: 'Disconnected',
    stopped: 'Stopped',
    done: 'Done',
    idle: 'Idle'
  }

  /* "Viewing": the turn ended but background tasks it started still run, and the agent continues
     when they finish (src/shared/project-activity.ts). It stays in the working filter; only the
     word and the missing turn timer tell it apart. */
  function sessionViewing(session) {
    return session.state === 'working' && (session.activity === 'waiting_background' || (session.backgroundTasks > 0 && (session.phase === 'completed' || session.phase === 'idle')))
  }
  function viewingDescription(count) {
    return 'Turn ended; ' + (count > 0 ? count + ' background task' + (count === 1 ? '' : 's') : 'background tasks') + ' still running; the agent continues when they finish'
  }

  const PROVIDER_WORDS = {
    codex: 'Codex',
    claude: 'Claude',
    grok: 'Grok',
    local: 'Local',
    gemini: 'Gemini',
    qwen: 'Qwen',
    kimi: 'Kimi'
  }

  const FILTERS = [
    { id: 'all', label: 'All' },
    { id: 'attention', label: 'Needs attention' },
    { id: 'working', label: 'Working' },
    { id: 'done', label: 'Done' }
  ]

  const CHANGE_MARKS = { add: 'A', update: 'M', delete: 'D', rename: 'R' }
  const PLAN_MARKS = { completed: '✓', in_progress: '▸', pending: '○' }

  const BUSY_PHASES = ['starting', 'running', 'waiting_approval', 'waiting_input', 'interrupting']

  const HEALTH_TIMEOUT_MS = 8000
  /* How long the stream may stay down while the owner is looking before the list says so. */
  const UNREACHABLE_BANNER_MS = 20000

  /* boot.js owns browser detection so the boot card and the app agree on it. If boot.js itself did
     not load, the app still runs and treats the page as a plain browser tab. */
  const shell = window.ConductorBoot || {
    facts: () => ({ origin: window.location.origin, standalone: false, online: navigator.onLine !== false, serviceWorker: false, secure: window.isSecureContext === true }),
    currentPlatform: () => ({ ios: false, android: false, browser: 'other', name: 'this browser' }),
    isStandalone: () => false,
    safariUrl: url => url,
    pairCodeFromUrl: () => '',
    booted: () => { window.__conductorBooted = true },
    notAnsweringSteps: []
  }

  // ------------------------------------------------------------------ app state

  const state = {
    token: null,
    /* PhoneState, always straight from the stream - never patched locally. */
    phone: null,
    /* PhoneSelf, fetched lazily: only the Phone screen needs it. */
    me: null,
    conversation: null,
    conversationId: null,
    conversationError: '',
    conversationLoading: false,
    metrics: null,
    metricsError: '',
    connected: false,
    filter: 'all',
    pairCode: '',
    showClosed: false,
    /* Per-conversation composer text, so a stream refresh never eats what is half-typed. */
    drafts: {},
    /* Tool rows the owner opened, by timeline item id. */
    expanded: {},
    /* Coworker groups are compact by default; expansion is a local viewing choice. */
    expandedCoworkers: {},
    /* In-progress answers per pending interaction id, same reason as drafts. */
    answers: {},
    form: null,
    /* The hash a page like #diagnose returns to. */
    returnTo: '',
    /* Why the live stream is not open, in the owner's words; '' while it is, or before it tried. */
    streamProblem: '',
    /* Android's deferred install prompt, offered once after pairing in a browser tab. */
    installPrompt: null,
    offerInstall: false,
    /* PhoneLockState from /api/lock/state; null until read, or when the computer has no lock. */
    lock: null,
    /* True while the computer wants the code; the lock pad is then the only screen. */
    locked: false,
    /* Memory only, never stored: a reload or a crash locks the phone. */
    unlockToken: null,
    terminalProject: null
  }

  let appRoot = null
  let overlayPill = null
  let toastHost = null
  let tabBar = null
  let screen = null
  /* Functions re-run once a second so relative times and elapsed timers stay honest without
     rebuilding any list. Cleared by whichever view rebuilt its rows. */
  let tickers = []

  // ------------------------------------------------------------------ storage

  const readStored = key => {
    try { return window.localStorage.getItem(key) } catch (error) { return null }
  }

  const writeStored = (key, value) => {
    try {
      if (value === null) window.localStorage.removeItem(key)
      else window.localStorage.setItem(key, value)
    } catch (error) { /* private mode: the session simply does not survive a reload */ }
  }

  const setToken = token => {
    state.token = token || null
    writeStored(TOKEN_KEY, state.token)
  }

  /* The key the service worker needs to re-subscribe on its own, plus the token that POST needs. */
  const rememberPushAuth = async (key, token) => {
    if (!window.caches) return
    try {
      const cache = await window.caches.open(AUTH_CACHE)
      await cache.put(AUTH_KEY, new Response(JSON.stringify({ key: key, token: token }), { headers: { 'Content-Type': 'application/json' } }))
    } catch (error) { /* best effort */ }
  }

  const forgetPushAuth = async () => {
    if (!window.caches) return
    try { await window.caches.delete(AUTH_CACHE) } catch (error) { /* best effort */ }
  }

  // ------------------------------------------------------------------ dom helpers

  const el = (tag, className, text) => {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.textContent = String(text)
    return node
  }

  const fill = (node, children) => {
    for (const child of children) if (child) node.appendChild(child)
    return node
  }

  const box = (className, children) => fill(el('div', className), children || [])

  const clear = node => {
    while (node.firstChild) node.removeChild(node.firstChild)
    return node
  }

  const button = (className, label, onTap) => {
    const node = el('button', className, label)
    node.type = 'button'
    if (onTap) node.addEventListener('click', onTap)
    return node
  }

  const icon = (paths, size) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('width', String(size || 22))
    svg.setAttribute('height', String(size || 22))
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '1.7')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
    svg.setAttribute('aria-hidden', 'true')
    for (const definition of paths) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', definition)
      svg.appendChild(path)
    }
    return svg
  }

  const field = (label, control, hint) => {
    const wrap = el('label', 'field')
    wrap.appendChild(el('span', 'field-label', label))
    wrap.appendChild(control)
    if (hint) wrap.appendChild(el('span', 'field-hint', hint))
    return wrap
  }

  const select = (options, value, onChange) => {
    const node = el('select', 'input')
    for (const option of options) {
      const item = el('option', null, option.label)
      item.value = option.value
      if (option.disabled) item.disabled = true
      node.appendChild(item)
    }
    node.value = value === null || value === undefined ? '' : String(value)
    node.addEventListener('change', () => onChange(node.value))
    return node
  }

  const badge = sessionState => {
    const word = STATE_WORDS[sessionState] || 'Idle'
    const node = el('span', 'badge tone-' + (sessionState || 'idle'))
    node.appendChild(el('span', 'badge-dot'))
    node.appendChild(el('span', 'badge-word', word))
    return node
  }

  const dotRow = parts => {
    /* "claude · sonnet · on mac-mini" built from whatever parts are actually known. */
    const known = parts.filter(part => part !== null && part !== undefined && part !== '')
    return known.join(' · ')
  }

  // ------------------------------------------------------------------ formatting

  const parseTime = value => {
    const ms = value ? Date.parse(value) : NaN
    return Number.isFinite(ms) ? ms : null
  }

  const relativeTime = value => {
    const at = parseTime(value)
    if (at === null) return ''
    const seconds = Math.round((Date.now() - at) / 1000)
    if (seconds < 10) return 'now'
    if (seconds < 60) return seconds + 's ago'
    const minutes = Math.round(seconds / 60)
    if (minutes < 60) return minutes + 'm ago'
    const hours = Math.round(minutes / 60)
    if (hours < 24) return hours + 'h ago'
    const days = Math.round(hours / 24)
    if (days < 7) return days + 'd ago'
    return new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' })
  }

  const clockTime = value => {
    const at = parseTime(value)
    if (at === null) return ''
    return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  }

  const dayTime = value => {
    const at = parseTime(value)
    if (at === null) return ''
    const date = new Date(at)
    const today = new Date()
    const sameDay = date.toDateString() === today.toDateString()
    return sameDay ? clockTime(value) : date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  }

  const elapsedSince = value => {
    const at = parseTime(value)
    if (at === null) return ''
    const total = Math.max(0, Math.round((Date.now() - at) / 1000))
    const seconds = total % 60
    const minutes = Math.floor(total / 60) % 60
    const hours = Math.floor(total / 3600)
    const pad = number => (number < 10 ? '0' + number : String(number))
    return hours > 0 ? hours + ':' + pad(minutes) + ':' + pad(seconds) : minutes + ':' + pad(seconds)
  }

  /* Mirrors src/shared/system-metrics.ts so both screens read the same numbers the same way. */
  const formatBytes = bytes => {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
    const gb = bytes / Math.pow(1024, 3)
    if (gb >= 1) return gb.toFixed(gb >= 10 ? 0 : 1) + ' GB'
    return Math.round(bytes / Math.pow(1024, 2)) + ' MB'
  }

  const formatPercent = value => Math.round(Math.max(0, Math.min(100, Number(value) || 0))) + '%'
  const formatNumber = value => Math.max(0, Number(value) || 0).toLocaleString()

  const providerWord = provider => PROVIDER_WORDS[provider] || (provider ? String(provider) : '')

  const oneLine = (text, limit) => {
    const flat = String(text === null || text === undefined ? '' : text).replace(/\s+/g, ' ').trim()
    const max = limit || 160
    return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
  }

  const isBusyPhase = phase => BUSY_PHASES.indexOf(phase) >= 0

  const errorMessage = error => {
    if (!error) return 'Something went wrong.'
    if (error.name === 'AbortError') return ''
    const message = error.message || String(error)
    /* fetch() to an unreachable computer says "Failed to fetch", which tells the owner nothing. */
    if (/failed to fetch|load failed|networkerror/i.test(message)) return 'This computer is not answering.'
    return message
  }

  // ------------------------------------------------------------------ api

  function ApiError (message, status, detail) {
    const error = new Error(message)
    error.name = 'ApiError'
    error.status = status
    error.detail = detail || null
    return error
  }

  const api = async (path, options) => {
    const settings = options || {}
    const headers = {}
    if (state.token) headers.Authorization = 'Bearer ' + state.token
    if (state.unlockToken) headers[UNLOCK_HEADER] = state.unlockToken
    let body
    if (settings.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(settings.body)
    }
    const response = await fetch(path, {
      method: settings.method || 'GET',
      headers: headers,
      body: body,
      cache: 'no-store',
      signal: settings.signal,
      /* Lets a save started as the page is hidden or closed outlive the page. */
      keepalive: Boolean(settings.keepalive)
    })
    if (response.status === 401) {
      handleUnauthorized()
      throw ApiError('This phone is no longer paired.', 401)
    }
    const text = await response.text()
    let data = null
    if (text) {
      try { data = JSON.parse(text) } catch (error) { data = null }
    }
    if (!response.ok) {
      const message = data && typeof data.error === 'string' ? data.error : 'Request failed (' + response.status + ')'
      /* The computer says this phone is locked: nothing else is worth showing until it unlocks. */
      if (response.status === 423 && data && data.locked) markLocked()
      throw ApiError(message, response.status, data)
    }
    return data
  }

  /* One place decides what "no longer paired" means, because both the API and the stream can
     discover it: drop everything that was read with that token and go back to the code screen. */
  const handleUnauthorized = () => {
    if (!state.token) return
    setToken(null)
    state.unlockToken = null
    state.locked = false
    state.lock = null
    state.phone = null
    state.me = null
    state.conversation = null
    state.conversationId = null
    state.metrics = null
    stopStream()
    void forgetPushAuth()
    render()
  }

  // ------------------------------------------------------------------ live stream

  let streamController = null
  let streamAttempt = 0
  let streamTimer = null
  let lastEventAt = 0
  let refetchTimer = null
  /* When the stream last went down and when the owner last looked; the later of the two is where
     "not answering for 20 seconds" starts, so a phone that slept through an outage is not scolded
     the instant it wakes. */
  let downSince = Date.now()
  let visibleSince = Date.now()

  const setConnected = value => {
    if (state.connected === value) return
    state.connected = value
    downSince = value ? 0 : Date.now()
    if (overlayPill) overlayPill.hidden = value || !state.token
    /* The header carries a live dot of its own, and it only repaints when a view is asked to. */
    if (appRoot) render()
  }

  const stopStream = () => {
    if (streamTimer) { clearTimeout(streamTimer); streamTimer = null }
    if (streamController) {
      const controller = streamController
      streamController = null
      controller.abort()
    }
    setConnected(false)
  }

  const scheduleReconnect = () => {
    if (!state.token || streamTimer || streamController || state.locked) return
    const delay = BACKOFF_MS[Math.min(streamAttempt, BACKOFF_MS.length - 1)]
    streamAttempt += 1
    streamTimer = setTimeout(() => { streamTimer = null; connectStream() }, delay)
  }

  /* SSE without EventSource: EventSource cannot carry an Authorization header, so the frames are
     read off a fetch body and parsed here. Lines are cut on \n with a trailing \r stripped, which
     keeps a \r\n that straddles two chunks from looking like a blank line - a false frame end. */
  const readStream = async (body, handler) => {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let eventName = ''
    let dataLines = []

    const dispatch = () => {
      if (!dataLines.length && !eventName) return
      const name = eventName || 'message'
      const payload = dataLines.join('\n')
      eventName = ''
      dataLines = []
      let data = null
      if (payload) {
        try { data = JSON.parse(payload) } catch (error) { return }
      }
      if (handler) { handler(name, data); return }
      lastEventAt = Date.now()
      onStreamEvent(name, data)
    }

    const handleLine = line => {
      if (line === '') { dispatch(); return }
      if (line.charAt(0) === ':') { if (!handler) lastEventAt = Date.now(); return }
      const colon = line.indexOf(':')
      const name = colon < 0 ? line : line.slice(0, colon)
      let value = colon < 0 ? '' : line.slice(colon + 1)
      if (value.charAt(0) === ' ') value = value.slice(1)
      if (name === 'event') eventName = value
      else if (name === 'data') dataLines.push(value)
      /* id and retry are ignored: this server replays nothing, so a Last-Event-ID buys nothing. */
    }

    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        let line = buffer.slice(0, newline)
        if (line.charAt(line.length - 1) === '\r') line = line.slice(0, -1)
        buffer = buffer.slice(newline + 1)
        handleLine(line)
        newline = buffer.indexOf('\n')
      }
    }
    dispatch()
  }

  const connectStream = () => {
    if (!state.token || streamController || state.locked) return
    if (streamTimer) { clearTimeout(streamTimer); streamTimer = null }
    const controller = new AbortController()
    streamController = controller
    lastEventAt = Date.now()
    const headers = { Authorization: 'Bearer ' + state.token, Accept: 'text/event-stream' }
    if (state.unlockToken) headers[UNLOCK_HEADER] = state.unlockToken
    fetch('/api/stream', {
      headers: headers,
      cache: 'no-store',
      signal: controller.signal
    }).then(async response => {
      if (response.status === 401) { handleUnauthorized(); return }
      if (response.status === 423) { void checkLock(); return }
      if (!response.ok || !response.body) {
        state.streamProblem = 'The computer refused it (' + response.status + ').'
        return
      }
      streamAttempt = 0
      state.streamProblem = ''
      setConnected(true)
      await readStream(response.body)
      state.streamProblem = 'The computer closed it.'
    }).catch(error => {
      /* Every failure is retried the same way, slower; the connection check only needs the word. */
      if (!error || error.name !== 'AbortError') state.streamProblem = 'The network failed before the computer answered.'
    })
      .then(() => {
        if (streamController !== controller) return
        streamController = null
        setConnected(false)
        scheduleReconnect()
      })
  }

  const restartStream = () => {
    streamAttempt = 0
    stopStream()
    connectStream()
  }

  const onStreamEvent = (name, data) => {
    if (name === 'state') {
      if (!data) return
      state.phone = data
      reconcileForm()
      render()
      return
    }
    if (name === 'session') {
      if (!data || !state.conversationId || data.id !== state.conversationId) return
      scheduleConversationRefetch()
      return
    }
    if (name === 'notification') {
      if (data) showToast(data)
      return
    }
    /* The computer ended this unlocked session (idle, code changed, lockout): it closes the
       stream right after saying so. */
    if (name === 'locked') { markLocked(); void checkLock(); return }
    /* 'ping' only proves the pipe is alive, which lastEventAt already recorded. */
  }

  const scheduleConversationRefetch = () => {
    if (refetchTimer) return
    refetchTimer = setTimeout(() => {
      refetchTimer = null
      if (state.conversationId) void loadConversation(state.conversationId, true)
    }, REFETCH_DEBOUNCE_MS)
  }

  // ------------------------------------------------------------------ toasts

  const openUrl = url => {
    const text = String(url || '')
    const hash = text.indexOf('#')
    if (hash >= 0) { window.location.hash = text.slice(hash); return }
    if (text) window.location.assign(text)
  }

  const showToast = notification => {
    if (!toastHost) return
    const node = el('div', 'toast tone-' + (notification.kind || 'attention'))
    node.appendChild(el('strong', 'toast-title', notification.title || 'Conductor'))
    if (notification.body) node.appendChild(el('span', 'toast-body', oneLine(notification.body, 140)))
    const dismiss = () => { if (node.parentNode) node.parentNode.removeChild(node) }
    node.addEventListener('click', () => { dismiss(); openUrl(notification.url || '#/') })
    toastHost.appendChild(node)
    setTimeout(dismiss, 6000)
    while (toastHost.childNodes.length > 3) toastHost.removeChild(toastHost.firstChild)
  }

  // ------------------------------------------------------------------ routing

  const currentRoute = () => {
    const hash = window.location.hash || '#/'
    const session = /^#\/session\/(.+)$/.exec(hash)
    if (session) return { name: 'session', id: decodeURIComponent(session[1]), key: 'session:' + session[1] }
    /* #/ideas is a new note (bookmarkable: open, type, leave); #/ideas/<id> is the same editor on
       one idea; #/ideas/list and #/ideas/search are the list, the latter with the search field up. */
    const idea = /^#\/ideas(?:\/([^?]*))?$/.exec(hash)
    if (idea) {
      const rest = idea[1] || ''
      if (rest === 'list' || rest === 'search') return { name: 'ideas', key: 'ideas', search: rest === 'search' }
      if (!rest || rest === 'new') return { name: 'idea', id: null, key: 'idea:new' }
      return { name: 'idea', id: decodeURIComponent(rest), key: 'idea:' + rest }
    }
    if (hash.indexOf('#/tasks') === 0) return { name: 'tasks', key: 'tasks' }
    if (hash.indexOf('#/new') === 0) return { name: 'new', key: 'new' }
    if (hash.indexOf('#/system') === 0) return { name: 'system', key: 'system' }
    if (hash.indexOf('#/phone') === 0) return { name: 'phone', key: 'phone' }
    if (hash.indexOf('#/terminal') === 0) return { name: 'terminal', key: 'terminal' }
    if (hash.indexOf('#diagnose') === 0) return { name: 'diagnose', key: 'diagnose' }
    if (hash.indexOf('#trust') === 0) return { name: 'trust', key: 'trust' }
    return { name: 'sessions', key: 'sessions' }
  }

  /* The two pages a phone needs before it is paired, or when pairing is what broke. */
  const OPEN_ROUTES = ['diagnose', 'trust']

  const go = hash => {
    if (window.location.hash === hash) render()
    else window.location.hash = hash
  }

  /* Opens a page that has a back button, remembering where back goes. */
  const visit = hash => {
    state.returnTo = window.location.hash || '#/'
    go(hash)
  }

  /* iOS only raises the keyboard for a focus() made inside the tap itself, and hashchange arrives
     after the tap has ended; screens that open with the cursor in a field are rendered right away. */
  const goNow = hash => {
    if (window.location.hash !== hash) window.location.hash = hash
    render()
  }

  const goBack = () => {
    const target = state.returnTo && state.returnTo !== window.location.hash ? state.returnTo : '#/'
    state.returnTo = ''
    go(target)
  }

  const beginTicks = () => { tickers = [] }
  const onTick = fn => { tickers.push(fn); fn() }

  const render = () => {
    const wanted = currentRoute()
    const open = OPEN_ROUTES.indexOf(wanted.name) >= 0
    const route = !state.token && !open ? { name: 'pair', key: 'pair' } : state.token && state.locked && !open ? { name: 'lock', key: 'lock' } : wanted
    if (screen && screen.key === route.key) {
      if (screen.update) screen.update(route)
      updateTabBar(route)
      return
    }
    if (screen && screen.destroy) screen.destroy()
    beginTicks()
    screen = buildScreen(route)
    clear(appRoot)
    appRoot.appendChild(screen.root)
    appRoot.appendChild(tabBar)
    updateTabBar(route)
    if (overlayPill) overlayPill.hidden = state.connected || !state.token || state.locked
    /* A field can only take focus once it is in the page. */
    if (screen.onShown) screen.onShown()
  }

  const buildScreen = route => {
    if (route.name === 'pair') return pairScreen()
    if (route.name === 'lock') return lockScreen()
    if (route.name === 'terminal') return terminalScreen()
    if (route.name === 'session') return conversationScreen(route.id)
    if (route.name === 'tasks') return projectTasksScreen()
    if (route.name === 'idea') return ideaEditorScreen(route.id)
    if (route.name === 'ideas') return ideasListScreen(route)
    if (route.name === 'new') return newTaskScreen()
    if (route.name === 'system') return systemScreen()
    if (route.name === 'phone') return phoneScreen()
    if (route.name === 'diagnose') return diagnoseScreen()
    if (route.name === 'trust') return trustScreen()
    return sessionsScreen()
  }

  // ------------------------------------------------------------------ shell chrome

  const TAB_ICONS = {
    sessions: ['M4 7h16', 'M4 12h16', 'M4 17h11'],
    tasks: ['M9 6h11', 'M9 12h11', 'M9 18h11', 'M3.5 6h.01', 'M3.5 12h.01', 'M3.5 18h.01'],
    ideas: ['M9.5 18h5', 'M10.5 21h3', 'M12 3a6 6 0 0 0-3.6 10.8c.7.5 1.1 1.3 1.1 2.1v.1h5v-.1c0-.8.4-1.6 1.1-2.1A6 6 0 0 0 12 3Z'],
    new: ['M12 5v14', 'M5 12h14'],
    system: ['M3 13h3.5l2.5-6 3.5 12 2.5-6H21'],
    phone: ['M8.5 2.75h7a1.75 1.75 0 0 1 1.75 1.75v15a1.75 1.75 0 0 1-1.75 1.75h-7A1.75 1.75 0 0 1 6.75 19.5v-15A1.75 1.75 0 0 1 8.5 2.75Z', 'M11 18.5h2']
  }

  const buildTabBar = () => {
    const bar = el('nav', 'tabbar')
    bar.setAttribute('aria-label', 'Sections')
    const tabs = [
      { id: 'sessions', label: 'Sessions', hash: '#/' },
      { id: 'tasks', label: 'Tasks', hash: '#/tasks' },
      /* Opens a new note with the keyboard up, so it renders inside the tap (goNow). */
      { id: 'ideas', label: 'Ideas', hash: '#/ideas', now: true },
      { id: 'new', label: 'New', hash: '#/new' },
      { id: 'system', label: 'System', hash: '#/system' },
      { id: 'phone', label: 'Phone', hash: '#/phone' }
    ]
    for (const tab of tabs) {
      const node = button('tab', null, () => (tab.now ? goNow(tab.hash) : go(tab.hash)))
      node.dataset.tab = tab.id
      const glyph = el('span', 'tab-icon')
      glyph.appendChild(icon(TAB_ICONS[tab.id], 22))
      if (tab.id === 'sessions') glyph.appendChild(el('span', 'tab-badge'))
      node.appendChild(glyph)
      node.appendChild(el('span', 'tab-label', tab.label))
      bar.appendChild(node)
    }
    return bar
  }

  const updateTabBar = route => {
    const hidden = route.name === 'pair' || route.name === 'lock' || route.name === 'terminal' || route.name === 'session' || route.name === 'idea' || OPEN_ROUTES.indexOf(route.name) >= 0
    tabBar.hidden = hidden
    const attention = state.phone && state.phone.counts ? state.phone.counts.attention : 0
    for (const node of tabBar.querySelectorAll('.tab')) {
      const active = node.dataset.tab === route.name
      node.classList.toggle('active', active)
      node.setAttribute('aria-current', active ? 'page' : 'false')
      const mark = node.querySelector('.tab-badge')
      if (!mark) continue
      mark.textContent = attention > 9 ? '9+' : String(attention || '')
      mark.hidden = !attention
    }
  }

  const topbar = () => el('header', 'topbar')

  const scroller = () => {
    const node = el('div', 'scroll')
    node.tabIndex = -1
    return node
  }

  const emptyNote = (title, hint) => {
    const node = box('empty', [el('p', 'empty-title', title)])
    if (hint) node.appendChild(el('p', 'empty-hint', hint))
    return node
  }

  const errorLine = (message, onDismiss) => {
    const node = el('div', 'error-line')
    node.setAttribute('role', 'alert')
    node.appendChild(el('span', null, message))
    node.appendChild(button('error-close', '×', onDismiss))
    return node
  }

  // ------------------------------------------------------------------ pairing screen

  const guessDeviceName = () => {
    const agent = navigator.userAgent || ''
    if (/iPhone/.test(agent)) return 'iPhone'
    if (/iPad/.test(agent) || (/Macintosh/.test(agent) && navigator.maxTouchPoints > 1)) return 'iPad'
    if (/Android/.test(agent)) return 'Android phone'
    return 'Phone'
  }

  const formatCode = raw => {
    const letters = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
    return letters.length > 4 ? letters.slice(0, 4) + '-' + letters.slice(4) : letters
  }

  /* Where the pairing page landed decides what it asks for. iOS gives a Home Screen app storage of
     its own, apart from Safari and every other browser, so a token made in a browser tab never
     reaches the Home Screen app: on iOS a tab shows the code to carry over instead of spending it.
     Android shares storage between Chrome and the installed app, so it pairs right here. */
  const pairMode = () => {
    if (shell.isStandalone()) return 'direct'
    const where = shell.currentPlatform()
    if (where.ios && where.browser === 'safari') return 'ios-safari'
    if (where.ios) return 'ios-other'
    return 'direct'
  }

  /* No decoder is bundled: without the browser's own BarcodeDetector the button is not offered. */
  const canScan = () => 'BarcodeDetector' in window && Boolean(navigator.mediaDevices) && typeof navigator.mediaDevices.getUserMedia === 'function'

  const pairForm = onScan => {
    const form = el('form', 'pair-form')

    const nameInput = el('input', 'input')
    nameInput.type = 'text'
    nameInput.value = guessDeviceName()
    nameInput.autocomplete = 'off'
    form.appendChild(field('Name this phone', nameInput))

    const codeInput = el('input', 'input code-input')
    codeInput.type = 'text'
    codeInput.placeholder = 'XXXX-XXXX'
    codeInput.autocomplete = 'one-time-code'
    codeInput.spellcheck = false
    codeInput.setAttribute('autocapitalize', 'characters')
    codeInput.setAttribute('autocorrect', 'off')
    codeInput.maxLength = 9
    codeInput.value = formatCode(state.pairCode)
    codeInput.addEventListener('input', () => {
      const caretAtEnd = codeInput.selectionStart === codeInput.value.length
      codeInput.value = formatCode(codeInput.value)
      if (caretAtEnd) codeInput.setSelectionRange(codeInput.value.length, codeInput.value.length)
      state.pairCode = codeInput.value
    })
    form.appendChild(field('Pairing code', codeInput))

    if (canScan()) form.appendChild(button('ghost wide', 'Scan the code instead', () => onScan()))

    const problem = el('p', 'pair-error')
    problem.hidden = true
    form.appendChild(problem)

    const submit = button('primary', 'Pair', null)
    submit.type = 'submit'
    form.appendChild(submit)

    /* Push needs both a service worker and a secure context; a self-signed certificate that was
       never trusted gives neither, and the owner deserves to know that before they wonder. */
    if (!window.isSecureContext || !('serviceWorker' in navigator)) {
      form.appendChild(el('p', 'pair-note', 'This connection is not trusted by the phone yet, so notifications will not work until the Conductor certificate is installed. Everything else works.'))
    }

    form.addEventListener('submit', async event => {
      event.preventDefault()
      const code = formatCode(codeInput.value)
      const name = nameInput.value.trim() || guessDeviceName()
      if (code.replace('-', '').length < 4) {
        problem.textContent = 'Enter the code shown on the computer.'
        problem.hidden = false
        return
      }
      submit.disabled = true
      submit.textContent = 'Pairing…'
      problem.hidden = true
      try {
        const result = await api('/api/pair', { method: 'POST', body: { code: code, name: name } })
        setToken(result && result.token)
        state.me = result && result.device ? result.device : null
        state.pairCode = ''
        /* Android keeps one storage for Chrome and the installed app, so a tab that just paired
           can still become the app; the list offers it once, if Chrome offered an install. */
        if (!shell.isStandalone() && shell.currentPlatform().android) state.offerInstall = true
        streamAttempt = 0
        connectStream()
        go('#/')
      } catch (error) {
        problem.textContent = errorMessage(error) || 'That code did not work.'
        problem.hidden = false
        submit.disabled = false
        submit.textContent = 'Pair'
      }
    })

    const setCode = code => {
      codeInput.value = formatCode(code)
      state.pairCode = codeInput.value
      problem.hidden = true
    }
    return { root: form, setCode: setCode }
  }

  const bigCode = code => {
    const node = el('p', 'pair-code', code)
    node.setAttribute('aria-label', 'Pairing code ' + code.split('').join(' '))
    return node
  }

  const stepsList = items => {
    const list = el('ol', 'steps')
    for (const item of items) if (item) list.appendChild(el('li', null, item))
    return list
  }

  const linkButton = (className, label, href) => {
    const node = el('a', className, label)
    node.href = href
    return node
  }

  const pairLinks = () => box('pair-links', [
    button('ghost', 'Connection check', () => visit('#diagnose')),
    button('ghost', 'Install the certificate', () => visit('#trust'))
  ])

  /* The notice a page shows when GET /api/health failed: where it asked, and a way to the check. */
  const notAnsweringNote = () => {
    const node = el('div', 'reach-note')
    node.setAttribute('role', 'alert')
    node.appendChild(el('p', 'reach-note-text', 'This computer is not answering at ' + window.location.origin + '.'))
    node.appendChild(button('ghost', 'Connection check', () => visit('#diagnose')))
    return node
  }

  const pairScreen = () => {
    const root = el('div', 'screen')
    const scroll = scroller()
    const mode = pairMode()
    const where = shell.currentPlatform()
    const code = formatCode(state.pairCode)
    const origin = window.location.origin
    scroll.classList.add(mode === 'direct' ? 'centered' : 'pair-top')
    const card = el('div', 'pair-card')

    const mark = el('div', 'pair-mark')
    mark.appendChild(icon(['M16.5 7.5A7.5 7.5 0 1 0 16.5 16.5'], 38))
    card.appendChild(mark)

    let stopScanner = null
    const form = pairForm(() => {
      if (stopScanner) stopScanner()
      stopScanner = openScanner(found => form.setCode(found))
    })
    const warning = el('div', 'pair-warning')

    if (mode === 'ios-other') {
      card.appendChild(el('h1', 'pair-title', 'Open Conductor in Safari'))
      card.appendChild(el('p', 'pair-lead', (code ? 'The Camera opened this link in ' : 'This page is open in ') + where.name + '. Continue in Safari: on iPhone it is the only browser that can install this computer\'s certificate.'))
      card.appendChild(warning)
      card.appendChild(linkButton('primary wide link-button', 'Open in Safari', shell.safariUrl(origin + '/' + (code ? '#pair=' + encodeURIComponent(code) : ''))))
      card.appendChild(el('p', 'pair-note', 'If Safari does not open, open Safari yourself and go to this address:'))
      card.appendChild(el('p', 'pair-address', origin + '/'))
      if (code) {
        card.appendChild(el('span', 'field-label', 'Pairing code'))
        card.appendChild(bigCode(code))
        card.appendChild(el('p', 'pair-note', 'Already have Conductor on your Home Screen? Open it and enter this code. The code works for ten minutes after the computer showed it.'))
      }
      form.root.hidden = true
      const reveal = button('ghost wide', 'Pair in ' + where.name + ' instead', () => {
        reveal.hidden = true
        form.root.hidden = false
      })
      card.appendChild(el('div', 'pair-divider'))
      card.appendChild(reveal)
      card.appendChild(form.root)
    } else if (mode === 'ios-safari') {
      card.appendChild(el('h1', 'pair-title', 'Add Conductor to your Home Screen'))
      card.appendChild(el('p', 'pair-lead', 'iOS gives a Home Screen app its own storage, apart from Safari, so a pairing made in this tab would not reach it. Pair inside the Home Screen app.'))
      card.appendChild(warning)
      if (code) {
        card.appendChild(el('span', 'field-label', 'Pairing code'))
        card.appendChild(bigCode(code))
        card.appendChild(el('p', 'pair-note', 'The code works for ten minutes after the computer showed it.'))
      }
      card.appendChild(stepsList([
        'Tap Share, the square with the arrow.',
        'Tap Add to Home Screen, then Add.',
        code ? 'Open Conductor from the Home Screen and enter this code.' : 'Open Conductor from the Home Screen and enter the code the computer shows.'
      ]))
      card.appendChild(el('div', 'pair-divider'))
      card.appendChild(el('p', 'pair-note', 'Only want a browser tab? Pair here instead.'))
      card.appendChild(form.root)
    } else {
      card.appendChild(el('h1', 'pair-title', 'Conductor'))
      card.appendChild(el('p', 'pair-lead', 'This phone will watch and steer the agents running on this computer. Enter the code the desktop is showing.'))
      card.appendChild(warning)
      card.appendChild(form.root)
    }
    card.appendChild(pairLinks())

    scroll.appendChild(card)
    root.appendChild(scroll)

    let alive = true
    void checkHealth().then(result => {
      if (!alive || result.kind !== 'unreachable') return
      warning.appendChild(notAnsweringNote())
    })

    return {
      key: 'pair',
      root: root,
      destroy: () => {
        alive = false
        if (stopScanner) stopScanner()
      }
    }
  }

  // ------------------------------------------------------------------ qr scanner

  /* Full-screen camera view reading QR codes with the browser's own BarcodeDetector. Only a code
     for this very origin counts; anything else is named and ignored. Returns a stop function. */
  const openScanner = onCode => {
    const view = el('div', 'scanner')
    view.setAttribute('role', 'dialog')
    view.setAttribute('aria-label', 'Scan the pairing code')
    const video = el('video', 'scanner-video')
    video.setAttribute('playsinline', '')
    video.setAttribute('muted', '')
    video.muted = true
    video.autoplay = true
    const note = el('p', 'scanner-note', 'Point the camera at the pairing code on the computer.')
    let stream = null
    let timer = null
    let stopped = false

    const stop = () => {
      if (stopped) return
      stopped = true
      if (timer) clearTimeout(timer)
      if (stream) for (const track of stream.getTracks()) track.stop()
      document.removeEventListener('visibilitychange', onHidden)
      if (view.parentNode) view.parentNode.removeChild(view)
    }
    /* iOS keeps the camera light on for a page in the background; a hidden scanner is a closed one. */
    const onHidden = () => { if (document.visibilityState !== 'visible') stop() }
    document.addEventListener('visibilitychange', onHidden)

    view.appendChild(video)
    view.appendChild(el('div', 'scanner-frame'))
    view.appendChild(fill(el('div', 'scanner-bar'), [note, button('ghost wide', 'Cancel', stop)]))
    document.body.appendChild(view)

    const scan = async detector => {
      if (stopped) return
      try {
        if (video.readyState >= 2) {
          const found = await detector.detect(video)
          for (const entry of found) {
            const code = shell.pairCodeFromUrl(entry.rawValue, window.location.origin)
            if (code) { onCode(code); stop(); return }
            if (entry.rawValue) note.textContent = 'That code is for a different address. Scan the pairing code for ' + window.location.host + ', or type the code.'
          }
        }
      } catch (error) { /* a frame the detector could not read; the next one may */ }
      if (!stopped) timer = setTimeout(() => void scan(detector), 250)
    }

    void (async () => {
      try {
        const Detector = window.BarcodeDetector
        const formats = typeof Detector.getSupportedFormats === 'function' ? await Detector.getSupportedFormats() : ['qr_code']
        if (formats.indexOf('qr_code') < 0) throw new Error('This browser cannot read QR codes. Type the code instead.')
        const detector = new Detector({ formats: ['qr_code'] })
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
        if (stopped) { for (const track of stream.getTracks()) track.stop(); return }
        video.srcObject = stream
        try { await video.play() } catch (error) { /* autoplay with muted video is allowed; a refusal still shows frames */ }
        void scan(detector)
      } catch (error) {
        note.textContent = error && error.name === 'NotAllowedError'
          ? 'The camera is not allowed for this page. Type the code instead.'
          : (errorMessage(error) || 'The camera could not start. Type the code instead.')
      }
    })()
    return stop
  }

  // ------------------------------------------------------------------ connection check

  /* GET /api/health needs no token: it is the one question that separates "cannot reach the
     computer" (address, network, Tailscale, certificate) from "reached it, something else is off". */
  const checkHealth = async () => {
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = setTimeout(() => { if (controller) controller.abort() }, HEALTH_TIMEOUT_MS)
    try {
      const response = await fetch('/api/health', { cache: 'no-store', signal: controller ? controller.signal : undefined })
      const text = await response.text()
      let data = null
      try { data = JSON.parse(text) } catch (error) { data = null }
      if (response.ok && data && data.ok === true) return { kind: 'ok', health: data }
      return { kind: 'odd', status: response.status, message: data && typeof data.error === 'string' ? data.error : '' }
    } catch (error) {
      return { kind: 'unreachable', timedOut: Boolean(error && error.name === 'AbortError') }
    } finally {
      clearTimeout(timer)
    }
  }

  const pageHeader = title => {
    const header = topbar()
    const back = button('back', null, goBack)
    back.setAttribute('aria-label', 'Back')
    back.appendChild(icon(['M15 5l-7 7 7 7'], 24))
    const line = el('div', 'topbar-main')
    line.appendChild(back)
    line.appendChild(el('h1', 'topbar-title', title))
    header.appendChild(line)
    return header
  }

  const factRow = (label, value, tone) => {
    const row = el('div', 'check-row')
    row.appendChild(el('span', 'check-label', label))
    row.appendChild(el('span', 'check-value' + (tone ? ' ' + tone : ''), value))
    return row
  }

  const diagnoseScreen = () => {
    const root = el('div', 'screen')
    const scroll = scroller()
    root.appendChild(pageHeader('Connection check'))
    root.appendChild(scroll)

    let alive = true
    let run = 0
    let health = null
    /* 'none' without a token; otherwise running, ok (with me), rejected (401) or failed. */
    let pairing = { kind: state.token ? 'running' : 'none' }

    const phoneCard = () => {
      const known = shell.facts()
      const where = shell.currentPlatform()
      const card = el('section', 'card')
      card.appendChild(el('h2', 'card-title', 'This phone'))
      card.appendChild(factRow('Address', known.origin || window.location.origin))
      card.appendChild(factRow('Opened from', known.standalone ? 'The Home Screen app' : 'A tab in ' + where.name))
      card.appendChild(factRow('Network', known.online ? 'The phone says it is online' : 'The phone says it is offline', known.online ? '' : 'warn'))
      card.appendChild(factRow('Service worker', known.serviceWorker ? 'Controls this page' : 'Not in control of this page'))
      card.appendChild(factRow('Certificate', known.secure ? 'Trusted' : 'Not trusted by this phone yet', known.secure ? '' : 'warn'))
      return card
    }

    const computerCard = () => {
      const card = el('section', 'card')
      card.appendChild(el('h2', 'card-title', 'This computer'))
      const origin = window.location.origin
      if (!health) {
        card.appendChild(el('p', 'check-status', 'Asking ' + origin + '/api/health…'))
        return card
      }
      if (health.kind === 'ok') {
        const info = health.health
        card.appendChild(el('p', 'check-status good', 'Reached Conductor ' + (info.version || '') + '.'))
        card.appendChild(factRow('Listening', info.exposure === 'tailscale' ? 'Only through Tailscale' : 'On this network'))
        card.appendChild(factRow('This phone came in', info.viaTailscale ? 'Over Tailscale' : 'Not over Tailscale'))
        return card
      }
      if (health.kind === 'odd') {
        card.appendChild(el('p', 'check-status warn', 'Something answered at ' + origin + ' with status ' + health.status + ', but not the way Conductor does.'))
        if (health.message) card.appendChild(el('p', 'card-note', 'It said: ' + health.message))
        if (health.status === 404) card.appendChild(el('p', 'card-note', 'An older Conductor does not know this check. Update Conductor on the computer.'))
        return card
      }
      card.appendChild(el('p', 'check-status bad', 'This computer is not answering at ' + origin + '.'))
      if (health.timedOut) card.appendChild(el('p', 'card-note', 'Nothing came back within ' + Math.round(HEALTH_TIMEOUT_MS / 1000) + ' seconds.'))
      card.appendChild(stepsList(shell.notAnsweringSteps.concat(['If the phone warned about the certificate, trust it first: Install the certificate, below.'])))
      return card
    }

    const pairingCard = () => {
      if (!health || health.kind !== 'ok') return null
      const card = el('section', 'card')
      card.appendChild(el('h2', 'card-title', 'This phone and Conductor'))
      if (pairing.kind === 'none') {
        card.appendChild(el('p', 'check-status', 'This phone is not paired yet.'))
        card.appendChild(el('p', 'card-note', 'Enter the code Conductor shows under Settings, Phone.'))
        card.appendChild(button('ghost wide', 'Pair this phone', () => go('#/')))
        return card
      }
      if (pairing.kind === 'running') {
        card.appendChild(el('p', 'check-status', 'Checking this phone\'s pairing…'))
        return card
      }
      if (pairing.kind === 'rejected') {
        card.appendChild(el('p', 'check-status bad', 'The computer rejected this phone\'s pairing (401).'))
        card.appendChild(el('p', 'card-note', 'It was unpaired or revoked on the computer. Pair it again with a new code.'))
        card.appendChild(button('ghost wide', 'Pair again', () => go('#/')))
        return card
      }
      if (pairing.kind === 'failed') {
        card.appendChild(el('p', 'check-status warn', 'The computer answered the check but not this phone\'s request.'))
        card.appendChild(el('p', 'card-note', pairing.message))
        return card
      }
      const me = pairing.me
      card.appendChild(el('p', 'check-status good', 'Paired as ' + (me && me.name ? me.name : 'this phone') + ' with ' + (me && me.machineName ? me.machineName : 'this computer') + '.'))
      if (state.connected) card.appendChild(factRow('Live connection', 'Open'))
      else card.appendChild(factRow('Live connection', state.streamProblem ? 'Not open. ' + state.streamProblem : 'Opening…', state.streamProblem ? 'warn' : ''))
      return card
    }

    const draw = () => {
      if (!alive) return
      const top = scroll.scrollTop
      clear(scroll)
      const body = el('div', 'form')
      body.appendChild(phoneCard())
      body.appendChild(computerCard())
      const paired = pairingCard()
      if (paired) body.appendChild(paired)
      const again = button('primary wide', 'Run again', () => void check())
      again.disabled = !health
      body.appendChild(again)
      body.appendChild(button('ghost wide', 'Install the certificate', () => visit('#trust')))
      scroll.appendChild(body)
      scroll.scrollTop = top
    }

    const check = async () => {
      const mine = ++run
      health = null
      pairing = { kind: state.token ? 'running' : 'none' }
      draw()
      const result = await checkHealth()
      if (!alive || mine !== run) return
      health = result
      draw()
      if (result.kind !== 'ok' || !state.token) return
      try {
        const me = await api('/api/me')
        if (me) state.me = me
        pairing = { kind: 'ok', me: me }
      } catch (error) {
        /* api() has already dropped a rejected token; the page says so instead of leaving. */
        pairing = error && error.status === 401 ? { kind: 'rejected' } : { kind: 'failed', message: errorMessage(error) || 'The request failed.' }
      }
      if (!alive || mine !== run) return
      draw()
    }

    void check()
    return {
      key: 'diagnose',
      root: root,
      update: draw,
      destroy: () => { alive = false }
    }
  }

  // ------------------------------------------------------------------ certificate page

  const trustScreen = () => {
    const root = el('div', 'screen')
    const scroll = scroller()
    root.appendChild(pageHeader('Trust this computer'))
    root.appendChild(scroll)

    const where = shell.currentPlatform()
    const standalone = shell.isStandalone()
    const origin = window.location.origin
    const body = el('div', 'form')

    const why = el('section', 'card')
    why.appendChild(el('h2', 'card-title', 'Why'))
    why.appendChild(el('p', 'trust-line', 'Conductor on your computer made its own certificate, so this phone does not know it yet.'))
    why.appendChild(el('p', 'trust-line', 'Trusting it once lets the phone open Conductor without warnings, and lets notifications and the Home Screen app work.'))
    why.appendChild(el('p', 'trust-line', 'This page cannot read the fingerprint itself: compare the one your phone shows with the fingerprint shown in Conductor\'s settings under Phone.'))
    why.appendChild(el('p', 'card-note', 'If Conductor uses a certificate from Tailscale (an address ending in .ts.net), the phone already trusts it and you can skip this.'))
    body.appendChild(why)

    const how = el('section', 'card')
    how.appendChild(el('h2', 'card-title', 'How'))
    const iosSteps = [
      'Tap Allow when Safari asks to download a configuration profile.',
      'Open Settings and tap Profile Downloaded near the top (or General, then VPN & Device Management). Tap Install and enter your passcode.',
      'In Settings, go to General, About, Certificate Trust Settings, and turn on full trust for Conductor.',
      'Come back to Conductor and reload.'
    ]
    if (where.ios && (where.browser !== 'safari' || standalone)) {
      /* x-safari-https has no feature test; if it does nothing, the plain address below still works. */
      how.appendChild(linkButton('primary wide link-button', 'Open in Safari', shell.safariUrl(origin + '/#trust')))
      how.appendChild(el('p', 'card-note', standalone
        ? 'Only Safari can install a profile on iPhone, so this continues there.'
        : 'Only Safari can install a profile on iPhone. ' + where.name + ' would only save the file.'))
      how.appendChild(el('p', 'card-note', 'If Safari does not open, open Safari yourself and go to this address:'))
      how.appendChild(el('p', 'pair-address', origin + '/#trust'))
      how.appendChild(el('p', 'card-note', 'Then, in Safari:'))
      how.appendChild(stepsList(['Tap Download the certificate.'].concat(iosSteps)))
    } else if (where.ios) {
      how.appendChild(linkButton('primary wide link-button', 'Download the certificate', '/ca.crt'))
      how.appendChild(stepsList(iosSteps))
    } else if (where.android) {
      how.appendChild(linkButton('primary wide link-button', 'Download the certificate', '/ca.crt'))
      how.appendChild(stepsList([
        'The file lands in Downloads. Android does not install a certificate from the browser.',
        'Open Settings, then Security & privacy, More security settings, Encryption & credentials, Install a certificate, CA certificate. The names differ a little between phone makers; searching Settings for "CA certificate" finds it.',
        'Tap Install anyway and pick conductor-phone-ca.crt.',
        'Come back to Conductor and reload. Chrome trusts a certificate installed this way.'
      ]))
    } else {
      how.appendChild(linkButton('primary wide link-button', 'Download the certificate', '/ca.crt'))
      how.appendChild(el('p', 'card-note', 'Open the file and mark it as trusted for websites. Each system asks for this in its own place.'))
    }
    body.appendChild(how)
    body.appendChild(button('ghost wide', 'Connection check', () => visit('#diagnose')))

    scroll.appendChild(body)
    return { key: 'trust', root: root }
  }

  // ------------------------------------------------------------------ sessions screen

  const matchesFilter = session => {
    if (state.filter === 'all') return true
    return session.state === state.filter
  }

  const sessionRow = (session, compact) => {
    const node = button('session' + (compact ? ' coworker-session' : ''), null, () => go('#/session/' + encodeURIComponent(session.id)))
    node.appendChild(badge(session.state))

    const main = el('div', 'session-main')
    const head = el('div', 'session-head')
    head.appendChild(el('span', 'session-title', session.title || 'Untitled'))
    const when = el('span', 'session-when')
    onTick(() => { when.textContent = relativeTime(session.updatedAt) })
    head.appendChild(when)
    main.appendChild(head)

    const meta = el('div', 'session-meta')
    const parts = [providerWord(session.provider), session.model]
    if (session.machineId && session.machineId !== 'local') parts.push('on ' + session.machineName)
    const viewing = sessionViewing(session)
    const stateWord = el('span', 'session-state tone-' + (session.state || 'idle') + (viewing ? ' viewing' : ''), viewing ? 'Viewing' : STATE_WORDS[session.state] || 'Idle')
    if (viewing) stateWord.title = viewingDescription(session.backgroundTasks)
    meta.appendChild(stateWord)
    meta.appendChild(el('span', 'session-facts', dotRow(parts)))
    if (session.state === 'working' && !viewing && session.turnStartedAt) {
      const timer = el('span', 'session-timer')
      onTick(() => { timer.textContent = elapsedSince(session.turnStartedAt) })
      meta.appendChild(timer)
    }
    if (session.state === 'limited' && session.limitResumeAt) meta.appendChild(el('span', 'session-flag', 'resumes ' + clockTime(session.limitResumeAt)))
    if (session.queued) meta.appendChild(el('span', 'session-flag', session.queued + ' queued'))
    if (session.backgroundTasks) meta.appendChild(el('span', 'session-flag', session.backgroundTasks + ' in background'))
    if (session.archived) meta.appendChild(el('span', 'session-flag', 'archived'))
    main.appendChild(meta)

    const preview = session.state === 'attention' && session.pendingTitle ? session.pendingTitle : session.lastText
    if (preview) {
      const prefix = session.state !== 'attention' && session.lastRole === 'user' ? 'You: ' : ''
      main.appendChild(el('p', 'session-preview', prefix + oneLine(preview, 150)))
    }

    node.appendChild(main)
    node.appendChild(el('span', 'chev', '›'))
    return node
  }

  /* Grouped the way the desktop sidebar is: project, then workspace, in the order the state
     listed them, so the same conversation sits in the same place on both screens. */
  const groupSessions = sessions => {
    const projects = []
    const byProject = {}
    for (const session of sessions) {
      let project = byProject[session.projectId]
      if (!project) {
        project = { id: session.projectId, name: session.projectName, workspaces: [], byWorkspace: {} }
        byProject[session.projectId] = project
        projects.push(project)
      }
      let workspace = project.byWorkspace[session.workspaceId]
      if (!workspace) {
        workspace = { id: session.workspaceId, name: session.workspaceName, sessions: [] }
        project.byWorkspace[session.workspaceId] = workspace
        project.workspaces.push(workspace)
      }
      workspace.sessions.push(session)
    }
    return projects
  }

  const renderGroups = (host, sessions) => {
    for (const project of groupSessions(sessions)) {
      const group = el('section', 'group')
      group.appendChild(el('h2', 'group-title', project.name || 'Project'))
      for (const workspace of project.workspaces) {
        const single = project.workspaces.length === 1 && workspace.name === project.name
        if (!single) group.appendChild(el('h3', 'group-workspace', workspace.name || 'Workspace'))
        const list = el('div', 'list')
        const byId = {}
        for (const session of workspace.sessions) byId[session.id] = session
        const rootId = session => {
          let current = session, seen = {}
          while (current.controllerId && byId[current.controllerId] && !seen[current.controllerId]) {
            seen[current.id] = true
            current = byId[current.controllerId]
          }
          return current.id
        }
        const roots = workspace.sessions.filter(session => rootId(session) === session.id)
        for (const root of roots) {
          list.appendChild(sessionRow(root, false))
          const coworkers = workspace.sessions.filter(session => session.id !== root.id && rootId(session) === root.id)
          if (!coworkers.length) continue
          const expanded = state.expandedCoworkers[root.id] === true
          const working = coworkers.filter(session => session.state === 'working').length
          const waiting = coworkers.filter(session => session.state === 'attention').length
          const toggle = button('coworker-toggle', null, () => { state.expandedCoworkers[root.id] = !expanded; render() })
          toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false')
          toggle.appendChild(el('span', 'coworker-toggle-label', coworkers.length + (coworkers.length === 1 ? ' coworker' : ' coworkers')))
          toggle.appendChild(el('span', 'coworker-toggle-state', dotRow([waiting ? waiting + ' waiting' : '', working ? working + ' working' : ''])))
          toggle.appendChild(el('span', 'chev' + (expanded ? ' down' : ''), '›'))
          list.appendChild(toggle)
          if (expanded) {
            const children = el('div', 'coworker-list')
            for (const coworker of coworkers) children.appendChild(sessionRow(coworker, true))
            list.appendChild(children)
          }
        }
        group.appendChild(list)
      }
      host.appendChild(group)
    }
  }

  /* The stream has been down for 20 seconds of the owner actually looking at the phone. */
  const unreachableTooLong = () => {
    if (!state.token || state.connected || document.visibilityState !== 'visible') return false
    return Date.now() - Math.max(downSince, visibleSince) > UNREACHABLE_BANNER_MS
  }

  const installCard = () => {
    const card = el('section', 'card install-card')
    card.appendChild(el('h2', 'card-title', 'Add to Home Screen'))
    card.appendChild(el('p', 'card-note', 'Install Conductor as an app on this phone. It keeps this pairing.'))
    const row = el('div', 'inline')
    row.appendChild(button('primary', 'Install', async () => {
      const prompt = state.installPrompt
      state.installPrompt = null
      state.offerInstall = false
      render()
      if (!prompt) return
      try { await prompt.prompt() } catch (error) { /* Chrome allows one prompt per event */ }
    }))
    row.appendChild(button('ghost', 'Not now', () => {
      state.offerInstall = false
      render()
    }))
    card.appendChild(row)
    return card
  }

  const sessionsScreen = () => {
    const root = el('div', 'screen')
    const header = topbar()
    const scroll = scroller()
    /* A line under the header, never a takeover: the list below may still be worth reading. */
    const reach = button('reach-banner', null, () => visit('#diagnose'))
    reach.appendChild(el('span', 'reach-banner-text', 'This computer is not answering.'))
    reach.appendChild(el('span', 'reach-banner-link', 'Connection check ›'))
    reach.hidden = true
    const drawReach = () => { reach.hidden = !unreachableTooLong() }
    root.appendChild(header)
    root.appendChild(reach)
    root.appendChild(scroll)

    const drawHeader = () => {
      clear(header)
      const phone = state.phone
      const line = el('div', 'topbar-main')
      const title = el('div', 'topbar-heading')
      const dot = el('span', 'live-dot' + (state.connected ? ' live' : ''))
      title.appendChild(dot)
      title.appendChild(el('h1', 'topbar-title', phone ? phone.machineName : 'Conductor'))
      line.appendChild(title)
      const counts = el('div', 'counts')
      const attention = phone && phone.counts ? phone.counts.attention : 0
      const working = phone && phone.counts ? phone.counts.working : 0
      counts.appendChild(el('span', 'count tone-attention', attention + ' waiting'))
      counts.appendChild(el('span', 'count tone-working', working + ' working'))
      line.appendChild(counts)
      header.appendChild(line)

      const chips = el('div', 'chips')
      for (const entry of FILTERS) {
        const chip = button('chip' + (state.filter === entry.id ? ' selected' : ''), entry.label, () => {
          state.filter = entry.id
          writeStored(FILTER_KEY, entry.id)
          drawHeader()
          drawList()
        })
        chip.setAttribute('aria-pressed', state.filter === entry.id ? 'true' : 'false')
        chips.appendChild(chip)
      }
      header.appendChild(chips)
    }

    const drawList = () => {
      const top = scroll.scrollTop
      beginTicks()
      clear(scroll)
      const phone = state.phone
      if (!phone) {
        scroll.appendChild(emptyNote('Reading this computer…', 'The list appears as soon as the stream connects.'))
        return
      }
      if (state.offerInstall && state.installPrompt) scroll.appendChild(installCard())
      const all = phone.sessions || []
      const open = all.filter(session => session.tabId !== null && matchesFilter(session))
      const closed = all.filter(session => session.tabId === null && matchesFilter(session))

      if (!open.length && !closed.length) {
        const hint = state.filter === 'all'
          ? 'Start one from the New tab; it runs on the computer, not on this phone.'
          : 'Nothing matches this filter right now.'
        scroll.appendChild(emptyNote(state.filter === 'all' ? 'No conversations yet.' : 'Nothing here.', hint))
      } else {
        renderGroups(scroll, open)
      }

      if (closed.length) {
        const section = el('section', 'group closed-group')
        const toggle = button('closed-toggle', null, () => {
          state.showClosed = !state.showClosed
          drawList()
        })
        toggle.appendChild(el('span', 'closed-word', 'Not open · ' + closed.length))
        toggle.appendChild(el('span', 'chev' + (state.showClosed ? ' down' : ''), '›'))
        toggle.setAttribute('aria-expanded', state.showClosed ? 'true' : 'false')
        section.appendChild(toggle)
        if (state.showClosed) {
          section.appendChild(el('p', 'closed-hint', 'History on this computer, with no tab open. Opening one from the phone is not possible yet.'))
          const list = el('div', 'list')
          for (const session of closed) list.appendChild(sessionRow(session))
          section.appendChild(list)
        }
        scroll.appendChild(section)
      }
      scroll.scrollTop = top
    }

    drawHeader()
    drawList()
    drawReach()
    return {
      key: 'sessions',
      root: root,
      update: () => { drawHeader(); drawList(); drawReach() },
      onSecond: drawReach
    }
  }

  // ------------------------------------------------------------------ conversation pieces

  /* Text arrives as plain markdown-ish output. Only two things matter on a phone: newlines stay
     newlines, and a fenced block reads as code instead of wrapping into soup. */
  const appendRichText = (host, text) => {
    const lines = String(text === null || text === undefined ? '' : text).split('\n')
    let paragraph = []
    let code = null
    const flushParagraph = () => {
      if (!paragraph.length) return
      const joined = paragraph.join('\n').replace(/^\n+|\n+$/g, '')
      if (joined) host.appendChild(el('p', 'text-block', joined))
      paragraph = []
    }
    const flushCode = () => {
      if (code === null) return
      const pre = el('pre', 'code-block')
      pre.appendChild(el('code', null, code.join('\n')))
      host.appendChild(pre)
      code = null
    }
    for (const line of lines) {
      if (/^\s*```/.test(line)) {
        if (code === null) { flushParagraph(); code = [] } else flushCode()
        continue
      }
      if (code === null) paragraph.push(line)
      else code.push(line)
    }
    flushCode()
    flushParagraph()
  }

  const textItem = (item, data) => {
    const text = data.text || ''
    const attachments = data.attachments || []
    if (!text.trim() && !attachments.length) return null
    if (data.role === 'status') {
      const node = el('div', 'status-line')
      node.appendChild(el('span', null, oneLine(text, 200)))
      return node
    }
    const node = el('div', 'bubble ' + (data.role === 'user' ? 'user' : 'assistant'))
    const body = el('div', 'bubble-body')
    appendRichText(body, text)
    node.appendChild(body)
    if (attachments.length) {
      const chips = el('div', 'attachments')
      for (const attachment of attachments) chips.appendChild(el('span', 'attachment', attachment.name || attachment.kind || 'attachment'))
      node.appendChild(chips)
    }
    const stamp = el('time', 'bubble-time', dayTime(item.timestamp))
    node.appendChild(stamp)
    return node
  }

  const toolItem = (item, data) => {
    const node = el('div', 'tool')
    const head = button('tool-head', null, () => {
      state.expanded[item.id] = !state.expanded[item.id]
      const open = Boolean(state.expanded[item.id])
      head.setAttribute('aria-expanded', open ? 'true' : 'false')
      chev.classList.toggle('down', open)
      body.hidden = !open
    })
    head.appendChild(el('span', 'tool-dot status-' + (data.status || 'running')))
    head.appendChild(el('span', 'tool-name', data.name || 'tool'))
    head.appendChild(el('span', 'tool-status', data.status || ''))
    if (data.detached) head.appendChild(el('span', 'tool-flag', 'background'))
    const chev = el('span', 'chev')
    chev.textContent = '›'
    head.appendChild(chev)
    node.appendChild(head)

    const body = el('div', 'tool-body')
    if (data.description) body.appendChild(el('p', 'tool-note', oneLine(data.description, 300)))
    if (data.input !== undefined && data.input !== null) {
      let summary = ''
      try { summary = JSON.stringify(data.input) } catch (error) { summary = String(data.input) }
      if (summary && summary !== '{}') {
        body.appendChild(el('span', 'tool-label', 'Input'))
        const pre = el('pre', 'tool-pre', summary.length > 800 ? summary.slice(0, 800) + '…' : summary)
        body.appendChild(pre)
      }
    }
    const output = data.output || data.stderr || ''
    if (output) {
      body.appendChild(el('span', 'tool-label', data.output ? 'Output' : 'Errors'))
      /* The tail is what a finished command actually says; the head is usually a banner. */
      const tail = output.length > 1200 ? '…' + output.slice(output.length - 1200) : output
      body.appendChild(el('pre', 'tool-pre', tail))
    }
    if (typeof data.exitCode === 'number' || typeof data.durationMs === 'number') {
      const facts = []
      if (typeof data.exitCode === 'number') facts.push('exit ' + data.exitCode)
      if (typeof data.durationMs === 'number') facts.push(Math.round(data.durationMs / 100) / 10 + 's')
      body.appendChild(el('p', 'tool-note', dotRow(facts)))
    }
    if (!body.childNodes.length) body.appendChild(el('p', 'tool-note', 'No detail was reported.'))
    body.hidden = !state.expanded[item.id]
    head.setAttribute('aria-expanded', state.expanded[item.id] ? 'true' : 'false')
    if (state.expanded[item.id]) chev.classList.add('down')
    node.appendChild(body)
    return node
  }

  const changesItem = (item, data) => {
    const changes = data.changes || []
    if (!changes.length) return null
    const node = el('div', 'changes')
    node.appendChild(el('span', 'changes-title', changes.length === 1 ? '1 file changed' : changes.length + ' files changed'))
    for (const change of changes) {
      const row = el('div', 'change')
      row.appendChild(el('span', 'change-kind kind-' + (change.kind || 'update'), CHANGE_MARKS[change.kind] || '?'))
      row.appendChild(el('span', 'change-path', change.path || ''))
      const counts = []
      if (change.additions) counts.push('+' + change.additions)
      if (change.deletions) counts.push('-' + change.deletions)
      if (counts.length) row.appendChild(el('span', 'change-counts', counts.join(' ')))
      if (change.status && change.status !== 'applied') row.appendChild(el('span', 'change-status', change.status))
      node.appendChild(row)
    }
    return node
  }

  const planItem = (item, data) => {
    const steps = data.steps || []
    if (!steps.length) return null
    const node = el('div', 'plan')
    node.appendChild(el('span', 'plan-title', 'Plan'))
    if (data.explanation) node.appendChild(el('p', 'plan-note', oneLine(data.explanation, 300)))
    for (const step of steps) {
      const row = el('div', 'plan-step step-' + (step.status || 'pending'))
      row.appendChild(el('span', 'plan-mark', PLAN_MARKS[step.status] || PLAN_MARKS.pending))
      row.appendChild(el('span', 'plan-text', step.text || ''))
      node.appendChild(row)
    }
    return node
  }

  const answerSummary = interaction => {
    const answers = interaction.answers || {}
    const parts = []
    for (const key of Object.keys(answers)) {
      const value = answers[key]
      parts.push(Array.isArray(value) ? value.join(', ') : String(value))
    }
    return parts.join(' · ')
  }

  const resolvedInteraction = interaction => {
    const node = el('div', 'resolved')
    node.appendChild(el('span', 'resolved-kind', interaction.kind === 'approval' ? 'Approval' : 'Question'))
    node.appendChild(el('span', 'resolved-title', oneLine(interaction.title || '', 160)))
    const outcome = interaction.outcome || answerSummary(interaction) || (interaction.status === 'expired' ? 'expired' : '')
    if (outcome) node.appendChild(el('span', 'resolved-outcome', oneLine(outcome, 120)))
    return node
  }

  const noticeItem = (message, tone) => {
    if (!message) return null
    const node = el('div', 'notice ' + (tone || 'muted'))
    appendRichText(node, message)
    return node
  }

  const renderTimelineItem = (item, pendingIds) => {
    const data = item && item.data
    if (!data || typeof data !== 'object') return null
    if (data.type === 'text') return textItem(item, data)
    if (data.type === 'tool') return toolItem(item, data)
    if (data.type === 'changes') return changesItem(item, data)
    if (data.type === 'plan') return planItem(item, data)
    if (data.type === 'interaction') {
      const interaction = data.interaction
      if (!interaction) return null
      /* A still-pending request is shown as the card above the composer, never twice. */
      if (interaction.status === 'pending' && pendingIds[interaction.id]) return null
      return resolvedInteraction(interaction)
    }
    if (data.type === 'error') return noticeItem(data.message, 'error')
    if (data.type === 'notice') return noticeItem(data.message, 'muted')
    if (data.type === 'subagent') return noticeItem('Subagent ' + (data.name || 'task') + ' · ' + (data.status || ''), 'muted')
    /* usage, session, queue, steering and review are bookkeeping the phone has no use for. */
    return null
  }

  // ------------------------------------------------------------------ pending interaction card

  const answerStore = interaction => {
    let store = state.answers[interaction.id]
    if (!store) { store = {}; state.answers[interaction.id] = store }
    return store
  }

  const questionState = (interaction, question) => {
    const store = answerStore(interaction)
    let entry = store[question.id]
    if (!entry) { entry = { selected: [], custom: '', customSelected: false }; store[question.id] = entry }
    return entry
  }

  /* Same rule the desktop uses: "Other" is an option like any other, and picking it is what makes
     the typed text the answer. Answers go out keyed by question id, valued by option label. */
  const combinedAnswer = (question, entry) => {
    const text = (entry.custom || '').trim()
    if (!question.options || !question.options.length) return text ? [text] : []
    if (!entry.customSelected || !text) return entry.selected.slice()
    return question.multiSelect ? entry.selected.concat([text]) : [text]
  }

  const approvalSummary = input => {
    if (!input || typeof input !== 'object') return ''
    if (typeof input.description === 'string') return input.description
    if (typeof input.command === 'string') return input.command
    if (Array.isArray(input.command)) return input.command.join(' ')
    if (typeof input.file_path === 'string') return input.file_path
    if (typeof input.path === 'string') return input.path
    return ''
  }

  const pendingCard = (interaction, respond) => {
    const card = el('section', 'pending')
    card.appendChild(el('span', 'pending-kind', interaction.kind === 'approval' ? 'Approval needed' : 'Question'))
    card.appendChild(el('h3', 'pending-title', interaction.title || (interaction.kind === 'approval' ? 'Allow this?' : 'Answer needed')))

    const problem = el('p', 'pending-error')
    problem.hidden = true

    let busy = false
    const submit = async payload => {
      if (busy) return
      busy = true
      problem.hidden = true
      card.classList.add('busy')
      try {
        await respond(payload)
      } catch (error) {
        problem.textContent = errorMessage(error)
        problem.hidden = false
        busy = false
        card.classList.remove('busy')
      }
    }

    if (interaction.kind === 'approval') {
      const summary = approvalSummary(interaction.input)
      if (summary) card.appendChild(el('pre', 'pending-input', summary.length > 600 ? summary.slice(0, 600) + '…' : summary))
      const choices = el('div', 'choices')
      for (const choice of interaction.choices || []) {
        const node = button('choice' + (choice.id === 'approve' || choice.id === 'allow' ? ' primary' : ''), choice.label || choice.id, () => {
          void submit({ requestId: interaction.id, decision: choice.id })
        })
        node.disabled = Boolean(choice.disabled)
        if (choice.description) node.title = choice.description
        choices.appendChild(node)
      }
      card.appendChild(choices)
      for (const choice of interaction.choices || []) {
        if (!choice.description) continue
        const hint = el('p', 'pending-hint')
        hint.appendChild(el('strong', null, (choice.label || choice.id) + ': '))
        hint.appendChild(el('span', null, choice.description))
        card.appendChild(hint)
      }
      card.appendChild(problem)
      return card
    }

    const questions = interaction.questions || []
    const redraw = []
    for (const question of questions) {
      const entry = questionState(interaction, question)
      const block = el('div', 'question')
      if (question.header) block.appendChild(el('span', 'question-header', question.header))
      block.appendChild(el('p', 'question-text', question.question || ''))
      const options = el('div', 'options')
      const custom = el('input', 'input')
      custom.type = question.isSecret ? 'password' : 'text'
      custom.placeholder = 'Type an answer'
      custom.value = entry.custom
      custom.addEventListener('input', () => { entry.custom = custom.value; refresh() })

      const paint = () => {
        for (const node of options.querySelectorAll('.option')) {
          /* dataset stringifies everything, so "is this the Other button" is a class, not a value. */
          const picked = node.classList.contains('option-custom')
            ? entry.customSelected
            : entry.selected.indexOf(node.dataset.label) >= 0
          node.classList.toggle('selected', Boolean(picked))
          node.setAttribute('aria-pressed', picked ? 'true' : 'false')
        }
        custom.hidden = Boolean(question.options && question.options.length) && !entry.customSelected
      }

      for (const option of question.options || []) {
        const node = button('option', null, () => {
          const already = entry.selected.indexOf(option.label) >= 0
          if (question.multiSelect) {
            entry.selected = already ? entry.selected.filter(label => label !== option.label) : entry.selected.concat([option.label])
          } else {
            entry.selected = [option.label]
            entry.customSelected = false
            entry.custom = ''
            custom.value = ''
          }
          paint()
          refresh()
        })
        node.dataset.label = option.label
        const face = el('span', 'option-face')
        face.appendChild(el('strong', null, option.label))
        if (option.description) face.appendChild(el('small', null, option.description))
        node.appendChild(el('span', 'option-mark'))
        node.appendChild(face)
        options.appendChild(node)
      }

      /* The desktop offers free text unless the provider explicitly forbids it, and a question
         with no options is free text by definition. */
      const allowCustom = question.allowCustom !== false
      if (allowCustom && question.options && question.options.length) {
        const node = button('option option-custom', null, () => {
          entry.customSelected = question.multiSelect ? !entry.customSelected : true
          if (!question.multiSelect) entry.selected = []
          if (!entry.customSelected) { entry.custom = ''; custom.value = '' }
          paint()
          refresh()
          if (entry.customSelected) custom.focus()
        })
        const face = el('span', 'option-face')
        face.appendChild(el('strong', null, 'Other'))
        node.appendChild(el('span', 'option-mark'))
        node.appendChild(face)
        options.appendChild(node)
      }
      block.appendChild(options)
      if (allowCustom) block.appendChild(custom)
      card.appendChild(block)
      redraw.push(paint)
      paint()
    }

    const send = button('primary', 'Submit', () => {
      const payload = { requestId: interaction.id, answers: {} }
      for (const question of questions) payload.answers[question.id] = combinedAnswer(question, questionState(interaction, question))
      void submit(payload)
    })
    const refresh = () => {
      const unanswered = questions.some(question => combinedAnswer(question, questionState(interaction, question)).length === 0)
      send.disabled = unanswered
    }
    for (const paint of redraw) paint()
    refresh()
    card.appendChild(send)
    card.appendChild(problem)
    return card
  }

  // ------------------------------------------------------------------ conversation screen

  const loadConversation = async (id, quiet) => {
    if (!quiet) {
      state.conversationLoading = true
      state.conversation = null
    }
    try {
      const data = await api('/api/sessions/' + encodeURIComponent(id))
      if (state.conversationId !== id) return
      state.conversation = data
      state.conversationError = ''
    } catch (error) {
      if (state.conversationId !== id) return
      const message = errorMessage(error)
      if (message) state.conversationError = message
    } finally {
      state.conversationLoading = false
      render()
    }
  }

  const conversationScreen = id => {
    state.conversationId = id
    state.conversationError = ''
    const root = el('div', 'screen')
    const header = topbar()
    header.classList.add('conversation-bar')
    const scroll = scroller()
    scroll.classList.add('timeline')
    const footer = el('div', 'footer')
    root.appendChild(header)
    root.appendChild(scroll)
    root.appendChild(footer)

    let workingTimer = null
    let workingStartedAt = null
    const workingWords = ['Thinking…', 'Spelunking…', 'Working…', 'Considering…']
    const stopWorking = () => { if (workingTimer !== null) { clearInterval(workingTimer); workingTimer = null } }
    let firstPaint = true
    let busy = false

    const pendingHost = el('div', 'pending-host')
    const queuedHost = el('div', 'queued-host')
    const errorHost = el('div', 'error-host')
    const composer = el('div', 'composer')
    const input = el('textarea', 'composer-input')
    input.rows = 1
    input.placeholder = 'Message'
    input.value = state.drafts[id] || ''
    const stop = button('composer-stop', null, () => void interrupt())
    stop.appendChild(icon(['M8.5 8.5h7v7h-7z'], 20))
    stop.setAttribute('aria-label', 'Stop this turn')
    const primary = button('composer-send', 'Send', () => void sendPrimary())
    composer.appendChild(input)
    composer.appendChild(stop)
    composer.appendChild(primary)
    footer.appendChild(pendingHost)
    footer.appendChild(queuedHost)
    footer.appendChild(errorHost)
    footer.appendChild(composer)

    const lineHeight = 21
    const grow = () => {
      input.style.height = 'auto'
      const max = lineHeight * MAX_COMPOSER_LINES + 18
      input.style.height = Math.min(input.scrollHeight, max) + 'px'
      input.style.overflowY = input.scrollHeight > max ? 'auto' : 'hidden'
    }
    input.addEventListener('input', () => {
      state.drafts[id] = input.value
      grow()
      paintComposer()
      scrollCaretIntoView(input)
    })
    input.addEventListener('focus', () => scrollCaretIntoView(input))

    const atBottom = () => scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 64
    const toBottom = () => { scroll.scrollTop = scroll.scrollHeight }

    const run = async work => {
      if (busy) return
      busy = true
      paintComposer()
      try {
        await work()
        state.conversationError = ''
      } catch (error) {
        const message = errorMessage(error)
        if (message) state.conversationError = message
      } finally {
        busy = false
        await loadConversation(id, true)
      }
    }

    const sendPrimary = async () => {
      const text = input.value.trim()
      const conversation = state.conversation
      const resume = conversation && conversation.needsResume
      if (!resume && !text) return
      await run(async () => {
        if (resume) await api('/api/sessions/' + encodeURIComponent(id) + '/resume', { method: 'POST' })
        if (text) await api('/api/sessions/' + encodeURIComponent(id) + '/message', { method: 'POST', body: { text: text, mode: 'auto' } })
        input.value = ''
        state.drafts[id] = ''
        grow()
      })
    }

    const interrupt = async () => {
      await run(async () => { await api('/api/sessions/' + encodeURIComponent(id) + '/interrupt', { method: 'POST' }) })
    }

    const respond = async payload => {
      await api('/api/sessions/' + encodeURIComponent(id) + '/respond', { method: 'POST', body: payload })
      delete state.answers[payload.requestId]
      await loadConversation(id, true)
    }

    input.addEventListener('keydown', event => {
      /* A hardware keyboard on an iPad should send; the on-screen keyboard sends a newline. */
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
      if (!event.metaKey && !event.ctrlKey) return
      event.preventDefault()
      void sendPrimary()
    })

    const drawHeader = () => {
      clear(header)
      const conversation = state.conversation
      const summary = conversation ? conversation.summary : null
      const back = button('back', null, () => go('#/'))
      back.setAttribute('aria-label', 'Back to sessions')
      back.appendChild(icon(['M15 5l-7 7 7 7'], 24))
      const heading = el('div', 'conversation-heading')
      heading.appendChild(el('h1', 'topbar-title', summary ? summary.title || 'Untitled' : 'Conversation'))
      if (summary) {
        const facts = [summary.projectName, summary.workspaceName]
        if (summary.machineId && summary.machineId !== 'local') facts.push(summary.machineName)
        heading.appendChild(el('p', 'conversation-facts', dotRow(facts.concat([providerWord(summary.provider), summary.model]))))
      }
      const line = el('div', 'topbar-main')
      line.appendChild(back)
      line.appendChild(heading)
      if (summary) line.appendChild(badge(summary.state))
      header.appendChild(line)
    }

    const drawTimeline = () => {
      stopWorking()
      const stick = firstPaint || atBottom()
      const top = scroll.scrollTop
      beginTicks()
      clear(scroll)
      const conversation = state.conversation
      if (!conversation) {
        scroll.appendChild(emptyNote(state.conversationError ? 'Could not read this conversation.' : 'Loading…', state.conversationError || null))
        return
      }
      if (conversation.truncated) scroll.appendChild(el('p', 'timeline-note', 'Older messages stayed on the computer.'))
      const pendingIds = {}
      for (const interaction of conversation.pending || []) pendingIds[interaction.id] = true
      const items = (conversation.items || []).slice().sort((left, right) => left.sequence - right.sequence)
      let drawn = 0
      for (let index = 0; index < items.length; index++) {
        const item = items[index], next = items[index + 1]
        if (item.data.type === 'text' && item.data.role === 'status' && next && next.data.type === 'text' && next.data.role === 'status') continue
        const node = renderTimelineItem(item, pendingIds)
        if (!node) continue
        scroll.appendChild(node)
        drawn += 1
      }
      const working = ['running', 'starting'].includes(conversation.summary.phase)
      if (!working) workingStartedAt = null
      if (!drawn && !working) scroll.appendChild(emptyNote('Nothing said yet.', 'Send the first message below.'))
      if (working) {
        if (workingStartedAt === null) workingStartedAt = Date.now()
        const word = () => workingWords[Math.floor((Date.now() - workingStartedAt) / 7000) % workingWords.length]
        const line = el('p', 'timeline-working', word())
        line.setAttribute('role', 'status')
        scroll.appendChild(line)
        workingTimer = setInterval(() => {
          line.textContent = word()
        }, 7000)
      }
      if (stick) toBottom()
      else scroll.scrollTop = top
      firstPaint = false
    }

    let pendingKey = null
    const drawFooter = () => {
      const conversation = state.conversation

      const live = ((conversation && conversation.pending) || []).filter(interaction => !interaction.status || interaction.status === 'pending')
      const key = live.map(interaction => interaction.id).join(',')
      /* Rebuilding these cards on every stream tick would steal focus from a half-typed answer,
         so they are only rebuilt when the set of open requests actually changes. */
      if (key !== pendingKey) {
        pendingKey = key
        clear(pendingHost)
        for (const interaction of live) pendingHost.appendChild(pendingCard(interaction, respond))
      }

      clear(queuedHost)
      const queued = (conversation && conversation.queued) || []
      if (queued.length) {
        queuedHost.appendChild(el('span', 'queued-title', queued.length === 1 ? '1 message queued' : queued.length + ' messages queued'))
        /* While a request is open, the answer is what the screen is for: the queue keeps its
           count line but gives its rows back to the card. */
        if (!live.length) for (const entry of queued) queuedHost.appendChild(el('p', 'queued-item', oneLine(entry.text, 120)))
      }

      clear(errorHost)
      if (state.conversationError) {
        errorHost.appendChild(errorLine(state.conversationError, () => {
          state.conversationError = ''
          clear(errorHost)
        }))
      }
      paintComposer()
    }

    const paintComposer = () => {
      const conversation = state.conversation
      const summary = conversation ? conversation.summary : null
      const phase = summary ? summary.phase : 'idle'
      const working = phase === 'running' || phase === 'starting'
      let label = 'Send'
      if (conversation && conversation.needsResume) label = 'Resume'
      else if (working) label = conversation && conversation.canSteer ? 'Steer' : 'Queue'
      primary.textContent = busy ? '…' : label
      const empty = !input.value.trim()
      primary.disabled = busy || (empty && label !== 'Resume')
      input.placeholder = label === 'Steer' ? 'Add to this turn' : label === 'Queue' ? 'Send after this turn' : 'Message'
      const stoppable = phase === 'running' || phase === 'starting' || phase === 'waiting_approval' || phase === 'waiting_input' || phase === 'interrupting'
      stop.hidden = !stoppable
      stop.disabled = busy || phase === 'interrupting'
    }

    const update = () => {
      drawHeader()
      drawTimeline()
      drawFooter()
    }

    drawHeader()
    drawTimeline()
    drawFooter()
    grow()
    void loadConversation(id, Boolean(state.conversation && state.conversationId === id))

    return {
      key: 'session:' + id,
      root: root,
      update: update,
      destroy: () => {
        stopWorking()
        state.conversationId = null
        state.conversation = null
        if (refetchTimer) { clearTimeout(refetchTimer); refetchTimer = null }
      }
    }
  }

  // ------------------------------------------------------------------ project tasks screen

  const projectTasksScreen = () => {
    const root = el('div', 'screen')
    const header = topbar()
    const scroll = scroller()
    root.appendChild(header)
    root.appendChild(scroll)
    clear(header).appendChild(fill(el('div', 'topbar-main'), [el('h1', 'topbar-title', 'Tasks')]))

    let page = { tasks: [], page: { offset: 0, limit: 20, total: 0, hasMore: false } }
    let loading = false
    let adding = false
    let problem = ''
    const expanded = {}

    const load = async reset => {
      reconcileForm()
      const form = state.form
      if (!form || !form.projectId || loading) return
      loading = true
      problem = ''
      const projectId = form.projectId
      const offset = reset ? 0 : page.tasks.length
      draw()
      try {
        const next = await api('/api/projects/' + encodeURIComponent(form.projectId) + '/tasks?offset=' + offset + '&limit=20')
        if (projectId !== state.form.projectId) return
        page = reset ? next : { ...next, tasks: page.tasks.concat(next.tasks || []) }
      } catch (error) { problem = errorMessage(error) }
      finally { loading = false; if (screen && screen.key === 'tasks') draw() }
    }

    const draw = () => {
      reconcileForm()
      const top = scroll.scrollTop
      clear(scroll)
      const phone = state.phone
      if (!phone) { scroll.appendChild(emptyNote('Reading this computerâ€¦')); return }
      const form = state.form
      const body = el('div', 'form project-tasks-phone')
      body.appendChild(field('Project', select(
        (phone.projects || []).map(entry => ({ value: entry.id, label: entry.name })),
        form.projectId,
        value => { form.projectId = value; page = { tasks: [], page: { offset: 0, limit: 20, total: 0, hasMore: false } }; draw(); void load(true) }
      )))

      const quick = el('section', 'card task-quick-add')
      quick.appendChild(el('h2', 'card-title', 'Quick add'))
      const report = el('textarea', 'input prompt')
      report.rows = 3
      report.placeholder = 'Add a task, bug, feature, or idea'
      report.setAttribute('aria-label', 'New project task')
      report.maxLength = phone.projectTaskMaxLength || 200000
      report.value = form.taskTitle
      report.addEventListener('input', () => { form.taskTitle = report.value; paintAdd() })
      quick.appendChild(report)
      const scales = el('div', 'task-scales')
      const taskKind = select(['task', 'bug', 'feature', 'idea'].map(value => ({ value: value, label: value.charAt(0).toUpperCase() + value.slice(1) })), form.taskKind, value => { form.taskKind = value })
      const taskPriority = select(['high', 'normal', 'low'].map(value => ({ value: value, label: value.charAt(0).toUpperCase() + value.slice(1) })), form.taskPriority, value => { form.taskPriority = value })
      const taskWeight = select(['heavy', 'medium', 'light'].map(value => ({ value: value, label: value.charAt(0).toUpperCase() + value.slice(1) })), form.taskWeight, value => { form.taskWeight = value })
      taskKind.setAttribute('aria-label', 'Task type'); taskPriority.setAttribute('aria-label', 'Task priority'); taskWeight.setAttribute('aria-label', 'Task weight')
      scales.appendChild(taskKind); scales.appendChild(taskPriority); scales.appendChild(taskWeight)
      quick.appendChild(scales)
      const add = button('primary wide', 'Add task', async () => {
        if (adding || !form.taskTitle.trim()) return
        adding = true; paintAdd(); problem = ''
        try {
          const created = await api('/api/projects/' + encodeURIComponent(form.projectId) + '/tasks', { method: 'POST', body: { title: form.taskTitle, kind: form.taskKind, priority: form.taskPriority, weight: form.taskWeight } })
          form.taskTitle = ''
          showToast({ kind: 'done', title: 'Project task added', body: created && created.title, url: '#/tasks' })
          page = { tasks: [], page: { offset: 0, limit: 20, total: 0, hasMore: false } }
          adding = false
          await load(true)
        } catch (error) { problem = errorMessage(error); adding = false; draw() }
      })
      const paintAdd = () => { add.disabled = adding || !form.projectId || !form.taskTitle.trim(); add.textContent = adding ? 'Addingâ€¦' : 'Add task' }
      paintAdd()
      quick.appendChild(add)
      body.appendChild(quick)

      const project = projectById(form.projectId)
      const heading = el('div', 'task-list-head')
      heading.appendChild(el('h2', 'card-title', project ? project.name : 'Project tasks'))
      heading.appendChild(el('span', 'muted-note', page.page.total + ' open'))
      body.appendChild(heading)
      const list = el('div', 'phone-task-list')
      for (const task of page.tasks || []) {
        const card = el('article', 'card phone-task')
        const text = el('button', 'phone-task-title' + (expanded[task.id] ? ' expanded' : ''), task.title)
        text.type = 'button'
        text.setAttribute('aria-expanded', expanded[task.id] ? 'true' : 'false')
        text.addEventListener('click', () => { expanded[task.id] = !expanded[task.id]; draw() })
        card.appendChild(text)
        card.appendChild(el('p', 'card-note', [task.status === 'doing' ? 'In progress' : 'To do', task.kind, task.priority + ' priority', task.weight + ' weight'].join(' · ')))
        list.appendChild(card)
      }
      if (!page.tasks.length && !loading) list.appendChild(emptyNote('No open tasks in this project.'))
      body.appendChild(list)
      if (page.page.hasMore) body.appendChild(button('ghost wide task-more', loading ? 'Loadingâ€¦' : 'Load more', () => { if (!loading) void load(false) }))
      if (loading && !page.tasks.length) body.appendChild(emptyNote('Loading tasksâ€¦'))
      if (problem) body.appendChild(el('p', 'pending-error', problem))
      scroll.appendChild(body)
      scroll.scrollTop = top
    }

    scroll.addEventListener('scroll', () => {
      if (!loading && page.page.hasMore && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 180) void load(false)
    })
    draw()
    if (state.form && state.form.projectId) void load(true)
    return { key: 'tasks', root: root, update: () => { reconcileForm(); draw(); if (state.form && state.form.projectId) void load(true) } }
  }

  // ------------------------------------------------------------------ new task screen

  const projectById = id => ((state.phone && state.phone.projects) || []).filter(project => project.id === id)[0] || null
  const providerById = id => ((state.phone && state.phone.providers) || []).filter(provider => provider.id === id)[0] || null

  const machineUsable = (machine, projectId) =>
    machine.status === 'online' && (machine.projectIds || []).indexOf(projectId) >= 0

  /* How much of its weekly window each provider has left, from the usage data the phone already
     receives. A provider with no reported window yet is assumed untouched, not exhausted. */
  const usageRemainingByProvider = () => {
    const remaining = new Map()
    for (const window_ of (state.phone && state.phone.usage) || []) {
      if (window_.kind !== 'weekly') continue
      const left = 100 - window_.usedPercent
      remaining.set(window_.provider, Math.min(remaining.has(window_.provider) ? remaining.get(window_.provider) : 100, left))
    }
    return remaining
  }

  /* A phone task is usually a quick ask, so the pick is a mid-tier model - Sonnet, or GPT's
     Terra/Sol tier - never the frontier one, which a phone default should not spend on its own. */
  const FRONTIER_MODEL = /opus|astra|frontier/i
  const MID_TIER_MODEL = /sonnet|terra|\bsol\b/i
  const preferredModel = models => {
    const affordable = models.filter(model => !FRONTIER_MODEL.test(model.label))
    return affordable.filter(model => MID_TIER_MODEL.test(model.label))[0] ||
      affordable.filter(model => model.isDefault)[0] || affordable[0] ||
      models.filter(model => model.isDefault)[0] || models[0]
  }

  /* The form is rebuilt from every fresh PhoneState, so it must forget any choice the desktop no
     longer offers - a project removed, a machine gone offline - without losing the rest. */
  const reconcileForm = () => {
    const phone = state.phone
    if (!phone) return
    const form = state.form || (state.form = { projectId: '', workspaceId: '', machineId: '', provider: '', model: '', effort: '', title: '', prompt: '', taskTitle: '', taskKind: 'task', taskPriority: 'normal', taskWeight: 'medium', settingsOpen: false })
    const projects = phone.projects || []
    if (!projectById(form.projectId)) form.projectId = projects.length ? projects[0].id : ''
    const project = projectById(form.projectId)
    const workspaces = project ? project.workspaces || [] : []
    if (!workspaces.some(workspace => workspace.id === form.workspaceId)) form.workspaceId = workspaces.length ? workspaces[0].id : ''
    const machines = (phone.machines || []).filter(machine => machineUsable(machine, form.projectId))
    if (!machines.some(machine => machine.id === form.machineId)) {
      const own = project ? machines.filter(machine => machine.id === project.machineId)[0] : null
      form.machineId = own ? own.id : machines.length ? machines[0].id : ''
    }
    const providers = (phone.providers || []).filter(provider => provider.available)
    if (!providers.some(provider => provider.id === form.provider)) {
      const remaining = usageRemainingByProvider()
      const ranked = providers.slice().sort((a, b) => (remaining.has(b.id) ? remaining.get(b.id) : 100) - (remaining.has(a.id) ? remaining.get(a.id) : 100))
      form.provider = ranked.length ? ranked[0].id : ''
    }
    const provider = providerById(form.provider)
    const models = provider ? provider.models || [] : []
    if (!models.some(model => model.id === form.model)) {
      const preferred = preferredModel(models)
      form.model = preferred ? preferred.id : ''
    }
    const model = models.filter(entry => entry.id === form.model)[0]
    const efforts = model && model.effort ? model.effort : []
    if (!efforts.length) form.effort = ''
    else if (efforts.indexOf(form.effort) < 0) form.effort = model.defaultEffort && efforts.indexOf(model.defaultEffort) >= 0 ? model.defaultEffort : efforts[0]
  }

  const newTaskScreen = () => {
    const root = el('div', 'screen')
    const header = topbar()
    const scroll = scroller()
    root.appendChild(header)
    root.appendChild(scroll)
    clear(header).appendChild(fill(el('div', 'topbar-main'), [el('h1', 'topbar-title', 'New')]))

    let busy = false

    const draw = () => {
      reconcileForm()
      clear(scroll)
      const phone = state.phone
      if (!phone) {
        scroll.appendChild(emptyNote('Reading this computer…'))
        return
      }
      const form = state.form
      const project = projectById(form.projectId)
      const provider = providerById(form.provider)
      const models = provider ? provider.models || [] : []
      const model = models.filter(entry => entry.id === form.model)[0] || null
      const body = el('div', 'form')

      const prompt = el('textarea', 'input prompt')
      prompt.rows = 5
      prompt.placeholder = 'What should it do?'
      prompt.value = form.prompt
      prompt.addEventListener('input', () => { form.prompt = prompt.value; paint() })
      body.appendChild(field('Prompt', prompt, 'Leave this empty to just open an idle tab.'))

      const summary = (project ? project.name : 'No project') + ' · ' + (provider ? provider.displayName : 'No agent') + (model ? ' · ' + model.label : '')
      const settingsToggle = button('ghost wide settings-toggle', (form.settingsOpen ? 'Hide settings' : 'Settings') + ' · ' + summary,
        () => { form.settingsOpen = !form.settingsOpen; draw() })
      body.appendChild(settingsToggle)

      const settings = el('div', 'form')
      settings.hidden = !form.settingsOpen

      settings.appendChild(field('Project', select(
        (phone.projects || []).map(entry => ({ value: entry.id, label: entry.name })),
        form.projectId,
        value => { form.projectId = value; form.workspaceId = ''; form.machineId = ''; draw() }
      )))

      const workspaces = project ? project.workspaces || [] : []
      settings.appendChild(field('Workspace', select(
        workspaces.map(entry => ({ value: entry.id, label: entry.name })),
        form.workspaceId,
        value => { form.workspaceId = value; draw() }
      )))

      const machines = phone.machines || []
      const machineOptions = machines.map(machine => ({
        value: machine.id,
        label: machine.name + ' (' + machine.status + (machineUsable(machine, form.projectId) ? '' : ', no copy of this project') + ')',
        disabled: !machineUsable(machine, form.projectId)
      }))
      settings.appendChild(field('Run on', select(machineOptions, form.machineId, value => { form.machineId = value; draw() }),
        'The task runs on that computer. This phone only watches it.'))

      const providers = (phone.providers || []).filter(entry => entry.available)
      settings.appendChild(field('Agent', select(
        providers.map(entry => ({ value: entry.id, label: entry.displayName })),
        form.provider,
        value => { form.provider = value; form.model = ''; form.effort = ''; draw() }
      )))

      settings.appendChild(field('Model', select(
        models.map(entry => ({ value: entry.id, label: entry.label })),
        form.model,
        value => { form.model = value; form.effort = ''; draw() }
      )))

      const efforts = model && model.effort ? model.effort : []
      if (efforts.length) {
        settings.appendChild(field('Effort', select(
          efforts.map(entry => ({ value: entry, label: entry })),
          form.effort,
          value => { form.effort = value }
        )))
      }

      const title = el('input', 'input')
      title.type = 'text'
      title.placeholder = 'Optional'
      title.value = form.title
      title.addEventListener('input', () => { form.title = title.value })
      settings.appendChild(field('Title', title))

      body.appendChild(settings)

      const problem = el('p', 'pending-error')
      problem.hidden = true
      const start = button('primary wide', 'Start', async () => {
        if (busy) return
        busy = true
        problem.hidden = true
        start.textContent = 'Starting…'
        start.disabled = true
        try {
          const request = {
            projectId: form.projectId,
            workspaceId: form.workspaceId,
            machineId: form.machineId,
            provider: form.provider,
            model: form.model
          }
          if (form.effort) request.effort = form.effort
          if (form.title.trim()) request.title = form.title.trim()
          if (form.prompt.trim()) request.prompt = form.prompt.trim()
          const result = await api('/api/tabs/open', { method: 'POST', body: request })
          form.title = ''
          form.prompt = ''
          busy = false
          if (result && result.sessionId) go('#/session/' + encodeURIComponent(result.sessionId))
          else draw()
        } catch (error) {
          busy = false
          problem.textContent = errorMessage(error)
          problem.hidden = false
          start.disabled = false
          start.textContent = 'Start'
        }
      })
      const reason = el('p', 'field-hint reason')

      const paint = () => {
        let blocker = ''
        if (!form.projectId) blocker = 'Add a project on the computer first.'
        else if (!form.workspaceId) blocker = 'This project has no workspace to run in.'
        else if (!form.machineId) blocker = 'No online computer holds this project.'
        else if (!form.provider) blocker = 'No agent is available on that computer.'
        else if (!form.model) blocker = 'Choose a model.'
        start.disabled = busy || Boolean(blocker)
        reason.textContent = blocker
        reason.hidden = !blocker
      }
      paint()

      body.appendChild(start)
      body.appendChild(reason)
      body.appendChild(problem)
      scroll.appendChild(body)
    }

    draw()
    return { key: 'new', root: root, update: draw }
  }

  // ------------------------------------------------------------------ system screen

  const meterCard = (title, value, used, total, note) => {
    const card = el('section', 'card')
    const head = el('div', 'card-head')
    head.appendChild(el('h2', 'card-title', title))
    head.appendChild(el('span', 'card-value', value))
    card.appendChild(head)
    if (total > 0) {
      const bar = el('div', 'bar')
      const fillNode = el('div', 'bar-fill')
      fillNode.style.width = Math.max(0, Math.min(100, (used / total) * 100)) + '%'
      bar.appendChild(fillNode)
      card.appendChild(bar)
    }
    if (note) card.appendChild(el('p', 'card-note', note))
    return card
  }

  const systemScreen = () => {
    const root = el('div', 'screen')
    const header = topbar()
    const scroll = scroller()
    root.appendChild(header)
    root.appendChild(scroll)
    const terminalLink = button('ghost terminal-open', 'Terminal', () => visit('#/terminal'))
    terminalLink.setAttribute('aria-label', 'Open a terminal on this computer')
    clear(header).appendChild(fill(el('div', 'topbar-main'), [el('h1', 'topbar-title', 'System'), terminalLink]))

    let timer = null

    const load = async () => {
      try {
        state.metrics = await api('/api/metrics')
        state.metricsError = ''
      } catch (error) {
        const message = errorMessage(error)
        if (message) state.metricsError = message
      }
      if (screen && screen.key === 'system') draw()
    }

    const start = () => {
      if (timer) return
      timer = setInterval(() => { void load() }, METRICS_INTERVAL_MS)
      void load()
    }
    const pause = () => { if (timer) { clearInterval(timer); timer = null } }

    const draw = () => {
      const top = scroll.scrollTop
      clear(scroll)
      const metrics = state.metrics
      if (!metrics) {
        scroll.appendChild(emptyNote(state.metricsError ? 'Could not read this computer.' : 'Measuring…', state.metricsError || null))
        return
      }
      const system = metrics.system || {}
      const cards = el('div', 'cards')

      cards.appendChild(meterCard('CPU', formatPercent(system.cpuPercent), system.cpuPercent || 0, 100,
        (system.cpuCores || 0) + ' cores'))
      cards.appendChild(meterCard('Memory', formatBytes(system.memoryUsedBytes) + ' of ' + formatBytes(system.memoryTotalBytes),
        system.memoryUsedBytes || 0, system.memoryTotalBytes || 0, null))

      for (const gpu of system.gpus || []) {
        const note = [formatBytes(gpu.memoryUsedBytes) + ' of ' + formatBytes(gpu.memoryTotalBytes) + ' VRAM']
        if (typeof gpu.temperatureC === 'number') note.push(Math.round(gpu.temperatureC) + '°C')
        cards.appendChild(meterCard(gpu.name || 'GPU ' + gpu.index, formatPercent(gpu.utilizationPercent),
          gpu.utilizationPercent || 0, 100, dotRow(note)))
      }
      scroll.appendChild(cards)

      const processes = system.processes || []
      const servers = system.localServers || []
      if (processes.length || servers.length) {
        const card = el('section', 'card')
        card.appendChild(el('h2', 'card-title', 'Notable processes'))
        const table = el('div', 'table')
        for (const process of processes) {
          const row = el('div', 'trow')
          row.appendChild(el('span', 'tcell grow', process.label || process.name || String(process.pid)))
          row.appendChild(el('span', 'tcell num', formatPercent(process.cpuPercent)))
          row.appendChild(el('span', 'tcell num', formatBytes(process.memoryBytes)))
          table.appendChild(row)
        }
        for (const server of servers) {
          const row = el('div', 'trow')
          row.appendChild(el('span', 'tcell grow', (server.label || server.model) + ' · port ' + server.port))
          row.appendChild(el('span', 'tcell num', server.running ? 'running' : 'stopped'))
          row.appendChild(el('span', 'tcell num', formatBytes(server.memoryBytes)))
          table.appendChild(row)
        }
        card.appendChild(table)
        scroll.appendChild(card)
      }

      const runtimes = metrics.runtimes || []
      if (runtimes.length) {
        const card = el('section', 'card')
        card.appendChild(el('h2', 'card-title', 'Runtimes'))
        for (const runtime of runtimes) {
          const row = el('div', 'runtime')
          row.appendChild(el('span', 'runtime-title', runtime.title || runtime.kind))
          row.appendChild(el('span', 'runtime-meta', dotRow([
            providerWord(runtime.provider),
            runtime.activityPhase || runtime.status,
            dotRow([runtime.projectName, runtime.workspaceName])
          ])))
          card.appendChild(row)
        }
        scroll.appendChild(card)
      }

      const weekly = state.phone && state.phone.weeklyUsage
      if (weekly && weekly.models && weekly.models.length) {
        const card = el('section', 'card')
        card.appendChild(el('h2', 'card-title', 'Last 7 days by model'))
        for (const modelUsage of weekly.models) {
          const row = el('div', 'runtime')
          row.appendChild(el('span', 'runtime-title', modelUsage.model || 'Model not reported'))
          row.appendChild(el('span', 'runtime-meta', dotRow([
            providerWord(modelUsage.provider),
            formatNumber(modelUsage.totalTokens || 0) + ' tokens',
            modelUsage.conversations + (modelUsage.conversations === 1 ? ' conversation' : ' conversations'),
            modelUsage.estimated ? 'includes estimates' : ''
          ])))
          card.appendChild(row)
        }
        const coverage = weekly.coverage || {}
        if (coverage.countersWithoutBaseline || coverage.truncatedConversations) card.appendChild(el('p', 'card-note', 'Only usage that can be placed inside this seven-day window is counted.'))
        scroll.appendChild(card)
      }

      const usage = (state.phone && state.phone.usage) || []
      if (usage.length) {
        const card = el('section', 'card')
        card.appendChild(el('h2', 'card-title', 'Allowance windows'))
        for (const window_ of usage) {
          const row = el('div', 'meter')
          const head = el('div', 'meter-head')
          head.appendChild(el('span', 'meter-label', dotRow([providerWord(window_.provider), window_.model, window_.label])))
          head.appendChild(el('span', 'meter-value', formatPercent(window_.usedPercent)))
          row.appendChild(head)
          const bar = el('div', 'bar')
          const fillNode = el('div', 'bar-fill' + (window_.usedPercent >= 90 ? ' hot' : ''))
          fillNode.style.width = Math.max(0, Math.min(100, window_.usedPercent || 0)) + '%'
          bar.appendChild(fillNode)
          row.appendChild(bar)
          if (window_.resetsAt) row.appendChild(el('p', 'card-note', 'resets ' + dayTime(window_.resetsAt)))
          card.appendChild(row)
        }
        scroll.appendChild(card)
      }

      for (const line of system.unavailable || []) scroll.appendChild(el('p', 'muted-note', line))
      if (state.metricsError) scroll.appendChild(el('p', 'muted-note', state.metricsError))
      scroll.scrollTop = top
    }

    draw()
    start()
    return {
      key: 'system',
      root: root,
      update: draw,
      destroy: pause,
      onVisibility: visible => { if (visible) start(); else pause() }
    }
  }

  // ------------------------------------------------------------------ phone screen

  const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent || '') ||
    ((navigator.platform === 'MacIntel' || /Macintosh/.test(navigator.userAgent || '')) && navigator.maxTouchPoints > 1)

  const base64ToBytes = value => {
    const padded = String(value).replace(/-/g, '+').replace(/_/g, '/')
    const full = padded + '==='.slice(0, (4 - (padded.length % 4)) % 4)
    const binary = window.atob(full)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
  }

  /* Why the switch is unavailable, in words that name the fix. Order matters: on iOS Safari
     PushManager simply does not exist until the app lives on the Home Screen. */
  const pushBlocker = () => {
    if (!window.isSecureContext) return 'This phone does not trust the computer’s certificate yet. Install it from the Conductor settings on the desktop, then reopen this page.'
    if (!('serviceWorker' in navigator)) return 'This browser has no service worker, which notifications need.'
    if (isIos() && navigator.standalone !== true) return 'On iPhone and iPad, notifications only work once this page is on the Home Screen. Tap Share, then Add to Home Screen, and open Conductor from there.'
    if (!('PushManager' in window)) return 'This browser cannot receive push notifications.'
    if (state.me && !state.me.vapidPublicKey) return 'The computer has no push keys yet, so there is nothing to subscribe to.'
    return ''
  }

  const phoneScreen = () => {
    const root = el('div', 'screen')
    const header = topbar()
    const scroll = scroller()
    root.appendChild(header)
    root.appendChild(scroll)
    clear(header).appendChild(fill(el('div', 'topbar-main'), [el('h1', 'topbar-title', 'This phone')]))

    let notice = ''
    let problem = ''
    let working = false

    const load = async () => {
      try {
        state.me = await api('/api/me')
      } catch (error) {
        problem = errorMessage(error)
      }
      if (screen && screen.key === 'phone') draw()
    }

    const act = async work => {
      if (working) return
      working = true
      problem = ''
      draw()
      try { await work() } catch (error) { problem = errorMessage(error) }
      working = false
      draw()
    }

    const enablePush = permission => act(async () => {
      if (permission !== 'granted') throw new Error('Notifications are turned off for this page in the phone’s settings.')
      const registration = await navigator.serviceWorker.ready
      const key = state.me && state.me.vapidPublicKey
      if (!key) throw new Error('The computer has no push key to subscribe with.')
      let subscription = await registration.pushManager.getSubscription()
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64ToBytes(key)
        })
      }
      await api('/api/push/subscribe', { method: 'POST', body: { subscription: subscription.toJSON() } })
      await rememberPushAuth(key, state.token)
      notice = 'Notifications are on.'
      await load()
    })

    const disablePush = () => act(async () => {
      if ('serviceWorker' in navigator) {
        const registration = await navigator.serviceWorker.ready
        const subscription = await registration.pushManager.getSubscription()
        if (subscription) await subscription.unsubscribe()
      }
      await api('/api/push/unsubscribe', { method: 'POST' })
      await forgetPushAuth()
      notice = 'Notifications are off.'
      await load()
    })

    const draw = () => {
      const top = scroll.scrollTop
      clear(scroll)
      const me = state.me
      const body = el('div', 'form')

      const nameInput = el('input', 'input')
      nameInput.type = 'text'
      nameInput.value = me ? me.name : ''
      nameInput.placeholder = guessDeviceName()
      const save = button('ghost', 'Save', () => act(async () => {
        state.me = await api('/api/me', { method: 'POST', body: { name: nameInput.value.trim() || guessDeviceName() } })
        notice = 'Name saved.'
      }))
      save.hidden = true
      nameInput.addEventListener('input', () => { save.hidden = !me || nameInput.value.trim() === me.name })
      const nameRow = el('div', 'inline')
      nameRow.appendChild(nameInput)
      nameRow.appendChild(save)
      body.appendChild(field('Name', nameRow))

      const facts = el('div', 'facts')
      facts.appendChild(el('p', 'fact', 'Computer: ' + (me ? me.machineName : state.phone ? state.phone.machineName : 'unknown')))
      facts.appendChild(el('p', 'fact', 'Conductor ' + (me ? me.version : '…')))
      facts.appendChild(el('p', 'fact', state.connected ? 'Live connection is open.' : 'Not connected right now.'))
      body.appendChild(facts)
      body.appendChild(box('inline', [
        button('ghost', 'Connection check', () => visit('#diagnose')),
        button('ghost', 'Certificate', () => visit('#trust'))
      ]))

      const notifications = el('section', 'card')
      notifications.appendChild(el('h2', 'card-title', 'Notifications'))
      const blocker = pushBlocker()
      const row = el('div', 'switch-row')
      row.appendChild(el('span', 'switch-label', 'Push to this phone'))
      const enabled = Boolean(me && me.pushEnabled)
      const toggle = button('switch' + (enabled ? ' on' : ''), null, () => {
        if (working) return
        if (enabled) { void disablePush(); return }
        /* requestPermission has to be the first thing the tap does, or iOS refuses it. */
        let request = null
        try { request = Notification.requestPermission() } catch (error) { request = null }
        if (!request || typeof request.then !== 'function') {
          problem = 'This browser would not ask for notification permission.'
          draw()
          return
        }
        request.then(permission => enablePush(permission)).catch(error => { problem = errorMessage(error); draw() })
      })
      toggle.setAttribute('role', 'switch')
      toggle.setAttribute('aria-checked', enabled ? 'true' : 'false')
      toggle.setAttribute('aria-label', 'Push notifications')
      toggle.appendChild(el('span', 'knob'))
      toggle.disabled = Boolean(blocker) || working
      row.appendChild(toggle)
      notifications.appendChild(row)
      if (blocker) notifications.appendChild(el('p', 'card-note', blocker))
      if (me && !me.notificationsAllowed) notifications.appendChild(el('p', 'card-note warn', 'Notifications are switched off for every phone in the desktop settings, so nothing will arrive until that is turned back on.'))
      if (enabled) {
        notifications.appendChild(button('ghost wide', 'Send test notification', () => act(async () => {
          await api('/api/push/test', { method: 'POST' })
          notice = 'Test sent. It can take a few seconds.'
        })))
      }
      const prefs = (me && me.notificationPrefs) || { taskDone: true, needsYou: true, coworkerDone: false }
      const prefRow = (label, key) => {
        const line = el('div', 'switch-row')
        line.appendChild(el('span', 'switch-label', label))
        const on = Boolean(prefs[key])
        const flip = button('switch' + (on ? ' on' : ''), null, () => act(async () => {
          state.me = await api('/api/notifications', { method: 'POST', body: { prefs: Object.assign({}, prefs, { [key]: !on }) } })
        }))
        flip.setAttribute('role', 'switch')
        flip.setAttribute('aria-checked', on ? 'true' : 'false')
        flip.setAttribute('aria-label', label)
        flip.appendChild(el('span', 'knob'))
        flip.disabled = working
        line.appendChild(flip)
        return line
      }
      notifications.appendChild(prefRow('A controller or main task is done', 'taskDone'))
      notifications.appendChild(prefRow('Something needs you (approval, question, error)', 'needsYou'))
      notifications.appendChild(prefRow('A coworker finishes', 'coworkerDone'))
      body.appendChild(notifications)

      if (notice) body.appendChild(el('p', 'good-note', notice))
      if (problem) body.appendChild(el('p', 'pending-error', problem))

      const unpair = button('danger wide', 'Unpair this phone', () => {
        if (!window.confirm('Unpair this phone? It will need a new code to connect again.')) return
        void act(async () => {
          try { await api('/api/unpair', { method: 'POST' }) } catch (error) { /* leaving anyway */ }
          if ('serviceWorker' in navigator) {
            try {
              const registration = await navigator.serviceWorker.ready
              const subscription = await registration.pushManager.getSubscription()
              if (subscription) await subscription.unsubscribe()
            } catch (error) { /* best effort */ }
          }
          await forgetPushAuth()
          setToken(null)
          state.phone = null
          state.me = null
          stopStream()
          go('#/')
          render()
        })
      })
      body.appendChild(unpair)
      body.appendChild(el('p', 'field-hint', 'Pairing only lets this phone talk to Conductor on ' + (me ? me.machineName : 'that computer') + '. Tasks always run there.'))

      scroll.appendChild(body)
      scroll.scrollTop = top
    }

    draw()
    void load()
    return { key: 'phone', root: root, update: draw }
  }

  // ------------------------------------------------------------------ ideas

  /* docs/ideas.md, contract in src/shared/ideas.ts. Capture asks for nothing but text: #/ideas opens
     with the cursor in an empty note, the idea is created on the first words and autosaved after
     that, and everything else (list, search, the idea's actions) sits on a bar under the note. */

  const IDEA_STATUS_WORDS = { inbox: 'Inbox', untouched: 'Untouched', exploring: 'Exploring', active: 'Active', parked: 'Parked', converted: 'Converted', archived: 'Archived' }
  const IDEA_LINK_GROUPS = [
    { kind: 'agent-session', label: 'Conversations' },
    { kind: 'task', label: 'Tasks' },
    { kind: 'project', label: 'Projects' },
    { kind: 'memory', label: 'Memories' },
    { kind: 'artifact', label: 'Files and links' },
    { kind: 'job', label: 'Jobs' }
  ]
  const IDEA_SAVE_DEBOUNCE_MS = 700
  const IDEA_RETRY_MS = [2000, 5000, 10000, 30000]
  const IDEA_SEARCH_DEBOUNCE_MS = 250
  /* keepalive requests are capped at 64 KB of body by the browser. */
  const IDEA_KEEPALIVE_MAX = 60000
  const IDEA_ICONS = {
    list: TAB_ICONS.ideas,
    new: ['M12 20h8', 'M16.5 3.6a2.1 2.1 0 0 1 3 3L7.5 18.6 3.5 19.5l.9-4Z'],
    search: ['M17.5 10.5a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z', 'M20.5 20.5l-5-5'],
    more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
    close: ['M6 6l12 12', 'M18 6L6 18']
  }

  /* The search text survives a trip into an idea and back. */
  let ideaListQuery = ''
  let ideaListArchived = false

  const ideaTouch = idea => {
    if (idea.exploring) return { word: 'Exploring', tone: 'exploring' }
    if (idea.workedOn) return { word: 'Worked on', tone: 'worked' }
    if (idea.lastExploredAt) return { word: 'Explored', tone: 'explored' }
    return { word: 'Never touched', tone: 'untouched' }
  }

  /* Mirrors inferIdeaTitle: the first non-empty line, without Markdown markers. Runs per keystroke,
     so it reads only that line, never the whole note. */
  const ideaTitle = text => {
    const match = /\S[^\r\n]*/.exec(String(text || ''))
    const line = match ? match[0].trim() : ''
    return line.replace(/^(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, '').trim() || 'New idea'
  }

  /* One request at a time, always carrying the latest text: keystrokes typed while a save is in
     flight are sent by the next one, never dropped. Nothing is created until there are words. */
  const ideaSaver = (initial, onChange, onSaved) => {
    const saver = { id: initial.id || null, saved: initial.text || '', latest: initial.text || '', status: 'idle', problem: '' }
    let timer = null
    let retry = null
    let inflight = false
    let attempt = 0

    const set = (status, problem) => {
      saver.status = status
      saver.problem = problem || ''
      onChange(saver)
    }
    const dirty = () => saver.latest !== saver.saved && (saver.id !== null || Boolean(saver.latest.trim()))

    const flush = async keepalive => {
      if (timer) { clearTimeout(timer); timer = null }
      if (inflight || !dirty()) return
      const text = saver.latest
      /* A note emptied by hand keeps its last words; archiving is how an idea goes away. */
      if (!text.trim()) { set('empty'); return }
      if (retry) { clearTimeout(retry); retry = null }
      inflight = true
      set('saving')
      const options = { method: 'POST', body: { text: text }, keepalive: keepalive && text.length < IDEA_KEEPALIVE_MAX }
      let detail = null
      try {
        detail = saver.id
          ? await api('/api/ideas/' + encodeURIComponent(saver.id), options)
          : await api('/api/ideas', options)
      } catch (error) {
        inflight = false
        const offline = !error || !error.status
        /* A refusal the computer will repeat (a bad request, unpaired) waits for the next edit. */
        const retryable = offline || error.status >= 500 || error.status === 408 || error.status === 429
        set(offline ? 'offline' : retryable ? 'failed' : 'refused', errorMessage(error))
        if (!retryable) return
        const delay = IDEA_RETRY_MS[Math.min(attempt, IDEA_RETRY_MS.length - 1)]
        attempt += 1
        retry = setTimeout(() => { retry = null; void flush(false) }, delay)
        return
      }
      inflight = false
      attempt = 0
      if (!saver.id && detail && detail.id) saver.id = detail.id
      saver.saved = text
      if (detail) onSaved(detail)
      if (dirty()) void flush(false)
      else set('saved')
    }

    saver.type = text => {
      saver.latest = text
      if (timer) { clearTimeout(timer); timer = null }
      if (!dirty()) {
        if (!inflight && saver.status !== 'offline' && saver.status !== 'failed') set(saver.id ? 'saved' : 'idle')
        return
      }
      if (!inflight && saver.status !== 'offline' && saver.status !== 'failed') set('pending')
      timer = setTimeout(() => { timer = null; void flush(false) }, IDEA_SAVE_DEBOUNCE_MS)
    }
    saver.flush = keepalive => flush(Boolean(keepalive))
    return saver
  }

  const ideaStatusWord = saver => {
    if (saver.status === 'pending' || saver.status === 'saving') return 'Saving…'
    if (saver.status === 'saved') return 'Saved'
    if (saver.status === 'offline') return 'Offline — will retry'
    if (saver.status === 'failed') return 'Not saved: ' + (saver.problem || 'the computer did not take it') + ' — will retry'
    if (saver.status === 'refused') return 'Not saved: ' + (saver.problem || 'the computer refused it')
    if (saver.status === 'empty') return 'An empty note is not saved'
    return ''
  }

  const ideaBarButton = (label, glyph, word, onTap) => {
    const node = button('idea-bar-button', null, onTap)
    node.setAttribute('aria-label', label)
    /* Keeps the keyboard up: the tap must not move focus out of the note before it acts. */
    node.addEventListener('mousedown', event => event.preventDefault())
    const mark = el('span', 'idea-bar-icon')
    mark.appendChild(icon(glyph, 22))
    node.appendChild(mark)
    node.appendChild(el('span', 'idea-bar-label', word))
    return node
  }

  const ideaEditorScreen = id => {
    const root = el('div', 'screen idea-screen')
    const header = topbar()
    header.classList.add('idea-topbar')
    const heading = el('h1', 'topbar-title idea-heading', id ? 'Idea' : 'New idea')
    const status = el('span', 'idea-status')
    status.setAttribute('role', 'status')
    const done = button('idea-done', 'Done', () => input.blur())
    done.hidden = true
    header.appendChild(fill(el('div', 'topbar-main'), [heading, status, done]))

    const body = el('div', 'idea-body')
    const input = el('textarea', 'idea-editor')
    input.placeholder = id ? 'Loading…' : 'What’s the idea?'
    input.setAttribute('aria-label', 'Idea')
    input.setAttribute('autocapitalize', 'sentences')
    input.maxLength = 100000
    input.readOnly = Boolean(id)
    body.appendChild(input)

    const sheet = el('div', 'idea-sheet')
    sheet.hidden = true

    const bar = el('nav', 'idea-bar')
    bar.setAttribute('aria-label', 'Idea')
    const more = ideaBarButton('More', IDEA_ICONS.more, 'More', () => void openSheet())
    fill(bar, [
      ideaBarButton('Ideas', IDEA_ICONS.list, 'Ideas', () => { void saver.flush(false); go('#/ideas/list') }),
      ideaBarButton('New idea', IDEA_ICONS.new, 'New', () => {
        if (!saver.id && !input.value.trim()) { input.focus(); return }
        void saver.flush(false)
        goNow('#/ideas')
      }),
      ideaBarButton('Search ideas', IDEA_ICONS.search, 'Search', () => { void saver.flush(false); goNow('#/ideas/search') }),
      more
    ])

    root.appendChild(header)
    root.appendChild(body)
    root.appendChild(bar)
    root.appendChild(sheet)

    let alive = true
    let detail = null
    let loadProblem = ''

    const paint = () => {
      const word = loadProblem || ideaStatusWord(saver)
      status.textContent = word
      status.classList.toggle('warn', Boolean(loadProblem) || ['offline', 'failed', 'refused', 'empty'].indexOf(saver.status) >= 0)
      more.disabled = !saver.id
      heading.textContent = !saver.id ? 'New idea' : input.value.trim() ? ideaTitle(input.value) : 'Idea'
    }

    const self = {
      key: id ? 'idea:' + id : 'idea:new',
      root: root,
      update: () => { if (!sheet.hidden) drawSheet() },
      onShown: () => { if (!id) input.focus() },
      onVisibility: visible => {
        if (!visible) { void saver.flush(true); return }
        if (!saver.id && !input.value.trim() && sheet.hidden) input.focus()
      },
      onPageHide: () => { void saver.flush(true) },
      destroy: () => {
        alive = false
        void saver.flush(false)
      }
    }

    const saver = ideaSaver({ id: id, text: '' }, () => { if (alive) paint() }, saved => {
      detail = saved
      if (!alive) return
      /* The new note gets its own address without a rebuild, which would drop the keyboard. */
      if (self.key === 'idea:new' && saved.id && window.location.hash === '#/ideas' && window.history && window.history.replaceState) {
        window.history.replaceState(null, '', window.location.pathname + window.location.search + '#/ideas/' + encodeURIComponent(saved.id))
        /* render() compares keys, so the screen answers to its new address from now on. */
        self.key = 'idea:' + encodeURIComponent(saved.id)
      }
    })

    input.addEventListener('input', () => {
      saver.type(input.value)
      scrollCaretIntoView(input)
    })
    input.addEventListener('focus', () => {
      done.hidden = false
      root.classList.add('idea-typing')
      scrollCaretIntoView(input)
    })
    input.addEventListener('blur', () => {
      done.hidden = true
      root.classList.remove('idea-typing')
      void saver.flush(false)
    })

    const load = async () => {
      try {
        const found = await api('/api/ideas/' + encodeURIComponent(id))
        if (!alive) return
        detail = found || {}
        const text = typeof detail.text === 'string' ? detail.text : ''
        saver.saved = text
        saver.latest = text
        input.value = text
        input.readOnly = false
        input.placeholder = 'What’s the idea?'
        loadProblem = ''
        saver.status = 'saved'
      } catch (error) {
        if (!alive) return
        loadProblem = errorMessage(error) || 'This idea could not be read.'
        input.placeholder = 'This idea could not be read.'
      }
      paint()
    }

    // ---- the More sheet: the idea's actions, its latest brief, related work and timeline.

    let sheetBusy = false
    let sheetNotice = ''
    let sheetProblem = ''
    let sheetProject = ''

    const closeSheet = () => {
      sheet.hidden = true
      sheetNotice = ''
      sheetProblem = ''
    }

    const reloadDetail = async () => {
      if (!saver.id) return
      try {
        const fresh = await api('/api/ideas/' + encodeURIComponent(saver.id))
        if (fresh) detail = fresh
      } catch (error) {
        const message = errorMessage(error)
        if (message) sheetProblem = message
      }
      if (alive && !sheet.hidden) drawSheet()
    }

    const openSheet = async () => {
      if (!saver.id) return
      input.blur()
      sheet.hidden = false
      drawSheet()
      await saver.flush(false)
      await reloadDetail()
    }

    const act = async work => {
      if (sheetBusy) return
      sheetBusy = true
      sheetNotice = ''
      sheetProblem = ''
      drawSheet()
      try {
        await work()
      } catch (error) {
        sheetProblem = errorMessage(error) || 'That did not work.'
      }
      sheetBusy = false
      if (alive && !sheet.hidden) drawSheet()
    }

    const pickedProject = () => {
      const projects = (state.phone && state.phone.projects) || []
      if (projects.some(project => project.id === sheetProject)) return sheetProject
      const linked = ((detail && detail.links) || []).filter(link => link.kind === 'project' && projects.some(project => project.id === link.targetId))[0]
      reconcileForm()
      sheetProject = linked ? linked.targetId : state.form && state.form.projectId ? state.form.projectId : projects.length ? projects[0].id : ''
      return sheetProject
    }

    const briefCard = section => {
      const card = el('section', 'card idea-brief')
      card.appendChild(el('h2', 'card-title', 'Latest brief'))
      const brief = section.brief
      if (brief) {
        const part = (label, text) => {
          if (!text) return
          card.appendChild(el('span', 'idea-brief-label', label))
          card.appendChild(el('p', 'idea-brief-text', text))
        }
        const list = (label, items) => {
          if (!items || !items.length) return
          card.appendChild(el('span', 'idea-brief-label', label))
          const node = el('ul', 'idea-brief-list')
          for (const item of items) node.appendChild(el('li', null, item))
          card.appendChild(node)
        }
        part('Concept', brief.concept)
        part('Next step', brief.nextStep)
        list('Open questions', brief.openQuestions)
        list('Observations', brief.observations)
      } else {
        const text = el('div', 'idea-brief-text')
        appendRichText(text, section.body || '')
        card.appendChild(text)
      }
      const by = section.createdBy || {}
      card.appendChild(el('p', 'card-note', dotRow([by.label || by.model, by.machine, relativeTime(section.createdAt)])))
      return card
    }

    const linksCard = links => {
      if (!links || !links.length) return null
      const card = el('section', 'card')
      card.appendChild(el('h2', 'card-title', 'Related work'))
      for (const group of IDEA_LINK_GROUPS) {
        const entries = links.filter(link => link.kind === group.kind)
        if (!entries.length) continue
        card.appendChild(el('span', 'idea-brief-label', group.label))
        for (const link of entries) {
          const project = link.projectId ? projectById(link.projectId) : null
          const label = link.label || link.targetId
          if (link.kind === 'agent-session') {
            const row = button('idea-link idea-link-open', null, () => { closeSheet(); go('#/session/' + encodeURIComponent(link.targetId)) })
            row.appendChild(el('span', 'idea-link-label', label))
            if (project) row.appendChild(el('span', 'idea-link-meta', project.name))
            row.appendChild(el('span', 'chev', '›'))
            card.appendChild(row)
          } else {
            const row = el('div', 'idea-link')
            row.appendChild(el('span', 'idea-link-label', label))
            if (project && link.kind !== 'project') row.appendChild(el('span', 'idea-link-meta', project.name))
            card.appendChild(row)
          }
        }
      }
      return card
    }

    const timelineCard = events => {
      if (!events || !events.length) return null
      const card = el('section', 'card')
      card.appendChild(el('h2', 'card-title', 'Timeline'))
      for (const event of events.slice(0, 40)) {
        const row = el('div', 'idea-event')
        row.appendChild(el('span', 'idea-event-text', event.message || event.kind))
        const actor = event.actor && event.actor.label ? event.actor.label : ''
        row.appendChild(el('span', 'idea-event-meta', dotRow([actor, relativeTime(event.at)])))
        card.appendChild(row)
      }
      return card
    }

    const drawSheet = () => {
      clear(sheet)
      const backdrop = el('div', 'idea-sheet-backdrop')
      backdrop.addEventListener('click', closeSheet)
      const panel = el('section', 'idea-sheet-panel')
      panel.setAttribute('role', 'dialog')
      panel.setAttribute('aria-label', 'Idea details')
      const head = el('div', 'idea-sheet-head')
      head.appendChild(el('h2', 'idea-sheet-title', detail && detail.title ? detail.title : ideaTitle(input.value)))
      const close = button('idea-sheet-close', null, closeSheet)
      close.setAttribute('aria-label', 'Close')
      close.appendChild(icon(IDEA_ICONS.close, 20))
      head.appendChild(close)
      panel.appendChild(head)

      const content = el('div', 'idea-sheet-body')
      if (detail) {
        const touch = ideaTouch(detail)
        const facts = el('p', 'idea-facts')
        facts.appendChild(el('span', 'idea-touch ' + touch.tone, touch.word))
        facts.appendChild(el('span', null, ' · ' + dotRow([
          IDEA_STATUS_WORDS[detail.status] || detail.status,
          detail.lastExploredAt && !detail.exploring ? 'explored ' + relativeTime(detail.lastExploredAt) : '',
          detail.capturedFrom ? 'from ' + detail.capturedFrom : '',
          detail.createdAt ? 'created ' + relativeTime(detail.createdAt) : ''
        ])))
        content.appendChild(facts)
      }

      const actions = el('section', 'card idea-actions')
      actions.appendChild(el('h2', 'card-title', 'Actions'))
      const explore = button('ghost wide', detail && detail.exploring ? 'Exploring now…' : 'Explore with local model', () => act(async () => {
        const run = await api('/api/ideas/' + encodeURIComponent(saver.id) + '/explore', { method: 'POST', body: {} })
        sheetNotice = 'Exploring' + (run && run.model ? ' with ' + run.model : '') + ' on the computer. A brief appears here when it finishes.'
        await reloadDetail()
      }))
      explore.disabled = sheetBusy || Boolean(detail && detail.exploring)
      actions.appendChild(explore)

      const projects = (state.phone && state.phone.projects) || []
      if (!state.phone) {
        actions.appendChild(el('p', 'card-note', 'Reading this computer’s projects…'))
      } else if (!projects.length) {
        actions.appendChild(el('p', 'card-note', 'Add a project on the computer to create a task or start work from this idea.'))
      } else {
        const projectId = pickedProject()
        const picker = select(projects.map(project => ({ value: project.id, label: project.name })), projectId, value => { sheetProject = value })
        picker.setAttribute('aria-label', 'Project')
        actions.appendChild(field('Project', picker))
        const row = el('div', 'idea-action-row')
        const task = button('ghost', 'Create task', () => act(async () => {
          const link = await api('/api/ideas/' + encodeURIComponent(saver.id) + '/task', { method: 'POST', body: { projectId: pickedProject() } })
          const project = projectById(pickedProject())
          sheetNotice = 'Task added' + (project ? ' to ' + project.name : '') + (link && link.label ? ': ' + link.label : '.')
          await reloadDetail()
        }))
        const work = button('primary', 'Work on this idea', () => act(async () => {
          const opened = await api('/api/ideas/' + encodeURIComponent(saver.id) + '/work', { method: 'POST', body: { projectId: pickedProject() } })
          if (opened && opened.agentSessionId) {
            closeSheet()
            go('#/session/' + encodeURIComponent(opened.agentSessionId))
            return
          }
          sheetNotice = 'Work started on the computer.'
          await reloadDetail()
        }))
        task.disabled = sheetBusy
        work.disabled = sheetBusy
        row.appendChild(task)
        row.appendChild(work)
        actions.appendChild(row)
      }

      const archived = detail && detail.status === 'archived'
      const archive = button('ghost wide idea-archive', archived ? 'Restore from archive' : 'Archive', () => act(async () => {
        detail = await api('/api/ideas/' + encodeURIComponent(saver.id), { method: 'POST', body: { status: archived ? 'untouched' : 'archived' } }) || detail
        if (archived) { sheetNotice = 'Restored.'; return }
        closeSheet()
        go('#/ideas/list')
      }))
      archive.disabled = sheetBusy
      actions.appendChild(archive)
      if (sheetNotice) actions.appendChild(el('p', 'good-note', sheetNotice))
      if (sheetProblem) actions.appendChild(el('p', 'pending-error', sheetProblem))
      content.appendChild(actions)

      if (!detail) content.appendChild(emptyNote('Loading…'))
      else {
        if (detail.latestBrief) content.appendChild(briefCard(detail.latestBrief))
        const links = linksCard(detail.links)
        if (links) content.appendChild(links)
        const timeline = timelineCard(detail.events)
        if (timeline) content.appendChild(timeline)
      }
      panel.appendChild(content)
      sheet.appendChild(backdrop)
      sheet.appendChild(panel)
    }

    paint()
    if (id) void load()
    return self
  }

  const ideaRow = idea => {
    const node = button('idea-row', null, () => go('#/ideas/' + encodeURIComponent(idea.id)))
    const head = el('div', 'idea-row-head')
    head.appendChild(el('span', 'idea-row-title', idea.title || 'New idea'))
    const when = el('span', 'idea-row-when')
    onTick(() => { when.textContent = relativeTime(idea.updatedAt) })
    head.appendChild(when)
    node.appendChild(head)
    if (idea.preview) node.appendChild(el('p', 'idea-row-preview', idea.preview))
    const touch = ideaTouch(idea)
    const meta = el('div', 'idea-row-meta')
    meta.appendChild(el('span', 'idea-touch ' + touch.tone, touch.word))
    if (idea.status === 'parked' || idea.status === 'converted' || idea.status === 'archived') meta.appendChild(el('span', 'idea-row-status', IDEA_STATUS_WORDS[idea.status]))
    node.appendChild(meta)
    return node
  }

  const ideasListScreen = route => {
    const root = el('div', 'screen')
    const header = topbar()
    const scroll = scroller()
    root.appendChild(header)
    root.appendChild(scroll)

    const add = button('idea-new', null, () => goNow('#/ideas'))
    add.setAttribute('aria-label', 'New idea')
    add.appendChild(icon(IDEA_ICONS.new, 22))
    header.appendChild(fill(el('div', 'topbar-main'), [el('h1', 'topbar-title idea-list-title', 'Ideas'), add]))

    const search = el('input', 'input idea-search')
    search.type = 'search'
    search.placeholder = 'Search ideas'
    search.setAttribute('aria-label', 'Search ideas')
    search.setAttribute('enterkeyhint', 'search')
    search.value = ideaListQuery
    header.appendChild(search)

    const chips = el('div', 'chips')
    const chip = (label, archived) => {
      const node = button('chip' + (ideaListArchived === archived ? ' selected' : ''), label, () => {
        if (ideaListArchived === archived) return
        ideaListArchived = archived
        for (const other of chips.querySelectorAll('.chip')) other.classList.toggle('selected', other === node)
        void load()
      })
      return node
    }
    chips.appendChild(chip('Open', false))
    chips.appendChild(chip('Archived', true))
    header.appendChild(chips)

    let ideas = null
    let problem = ''
    let run = 0
    let searchTimer = null
    let searching = Boolean(route && route.search)

    const draw = () => {
      const top = scroll.scrollTop
      beginTicks()
      clear(scroll)
      if (problem && !ideas) {
        scroll.appendChild(emptyNote('Could not read the ideas.', problem))
        return
      }
      if (!ideas) {
        scroll.appendChild(emptyNote('Loading…'))
        return
      }
      if (!ideas.length) {
        if (ideaListQuery.trim()) scroll.appendChild(emptyNote('Nothing matches “' + ideaListQuery.trim() + '”.'))
        else if (ideaListArchived) scroll.appendChild(emptyNote('No archived ideas.'))
        else scroll.appendChild(emptyNote('No ideas yet.', 'Tap the pencil and type. It saves as you go.'))
      } else {
        const list = el('div', 'list idea-rows')
        for (const idea of ideas) list.appendChild(ideaRow(idea))
        scroll.appendChild(list)
      }
      if (problem) scroll.appendChild(el('p', 'pending-error', problem))
      scroll.scrollTop = top
    }

    const load = async () => {
      const mine = ++run
      const query = '/api/ideas?search=' + encodeURIComponent(ideaListQuery.trim()) + (ideaListArchived ? '&status=archived' : '')
      try {
        const data = await api(query)
        if (mine !== run) return
        ideas = (data && data.ideas) || []
        problem = ''
      } catch (error) {
        if (mine !== run) return
        const message = errorMessage(error)
        if (message) problem = message
      }
      if (screen && screen.key === 'ideas') draw()
    }

    search.addEventListener('input', () => {
      ideaListQuery = search.value
      if (searchTimer) clearTimeout(searchTimer)
      searchTimer = setTimeout(() => { searchTimer = null; void load() }, IDEA_SEARCH_DEBOUNCE_MS)
    })
    search.addEventListener('focus', () => scrollCaretIntoView(search))
    search.addEventListener('keydown', event => { if (event.key === 'Enter') search.blur() })

    draw()
    void load()
    return {
      key: 'ideas',
      root: root,
      onShown: () => { if (searching) search.focus() },
      update: next => {
        /* Every stream tick lands here; only a move from the list to #/ideas/search focuses. */
        const wantsSearch = Boolean(next && next.search)
        if (wantsSearch && !searching) search.focus()
        searching = wantsSearch
      },
      onVisibility: visible => { if (visible) void load() },
      destroy: () => { if (searchTimer) clearTimeout(searchTimer) }
    }
  }

  // ------------------------------------------------------------------ lock

  /* The 6-digit lock (docs/phone-lock-and-terminal.md). The computer enforces it: while locked it
     answers nothing but /api/lock/*, so this screen is the only thing a locked phone can show. The
     unlock token lives in memory only, so a reload, a crash or iOS dropping the app all lock. */

  /* Reads whether this phone has to unlock. A failure to ask is not "unlocked": the app simply
     carries on, and the first real call answers 423 if the lock is on. */
  const checkLock = async () => {
    if (!state.token) return
    try {
      const status = await api('/api/lock/state')
      applyLockStatus(status)
    } catch (error) {
      /* Offline, most likely: the stream retries on its own, and a locked phone's stream is
         answered 423, which asks again. */
      if (!state.locked) connectStream()
    }
  }

  const applyLockStatus = status => {
    state.lock = status && typeof status === 'object' ? status : null
    const mustUnlock = Boolean(state.lock && state.lock.configured && !state.lock.unlocked)
    if (mustUnlock) { markLocked(); return }
    if (state.locked) { state.locked = false; render() }
    if (!streamController && !streamTimer) connectStream()
  }

  /* Everything read while unlocked goes, and every live connection closes with it. */
  const markLocked = () => {
    const wasLocked = state.locked
    state.locked = true
    state.unlockToken = null
    state.phone = null
    state.conversation = null
    state.metrics = null
    stopStream()
    if (!wasLocked || !screen || screen.key !== 'lock') render()
  }

  /* The owner is using the phone: the computer's idle clock starts over, at most every 20 s. */
  let lastTouchSent = 0
  let lastActivityAt = Date.now()
  let hiddenAt = 0
  const noteActivity = () => {
    lastActivityAt = Date.now()
    if (!state.unlockToken || state.locked) return
    if (Date.now() - lastTouchSent < LOCK_TOUCH_MS) return
    lastTouchSent = Date.now()
    api('/api/lock/touch', { method: 'POST', body: {} }).catch(() => { /* a 423 already locked the app */ })
  }

  /* Locks now, telling the computer so the session ends there too. */
  const lockNow = () => {
    if (!state.unlockToken) { if (state.lock && state.lock.configured) markLocked(); return }
    const headers = { Authorization: 'Bearer ' + state.token, 'Content-Type': 'application/json' }
    headers[UNLOCK_HEADER] = state.unlockToken
    fetch('/api/lock/lock', { method: 'POST', headers: headers, body: '{}', cache: 'no-store', keepalive: true }).catch(() => undefined)
    markLocked()
  }

  const lockTick = () => {
    if (!state.unlockToken || state.locked) return
    const idle = state.lock && state.lock.idleMs ? state.lock.idleMs : 300000
    if (Date.now() - lastActivityAt > idle) lockNow()
  }

  const lockVisibility = visible => {
    if (!state.lock || !state.lock.configured) return
    if (!visible) { hiddenAt = Date.now(); return }
    const away = hiddenAt ? Date.now() - hiddenAt : 0
    hiddenAt = 0
    const limit = state.lock.backgroundMs || 60000
    if (state.unlockToken && away > limit) lockNow()
  }

  const lockScreen = () => {
    const root = el('div', 'screen lock-screen')
    const body = el('div', 'lock-body')
    root.appendChild(body)
    const title = el('h1', 'lock-title', 'Conductor is locked')
    const hint = el('p', 'lock-hint', 'Enter your 6-digit code.')
    const dots = el('div', 'lock-dots')
    dots.setAttribute('aria-hidden', 'true')
    const message = el('p', 'lock-message')
    message.setAttribute('role', 'status')
    const pad = el('div', 'lock-pad')
    let digits = ''
    let busy = false
    let waitUntil = 0

    const drawDots = () => {
      clear(dots)
      for (let index = 0; index < 6; index += 1) dots.appendChild(el('span', 'lock-dot' + (index < digits.length ? ' filled' : '')))
    }

    const say = (text, tone) => {
      message.textContent = text || ''
      message.className = 'lock-message' + (tone ? ' ' + tone : '')
    }

    const describe = status => {
      if (!status) return
      if (status.lockedOut) { say('Too many wrong codes. Reset the lock in Conductor on the computer (Settings > Phone).', 'danger'); return }
      const retry = parseTime(status.retryAt)
      if (retry && retry > Date.now()) { waitUntil = retry; return }
      if (status.configured === false) say('No code is set on the computer any more.', '')
    }

    const submit = async () => {
      if (busy || digits.length !== 6) return
      if (waitUntil > Date.now()) return
      busy = true
      say('Checking…', '')
      const code = digits
      try {
        const opened = await api('/api/lock/unlock', { method: 'POST', body: { code: code } })
        state.unlockToken = opened.unlockToken
        state.lock = Object.assign({}, state.lock || {}, { configured: true, unlocked: true, idleMs: opened.idleMs, backgroundMs: opened.backgroundMs, lockedOut: false, failures: 0, retryAt: null })
        state.locked = false
        lastActivityAt = Date.now()
        lastTouchSent = Date.now()
        digits = ''
        busy = false
        restartStream()
        render()
        return
      } catch (error) {
        digits = ''
        drawDots()
        busy = false
        const text = errorMessage(error)
        if (error && error.detail) {
          if (error.detail.lockedOut) { say(text, 'danger'); return }
          const retry = parseTime(error.detail.retryAt)
          if (retry && retry > Date.now()) waitUntil = retry
          if (typeof error.detail.remaining === 'number') { say(text + ' ' + error.detail.remaining + (error.detail.remaining === 1 ? ' try' : ' tries') + ' left before the lock needs the computer.', 'danger'); return }
        }
        say(text, 'danger')
      }
    }

    const press = key => {
      if (busy) return
      if (key === 'back') digits = digits.slice(0, -1)
      else if (digits.length < 6) digits += key
      drawDots()
      if (digits.length === 6) void submit()
    }

    for (const key of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'back']) {
      if (!key) { pad.appendChild(el('span', 'lock-key-gap')); continue }
      const node = button('lock-key', key === 'back' ? null : key, () => press(key))
      if (key === 'back') {
        node.setAttribute('aria-label', 'Delete')
        node.appendChild(icon(['M9 6h11v12H9l-5-6 5-6Z', 'M13 10l4 4', 'M17 10l-4 4'], 22))
      }
      pad.appendChild(node)
    }

    fill(body, [title, hint, dots, message, pad, button('ghost lock-help', 'Connection check', () => visit('#diagnose'))])
    drawDots()
    describe(state.lock)
    const onKey = event => {
      if (/^[0-9]$/.test(event.key || '')) press(event.key)
      else if (event.key === 'Backspace') press('back')
    }
    document.addEventListener('keydown', onKey)
    return {
      key: 'lock',
      root: root,
      onSecond: () => {
        if (waitUntil > Date.now()) say('Wait ' + Math.ceil((waitUntil - Date.now()) / 1000) + ' s before trying again.', '')
        else if (waitUntil) { waitUntil = 0; say('', '') }
      },
      destroy: () => document.removeEventListener('keydown', onKey)
    }
  }

  // ------------------------------------------------------------------ terminal

  /* A shell on the computer, over this phone's authenticated connection. xterm.js is loaded only
     when this screen opens; output arrives as server-sent events and keystrokes go up in small
     batched POSTs. The shell dies when the phone locks, after 10 minutes without typing, or on
     Close, and the computer writes one audit line for it. */

  const loadScript = src => new Promise((resolve, reject) => {
    if (document.querySelector && document.querySelector('script[src="' + src + '"]')) { resolve(); return }
    const node = document.createElement('script')
    node.src = src
    node.onload = () => resolve()
    node.onerror = () => reject(new Error('Could not load ' + src))
    document.body.appendChild(node)
  })

  const loadStyle = href => {
    if (document.querySelector && document.querySelector('link[href="' + href + '"]')) return
    const node = document.createElement('link')
    node.rel = 'stylesheet'
    node.href = href
    document.head.appendChild(node)
  }

  const loadXterm = async () => {
    loadStyle('/xterm.css')
    if (!window.Terminal) await loadScript('/xterm.js')
    if (!window.FitAddon) await loadScript('/xterm-fit.js')
  }

  const bytesToBase64 = bytes => {
    let text = ''
    for (let index = 0; index < bytes.length; index += 1) text += String.fromCharCode(bytes[index])
    return window.btoa(text)
  }

  const TERMINAL_KEYS = [
    { id: 'ctrl', label: 'Ctrl' },
    { id: 'esc', label: 'Esc', send: '\x1b' },
    { id: 'tab', label: 'Tab', send: '\t' },
    { id: 'left', label: '←', send: '\x1b[D' },
    { id: 'up', label: '↑', send: '\x1b[A' },
    { id: 'down', label: '↓', send: '\x1b[B' },
    { id: 'right', label: '→', send: '\x1b[C' },
    { id: 'paste', label: 'Paste' },
    { id: 'copy', label: 'Copy' }
  ]

  const terminalScreen = () => {
    const root = el('div', 'screen terminal-screen')
    const header = pageHeader('Terminal')
    const title = header.querySelector ? header.querySelector('.topbar-title') : null
    const closeButton = button('ghost terminal-close', 'Close', () => { void closeShell() })
    closeButton.hidden = true
    header.firstChild.appendChild(closeButton)
    const body = el('div', 'terminal-body')
    root.appendChild(header)
    root.appendChild(body)

    let term = null
    let fit = null
    let terminalId = null
    let offset = null
    let controller = null
    let pending = []
    let flushTimer = null
    let sending = false
    let ctrlArmed = false
    let resizeTimer = null
    let observer = null
    let ended = false
    let destroyed = false

    const machine = () => (state.phone && state.phone.machineName) || 'this computer'
    if (title) title.textContent = 'Terminal · ' + machine()

    const localProjects = () => ((state.phone && state.phone.projects) || []).filter(project => project.machineId === 'local' && project.workspaces && project.workspaces.length)

    /* ---- setup: pick a folder, type the code again */
    const drawSetup = (problem, existing) => {
      closeButton.hidden = true
      clear(body)
      const scroll = scroller()
      body.appendChild(scroll)
      const card = el('section', 'card terminal-setup')
      card.appendChild(el('h2', 'card-title', 'Open a shell on ' + machine()))
      card.appendChild(el('p', 'card-note', 'It runs as you on the computer. It closes when this phone locks, after 10 minutes without typing, or when you close it. The computer logs when it opened and closed, never what you typed.'))
      const projects = localProjects()
      if (!projects.length) {
        card.appendChild(el('p', 'card-note', 'No project on this computer to start in yet.'))
        scroll.appendChild(card)
        return
      }
      let projectId = state.terminalProject && projects.some(project => project.id === state.terminalProject) ? state.terminalProject : projects[0].id
      const workspacesOf = id => (projects.find(project => project.id === id) || projects[0]).workspaces
      let workspaceId = workspacesOf(projectId)[0].id
      const workspaceSelect = select(workspacesOf(projectId).map(workspace => ({ value: workspace.id, label: workspace.name })), workspaceId, value => { workspaceId = value })
      const projectSelect = select(projects.map(project => ({ value: project.id, label: project.name })), projectId, value => {
        projectId = value
        state.terminalProject = value
        const next = workspacesOf(projectId)
        workspaceId = next[0].id
        clear(workspaceSelect)
        for (const workspace of next) { const option = el('option', null, workspace.name); option.value = workspace.id; workspaceSelect.appendChild(option) }
        workspaceSelect.value = workspaceId
      })
      const code = el('input', 'input terminal-code')
      code.type = 'password'
      code.setAttribute('inputmode', 'numeric')
      code.setAttribute('autocomplete', 'off')
      code.setAttribute('maxlength', '6')
      code.setAttribute('aria-label', 'Your 6-digit code')
      const open = button('primary wide', 'Open terminal', () => { void start() })
      const start = async () => {
        const typed = String(code.value || '').replace(/\D/g, '')
        if (typed.length !== 6) { drawSetup('Type your 6-digit code again to open a shell.'); return }
        open.disabled = true
        try {
          const size = estimateSize()
          const opened = await api('/api/terminal/open', { method: 'POST', body: { code: typed, machineId: 'local', projectId: projectId, workspaceId: workspaceId, cols: size.cols, rows: size.rows } })
          await attachShell(opened.terminalId, null)
        } catch (error) {
          open.disabled = false
          const text = errorMessage(error)
          const left = error && error.detail && typeof error.detail.remaining === 'number' ? ' ' + error.detail.remaining + ' tries left.' : ''
          if (text) drawSetup(text + left)
        }
      }
      fill(card, [
        problem ? errorLine(problem, () => drawSetup('')) : null,
        field('Project', projectSelect),
        field('Workspace', workspaceSelect, 'The shell starts in the project folder.'),
        field('Code', code, 'Your 6-digit code, again, for every new shell.'),
        open
      ])
      scroll.appendChild(card)
      for (const shell of existing || []) {
        const row = el('section', 'card')
        row.appendChild(el('h2', 'card-title', shell.title))
        row.appendChild(el('p', 'card-note', shell.cwd + ' · since ' + clockTime(shell.startedAt)))
        row.appendChild(button('ghost wide', 'Back to this shell', () => { void attachShell(shell.terminalId, null) }))
        scroll.appendChild(row)
      }
    }

    const estimateSize = () => {
      const width = (body.clientWidth || window.innerWidth || 360) - 8
      const height = (body.clientHeight || window.innerHeight || 640) - 110
      return { cols: Math.max(20, Math.min(200, Math.floor(width / 7.3))), rows: Math.max(8, Math.min(100, Math.floor(height / 17))) }
    }

    /* ---- input: coalesced so a paste or a fast thumb is one request, in order */
    const send = text => {
      if (!terminalId || ended || !text) return
      noteActivity()
      pending.push(text)
      if (!flushTimer) flushTimer = setTimeout(flush, 12)
    }

    const flush = async () => {
      flushTimer = null
      if (sending || !pending.length || !terminalId) return
      sending = true
      const text = pending.join('')
      pending = []
      try {
        const bytes = new TextEncoder().encode(text)
        for (let start = 0; start < bytes.length; start += 48 * 1024) {
          await api('/api/terminal/' + encodeURIComponent(terminalId) + '/input', { method: 'POST', body: { data: bytesToBase64(bytes.subarray(start, start + 48 * 1024)) } })
        }
      } catch (error) {
        const message = errorMessage(error)
        if (message && term) term.write('\r\n\x1b[31m' + message + '\x1b[0m\r\n')
      }
      sending = false
      if (pending.length) flush()
    }

    const withCtrl = data => {
      if (!ctrlArmed || data.length !== 1) return data
      ctrlArmed = false
      drawKeys()
      const code = data.toUpperCase().charCodeAt(0)
      if (code >= 64 && code <= 95) return String.fromCharCode(code - 64)
      if (data === ' ') return '\x00'
      return data
    }

    /* ---- key row */
    const keys = el('div', 'terminal-keys')
    const drawKeys = () => {
      for (const node of keys.childNodes) node.classList.toggle('armed', node.dataset.key === 'ctrl' && ctrlArmed)
    }
    for (const key of TERMINAL_KEYS) {
      const node = button('terminal-key', key.label, () => {
        if (key.id === 'ctrl') { ctrlArmed = !ctrlArmed; drawKeys() }
        else if (key.id === 'paste') void paste()
        else if (key.id === 'copy') void copy()
        else send(key.send)
        if (term && key.id !== 'copy') term.focus()
      })
      node.dataset.key = key.id
      /* Keeps the on-screen keyboard up: a button that takes focus would drop it. */
      node.addEventListener('mousedown', event => { if (event.preventDefault) event.preventDefault() })
      keys.appendChild(node)
    }

    const paste = async () => {
      let text = ''
      try { text = navigator.clipboard && navigator.clipboard.readText ? await navigator.clipboard.readText() : '' } catch (error) { text = '' }
      if (!text && window.prompt) text = window.prompt('Paste here') || ''
      if (text) send(text.replace(/\r?\n/g, '\r'))
    }

    const copy = async () => {
      if (!term) return
      let text = term.getSelection()
      if (!text) {
        const buffer = term.buffer.active
        const lines = []
        for (let row = Math.max(0, buffer.baseY + buffer.cursorY - term.rows + 1); row <= buffer.baseY + buffer.cursorY; row += 1) {
          const line = buffer.getLine(row)
          if (line) lines.push(line.translateToString(true))
        }
        text = lines.join('\n').replace(/\s+$/, '')
      }
      try {
        await navigator.clipboard.writeText(text)
        showToast({ kind: 'done', title: 'Copied', body: text.length + ' characters' })
      } catch (error) {
        showToast({ kind: 'failed', title: 'Could not copy', body: 'Select the text with a long press instead.' })
      }
    }

    /* ---- output */
    const connect = () => {
      if (!terminalId || ended || destroyed) return
      const id = terminalId
      const local = new AbortController()
      controller = local
      const headers = { Authorization: 'Bearer ' + state.token, Accept: 'text/event-stream' }
      if (state.unlockToken) headers[UNLOCK_HEADER] = state.unlockToken
      const query = offset === null ? '' : '?from=' + offset
      fetch('/api/terminal/' + encodeURIComponent(id) + '/stream' + query, { headers: headers, cache: 'no-store', signal: local.signal })
        .then(async response => {
          if (response.status === 423) { markLocked(); return }
          if (response.status === 404) { finish('The shell is gone.'); return }
          if (!response.ok || !response.body) throw new Error('The computer refused the terminal (' + response.status + ').')
          await readStream(response.body, onTerminalEvent)
        })
        .catch(error => { if (!error || error.name !== 'AbortError') { /* retried below */ } })
        .then(() => {
          if (controller !== local) return
          controller = null
          if (!ended && !destroyed && state.unlockToken) setTimeout(connect, 1500)
        })
    }

    const onTerminalEvent = (name, data) => {
      if (!term || !data) return
      if (name === 'data') {
        const bytes = base64ToBytes(data.data || '')
        term.write(bytes)
        offset = (data.offset || 0) + bytes.length
      } else if (name === 'gap') {
        term.write('\r\n\x1b[33m[' + data.lostBytes + ' bytes of output were dropped]\x1b[0m\r\n')
      } else if (name === 'exit') {
        finish('The shell exited' + (data.exitCode === null || data.exitCode === undefined ? '.' : ' with ' + data.exitCode + '.'))
      } else if (name === 'closed') {
        finish('The shell closed: ' + (data.reason || 'closed') + '.')
      } else if (name === 'locked') {
        markLocked()
      }
    }

    const finish = reason => {
      if (ended) return
      ended = true
      if (controller) { const current = controller; controller = null; current.abort() }
      if (term) term.write('\r\n\x1b[90m' + reason + '\x1b[0m\r\n')
      closeButton.textContent = 'New'
      closeButton.hidden = false
    }

    const sendSize = () => {
      if (!fit || !term || !terminalId || ended) return
      try { fit.fit() } catch (error) { return }
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        resizeTimer = null
        api('/api/terminal/' + encodeURIComponent(terminalId) + '/resize', { method: 'POST', body: { cols: term.cols, rows: term.rows } }).catch(() => undefined)
      }, 150)
    }

    const attachShell = async (id, from) => {
      try { await loadXterm() } catch (error) { drawSetup('The terminal could not load: ' + errorMessage(error)); return }
      if (destroyed) return
      teardown()
      terminalId = id
      offset = from
      ended = false
      clear(body)
      const host = el('div', 'terminal-host')
      body.appendChild(host)
      body.appendChild(keys)
      closeButton.textContent = 'Close'
      closeButton.hidden = false
      term = new window.Terminal({ fontSize: 13, scrollback: 5000, cursorBlink: true, convertEol: false, fontFamily: 'ui-monospace, Menlo, Consolas, monospace', theme: { background: '#090b0e', foreground: '#e7e9ec', cursor: '#d6ff73' } })
      fit = new window.FitAddon.FitAddon()
      term.loadAddon(fit)
      term.open(host)
      term.onData(data => send(withCtrl(data)))
      sendSize()
      if (window.ResizeObserver) { observer = new window.ResizeObserver(() => sendSize()); observer.observe(host) }
      connect()
      term.focus()
    }

    const teardown = () => {
      if (controller) { const current = controller; controller = null; current.abort() }
      if (observer) { observer.disconnect(); observer = null }
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
      if (resizeTimer) { clearTimeout(resizeTimer); resizeTimer = null }
      pending = []
      if (term) { try { term.dispose() } catch (error) { /* already gone */ } }
      term = null
      fit = null
    }

    const closeShell = async () => {
      const id = terminalId
      if (id && !ended) {
        try { await api('/api/terminal/' + encodeURIComponent(id) + '/close', { method: 'POST', body: {} }) } catch (error) { /* ended anyway */ }
      }
      teardown()
      terminalId = null
      ended = false
      void loadExisting()
    }

    const loadExisting = async () => {
      let existing = []
      try { existing = await api('/api/terminal') } catch (error) {
        const message = errorMessage(error)
        drawSetup(message)
        return
      }
      if (!destroyed && !terminalId) drawSetup('', existing)
    }

    void loadExisting()
    return {
      key: 'terminal',
      root: root,
      onVisibility: visible => { if (visible && terminalId && !ended && !controller) connect() },
      destroy: () => { destroyed = true; teardown() }
    }
  }

  // ------------------------------------------------------------------ boot

  const registerServiceWorker = () => {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => { /* http, or no trust yet */ })
    navigator.serviceWorker.addEventListener('message', event => {
      const data = event.data
      if (!data || data.type !== 'navigate' || !data.url) return
      openUrl(data.url)
    })
  }

  /* The QR code on the desktop encodes the address plus #pair=CODE, so scanning it both opens
     the app and fills the code in. The fragment is dropped straight away: it is a secret. */
  const takePairHash = () => {
    const match = /^#pair=(.+)$/.exec(window.location.hash || '')
    if (!match) return
    state.pairCode = formatCode(decodeURIComponent(match[1]))
    const clean = window.location.pathname + window.location.search + '#/'
    if (window.history && window.history.replaceState) window.history.replaceState(null, '', clean)
    else window.location.hash = '#/'
  }

  const applyViewport = () => {
    /* iOS shrinks the visual viewport for the keyboard but not the layout viewport, which would
       hide a bottom-pinned composer behind it. Safari also scrolls the layout viewport to bring a
       focused field into view, which drags a position:fixed shell along with it unless the shell
       is pulled back by exactly that offset. */
    const viewport = window.visualViewport
    const height = viewport ? viewport.height : window.innerHeight
    const offset = viewport ? viewport.offsetTop : 0
    document.documentElement.style.setProperty('--app-height', Math.round(height) + 'px')
    document.documentElement.style.setProperty('--app-offset', Math.round(offset) + 'px')
    if (window.scrollTo) window.scrollTo(0, 0)
  }

  /* Once the keyboard has finished opening and the fixed shell has been pulled back into place,
     make sure the caret itself is not left under the keyboard, e.g. after growing a multi-line
     draft or focusing lower on the page. */
  const scrollCaretIntoView = field => {
    if (!field || typeof field.scrollIntoView !== 'function') return
    setTimeout(() => field.scrollIntoView({ block: 'end', inline: 'nearest' }), 60)
  }

  const boot = () => {
    appRoot = document.getElementById('app')
    overlayPill = document.getElementById('pill')
    toastHost = document.getElementById('toasts')
    tabBar = buildTabBar()
    state.token = readStored(TOKEN_KEY)
    const savedFilter = readStored(FILTER_KEY)
    if (savedFilter && FILTERS.some(entry => entry.id === savedFilter)) state.filter = savedFilter
    takePairHash()
    applyViewport()

    /* Chrome on Android offers installation once it decides the app qualifies; keep the event so
       a tab that has just paired can offer it, instead of Chrome's own banner at a random time. */
    window.addEventListener('beforeinstallprompt', event => {
      event.preventDefault()
      state.installPrompt = event
      if (state.offerInstall) render()
    })
    window.addEventListener('appinstalled', () => {
      state.installPrompt = null
      state.offerInstall = false
    })
    window.addEventListener('hashchange', () => render())
    /* The last chance to save a half-written idea when the page is closed or swapped out. */
    window.addEventListener('pagehide', () => { if (screen && screen.onPageHide) screen.onPageHide() })
    window.addEventListener('online', () => { if (state.token) restartStream() })
    window.addEventListener('resize', applyViewport)
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', applyViewport)
      window.visualViewport.addEventListener('scroll', applyViewport)
    }
    /* Any touch, key or scroll is the owner using the phone, which keeps an unlocked session open. */
    for (const type of ['pointerdown', 'keydown', 'input', 'touchstart']) document.addEventListener(type, noteActivity, { passive: true })
    document.addEventListener('visibilitychange', () => {
      const visible = document.visibilityState === 'visible'
      lockVisibility(visible)
      if (screen && screen.onVisibility) screen.onVisibility(visible)
      if (visible) visibleSince = Date.now()
      if (!visible || !state.token) return
      /* A phone that was asleep often keeps a stream object that is already dead, so a quiet
         connection counts as no connection the moment the owner looks at the screen again. */
      if (!state.connected || Date.now() - lastEventAt > 20000) restartStream()
    })
    setInterval(() => {
      for (const fn of tickers) {
        try { fn() } catch (error) { /* a dead node is not worth a crash */ }
      }
      if (screen && screen.onSecond) screen.onSecond()
      lockTick()
      /* A stream that has gone quiet is a stream the phone slept through. */
      if (state.connected && document.visibilityState === 'visible' && Date.now() - lastEventAt > STREAM_STALE_MS) restartStream()
    }, 1000)

    registerServiceWorker()
    render()
    /* The stream waits for the lock answer: a locked phone must not even ask for the state. */
    if (state.token) void checkLock()
    /* The boot guard's watchdog waits for this; its placeholder is already gone with the first render. */
    window.__conductorBooted = true
    shell.booted()
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
