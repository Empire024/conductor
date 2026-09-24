import type { RefObject } from 'react'

interface IdeaEditorProps {
  text: string
  /** True while a note is loading: nothing typed then could be attributed to the right note. */
  readOnly: boolean
  textareaRef: RefObject<HTMLTextAreaElement | null>
  onChange(text: string): void
  onBlur(): void
}

/**
 * The note itself: one borderless textarea, no title field and no form. The first line becomes
 * the title in the list.
 */
export function IdeaEditor({ text, readOnly, textareaRef, onChange, onBlur }: IdeaEditorProps): React.JSX.Element {
  return (
    <textarea
      ref={textareaRef}
      className="ideas-editor"
      aria-label="Idea"
      value={text}
      readOnly={readOnly}
      autoFocus
      spellCheck
      placeholder={readOnly ? '' : 'Write the idea down. The first line becomes its title.'}
      onChange={event => onChange(event.target.value)}
      onBlur={onBlur}
    />
  )
}
