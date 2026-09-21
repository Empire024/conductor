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

  const PROVIDER_WORDS = {
    codex: 'Codex',
    claude: 'Claude',
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
    /* In-progress answers per pending interaction id, same reason as drafts. */
    answers: {},
    form: null
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

  function ApiError (message, status) {
    const error = new Error(message)
    error.name = 'ApiError'
    error.status = status
    return error
  }

  const api = async (path, options) => {
    const settings = options || {}
    const headers = {}
    if (state.token) headers.Authorization = 'Bearer ' + state.token
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
      signal: settings.signal
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
      throw ApiError(message, response.status)
    }
    return data
  }

  /* One place decides what "no longer paired" means, because both the API and the stream can
     discover it: drop everything that was read with that token and go back to the code screen. */
  const handleUnauthorized = () => {
    if (!state.token) return
    setToken(null)
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

  const setConnected = value => {
    if (state.connected === value) return
    state.connected = value
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
    if (!state.token || streamTimer || streamController) return
    const delay = BACKOFF_MS[Math.min(streamAttempt, BACKOFF_MS.length - 1)]
    streamAttempt += 1
    streamTimer = setTimeout(() => { streamTimer = null; connectStream() }, delay)
  }

  /* SSE without EventSource: EventSource cannot carry an Authorization header, so the frames are
     read off a fetch body and parsed here. Lines are cut on \n with a trailing \r stripped, which
     keeps a \r\n that straddles two chunks from looking like a blank line - a false frame end. */
  const readStream = async body => {
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
      lastEventAt = Date.now()
      onStreamEvent(name, data)
    }

    const handleLine = line => {
      if (line === '') { dispatch(); return }
      if (line.charAt(0) === ':') { lastEventAt = Date.now(); return }
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
    if (!state.token || streamController) return
    if (streamTimer) { clearTimeout(streamTimer); streamTimer = null }
    const controller = new AbortController()
    streamController = controller
    lastEventAt = Date.now()
    fetch('/api/stream', {
      headers: { Authorization: 'Bearer ' + state.token, Accept: 'text/event-stream' },
      cache: 'no-store',
      signal: controller.signal
    }).then(async response => {
      if (response.status === 401) { handleUnauthorized(); return }
      if (!response.ok || !response.body) throw new Error('Stream refused (' + response.status + ')')
      streamAttempt = 0
      setConnected(true)
      await readStream(response.body)
    }).catch(() => { /* every failure is the same failure: try again, slower */ })
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
    if (hash.indexOf('#/new') === 0) return { name: 'new', key: 'new' }
    if (hash.indexOf('#/system') === 0) return { name: 'system', key: 'system' }
    if (hash.indexOf('#/phone') === 0) return { name: 'phone', key: 'phone' }
    return { name: 'sessions', key: 'sessions' }
  }

  const go = hash => {
    if (window.location.hash === hash) render()
    else window.location.hash = hash
  }

  const beginTicks = () => { tickers = [] }
  const onTick = fn => { tickers.push(fn); fn() }

  const render = () => {
    const route = state.token ? currentRoute() : { name: 'pair', key: 'pair' }
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
    if (overlayPill) overlayPill.hidden = state.connected || !state.token
  }

  const buildScreen = route => {
    if (route.name === 'pair') return pairScreen()
    if (route.name === 'session') return conversationScreen(route.id)
    if (route.name === 'new') return newTaskScreen()
    if (route.name === 'system') return systemScreen()
    if (route.name === 'phone') return phoneScreen()
    return sessionsScreen()
  }

  // ------------------------------------------------------------------ shell chrome

  const TAB_ICONS = {
    sessions: ['M4 7h16', 'M4 12h16', 'M4 17h11'],
    new: ['M12 5v14', 'M5 12h14'],
    system: ['M3 13h3.5l2.5-6 3.5 12 2.5-6H21'],
    phone: ['M8.5 2.75h7a1.75 1.75 0 0 1 1.75 1.75v15a1.75 1.75 0 0 1-1.75 1.75h-7A1.75 1.75 0 0 1 6.75 19.5v-15A1.75 1.75 0 0 1 8.5 2.75Z', 'M11 18.5h2']
  }

  const buildTabBar = () => {
    const bar = el('nav', 'tabbar')
    bar.setAttribute('aria-label', 'Sections')
    const tabs = [
      { id: 'sessions', label: 'Sessions', hash: '#/' },
      { id: 'new', label: 'New', hash: '#/new' },
      { id: 'system', label: 'System', hash: '#/system' },
      { id: 'phone', label: 'Phone', hash: '#/phone' }
    ]
    for (const tab of tabs) {
      const node = button('tab', null, () => go(tab.hash))
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
    const hidden = route.name === 'pair' || route.name === 'session'
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

  const pairScreen = () => {
    const root = el('div', 'screen')
    const scroll = scroller()
    scroll.classList.add('centered')
    const card = el('form', 'pair-card')

    const mark = el('div', 'pair-mark')
    mark.appendChild(icon(['M16.5 7.5A7.5 7.5 0 1 0 16.5 16.5'], 38))
    card.appendChild(mark)
    card.appendChild(el('h1', 'pair-title', 'Conductor'))
    card.appendChild(el('p', 'pair-lead', 'This phone will watch and steer the agents running on this computer. Enter the code the desktop is showing.'))

    const nameInput = el('input', 'input')
    nameInput.type = 'text'
    nameInput.value = guessDeviceName()
    nameInput.autocomplete = 'off'
    card.appendChild(field('Name this phone', nameInput))

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
    card.appendChild(field('Pairing code', codeInput))

    const problem = el('p', 'pair-error')
    problem.hidden = true
    card.appendChild(problem)

    const submit = button('primary', 'Pair', null)
    submit.type = 'submit'
    card.appendChild(submit)

    /* Push needs both a service worker and a secure context; a self-signed certificate that was
       never trusted gives neither, and the owner deserves to know that before they wonder. */
    if (!window.isSecureContext || !('serviceWorker' in navigator)) {
      card.appendChild(el('p', 'pair-note', 'This connection is not trusted by the phone yet, so notifications will not work until the Conductor certificate is installed. Everything else works.'))
    }

    card.addEventListener('submit', async event => {
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

    scroll.appendChild(card)
    root.appendChild(scroll)
    return { key: 'pair', root: root }
  }

  // ------------------------------------------------------------------ sessions screen

  const matchesFilter = session => {
    if (state.filter === 'all') return true
    return session.state === state.filter
  }

  const sessionRow = session => {
    const node = button('session', null, () => go('#/session/' + encodeURIComponent(session.id)))
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
    meta.appendChild(el('span', 'session-state tone-' + (session.state || 'idle'), STATE_WORDS[session.state] || 'Idle'))
    meta.appendChild(el('span', 'session-facts', dotRow(parts)))
    if (session.state === 'working' && session.turnStartedAt) {
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
        for (const session of workspace.sessions) list.appendChild(sessionRow(session))
        group.appendChild(list)
      }
      host.appendChild(group)
    }
  }

  const sessionsScreen = () => {
    const root = el('div', 'screen')
    const header = topbar()
    const scroll = scroller()
    root.appendChild(header)
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
    return {
      key: 'sessions',
      root: root,
      update: () => { drawHeader(); drawList() }
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
    })

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
      for (const item of items) {
        const node = renderTimelineItem(item, pendingIds)
        if (!node) continue
        scroll.appendChild(node)
        drawn += 1
      }
      if (!drawn) scroll.appendChild(emptyNote('Nothing said yet.', 'Send the first message below.'))
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
        state.conversationId = null
        state.conversation = null
        if (refetchTimer) { clearTimeout(refetchTimer); refetchTimer = null }
      }
    }
  }

  // ------------------------------------------------------------------ new task screen

  const projectById = id => ((state.phone && state.phone.projects) || []).filter(project => project.id === id)[0] || null
  const providerById = id => ((state.phone && state.phone.providers) || []).filter(provider => provider.id === id)[0] || null

  const machineUsable = (machine, projectId) =>
    machine.status === 'online' && (machine.projectIds || []).indexOf(projectId) >= 0

  /* The form is rebuilt from every fresh PhoneState, so it must forget any choice the desktop no
     longer offers - a project removed, a machine gone offline - without losing the rest. */
  const reconcileForm = () => {
    const phone = state.phone
    if (!phone) return
    const form = state.form || (state.form = { projectId: '', workspaceId: '', machineId: '', provider: '', model: '', effort: '', title: '', prompt: '' })
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
    if (!providers.some(provider => provider.id === form.provider)) form.provider = providers.length ? providers[0].id : ''
    const provider = providerById(form.provider)
    const models = provider ? provider.models || [] : []
    if (!models.some(model => model.id === form.model)) {
      const preferred = models.filter(model => model.isDefault)[0] || models[0]
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
    clear(header).appendChild(fill(el('div', 'topbar-main'), [el('h1', 'topbar-title', 'New task')]))

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

      body.appendChild(field('Project', select(
        (phone.projects || []).map(entry => ({ value: entry.id, label: entry.name })),
        form.projectId,
        value => { form.projectId = value; form.workspaceId = ''; form.machineId = ''; draw() }
      )))

      const workspaces = project ? project.workspaces || [] : []
      body.appendChild(field('Workspace', select(
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
      body.appendChild(field('Run on', select(machineOptions, form.machineId, value => { form.machineId = value; draw() }),
        'The task runs on that computer. This phone only watches it.'))

      const providers = (phone.providers || []).filter(entry => entry.available)
      body.appendChild(field('Agent', select(
        providers.map(entry => ({ value: entry.id, label: entry.displayName })),
        form.provider,
        value => { form.provider = value; form.model = ''; form.effort = ''; draw() }
      )))

      body.appendChild(field('Model', select(
        models.map(entry => ({ value: entry.id, label: entry.label })),
        form.model,
        value => { form.model = value; form.effort = ''; draw() }
      )))

      const efforts = model && model.effort ? model.effort : []
      if (efforts.length) {
        body.appendChild(field('Effort', select(
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
      body.appendChild(field('Title', title))

      const prompt = el('textarea', 'input prompt')
      prompt.rows = 5
      prompt.placeholder = 'What should it do?'
      prompt.value = form.prompt
      prompt.addEventListener('input', () => { form.prompt = prompt.value; paint() })
      body.appendChild(field('Prompt', prompt, 'Leave this empty to just open an idle tab.'))

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
    clear(header).appendChild(fill(el('div', 'topbar-main'), [el('h1', 'topbar-title', 'System')]))

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

      const usage = (state.phone && state.phone.usage) || []
      if (usage.length) {
        const card = el('section', 'card')
        card.appendChild(el('h2', 'card-title', 'Usage'))
        for (const window_ of usage) {
          const row = el('div', 'meter')
          const head = el('div', 'meter-head')
          head.appendChild(el('span', 'meter-label', dotRow([providerWord(window_.provider), window_.label])))
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
       hide a bottom-pinned composer behind it. */
    const viewport = window.visualViewport
    const height = viewport ? viewport.height : window.innerHeight
    document.documentElement.style.setProperty('--app-height', Math.round(height) + 'px')
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

    window.addEventListener('hashchange', () => render())
    window.addEventListener('online', () => { if (state.token) restartStream() })
    window.addEventListener('resize', applyViewport)
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', applyViewport)
      window.visualViewport.addEventListener('scroll', applyViewport)
    }
    document.addEventListener('visibilitychange', () => {
      const visible = document.visibilityState === 'visible'
      if (screen && screen.onVisibility) screen.onVisibility(visible)
      if (!visible || !state.token) return
      /* A phone that was asleep often keeps a stream object that is already dead, so a quiet
         connection counts as no connection the moment the owner looks at the screen again. */
      if (!state.connected || Date.now() - lastEventAt > 20000) restartStream()
    })
    setInterval(() => {
      for (const fn of tickers) {
        try { fn() } catch (error) { /* a dead node is not worth a crash */ }
      }
      /* A stream that has gone quiet is a stream the phone slept through. */
      if (state.connected && document.visibilityState === 'visible' && Date.now() - lastEventAt > STREAM_STALE_MS) restartStream()
    }, 1000)

    registerServiceWorker()
    render()
    if (state.token) connectStream()
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
