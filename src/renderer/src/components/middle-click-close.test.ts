import { describe, expect, it, vi } from 'vitest'
import { middleClickClose } from './middle-click-close'

const press = (button: number) => ({ button, preventDefault: vi.fn(), stopPropagation: vi.fn() })

describe('middleClickClose (file tabs, feature-list c8d7d75f)', () => {
  it('cancels the middle press so Chromium starts no autoscroll on an overflowing strip, and closes on its auxclick', () => {
    const close = vi.fn()
    const handlers = middleClickClose(close)
    const down = press(1)
    handlers.onMouseDown(down)
    expect(down.preventDefault).toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
    const aux = press(1)
    handlers.onAuxClick(aux)
    expect(aux.preventDefault).toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('leaves the left and right buttons alone', () => {
    const close = vi.fn()
    const handlers = middleClickClose(close)
    for (const button of [0, 2]) {
      const down = press(button), aux = press(button)
      handlers.onMouseDown(down); handlers.onAuxClick(aux)
      expect(down.preventDefault).not.toHaveBeenCalled()
      expect(aux.preventDefault).not.toHaveBeenCalled()
    }
    expect(close).not.toHaveBeenCalled()
  })

  it('does nothing while disabled (a tab being renamed)', () => {
    const close = vi.fn()
    const handlers = middleClickClose(close, false)
    const down = press(1)
    handlers.onMouseDown(down); handlers.onAuxClick(press(1))
    expect(down.preventDefault).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })
})
