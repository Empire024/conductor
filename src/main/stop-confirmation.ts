/** The "Work is still running" quit/restart confirmation, made answerable by an agent. The dialog
 *  itself is a native message box nobody but the owner can see, so while one is open this records
 *  what it asks, and a sovereign caller (wizard tab or owner credential, app.quit.confirm) can
 *  close it with an answer. The first answer wins, whether the owner clicked or an agent replied.
 *
 *  'background' keeps the running turns alive in the runtime host while the app goes
 *  (docs/runtime-host.md); it is offered only when the host can take them. */
export type StopDecision = 'stop' | 'background' | 'cancel'
export type PendingStopConfirmation = { action: 'quit' | 'restart'; running: Array<{ id: string; title: string }>; openedAt: string; choices?: StopDecision[] }

export class StopConfirmations {
  private open: { info: PendingStopConfirmation; answer(decision: StopDecision): void } | null = null

  pending(): PendingStopConfirmation | null { return this.open ? structuredClone(this.open.info) : null }

  /** Shows the dialog through `show`, which must close it when the signal aborts. Resolves with
   *  the owner's click, or the answer an agent gave first. */
  async ask(info: Omit<PendingStopConfirmation, 'openedAt' | 'choices'> & { choices?: StopDecision[] }, show: (signal: AbortSignal) => Promise<StopDecision>): Promise<StopDecision> {
    const abort = new AbortController()
    let answered: StopDecision | undefined
    const entry = { info: { ...info, choices: info.choices ?? ['stop', 'cancel'], openedAt: new Date().toISOString() }, answer: (decision: StopDecision) => { answered = decision; abort.abort() } }
    this.open = entry
    try {
      const clicked = await show(abort.signal)
      return answered ?? clicked
    } finally { if (this.open === entry) this.open = null }
  }

  /** Answers the open dialog; returns what it asked, or null when none is open. `true` stops the
   *  work and `false` cancels, as app.quit.confirm({stopWork}) always meant. A choice the dialog
   *  does not offer is refused (null) rather than turned into another one. */
  answer(answer: boolean | StopDecision): PendingStopConfirmation | null {
    const open = this.open
    if (!open) return null
    const decision: StopDecision = answer === true ? 'stop' : answer === false ? 'cancel' : answer
    if (!(open.info.choices ?? ['stop', 'cancel']).includes(decision)) return null
    this.open = null
    open.answer(decision)
    return open.info
  }
}
