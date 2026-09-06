import { useEffect, useState } from 'react'

export const useWindowMaximized = (): boolean => {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    let mounted = true
    void window.conductor.window.isMaximized().then((value) => {
      if (mounted) setMaximized(value)
    })
    const unsubscribe = window.conductor.window.onMaximizedChange(setMaximized)
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  return maximized
}
