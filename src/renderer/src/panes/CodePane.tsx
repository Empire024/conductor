import { useEffect, useMemo, useRef, useState } from 'react'
import Editor, { type BeforeMount, type OnMount } from '@monaco-editor/react'
import { Check, FilePlus2, LoaderCircle, Save } from 'lucide-react'
import type { ProjectRecord } from '../../../shared/models'
import { dispatchAgentContext } from './StructuredAgentPane'

const languageFor = (path: string): string => {
  const ext = path.split('.').pop()?.toLowerCase()
  return (
    {
      ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', json: 'json',
      css: 'css', scss: 'scss', html: 'html', md: 'markdown', py: 'python', php: 'php',
      rs: 'rust', go: 'go', cs: 'csharp', yml: 'yaml', yaml: 'yaml', sql: 'sql', ps1: 'powershell'
    }[ext ?? ''] ?? 'plaintext'
  )
}

export function CodePane({ project, tabId, path, line }: { project: ProjectRecord; tabId: string; path: string; line?: number }): React.JSX.Element {
  const [value, setValue] = useState('')
  const [savedValue, setSavedValue] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [recovered, setRecovered] = useState(false)
  const [error, setError] = useState('')
  const [theme, setTheme] = useState(document.documentElement.dataset.theme === 'light' ? 'conductor-light' : 'conductor-dark')
  const valueRef = useRef(value)
  const savedValueRef = useRef(savedValue)
  const pathRef = useRef(path)
  const tabIdRef = useRef(tabId)
  const viewStateRef = useRef<unknown | null>(null)
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null)
  const draftTimerRef = useRef<number | null>(null)
  valueRef.current = value
  savedValueRef.current = savedValue
  pathRef.current = path
  tabIdRef.current = tabId
  const dirty = value !== savedValue
  const language = useMemo(() => languageFor(path), [path])

  const flushDraft = (): void => {
    if (valueRef.current === savedValueRef.current) return
    if (draftTimerRef.current !== null) {
      window.clearTimeout(draftTimerRef.current)
      draftTimerRef.current = null
    }
    viewStateRef.current = editorRef.current?.saveViewState() ?? viewStateRef.current
    // A file can be renamed or moved from Explorer while it is open. Refs let
    // the outgoing effect checkpoint its unsaved content under the new path.
    window.conductor.files.flushDraft(tabIdRef.current, project.id, pathRef.current, valueRef.current, viewStateRef.current)
  }

  const checkpointDraft = (): void => {
    if (valueRef.current === savedValueRef.current) return
    if (draftTimerRef.current !== null) window.clearTimeout(draftTimerRef.current)
    draftTimerRef.current = window.setTimeout(() => {
      draftTimerRef.current = null
      viewStateRef.current = editorRef.current?.saveViewState() ?? viewStateRef.current
      window.conductor.files.checkpointDraft(tabId, project.id, path, valueRef.current, viewStateRef.current)
    }, 100)
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setRecovered(false)
    setError('')
    void Promise.all([
      window.conductor.files.read(project.id, path),
      window.conductor.files.getDraft(tabId, project.id, path)
    ]).then(([content, draft]) => {
      if (cancelled) return
      const recoveredContent = draft?.content ?? content
      valueRef.current = recoveredContent
      savedValueRef.current = content
      viewStateRef.current = draft?.viewState ?? null
      setValue(recoveredContent)
      setSavedValue(content)
      setRecovered(Boolean(draft && draft.content !== content))
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : `Could not open ${path}`)
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => {
      cancelled = true
      flushDraft()
    }
  }, [path, project.id, tabId])

  useEffect(() => {
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') flushDraft()
    }
    window.addEventListener('pagehide', flushDraft)
    window.addEventListener('beforeunload', flushDraft)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pagehide', flushDraft)
      window.removeEventListener('beforeunload', flushDraft)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [path, project.id, tabId])

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setTheme(document.documentElement.dataset.theme === 'light' ? 'conductor-light' : 'conductor-dark')
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  const save = async (): Promise<void> => {
    setSaving(true)
    setError('')
    try {
      await window.conductor.files.write(project.id, path, valueRef.current)
      savedValueRef.current = valueRef.current
      setSavedValue(valueRef.current)
      setRecovered(false)
      await window.conductor.files.removeDraft(tabId)
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : `Could not save ${path}`
      setError(message)
      window.dispatchEvent(new CustomEvent('conductor:toast', { detail: message }))
    } finally {
      setSaving(false)
    }
  }

  const beforeMount: BeforeMount = (monaco) => {
    monaco.editor.defineTheme('conductor-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '637777', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'C792EA' },
        { token: 'string', foreground: 'ADDB67' },
        { token: 'number', foreground: 'F78C6C' }
      ],
      colors: {
        'editor.background': '#011627',
        'editor.foreground': '#D6DEEB',
        'editorLineNumber.foreground': '#4B6479',
        'editorLineNumber.activeForeground': '#B2CCD6',
        'editor.selectionBackground': '#1D3B53',
        'editor.lineHighlightBackground': '#071D2E',
        'editorCursor.foreground': '#80A4C2',
        'editorIndentGuide.background1': '#1E2D3D',
        'editorIndentGuide.activeBackground1': '#5F7E97'
      }
    })
    monaco.editor.defineTheme('conductor-light', {
      base: 'vs',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '989FB1', fontStyle: 'italic' },
        { token: 'keyword', foreground: '994CC3' },
        { token: 'string', foreground: '4876D6' },
        { token: 'number', foreground: 'AA0982' }
      ],
      colors: {
        'editor.background': '#F6F8FA',
        'editor.foreground': '#403F53',
        'editorLineNumber.foreground': '#A8AEC0',
        'editorLineNumber.activeForeground': '#59607A',
        'editor.selectionBackground': '#D9E7F7',
        'editor.lineHighlightBackground': '#EEF2F7',
        'editorCursor.foreground': '#2AA298'
      }
    })
  }

  const onMount: OnMount = (_editor, monaco) => {
    editorRef.current = _editor
    _editor.addAction({
      id: 'conductor-attach-selection',
      label: 'Attach selection to focused agent',
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 2,
      run: () => attachContext()
    })
    _editor.addAction({
      id: 'conductor-attach-diagnostics',
      label: 'Attach file diagnostics to focused agent',
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 3,
      run: () => {
        const model = _editor.getModel()
        if (!model) return
        const markers = monaco.editor.getModelMarkers({ resource: model.uri })
        if (!markers.length) {
          window.dispatchEvent(new CustomEvent('conductor:toast', { detail: 'This file has no editor diagnostics.' }))
          return
        }
        dispatchAgentContext(project.id, { id: crypto.randomUUID(), kind: 'diagnostics', name: pathRef.current, path: pathRef.current, content: markers.map((marker) => pathRef.current + ':' + marker.startLineNumber + ':' + marker.startColumn + ' ' + marker.message).join('\n') })
      }
    })
    _editor.addAction({
      id: 'conductor-save',
      label: 'Save',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => save()
    })
    let copyTimer = 0
    _editor.onDidChangeCursorSelection(({ selection }) => {
      window.clearTimeout(copyTimer)
      if (selection.isEmpty()) return
      copyTimer = window.setTimeout(() => {
        const text = _editor.getModel()?.getValueInRange(selection) ?? ''
        if (!text) return
        void navigator.clipboard.writeText(text).then(() => {
          window.dispatchEvent(new CustomEvent('conductor:toast', { detail: `Copied ${text.length.toLocaleString()} characters` }))
        })
      }, 220)
    })
    if (viewStateRef.current) {
      _editor.restoreViewState(viewStateRef.current as Parameters<typeof _editor.restoreViewState>[0])
    } else if (line) {
      _editor.setPosition({ lineNumber: line, column: 1 })
      _editor.revealLineInCenter(line)
    }
    _editor.onDidScrollChange(checkpointDraft)
    _editor.onDidChangeCursorPosition(checkpointDraft)
    _editor.focus()
  }

  const attachContext = (): void => {
    const selected = editorRef.current?.getSelection()
    const model = editorRef.current?.getModel()
    const hasSelection = Boolean(selected && !selected.isEmpty())
    const content = hasSelection && selected && model ? model.getValueInRange(selected) : valueRef.current
    if (content.length > 160_000) {
      window.dispatchEvent(new CustomEvent('conductor:toast', { detail: 'Select a smaller range to attach (maximum 160,000 characters).' }))
      return
    }
    dispatchAgentContext(project.id, {
      id: crypto.randomUUID(),
      kind: hasSelection ? 'selection' : valueRef.current !== savedValueRef.current ? 'editor' : 'file',
      name: pathRef.current + (!hasSelection && valueRef.current !== savedValueRef.current ? ' (unsaved)' : ''),
      path: pathRef.current,
      content,
      startLine: hasSelection ? selected?.startLineNumber : undefined,
      endLine: hasSelection ? selected?.endLineNumber : undefined
    })
  }

  return (
    <div className="code-pane">
      <div className="code-toolbar">
        <span className="code-path">{path}</span>
        {recovered && <span className="code-recovered">Recovered draft</span>}
        <span className="code-language">{language}</span>
        <button onClick={attachContext} disabled={loading} title="Attach selected range, or current editor content, to the last focused agent"><FilePlus2 size={13} /> Attach context</button>
        <button className={dirty ? 'dirty' : ''} disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? <LoaderCircle className="spin" size={13} /> : dirty ? <Save size={13} /> : <Check size={13} />}
          {dirty ? 'Save' : 'Saved'}
        </button>
      </div>
      {loading ? (
        <div className="editor-loading"><LoaderCircle className="spin" size={18} /> Opening {path}</div>
      ) : error && !value ? (
        <div className="editor-loading">{error}</div>
      ) : (
        <Editor
          path={`${project.id}/${path}`}
          value={value}
          language={language}
          theme={theme}
          beforeMount={beforeMount}
          onMount={onMount}
          onChange={(next) => {
            valueRef.current = next ?? ''
            setValue(valueRef.current)
            checkpointDraft()
          }}
          options={{
            automaticLayout: true,
            fontFamily: 'Cascadia Code, Cascadia Mono, Consolas, monospace',
            fontSize: 12.5,
            lineHeight: 20,
            minimap: { enabled: false },
            padding: { top: 12 },
            smoothScrolling: true,
            scrollBeyondLastLine: false,
            bracketPairColorization: { enabled: true },
            renderWhitespace: 'selection'
          }}
        />
      )}
    </div>
  )
}
