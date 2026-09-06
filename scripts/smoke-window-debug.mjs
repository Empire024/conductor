const port = Number(process.argv[2] || 9362)
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds))

let targets
for (let attempt = 0; attempt < 50; attempt += 1) {
  try {
    targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())
    if (targets?.length) break
  } catch {}
  await delay(200)
}
const target = targets?.find((item) => item.type === 'page' && item.title === 'Conductor' && !item.url.includes('debug-console=1'))
if (!target) throw new Error('Conductor renderer was not available')

const socket = new WebSocket(target.webSocketDebuggerUrl)
const pending = new Map()
let sequence = 0
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  const request = pending.get(message.id)
  if (!request) return
  pending.delete(message.id)
  message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result)
})
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence
  pending.set(id, { resolve, reject })
  socket.send(JSON.stringify({ id, method, params }))
})
const evaluate = async (expression) => {
  const response = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
  return response.result.value
}

await call('Runtime.enable')
await call('Page.enable')
await delay(700)

const initial = await evaluate(`({
  version: document.querySelector('.titlebar-version')?.textContent,
  statusbar: Boolean(document.querySelector('.app-statusbar')),
  maximizeLabel: document.querySelector('.window-controls button:nth-child(2)')?.getAttribute('aria-label'),
  themeId: document.documentElement.dataset.themeId
})`)
if (initial.version !== 'v0.1.3' || !initial.statusbar || initial.maximizeLabel !== 'Maximize window') {
  throw new Error(`Initial window chrome was incorrect: ${JSON.stringify(initial)}`)
}

await evaluate("document.querySelector('.window-controls button:nth-child(2)')?.click()")
await delay(300)
const maximizedLabel = await evaluate("document.querySelector('.window-controls button:nth-child(2)')?.getAttribute('aria-label')")
if (maximizedLabel !== 'Restore window') throw new Error(`Maximize icon did not enter restore state: ${maximizedLabel}`)
await evaluate("document.querySelector('.window-controls button:nth-child(2)')?.click()")
await delay(250)

await evaluate("document.querySelector('.activity-rail button[aria-label=\"Settings\"]')?.click()")
await delay(160)
await evaluate(`(() => {
  const input = document.querySelector('.debug-setting input[type="checkbox"]')
  if (!input) throw new Error('Debug logging setting was missing')
  if (!input.checked) input.click()
})()`)
await delay(180)
await evaluate(`[...document.querySelectorAll('.debug-setting button')].find((button) => button.textContent.includes('Open console'))?.click()`)
await delay(180)

const minimizeLabel = await evaluate("document.querySelector('.debug-console button[aria-label=\"Minimize debug console\"]')?.getAttribute('aria-label')")
if (!minimizeLabel) throw new Error('Debug console did not open')
await evaluate("document.querySelector('.debug-console button[aria-label=\"Minimize debug console\"]')?.click()")
await delay(100)
const expandedControl = await evaluate(`({
  minimized: document.querySelector('.debug-console')?.classList.contains('minimized'),
  label: document.querySelector('.debug-console button[aria-label="Expand debug console"]')?.getAttribute('aria-label')
})`)
if (!expandedControl.minimized || expandedControl.label !== 'Expand debug console') {
  throw new Error(`Debug expand control did not reflect its state: ${JSON.stringify(expandedControl)}`)
}

await evaluate("document.querySelector('.debug-console button[aria-label=\"Take screenshot\"]')?.click()")
for (let attempt = 0; attempt < 30; attempt += 1) {
  if (await evaluate("Boolean(document.querySelector('.debug-screenshot textarea'))")) break
  await delay(100)
}
const capture = await evaluate(`({
  minimized: document.querySelector('.debug-console')?.classList.contains('minimized'),
  descriptionVisible: Boolean(document.querySelector('.debug-screenshot textarea')),
  descriptionFocused: document.activeElement === document.querySelector('.debug-screenshot textarea')
})`)
if (capture.minimized || !capture.descriptionVisible || !capture.descriptionFocused) {
  throw new Error(`Screenshot description flow was not exposed: ${JSON.stringify(capture)}`)
}

const dragPoint = await evaluate(`(() => {
  const rect = document.querySelector('.debug-console > header')?.getBoundingClientRect()
  return rect ? { x: rect.left + 180, y: rect.top + rect.height / 2 } : null
})()`)
if (!dragPoint) throw new Error('Debug drag header was missing')
await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: dragPoint.x, y: dragPoint.y, button: 'left', clickCount: 1 })
await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dragPoint.x + 18, y: dragPoint.y - 12, button: 'left', buttons: 1 })
await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dragPoint.x + 18, y: dragPoint.y - 12, button: 'left', clickCount: 1 })
await delay(600)
const finalTargets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())
const detachedDebug = finalTargets.some((item) => item.type === 'page' && item.url.includes('debug-console=1'))
if (!detachedDebug) throw new Error('Dragging the debug header did not detach the console')

console.log(JSON.stringify({ initial, maximizedLabel, expandedControl, capture, detachedDebug }, null, 2))
socket.close()
