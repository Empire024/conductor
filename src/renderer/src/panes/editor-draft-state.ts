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
