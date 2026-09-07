import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppUpdateState } from '../../shared/models'

const initialState: AppUpdateState = {
  phase: 'disabled',
  currentVersion: '',
  configured: false
}

type UpdateAction = 'check' | 'download' | 'install'

export const useAppUpdates = (): {
  updateState: AppUpdateState
  autoDownload: boolean
  setAutoDownload(enabled: boolean): void
  runUpdateAction(): Promise<void>
  checkForUpdates(): Promise<void>
} => {
  const [updateState, setUpdateState] = useState<AppUpdateState>(initialState)
  const [autoDownload, setAutoDownloadState] = useState(() => localStorage.getItem('conductor.autoDownloadUpdates') === 'true')
  const stateRef = useRef(updateState)
  const revision = useRef(0)
  const inFlight = useRef<{ id: number; action: UpdateAction } | null>(null)
  const nextRequestId = useRef(0)
  const autoDownloadAttempt = useRef<string | null>(null)
  const mounted = useRef(false)

  const acceptState = useCallback((state: AppUpdateState): void => {
    stateRef.current = state
    revision.current++
    if (mounted.current) setUpdateState(state)
  }, [])

  useEffect(() => {
    mounted.current = true
    const initialRevision = revision.current
    const unsubscribe = window.conductor.updates.onState((state) => {
      if (!mounted.current) return
      const pending = inFlight.current
      // A check already in progress can broadcast its old candidate after a click.
      if (pending?.action === 'download' && ['available', 'checking'].includes(state.phase)) return
      if (pending?.action === 'install' && state.phase === 'ready') return
      if (pending && (
        pending.action === 'download' && ['ready', 'error'].includes(state.phase) ||
        pending.action === 'install' && state.phase === 'error' ||
        pending.action === 'check' && state.phase !== 'checking'
      )) inFlight.current = null
      acceptState(state)
    })
    void window.conductor.updates.getState().then((state) => {
      if (mounted.current && revision.current === initialRevision) acceptState(state)
    }).catch((error: unknown) => {
      if (mounted.current && revision.current === initialRevision) {
        acceptState({ ...stateRef.current, phase: 'error', message: String(error).slice(0, 280) })
      }
    })
    return () => {
      mounted.current = false
      unsubscribe()
    }
  }, [acceptState])

  const perform = useCallback(async (action: UpdateAction): Promise<void> => {
    // React commits on the next render. This guard also blocks two clicks in the same tick.
    if (inFlight.current || ['checking', 'downloading', 'installing'].includes(stateRef.current.phase)) return
    const requestId = ++nextRequestId.current
    inFlight.current = { id: requestId, action }
    const startingState = stateRef.current
    acceptState({
      ...startingState,
      phase: action === 'check' ? 'checking' : action === 'download' ? 'downloading' : 'installing',
      progress: undefined,
      message: action === 'check' ? 'Checking for updates…' : action === 'download' ? 'Preparing download…' : 'Preparing restart…'
    })
    const requestRevision = revision.current
    try {
      let response: AppUpdateState
      if (action === 'install') {
        await window.conductor.updates.install()
        response = await window.conductor.updates.getState()
      } else {
        response = await window.conductor.updates[action]()
      }
      // Progress/completion broadcasts are newer than an IPC response snapshot.
      if (mounted.current && revision.current === requestRevision) acceptState(response)
    } catch (error: unknown) {
      if (mounted.current && inFlight.current?.id === requestId && stateRef.current.phase !== 'error') {
        acceptState({ ...stateRef.current, phase: 'error', progress: undefined, message: String(error).slice(0, 280) })
      }
    } finally {
      if (inFlight.current?.id === requestId) inFlight.current = null
    }
  }, [acceptState])

  const checkForUpdates = useCallback(async (): Promise<void> => {
    if (stateRef.current.phase !== 'ready') await perform('check')
  }, [perform])

  const runUpdateAction = useCallback(async (): Promise<void> => {
    const state = stateRef.current
    if (state.phase === 'ready') {
      await perform('install')
    } else if (state.phase === 'available' || state.phase === 'error' && state.availableVersion) {
      await perform('download')
    } else if (state.phase === 'error' || state.phase === 'idle') {
      await perform('check')
    }
  }, [perform])

  const setAutoDownload = useCallback((enabled: boolean): void => {
    localStorage.setItem('conductor.autoDownloadUpdates', String(enabled))
    setAutoDownloadState(enabled)
  }, [])

  useEffect(() => {
    if (!autoDownload || updateState.phase !== 'available') return
    const key = `${updateState.source ?? 'release'}:${updateState.availableVersion ?? ''}`
    if (autoDownloadAttempt.current === key) return
    autoDownloadAttempt.current = key
    void runUpdateAction()
  }, [autoDownload, runUpdateAction, updateState.phase, updateState.source, updateState.availableVersion])

  return { updateState, autoDownload, setAutoDownload, runUpdateAction, checkForUpdates }
}
