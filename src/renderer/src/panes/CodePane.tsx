import { useEffect, useMemo, useRef, useState } from 'react'
import Editor, { type BeforeMount, type OnMount } from '@monaco-editor/react'
import { Check, FilePlus2, LoaderCircle, Save, WrapText } from 'lucide-react'
import type { ProjectRecord } from '../../../shared/models'
import { dispatchAgentContext } from './StructuredAgentPane'
import { AgentDialog } from './StructuredAgentRenderers'
import { recoverEditorDraft } from './editor-draft-state'
import './CodePane.css'

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

export function CodePane({ project, tabId, path, line, autoFocus = true }: { project: ProjectRecord; tabId: string; path: string; line?: number; autoFocus?: boolean }): React.JSX.Element {
  const [wordWrap, setWordWrap] = useState(() => localStorage.getItem('conductor.editorWordWrap') !== 'off')
  const toggleWrap = (): void => setWordWrap((current) => { localStorage.setItem('conductor.editorWordWrap', current ? 'off' : 'on'); return !current })
  const [value, setValue] = useState('')
  const [savedValue, setSavedValue] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [recovered, setRecovered] = useState(false)
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState(false)
  const [reloadOpen, setReloadOpen] = useState(false)
  const [theme, setTheme] = useState(document.documentElement.dataset.theme === 'light' ? 'conductor-light' : 'conductor-dark')
  const loadedRef = useRef(false)
  const valueRef = useRef(value)
  const savedValueRef = useRef(savedValue)
  const baseContentRef = useRef<string | null | undefined>(undefined)
  const pathRef = useRef(path)
  const tabIdRef = useRef(tabId)
  const projectIdRef = useRef(project.id)
  const generationRef = useRef(0)
  const viewStateRef = useRef<unknown | null>(null)
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null)
  const draftTimerRef = useRef<number | null>(null)
  const saveTaskRef = useRef<Promise<void> | null>(null)
  const saveAgainRef = useRef(false)
  const reloadingRef = useRef(false)
  valueRef.current = value
  savedValueRef.current = savedValue
  pathRef.current = path
  tabIdRef.current = tabId
  projectIdRef.current = project.id
  const dirty = value !== savedValue
  const language = useMemo(() => languageFor(path), [path])

  const flushDraft = (event?: Event): void => {
    if (!loadedRef.current) return
    if (draftTimerRef.current !== null) {
      window.clearTimeout(draftTimerRef.current)
      draftTimerRef.current = null
    }
    viewStateRef.current = editorRef.current?.saveViewState() ?? viewStateRef.current
    const ok = window.conductor.files.flushDraft(tabIdRef.current, projectIdRef.current, pathRef.current, valueRef.current, viewStateRef.current, baseContentRef.current)
    if (!ok) {
      if (event instanceof CustomEvent && event.detail) event.detail.failed = true
      setError('Could not preserve your editor draft. Keep this window open and try saving again.')
    }
  }

  const checkpointDraft = (contentChanged = false): void => {
    if (!loadedRef.current || !contentChanged && valueRef.current === savedValueRef.current) return
    if (draftTimerRef.current !== null) window.clearTimeout(draftTimerRef.current)
    // Also checkpoint an undo back to the saved text to remove an older draft.
    draftTimerRef.current = window.setTimeout(() => {
      draftTimerRef.current = null
      viewStateRef.current = editorRef.current?.saveViewState() ?? viewStateRef.current
      window.conductor.files.checkpointDraft(tabIdRef.current, projectIdRef.current, pathRef.current, valueRef.current, viewStateRef.current, baseContentRef.current)
    }, 100)
  }

  useEffect(() => {
    let cancelled = false
    generationRef.current++
    loadedRef.current = false
    setLoading(true)
    setSaving(false)
    setRecovered(false)
    setConflict(false)
    setReloadOpen(false)
    setError('')
    void Promise.all([
      window.conductor.files.readForEditor(project.id, path),
      window.conductor.files.getDraft(tabId, project.id, path)
    ]).then(([content, draft]) => {
      if (cancelled) return
      const state = recoverEditorDraft(content, draft)
      valueRef.current = state.content
      savedValueRef.current = state.savedContent
      baseContentRef.current = state.baseContent
      viewStateRef.current = draft?.viewState ?? null
      setValue(state.content)
      setSavedValue(state.savedContent)
      loadedRef.current = true
      setRecovered(state.recovered)
      setConflict(state.conflict)
      if (state.conflict) setError('The file on disk differs from this recovered draft. Both versions are preserved; save a copy or reload the file.')
      else if (content === null && !draft) setError('This file no longer exists on disk.')
      // Remove historical clean checkpoints, without writing anything to disk.
      flushDraft()
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : `Could not open ${path}`)
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => {
      cancelled = true
      flushDraft()
      loadedRef.current = false
      generationRef.current++
    }
  }, [path, project.id, tabId])

  useEffect(() => {
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') flushDraft()
    }
    window.addEventListener('conductor:flush-editors', flushDraft)
    window.addEventListener('pagehide', flushDraft)
    window.addEventListener('beforeunload', flushDraft)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('conductor:flush-editors', flushDraft)
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

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('conductor:editor-dirty', { detail: { id: tabId, dirty: !loading && dirty } }))
  }, [tabId, dirty, loading])

  useEffect(() => window.conductor.files.onDraftConflict((result) => {
    if (result.tabId === tabId) { setConflict(true); setError(result.message) }
  }), [tabId])

  useEffect(() => window.conductor.files.onDraftResolved((result) => {
    if (result.tabId !== tabId) return
    const unchanged = valueRef.current === result.submitted
    // A discarded old draft must not authorize overwriting newer disk bytes
    // with edits that arrived while another window was deciding to close.
    if (unchanged || result.saved) {
      baseContentRef.current = result.content
      savedValueRef.current = result.content ?? ''
      setSavedValue(savedValueRef.current)
    }
    if (unchanged) {
      valueRef.current = result.content ?? ''
      setValue(valueRef.current)
      setRecovered(false)
      setConflict(false)
      setError('')
    } else {
      if (!result.saved && baseContentRef.current !== result.content) { setConflict(true); setError('The file changed while closing. Your newer edits are preserved; save a copy or reload the file.') }
      flushDraft()
    }
    queueMicrotask(() => window.dispatchEvent(new CustomEvent('conductor:editor-dirty', { detail: { id: tabId, dirty: valueRef.current !== savedValueRef.current } })))
  }), [tabId])

  const save = (): Promise<void> => {
    if (!loadedRef.current || reloadingRef.current) return Promise.resolve()
    if (saveTaskRef.current) { saveAgainRef.current = true; return saveTaskRef.current }
    if (valueRef.current === savedValueRef.current && baseContentRef.current !== undefined) return Promise.resolve()
    const generation = generationRef.current
    const owner = { projectId: projectIdRef.current, path: pathRef.current, tabId: tabIdRef.current }
    const isCurrent = (): boolean => generationRef.current === generation && owner.path === pathRef.current && owner.tabId === tabIdRef.current && owner.projectId === projectIdRef.current
    editorRef.current?.pushUndoStop()
    setSaving(true)
    setError('')
    const task = (async (): Promise<void> => {
      try {
        do {
          saveAgainRef.current = false
          const submittedValue = valueRef.current
          flushDraft()
          const result = await window.conductor.files.write(owner.projectId, owner.path, submittedValue, baseContentRef.current)
          if (!isCurrent()) return
          if (result.status === 'conflict') { setConflict(true); setError(result.message); return }
          editorRef.current?.pushUndoStop()
          baseContentRef.current = submittedValue
          savedValueRef.current = submittedValue
          setSavedValue(submittedValue)
          setRecovered(false)
          setConflict(false)
          // A synchronous checkpoint preserves edits typed while saving, or
          // removes the draft if the exact submitted buffer is still current.
          flushDraft()
        } while (saveAgainRef.current && valueRef.current !== savedValueRef.current)
      } catch (reason) {
        if (isCurrent()) {
          const message = reason instanceof Error ? reason.message : `Could not save ${owner.path}`
          setError(message)
          window.dispatchEvent(new CustomEvent('conductor:toast', { detail: message }))
        }
      } finally {
        if (isCurrent()) setSaving(false)
      }
    })()
    saveTaskRef.current = task
    void task.finally(() => { if (saveTaskRef.current === task) saveTaskRef.current = null })
    return task
  }

  const saveCopy = async (): Promise<void> => {
    try {
      const copy = await window.conductor.files.saveCopy(projectIdRef.current, pathRef.current, valueRef.current)
      window.dispatchEvent(new Event('conductor:refresh-files'))
      window.dispatchEvent(new CustomEvent('conductor:toast', { detail: 'Your edits were saved to ' + copy }))
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }

  const reload = async (): Promise<void> => {
    if (reloadingRef.current || saveTaskRef.current) return
    reloadingRef.current = true
    const generation = generationRef.current
    const submitted = valueRef.current
    try {
      const content = await window.conductor.files.readForEditor(projectIdRef.current, pathRef.current)
      if (generation !== generationRef.current) return
      if (submitted !== valueRef.current) { setError('Your edits changed while reloading. Try again when ready.'); return }
      if (content === null) { setError('The file no longer exists. Save a copy to preserve your edits.'); return }
      valueRef.current = content
      savedValueRef.current = content
      baseContentRef.current = content
      setValue(content)
      setSavedValue(content)
      setRecovered(false)
      setConflict(false)
      setError('')
      setReloadOpen(false)
      flushDraft()
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { reloadingRef.current = false }
  }

  useEffect(() => {
    if (line && editorRef.current) { editorRef.current.setPosition({ lineNumber: line, column: 1 }); editorRef.current.revealLineInCenter(line); editorRef.current.focus() }
  }, [line])

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
    _editor.addAction({ id: 'conductor-word-wrap', label: 'Toggle word wrap', keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyZ], run: toggleWrap })
    _editor.addAction({
      id: 'conductor-save',
      label: 'Save',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => save()
    })
    if (viewStateRef.current) {
      _editor.restoreViewState(viewStateRef.current as Parameters<typeof _editor.restoreViewState>[0])
    } else if (line) {
      _editor.setPosition({ lineNumber: line, column: 1 })
      _editor.revealLineInCenter(line)
    }
    _editor.onDidScrollChange(() => checkpointDraft())
    _editor.onDidChangeCursorPosition(() => checkpointDraft())
    if (autoFocus) _editor.focus()
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
        <button aria-pressed={wordWrap} onClick={toggleWrap} title="Toggle word wrap (Alt+Z)" aria-label="Toggle word wrap"><WrapText size={14} /></button>
        <button onClick={attachContext} disabled={loading} title="Attach selected range, or current editor content, to the last focused agent"><FilePlus2 size={13} /> Attach context</button>
        <button className={dirty ? 'dirty' : ''} disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? <LoaderCircle className="spin" size={13} /> : dirty ? <Save size={13} /> : <Check size={13} />}
          {dirty ? 'Save' : 'Saved'}
        </button>
      </div>
      {error && loadedRef.current && <div className="code-save-error" role="alert"><span>{error}</span>{conflict && <div><button onClick={() => void saveCopy()}>Save a copy</button><button disabled={saving} onClick={() => setReloadOpen(true)}>Reload from disk</button></div>}</div>}
      {reloadOpen && <AgentDialog title="Reload from disk?" onClose={() => setReloadOpen(false)}><div className="code-reload-dialog"><p>Reloading replaces your unsaved edits with the current file. Save a copy first if you want to keep both versions.</p><footer><button onClick={() => setReloadOpen(false)}>Cancel</button><button onClick={() => void reload()}>Reload from disk</button></footer></div></AgentDialog>}
      {loading ? (
        <div className="editor-loading"><LoaderCircle className="spin" size={18} /> Opening {path}</div>
      ) : error && !loadedRef.current ? (
        <div className="editor-loading">{error}</div>
      ) : (
        <Editor
          path={`${project.id}/${encodeURIComponent(tabId)}/${path}`}
          value={value}
          language={language}
          theme={theme}
          beforeMount={beforeMount}
          onMount={onMount}
          onChange={(next) => {
            valueRef.current = next ?? ''
            setValue(valueRef.current)
            checkpointDraft(true)
          }}
          options={{
            automaticLayout: true,
            wordWrap: wordWrap ? 'on' : 'off',
            wrappingIndent: 'same',
            scrollbar: { alwaysConsumeMouseWheel: false },
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
