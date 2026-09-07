/** Ignore selections in editors and other panes when following this conversation. */
export function hasTimelineSelection(element: HTMLElement | null, selection: Selection | null): boolean {
  return Boolean(element && selection?.toString() && (element.contains(selection.anchorNode) || element.contains(selection.focusNode)))
}

export function isAtConversationBottom(element: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 80
}
