/**
 * Just enough of a VT100 screen to read what a TUI shows. The cloud client is an Ink app that
 * redraws in place with cursor moves and line erases, so stripping escape codes from the raw
 * stream gives run-together words and every intermediate frame; replaying them onto a grid gives
 * the lines a person would see. Colours and modes are ignored; scrolled-off lines are kept.
 */
export class TerminalScreen {
  private grid: string[][] = []
  private scrollback: string[] = []
  private saved: { row: number; col: number } = { row: 0, col: 0 }
  private alternate: { grid: string[][]; row: number; col: number } | null = null
  private row = 0
  private col = 0
  private state: 'text' | 'escape' | 'csi' | 'osc' | 'osc-escape' | 'charset' = 'text'
  private params = ''

  constructor(private cols = 100, private rows = 30, private maxScrollback = 3000) {
    this.grid = Array.from({ length: rows }, () => this.blank())
  }

  resize(cols: number, rows: number): void {
    cols = Math.max(2, Math.min(500, Math.floor(cols))); rows = Math.max(2, Math.min(300, Math.floor(rows)))
    while (this.grid.length > rows) { const top = this.grid.shift()!; this.pushScrollback(top); this.row = Math.max(0, this.row - 1) }
    while (this.grid.length < rows) this.grid.push(this.blank(cols))
    this.grid = this.grid.map(line => line.length >= cols ? line.slice(0, cols) : [...line, ...Array<string>(cols - line.length).fill(' ')])
    this.cols = cols; this.rows = rows
    this.row = Math.min(this.row, rows - 1); this.col = Math.min(this.col, cols - 1)
  }

  write(data: string): void {
    for (const character of data) this.feed(character)
  }

  /** The visible screen, trailing blanks trimmed. */
  screenLines(): string[] {
    const lines = this.grid.map(line => line.join('').trimEnd())
    while (lines.length && !lines[lines.length - 1]) lines.pop()
    return lines
  }

  /** Scrollback followed by the screen, the last `limit` non-repeated lines. */
  text(limit = 200): string {
    const all = [...this.scrollback, ...this.screenLines()]
    return all.slice(-limit).join('\n')
  }

  private blank(cols = this.cols): string[] { return Array<string>(cols).fill(' ') }

  private pushScrollback(line: string[]): void {
    if (this.alternate) return
    this.scrollback.push(line.join('').trimEnd())
    if (this.scrollback.length > this.maxScrollback) this.scrollback.splice(0, this.scrollback.length - this.maxScrollback)
  }

  private lineFeed(): void {
    if (this.row < this.rows - 1) { this.row++; return }
    this.pushScrollback(this.grid.shift()!)
    this.grid.push(this.blank())
  }

  private feed(character: string): void {
    switch (this.state) {
      case 'escape':
        if (character === '[') { this.state = 'csi'; this.params = ''; return }
        if (character === ']') { this.state = 'osc'; return }
        if (character === '(' || character === ')') { this.state = 'charset'; return }
        if (character === '7') this.saved = { row: this.row, col: this.col }
        else if (character === '8') { this.row = this.saved.row; this.col = this.saved.col }
        else if (character === 'M') { if (this.row > 0) this.row--; else { this.grid.pop(); this.grid.unshift(this.blank()) } }
        else if (character === 'c') { this.grid = Array.from({ length: this.rows }, () => this.blank()); this.row = 0; this.col = 0 }
        this.state = 'text'; return
      case 'charset': this.state = 'text'; return
      case 'osc':
        if (character === '\x07') this.state = 'text'
        else if (character === '\x1b') this.state = 'osc-escape'
        return
      case 'osc-escape': this.state = character === '\\' ? 'text' : 'osc'; return
      case 'csi':
        if (character >= '@' && character <= '~') { this.state = 'text'; this.csi(this.params, character); return }
        this.params += character
        if (this.params.length > 64) this.state = 'text'
        return
    }
    if (character === '\x1b') { this.state = 'escape'; return }
    if (character === '\r') { this.col = 0; return }
    if (character === '\n' || character === '\x0b' || character === '\x0c') { this.lineFeed(); return }
    if (character === '\b') { this.col = Math.max(0, this.col - 1); return }
    if (character === '\t') { this.col = Math.min(this.cols - 1, (Math.floor(this.col / 8) + 1) * 8); return }
    if (character < ' ' || character === '\x7f') return
    if (this.col >= this.cols) { this.col = 0; this.lineFeed() }
    this.grid[this.row]![this.col] = character
    this.col++
  }

  private csi(raw: string, final: string): void {
    const privateMode = raw.startsWith('?')
    const values = raw.replace(/^[?>=<]/, '').split(';').map(value => Number.parseInt(value, 10))
    const n = (index = 0, fallback = 1): number => Number.isFinite(values[index]) && values[index]! > 0 ? values[index]! : fallback
    const clampRow = (value: number): number => Math.max(0, Math.min(this.rows - 1, value))
    const clampCol = (value: number): number => Math.max(0, Math.min(this.cols - 1, value))
    if (privateMode) {
      if ((final === 'h' || final === 'l') && values.some(value => value === 1049 || value === 47 || value === 1047)) {
        if (final === 'h' && !this.alternate) { this.alternate = { grid: this.grid, row: this.row, col: this.col }; this.grid = Array.from({ length: this.rows }, () => this.blank()); this.row = 0; this.col = 0 }
        if (final === 'l' && this.alternate) { this.grid = this.alternate.grid; this.row = clampRow(this.alternate.row); this.col = clampCol(this.alternate.col); this.alternate = null }
      }
      return
    }
    switch (final) {
      case 'A': this.row = clampRow(this.row - n()); break
      case 'B': case 'e': this.row = clampRow(this.row + n()); break
      case 'C': case 'a': this.col = clampCol(this.col + n()); break
      case 'D': this.col = clampCol(this.col - n()); break
      case 'E': this.row = clampRow(this.row + n()); this.col = 0; break
      case 'F': this.row = clampRow(this.row - n()); this.col = 0; break
      case 'G': case '`': this.col = clampCol(n() - 1); break
      case 'd': this.row = clampRow(n() - 1); break
      case 'H': case 'f': this.row = clampRow(n(0) - 1); this.col = clampCol(n(1) - 1); break
      case 'J': {
        const mode = Number.isFinite(values[0]) ? values[0] : 0
        if (mode === 0) { this.eraseLine(0); for (let row = this.row + 1; row < this.rows; row++) this.grid[row] = this.blank() }
        else if (mode === 1) { this.eraseLine(1); for (let row = 0; row < this.row; row++) this.grid[row] = this.blank() }
        else if (mode === 2 || mode === 3) this.grid = Array.from({ length: this.rows }, () => this.blank())
        break
      }
      case 'K': this.eraseLine(Number.isFinite(values[0]) ? values[0]! : 0); break
      case 'X': for (let col = this.col; col < Math.min(this.cols, this.col + n()); col++) this.grid[this.row]![col] = ' '; break
      case 'P': { const line = this.grid[this.row]!; line.splice(this.col, n()); while (line.length < this.cols) line.push(' '); break }
      case '@': { const line = this.grid[this.row]!; line.splice(this.col, 0, ...Array<string>(n()).fill(' ')); line.length = this.cols; break }
      case 'L': for (let i = 0; i < n(); i++) { this.grid.splice(this.row, 0, this.blank()); this.grid.length = this.rows } break
      case 'M': for (let i = 0; i < n(); i++) { this.grid.splice(this.row, 1); this.grid.push(this.blank()) } break
      case 'S': for (let i = 0; i < n(); i++) { this.pushScrollback(this.grid.shift()!); this.grid.push(this.blank()) } break
      case 'T': for (let i = 0; i < n(); i++) { this.grid.pop(); this.grid.unshift(this.blank()) } break
      case 's': this.saved = { row: this.row, col: this.col }; break
      case 'u': this.row = this.saved.row; this.col = this.saved.col; break
      default: break
    }
  }

  private eraseLine(mode: number): void {
    const line = this.grid[this.row]!
    const [from, to] = mode === 1 ? [0, this.col + 1] : mode === 2 ? [0, this.cols] : [this.col, this.cols]
    for (let col = from; col < Math.min(to, this.cols); col++) line[col] = ' '
  }
}

/** Strips a string to printable text for one-line summaries. */
export function plainText(value: string): string {
  const screen = new TerminalScreen(400, 50)
  screen.write(value)
  return screen.text(400)
}
