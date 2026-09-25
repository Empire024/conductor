import { describe, expect, it } from 'vitest'
import { StopConfirmations, type StopDecision } from './stop-confirmation'

/* conductor-task:wizard-answers-quit-dialog. The native "Work is still running" dialog is visible
   to agents while it is open and closes with the answer a wizard or the owner credential gives. */
describe('stop confirmations', () => {
  const info = { action: 'restart' as const, running: [{ id: 'agent-a', title: 'Worker' }] }
  const dialog = () => {
    let click!: (decision: StopDecision) => void, closed = false
    const show = (signal: AbortSignal) => new Promise<StopDecision>(resolve => {
      click = resolve
      // A native message box aborted by its signal behaves as if cancelled.
      signal.addEventListener('abort', () => { closed = true; resolve('cancel') })
    })
    return { show, click: (value: StopDecision) => click(value), get closed() { return closed } }
  }

  it('shows the open dialog and closes it with an agent answer', async () => {
    const confirmations = new StopConfirmations(), box = dialog()
    expect(confirmations.pending()).toBeNull()
    const decision = confirmations.ask(info, box.show)
    expect(confirmations.pending()).toMatchObject({ action: 'restart', running: [{ id: 'agent-a', title: 'Worker' }], openedAt: expect.any(String), choices: ['stop', 'cancel'] })
    expect(confirmations.answer(true)).toMatchObject({ action: 'restart' })
    expect(await decision).toBe('stop')
    expect(box.closed).toBe(true)
    expect(confirmations.pending()).toBeNull()
    expect(confirmations.answer(true)).toBeNull()
  })

  it('keeps work running when the agent answers stopWork:false', async () => {
    const confirmations = new StopConfirmations(), box = dialog()
    const decision = confirmations.ask(info, box.show)
    confirmations.answer(false)
    expect(await decision).toBe('cancel')
  })

  it('the owner clicking first settles it and leaves nothing to answer', async () => {
    const confirmations = new StopConfirmations(), box = dialog()
    const decision = confirmations.ask(info, box.show)
    box.click('stop')
    expect(await decision).toBe('stop')
    expect(confirmations.pending()).toBeNull()
    expect(confirmations.answer(false)).toBeNull()
  })

  /* 19c298e4 (V3 S12): a dialog never outlives the work it asks about. */
  it('closes itself and goes ahead once the work it names has settled', async () => {
    const confirmations = new StopConfirmations(), box = dialog()
    let running: Array<{ id: string; title: string }> | null = [{ id: 'agent-a', title: 'Worker' }, { id: 'agent-b', title: 'Other' }]
    const decision = confirmations.ask(info, box.show, { running: () => running, intervalMs: 5 })
    running = [{ id: 'agent-b', title: 'Other' }]
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(confirmations.pending()?.running).toEqual([{ id: 'agent-b', title: 'Other' }])
    running = null
    expect(await decision).toBe('stop')
    expect(box.closed).toBe(true)
    expect(confirmations.pending()).toBeNull()
  })

  /* e1610f01: quitting with running work can keep it running in the background. */
  it('offers keeping work in the background only when the dialog does', async () => {
    const confirmations = new StopConfirmations()
    const plain = confirmations.ask(info, dialog().show)
    expect(confirmations.answer('background')).toBeNull()
    confirmations.answer(false)
    expect(await plain).toBe('cancel')

    const offered = confirmations.ask({ ...info, choices: ['background', 'stop', 'cancel'] }, dialog().show)
    expect(confirmations.pending()?.choices).toEqual(['background', 'stop', 'cancel'])
    expect(confirmations.answer('background')).toMatchObject({ action: 'restart' })
    expect(await offered).toBe('background')
  })
})
