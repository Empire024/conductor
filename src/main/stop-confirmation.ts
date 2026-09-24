/** The "Work is still running" quit/restart confirmation, made answerable by an agent. The dialog
 *  itself is a native message box nobody but the owner can see, so while one is open this records
 *  what it asks, and a sovereign caller (wizard tab or owner credential, app.quit.confirm) can
 *  close it with an answer. The first answer wins, whether the owner clicked or an agent replied. */
export type PendingStopConfirmation = { action: 'quit' | 'restart'; running: Array<{ id: string; title: string }>; openedAt: string }

export class StopConfirmations {
  private open: { info: PendingStopConfirmation; answer(stopWork: boolean): void } | null = null

  pending(): PendingStopConfirmation | null { return this.open ? structuredClone(this.open.info) : null }

  /** Shows the dialog through `show`, which must close it when the signal aborts. Resolves with
   *  whether work may be stopped: the owner's click, or the answer an agent gave first. */
  async ask(info: Omit<PendingStopConfirmation, 'openedAt'>, show: (signal: AbortSignal) => Promise<boolean>): Promise<boolean> {
    const abort = new AbortController()
    let answered: boolean | undefined
    const entry = { info: { ...info, openedAt: new Date().toISOString() }, answer: (stopWork: boolean) => { answered = stopWork; abort.abort() } }
    this.open = entry
    try {
      const clicked = await show(abort.signal)
      return answered ?? clicked
    } finally { if (this.open === entry) this.open = null }
  }

  /** Answers the open dialog; returns what it asked, or null when none is open. */
  answer(stopWork: boolean): PendingStopConfirmation | null {
    const open = this.open
    if (!open) return null
    this.open = null
    open.answer(stopWork)
    return open.info
  }
}
