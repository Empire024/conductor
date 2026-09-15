import type { EditorDraft } from '../../../shared/models'

/** Recover only actual edits. Never adopt newer disk bytes as the baseline of
 * older edits: doing so would authorize overwriting an agent's newer work. */
export function recoverEditorDraft(disk: string | null, draft: EditorDraft | null): {
  content: string; savedContent: string; baseContent: string | null | undefined; recovered: boolean; conflict: boolean
} {
  if (!draft || draft.content === disk || draft.content === draft.baseContent) return {
    content: disk ?? '', savedContent: disk ?? '', baseContent: disk, recovered: false, conflict: false
  }
  return {
    content: draft.content, savedContent: draft.baseContent ?? disk ?? '', baseContent: draft.baseContent,
    recovered: true, conflict: draft.baseContent === undefined || draft.baseContent !== disk
  }
}

/**
 * An unsaved edit kept from a machine this computer is no longer attached to.
 *
 * When the owner detaches, edits they made to the host's files are the one thing that exists only
 * here. They are kept - losing them would make "use this computer independently" a destructive
 * action - but they are deliberately *not* treated as a live buffer any more: there is no host to
 * compare against or save through, and the same path on this computer is a different file that
 * must never be overwritten with them. So the editor labels them, refuses the ordinary save, and
 * leaves the owner with read, copy and save-a-copy, which are the three things that are honest.
 */
export function recoveryDraftLabel(
  draft: Pick<EditorDraft, 'recoveredAt' | 'path' | 'machineId'> | null | undefined,
  machineName?: string
): string {
  if (!draft?.recoveredAt) return ''
  return `Unsaved edit from ${machineName || draft.machineId || 'another machine'} › ${draft.path} (recovered)`
}

/** Whether this buffer is a recovery draft, and so must never be written to a local file. */
export function isRecoveryDraft(draft: Pick<EditorDraft, 'recoveredAt'> | null | undefined): boolean {
  return Boolean(draft?.recoveredAt)
}

/** What the editor says instead of offering to save a recovery draft to somewhere it does not belong. */
export function recoveryDraftNotice(machineName: string): string {
  return `This text was typed against ${machineName} while this computer was attached to it. It is kept here so nothing you wrote is lost. It cannot be saved back from here, and it is never written to a file of the same name on this computer - save a copy if you want to keep it.`
}
