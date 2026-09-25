import { useEffect, useRef, useState } from 'react'
import { lastOwnerKeyAt } from './stream-ingest'

/** Each animated step is a render and a frame of the conversation around it; while the owner is
 *  typing, those frames would sit between their keys and their paint, so the count jumps instead. */
const TYPING_MS = 1000

/** Interpolate only between provider reports; never extrapolate token usage. */
export function useAnimatedCount(target: number | undefined, identity: string): number | undefined {
  const [shown, setShown] = useState(target)
  const current = useRef(target), scope = useRef(identity)
  useEffect(() => {
    let frame = 0
    const publish = (value: number | undefined): void => { current.current = value; setShown(value) }
    const start = current.current
    if (scope.current !== identity || target === undefined || start === undefined || target < start || performance.now() - lastOwnerKeyAt() < TYPING_MS || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      scope.current = identity; publish(target); return
    }
    const began = performance.now()
    const tick = (time: number): void => {
      const progress = Math.min(1, Math.max(0, (time - began) / 260))
      publish(Math.min(target, Math.round(start + (target - start) * (1 - (1 - progress) ** 3))))
      if (progress < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [target, identity])
  return scope.current === identity && target !== undefined && shown !== undefined ? Math.min(shown, target) : target
}
