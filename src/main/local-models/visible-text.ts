/**
 * What of a local model's output reaches the timeline (VR7 row 19, dolphin-useful-like-any-model).
 *
 * A small model imitates the notes Conductor adds to its conversation ("[Conductor] ...") and then
 * loops on them - Dolphin wrote 23-69 fake "[Conductor: The assistant has provided a direct answer
 * ...]" lines into its drafts. Model text is cut where such a note starts: the stream holds back
 * anything that could be the start of one, and generation is stopped once it appears.
 */
export const CONDUCTOR_NOTE = '[Conductor'
/** A status line (reasoning, a processing narration) is a glimpse of what the model is doing, not
 *  a document: longer than this it is a draft the owner never asked to read. */
export const STATUS_TEXT_LIMIT = 480

/** The text before the first imitated Conductor note, trimmed of the whitespace leading into it. */
export function stripConductorNotes(text: string): string {
  const at = text.indexOf(CONDUCTOR_NOTE)
  return at < 0 ? text : text.slice(0, at).trimEnd()
}

/** Streams deltas through `emit`, holding back a tail that could still become a Conductor note
 *  and dropping everything from the note on. */
export function conductorNoteGuard(emit: (delta: string) => void): { push(delta: string): void; flush(): void; readonly cut: boolean } {
  let held = '', cut = false
  return {
    get cut() { return cut },
    push(delta: string) {
      if (cut) return
      held += delta
      const at = held.indexOf(CONDUCTOR_NOTE)
      if (at >= 0) {
        cut = true
        const before = held.slice(0, at).trimEnd()
        held = ''
        if (before) emit(before)
        return
      }
      // Keep back the longest tail that is a prefix of the marker: the next delta may complete it.
      let keep = 0
      for (let length = Math.min(CONDUCTOR_NOTE.length - 1, held.length); length > 0; length--) {
        if (CONDUCTOR_NOTE.startsWith(held.slice(-length))) { keep = length; break }
      }
      // ...and the whitespace leading into it, which the cut would trim.
      if (keep) while (keep < held.length && /\s/.test(held[held.length - keep - 1]!)) keep++
      const ready = held.slice(0, held.length - keep)
      held = held.slice(held.length - keep)
      if (ready) emit(ready)
    },
    flush() { if (!cut && held) emit(held); held = '' }
  }
}

/** Passes status deltas through until `limit` characters have gone out, then one ellipsis. */
export function cappedStatus(emit: (delta: string) => void, limit = STATUS_TEXT_LIMIT): (delta: string) => void {
  let sent = 0, closed = false
  return delta => {
    if (closed) return
    const room = limit - sent
    if (delta.length <= room) { sent += delta.length; emit(delta); return }
    if (room > 0) emit(delta.slice(0, room))
    emit(' …')
    closed = true
  }
}
