import { useEffect, useRef } from 'react'
import { Command } from 'lucide-react'
import type { ComposerCommand } from './composer-commands'
/** The browser MCP tools drive a browser pane tab in the caller's own workspace, resolving the
 *  webview by matching the tab id the pane stamps on it - they cannot attribute the sidebar's
 *  browser panel to a project and workspace, so that surface is not something the agent's own
 *  tool calls can reach. This is the one place that knows how to reach the *same* surface the
 *  agent uses: the @browser mention (via chooseCommand, which covers both the click and
 *  keyboard selection paths below) and the composer footer's Browser button both call it, so
 *  the owner and the agent end up looking at one browser tab, not two. App.tsx listens for the
 *  event and does the actual find/focus/create/close (see layout/browser-tab.ts). */
export function activateBrowserMention(): void {
  window.dispatchEvent(new Event('conductor:toggle-browser-tab'))
}
export function CommandAutocomplete({ id, commands, selected, loading, onSelect, onChoose }: { id: string; commands: ComposerCommand[]; selected: number; loading: boolean; onSelect(index: number): void; onChoose(command: ComposerCommand): void }): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => { host.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [selected])
  return <div ref={host} className="sa-command-menu"><header><Command size={13} /> Commands{loading && <small>Loading provider commands...</small>}</header><div role="listbox" aria-label="Chat commands" id={id}>{commands.map((command, index) => <button type="button" role="option" id={id + '-' + index} aria-selected={index === selected} key={command.name} onMouseDown={event => event.preventDefault()} onPointerMove={() => onSelect(index)} onClick={() => onChoose(command)}><strong>{command.trigger ?? '/'}{command.name}</strong><span>{command.description}</span></button>)}</div><small>Arrow keys to choose ? Enter / Tab to select ? Esc to dismiss</small></div>
}
