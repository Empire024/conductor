import { describe, expect, it } from 'vitest'
import { StopConfirmations } from './stop-confirmation'

/* conductor-task:wizard-answers-quit-dialog. The native "Work is still running" dialog is visible
   to agents while it is open and closes with the answer a wizard or the owner credential gives. */
describe('stop confirmations', () => {
  const info = { action: 'restart' as const, running: [{ id: 'agent-a', title: 'Worker' }] }
  const dialog = () => {
    let click!: (stopWork: boolean) => void, closed = false
    const show = (signal: AbortSignal) => new Promise<boolean>(resolve => {
      click = resolve
      // A native message box aborted by its signal behaves as if cancelled.
      signal.addEventListener('abort', () => { closed = true; resolve(false) })
    })
    return { show, click: (value: boolean) => click(value), get closed() { return closed } }
  }

  it('shows the open dialog and closes it with an agent answer', async () => {
    const confirmations = new StopConfirmations(), box = dialog()
    expect(confirmations.pending()).toBeNull()
    const decision = confirmations.ask(info, box.show)
    expect(confirmations.pending()).toMatchObject({ action: 'restart', running: [{ id: 'agent-a', title: 'Worker' }], openedAt: expect.any(String) })
    expect(confirmations.answer(true)).toMatchObject({ action: 'restart' })
    expect(await decision).toBe(true)
    expect(box.closed).toBe(true)
    expect(confirmations.pending()).toBeNull()
    expect(confirmations.answer(true)).toBeNull()
  })

  it('keeps work running when the agent answers stopWork:false', async () => {
    const confirmations = new StopConfirmations(), box = dialog()
    const decision = confirmations.ask(info, box.show)
    confirmations.answer(false)
    expect(await decision).toBe(false)
  })

  it('the owner clicking first settles it and leaves nothing to answer', async () => {
    const confirmations = new StopConfirmations(), box = dialog()
    const decision = confirmations.ask(info, box.show)
    box.click(true)
    expect(await decision).toBe(true)
    expect(confirmations.pending()).toBeNull()
    expect(confirmations.answer(false)).toBeNull()
  })
})
