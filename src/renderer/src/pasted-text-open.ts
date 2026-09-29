import type { ContextAttachment } from '../../shared/structured-agent'
import { isPastedText } from '../../shared/pasted-text'
import { openWorkspaceFile } from './components/workspace-files-state'

/**
 * Opens a pasted-text chip as a file in the document strip's read-only preview
 * (src/main/pasted-text-files.ts). A draft's chip carries its text; a sent one names the
 * conversation artifact its text was kept in, so it reopens after a reload.
 */
export async function openPastedText(projectId: string, attachment: ContextAttachment, sessionId?: string): Promise<void> {
  const request = typeof attachment.content === 'string'
    ? { attachmentId: attachment.id, content: attachment.content }
    : { attachmentId: attachment.id, sessionId, artifactId: attachment.artifactId }
  try {
    const { path } = await window.conductor.files.openPastedText(projectId, request)
    openWorkspaceFile(projectId, path, 'preview')
  } catch (error) {
    window.dispatchEvent(new CustomEvent('conductor:toast', { detail: `Could not open ${attachment.name}: ${error instanceof Error ? error.message : String(error)}` }))
  }
}

/** Whether a chip can open its pasted text: a draft holds the text, a sent one its artifact. */
export const canOpenPastedText = (attachment: ContextAttachment): boolean =>
  isPastedText(attachment) && (typeof attachment.content === 'string' || typeof attachment.artifactId === 'string')
