import { useCallback, useEffect, useState } from 'react'
import type { AppUpdateState } from '../../shared/models'

const initialState: AppUpdateState = {
  phase: 'disabled',
  currentVersion: '',
  configured: false
}

export const useAppUpdates = (): {
  updateState: AppUpdateState
  runUpdateAction(): Promise<void>
  checkForUpdates(): Promise<void>
} => {
  const [updateState, setUpdateState] = useState<AppUpdateState>(initialState)

  useEffect(() => {
    let mounted = true
    void window.conductor.updates.getState().then((state) => {
      if (mounted) setUpdateState(state)
    })
    const unsubscribe = window.conductor.updates.onState(setUpdateState)
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  const checkForUpdates = useCallback(async (): Promise<void> => {
    setUpdateState(await window.conductor.updates.check())
  }, [])

  const runUpdateAction = useCallback(async (): Promise<void> => {
    if (updateState.phase === 'ready') {
      await window.conductor.updates.install()
    } else if (updateState.phase === 'available') {
      setUpdateState(await window.conductor.updates.download())
    } else if (updateState.phase === 'error' && updateState.availableVersion) {
      setUpdateState(await window.conductor.updates.download())
    } else if (updateState.phase === 'error' || updateState.phase === 'idle') {
      setUpdateState(await window.conductor.updates.check())
    }
  }, [updateState.phase])

  return { updateState, runUpdateAction, checkForUpdates }
}
