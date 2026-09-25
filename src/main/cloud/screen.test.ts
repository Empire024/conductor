import { describe, expect, it } from 'vitest'
import { TerminalScreen, plainText } from './screen'

describe('TerminalScreen', () => {
  it('keeps the words a cursor-forward redraw spaces out', () => {
    const screen = new TerminalScreen(40, 5)
    screen.write('Quick\x1b[1Csafety\x1b[1Ccheck')
    expect(screen.text()).toBe('Quick safety check')
  })

  it('shows only the last frame of a line redrawn in place', () => {
    const screen = new TerminalScreen(60, 5)
    screen.write('> fix it\r\n✻ Working… (esc to interrupt)')
    screen.write('\x1b[2K\r✶ Working… (esc to interrupt)')
    screen.write('\x1b[2K\r● Done\r\n> ')
    expect(screen.text()).toBe('> fix it\n● Done\n>')
  })

  it('moves the cursor up to rewrite an earlier line', () => {
    const screen = new TerminalScreen(20, 5)
    screen.write('one\r\ntwo\r\nthree\x1b[2A\r\x1b[2Kuno')
    expect(screen.screenLines()).toEqual(['uno', 'two', 'three'])
  })

  it('keeps lines that scroll off the top as scrollback', () => {
    const screen = new TerminalScreen(20, 2)
    screen.write('a\r\nb\r\nc\r\nd')
    expect(screen.screenLines()).toEqual(['c', 'd'])
    expect(screen.text()).toBe('a\nb\nc\nd')
    expect(screen.text(2)).toBe('c\nd')
  })

  it('clears the screen, positions absolutely and ignores colours and titles', () => {
    const screen = new TerminalScreen(20, 4)
    screen.write('old text\x1b[2J\x1b[H\x1b]0;title\x07\x1b[1;32mnew\x1b[0m\x1b[3;5Hthere')
    expect(screen.screenLines()).toEqual(['new', '', '    there'])
  })

  it('restores the main screen after the alternate one', () => {
    const screen = new TerminalScreen(20, 3)
    screen.write('main\x1b[?1049hfull screen app\x1b[?1049l')
    expect(screen.screenLines()).toEqual(['main'])
  })

  it('carries an escape sequence split across writes', () => {
    const screen = new TerminalScreen(20, 3)
    screen.write('ab\x1b['); screen.write('2Dc')
    expect(screen.text()).toBe('cb')
  })

  it('reduces a raw stream to plain text', () => {
    expect(plainText('\x1b[1mhttps://claude.ai/code/session_01ABC\x1b[0m')).toBe('https://claude.ai/code/session_01ABC')
  })
})
