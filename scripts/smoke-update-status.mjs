const port = Number(process.argv[2] || 9363)
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds))

let targets
for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())
    if (targets?.length) break
  } catch {}
  await delay(200)
}
const target = targets?.find((item) => item.type === 'page' && item.title === 'Conductor')
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
const evaluate = (expression) => new Promise((resolve, reject) => {
  const id = ++sequence
  pending.set(id, {
    resolve: (result) => resolve(result.result.value),
    reject
  })
  socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
})

await evaluate('window.conductor.updates.check()')
let update
for (let attempt = 0; attempt < 60; attempt += 1) {
  update = await evaluate(`(() => {
    const button = document.querySelector('.statusbar-update')
    if (!button) return null
    const style = getComputedStyle(button)
    return { label: button.textContent.trim(), className: button.className, borderColor: style.borderColor, boxShadow: style.boxShadow }
  })()`)
  if (update?.label === 'Update pending') break
  await delay(200)
}
if (update?.label !== 'Update pending' || !update.className.includes('available') || update.boxShadow === 'none') {
  const state = await evaluate('window.conductor.updates.getState()')
  socket.close()
  throw new Error(`Bottom-bar update highlight was missing: ${JSON.stringify({ update, state })}`)
}
socket.close()
console.log(JSON.stringify(update, null, 2))
