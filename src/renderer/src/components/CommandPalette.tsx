import { useEffect, useMemo, useRef, useState } from 'react'
import { Bot, Braces, ChevronRight, FolderTree, Monitor, PanelsTopLeft, Search, Terminal } from 'lucide-react'

export interface PaletteCommand {
  id: string
  label: string
  detail?: string
  category: string
  icon: 'agent' | 'terminal' | 'file' | 'browser' | 'layout' | 'code'
  shortcut?: string
  run(): void
}

const icons = {
  agent: Bot,
  terminal: Terminal,
  file: FolderTree,
  browser: Monitor,
  layout: PanelsTopLeft,
  code: Braces
}

export function CommandPalette({
  commands,
  onClose
}: {
  commands: PaletteCommand[]
  onClose(): void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim()
    return q ? commands.filter((item) => `${item.label} ${item.category}`.toLowerCase().includes(q)) : commands
  }, [commands, query])

  useEffect(() => inputRef.current?.focus(), [])
  useEffect(() => setSelected(0), [query])

  const execute = (index: number): void => {
    const command = filtered[index]
    if (!command) return
    command.run()
    onClose()
  }

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="command-palette" onMouseDown={(event) => event.stopPropagation()}>
        <div className="palette-input">
          <Search size={18} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') onClose()
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setSelected((value) => Math.min(value + 1, filtered.length - 1))
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                setSelected((value) => Math.max(value - 1, 0))
              }
              if (event.key === 'Enter') execute(selected)
            }}
            placeholder="Type a command or open a tool..."
          />
          <kbd>ESC</kbd>
        </div>
        <div className="palette-list">
          {filtered.length === 0 && <div className="palette-empty">No matching commands</div>}
          {filtered.map((item, index) => {
            const Icon = icons[item.icon]
            return (
              <button
                key={item.id}
                className={index === selected ? 'selected' : ''}
                onMouseEnter={() => setSelected(index)}
                onClick={() => execute(index)}
              >
                <span className="palette-icon"><Icon size={16} /></span>
                <span className="palette-label"><strong>{item.label}</strong><small>{item.detail ?? item.category}</small></span>
                {item.shortcut ? <kbd>{item.shortcut}</kbd> : <ChevronRight size={14} />}
              </button>
            )
          })}
        </div>
        <footer><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> open</span></footer>
      </div>
    </div>
  )
}
