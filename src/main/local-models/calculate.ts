import { readFile, stat } from 'node:fs/promises'

/** Exact arithmetic for a local model, in process and without the sandbox.
 *
 *  An 8B model adds numbers in its head and gets them wrong: in VR8c's swarm run Dolphin summed a
 *  month's groceries as 299.5 or 319.5 against 350.8, and its controller "merged" two reports by
 *  writing Python it never ran. This gives it a way to compute instead of guess that needs no
 *  Docker, no network and no write access: a formula evaluator (numbers, + - * / ^ %, parentheses
 *  and a few functions, nothing else can be named) and a totaller for a delimited file in the
 *  workspace, which reads the file itself so no number passes through the model on the way in.
 *  Results are rounded to ten decimal places, which removes binary floating-point noise from money
 *  (212.4 + 87.1 + 51.3 is 350.8, not 350.79999999999995). */

export class CalculationError extends Error {}

const MAX_EXPRESSION = 2000
const MAX_EXPRESSIONS = 50
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_GROUPS = 200

/** A number as it should be read back: no float noise, no exponent for ordinary money sizes. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) throw new CalculationError('the result is not a finite number (division by zero?)')
  const rounded = Number(value.toFixed(10))
  return Object.is(rounded, -0) ? '0' : Math.abs(rounded) >= 1e21 ? String(rounded) : rounded.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 10 })
}

type Token = { kind: 'number'; value: number } | { kind: 'name'; value: string } | { kind: 'op'; value: string }

const FUNCTIONS: Record<string, (args: number[]) => number> = {
  sum: args => args.reduce((a, b) => a + b, 0),
  avg: args => args.length ? args.reduce((a, b) => a + b, 0) / args.length : NaN,
  mean: args => args.length ? args.reduce((a, b) => a + b, 0) / args.length : NaN,
  average: args => args.length ? args.reduce((a, b) => a + b, 0) / args.length : NaN,
  min: args => Math.min(...args),
  max: args => Math.max(...args),
  abs: ([x]) => Math.abs(x!),
  sqrt: ([x]) => Math.sqrt(x!),
  floor: ([x]) => Math.floor(x!),
  ceil: ([x]) => Math.ceil(x!),
  round: ([x, digits = 0]) => { const scale = 10 ** Math.max(0, Math.min(10, Math.trunc(digits))); return Math.round(x! * scale) / scale }
}

function tokenize(source: string): Token[] {
  // Money as a model writes it: currency signs dropped, thousands separators only where they
  // cannot be an argument separator (no function call in the formula).
  let text = source.replace(/[$€£¥]|\b(?:USD|EUR|GBP|CZK|CHF)\b/gi, '').replace(/×/g, '*').replace(/(\d\s*)x(?=\s*[\d(])/gi, '$1*').replace(/÷/g, '/')
  if (!/[a-z]\s*\(/i.test(text)) text = text.replace(/(\d),(?=\d{3}(?!\d))/g, '$1')
  const tokens: Token[] = []
  const pattern = /\s*(?:(\d+(?:\.\d*)?(?:e[+-]?\d+)?|\.\d+(?:e[+-]?\d+)?)|([a-z_]+)|(\*\*|[-+*/^%(),]))/iy
  let index = 0
  while (index < text.length) {
    if (/^\s*$/.test(text.slice(index))) break
    pattern.lastIndex = index
    const match = pattern.exec(text)
    if (!match) throw new CalculationError(`cannot read "${text.slice(index).trim().slice(0, 20)}"; use numbers, + - * / ^ %, parentheses and ${Object.keys(FUNCTIONS).join(', ')}`)
    index = pattern.lastIndex
    if (match[1] !== undefined) tokens.push({ kind: 'number', value: Number(match[1]) })
    else if (match[2] !== undefined) tokens.push({ kind: 'name', value: match[2].toLowerCase() })
    else tokens.push({ kind: 'op', value: match[3] === '**' ? '^' : match[3]! })
  }
  return tokens
}

/** Evaluates one formula. Recursive descent over a fixed grammar; there is no identifier other
 *  than the function names above, so nothing outside arithmetic can be reached. */
export function evaluateExpression(source: string): number {
  if (typeof source !== 'string' || !source.trim()) throw new CalculationError('the expression is empty')
  if (source.length > MAX_EXPRESSION) throw new CalculationError(`the expression is longer than ${MAX_EXPRESSION} characters`)
  const tokens = tokenize(source)
  let at = 0
  const peek = (): Token | undefined => tokens[at]
  const isOp = (value: string): boolean => peek()?.kind === 'op' && peek()!.value === value
  const expect = (value: string): void => { if (!isOp(value)) throw new CalculationError(`expected "${value}"`); at++ }
  const expression = (): number => {
    let value = term()
    while (isOp('+') || isOp('-')) { const op = tokens[at++]!.value; const right = term(); value = op === '+' ? value + right : value - right }
    return value
  }
  const term = (): number => {
    let value = unary()
    while (isOp('*') || isOp('/')) { const op = tokens[at++]!.value; const right = unary(); value = op === '*' ? value * right : value / right }
    return value
  }
  const unary = (): number => {
    if (isOp('-')) { at++; return -unary() }
    if (isOp('+')) { at++; return unary() }
    return power()
  }
  const power = (): number => {
    const base = postfix()
    if (isOp('^')) { at++; return base ** unary() }
    return base
  }
  // "15% * 240" and "240 * 15%": a percent sign is a hundredth.
  const postfix = (): number => {
    let value = primary()
    while (isOp('%')) { at++; value /= 100 }
    return value
  }
  const primary = (): number => {
    const token = peek()
    if (!token) throw new CalculationError('the expression ends too early')
    if (token.kind === 'number') { at++; return token.value }
    if (token.kind === 'name') {
      const fn = FUNCTIONS[token.value]
      if (!fn) throw new CalculationError(`unknown name "${token.value}"; functions are ${Object.keys(FUNCTIONS).join(', ')}`)
      at++
      expect('(')
      const args: number[] = []
      if (!isOp(')')) { args.push(expression()); while (isOp(',')) { at++; args.push(expression()) } }
      expect(')')
      if (!args.length) throw new CalculationError(`${token.value}() needs at least one number`)
      return fn(args)
    }
    if (token.value === '(') { at++; const value = expression(); expect(')'); return value }
    throw new CalculationError(`unexpected "${token.value}"`)
  }
  const value = expression()
  if (at < tokens.length) throw new CalculationError(`unexpected "${tokens[at]!.value}" after a complete expression`)
  return value
}

/** Splits delimited text into rows, honouring double quotes. */
function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], field = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (char === '"') quoted = false
      else field += char
    } else if (char === '"' && !field) quoted = true
    else if (char === delimiter) { row.push(field); field = '' }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.some(cell => cell.trim())) rows.push(row)
      row = []
    } else field += char
  }
  row.push(field)
  if (row.some(cell => cell.trim())) rows.push(row)
  return rows
}

const detectDelimiter = (header: string): string => [',', ';', '\t', '|'].map(d => [d, header.split(d).length] as const).sort((a, b) => b[1] - a[1])[0]![0]

/** A cell as a number: currency signs, spaces and thousands separators dropped, (12.50) negative,
 *  a lone decimal comma (12,50) read as a decimal point. Undefined when it is not a number. */
export function parseAmount(cell: string): number | undefined {
  let text = cell.trim().replace(/[$€£¥\s]|\b(?:USD|EUR|GBP|CZK|CHF|Kč)\b/gi, '')
  let negative = false
  if (/^\(.*\)$/.test(text)) { negative = true; text = text.slice(1, -1) }
  if (/^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(text)) text = text.replace(/,/g, '')
  else if (/^-?\d+,\d{1,2}$/.test(text)) text = text.replace(',', '.')
  if (!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return undefined
  const value = Number(text)
  return Number.isFinite(value) ? (negative ? -value : value) : undefined
}

export type Aggregate = 'sum' | 'average' | 'min' | 'max' | 'count'
const AGGREGATES: Aggregate[] = ['sum', 'average', 'min', 'max', 'count']

export interface TableRequest { path: string; column?: string; groupBy?: string; op?: string }

/** Totals one column of a delimited file, per group when group_by names a column. `file` is the
 *  resolved path; `label` is how the result names it. */
export async function aggregateFile(file: string, label: string, request: TableRequest): Promise<string> {
  const info = await stat(file)
  if (!info.isFile()) throw new CalculationError(`${label} is not a file`)
  if (info.size > MAX_FILE_BYTES) throw new CalculationError(`${label} is larger than 8 MiB`)
  const text = (await readFile(file, 'utf8')).replace(/^﻿/, '')
  if (text.includes('\0')) throw new CalculationError(`${label} is not a text file`)
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
  const rows = parseDelimited(text, detectDelimiter(firstLine))
  if (rows.length < 2) throw new CalculationError(`${label} has no data rows under a header`)
  const header = rows[0]!.map(cell => cell.trim())
  const data = rows.slice(1)
  const op = (request.op ?? 'sum').toLowerCase().replace(/^(?:avg|mean)$/, 'average') as Aggregate
  if (!AGGREGATES.includes(op)) throw new CalculationError(`op must be one of ${AGGREGATES.join(', ')}`)
  const find = (name: string, role: string): number => {
    const wanted = name.trim().toLowerCase()
    const index = /^\d+$/.test(wanted) ? Number(wanted) - 1 : header.findIndex(cell => cell.toLowerCase() === wanted)
    if (index < 0 || index >= header.length) throw new CalculationError(`${role} "${name}" is not a column of ${label}; its columns are ${header.join(', ')}`)
    return index
  }
  const numericShare = (index: number): number => data.filter(row => parseAmount(row[index] ?? '') !== undefined).length / data.length
  let column: number
  if (request.column !== undefined) column = find(request.column, 'column')
  else {
    // No column named: the one numeric column, when there is exactly one.
    const numeric = header.map((_, index) => index).filter(index => numericShare(index) >= 0.8)
    if (numeric.length !== 1 && op !== 'count') throw new CalculationError(`name the number column: ${label} has columns ${header.join(', ')}`)
    column = numeric[0] ?? 0
  }
  const group = request.groupBy !== undefined && request.groupBy !== '' ? find(request.groupBy, 'group_by') : undefined
  const groups = new Map<string, number[]>()
  const all: number[] = []
  const skipped: number[] = []
  data.forEach((row, index) => {
    const value = op === 'count' ? 1 : parseAmount(row[column] ?? '')
    if (value === undefined) { skipped.push(index + 2); return }
    all.push(value)
    if (group === undefined) return
    const key = (row[group] ?? '').trim() || '(blank)'
    if (!groups.has(key) && groups.size >= MAX_GROUPS) throw new CalculationError(`more than ${MAX_GROUPS} groups in ${request.groupBy}; group by a coarser column`)
    groups.set(key, [...(groups.get(key) ?? []), value])
  })
  const reduce = (values: number[]): number => op === 'count' ? values.length : op === 'sum' ? values.reduce((a, b) => a + b, 0) : op === 'average' ? values.reduce((a, b) => a + b, 0) / values.length : op === 'min' ? Math.min(...values) : Math.max(...values)
  const what = op === 'count' ? 'row count' : `${op} of ${header[column]}`
  const lines = [`${what}${group !== undefined ? ` by ${header[group]}` : ''} in ${label} (${all.length} rows used${skipped.length ? `, ${skipped.length} skipped as not numbers: lines ${skipped.slice(0, 8).join(', ')}${skipped.length > 8 ? ', ...' : ''}` : ''})`]
  if (!all.length) throw new CalculationError(`no row of ${label} has a number in ${header[column]}`)
  for (const [key, values] of groups) lines.push(`${key} = ${formatNumber(reduce(values))}`)
  lines.push(`${group !== undefined ? 'all rows' : what} = ${formatNumber(reduce(all))}`)
  if (group === undefined) {
    const text = header.map((_, index) => index).filter(index => index !== column && numericShare(index) < 0.5)
    if (text.length) lines.push(`(For one result per ${header[text[0]!]}, call again with group_by "${header[text[0]!]}".)`)
  }
  lines.push('These numbers are exact; copy them as they are.')
  return lines.join('\n')
}

const GRAND_TOTAL = /^(?:all[ _]rows|all[ _]labels|all|totals?|grand[ _]total|sum|overall(?:[ _]total)?)$/

// A comma after a number separates pairs ("rent=950, fun=45"); only 1,234 groups are thousands.
const PAIR = /([A-Za-z][A-Za-z0-9 _&/-]{0,40}?)\s*(?:=|:)\s*[$€£]?\s*(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?)(?!\d|\.\d)/g

/** The label = value pairs of one report ("jan.csv: rent=950, groceries=350.8"). A name before a
 *  colon that is followed by another pair ("jan.csv:") is not a value, so it is never read as one. */
export function reportPairs(text: string): Array<[string, number]> {
  const pairs: Array<[string, number]> = []
  for (const match of text.matchAll(PAIR)) {
    const value = parseAmount(match[2]!)
    const label = match[1]!.trim().toLowerCase().replace(/\s+/g, ' ')
    if (value !== undefined && label) pairs.push([label, value])
  }
  return pairs
}

/** Merges several reports of label = value pairs: the total per label across all of them, and the
 *  change from the first report to the last. What a swarm controller does with its coworkers'
 *  results, done by Conductor instead of by the model's head or by code it never runs. */
export function combineReports(input: unknown): string {
  let sources: unknown = input
  if (typeof input === 'string') { try { sources = JSON.parse(input) } catch { sources = input.split(/\r?\n(?=\s*\S)/) } }
  if (!Array.isArray(sources) || sources.length < 2 || sources.length > 12 || sources.some(source => typeof source !== 'string')) throw new CalculationError('combine must be a list of 2 to 12 report texts, the full text of each report as one list item')
  // A report's own grand total is not an item, and a model's invented one (FX40 swarm run: "total=1600.65"
  // beside items that add up to 1550.55) must not be summed as fact: the total below is computed.
  const parsed = (sources as string[]).map(text => reportPairs(text))
  // Only a report with no pairs at all is an error; one whose only pair is its total just adds nothing.
  const empty = parsed.map((pairs, index) => pairs.length ? -1 : index + 1).filter(index => index > 0)
  const reports = parsed.map(pairs => pairs.filter(([label]) => !GRAND_TOTAL.test(label)))
  if (empty.length) throw new CalculationError(`report ${empty.join(', ')} has no label = value pairs to combine`)
  const labels = [...new Set(reports.flatMap(pairs => pairs.map(([label]) => label)))]
  const valueIn = (pairs: Array<[string, number]>, label: string): number | undefined => {
    const found = pairs.filter(([name]) => name === label)
    return found.length ? found.reduce((sum, [, value]) => sum + value, 0) : undefined
  }
  const lines = [`combined ${reports.length} reports: total per label, and the change from report 1 to report ${reports.length}`]
  const changes: Array<[string, number]> = []
  for (const label of labels) {
    const values = reports.map(pairs => valueIn(pairs, label))
    const total = values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    const first = values[0], last = values.at(-1)
    const change = first !== undefined && last !== undefined ? last - first : undefined
    if (change !== undefined) changes.push([label, change])
    lines.push(`${label} = ${formatNumber(total)} (${values.map(value => value === undefined ? 'missing' : formatNumber(value)).join(' + ')}${change !== undefined ? `; change ${change >= 0 ? '+' : ''}${formatNumber(change)}` : ''})`)
  }
  // A report's own grand total ("all rows = ...") is not one more item to add.
  lines.push(`all labels = ${formatNumber(reports.flat().reduce((sum, [, value]) => sum + value, 0))}`)
  if (changes.length > 1) {
    const sorted = [...changes].sort((a, b) => b[1] - a[1])
    lines.push(`largest increase: ${sorted[0]![0]} (${sorted[0]![1] >= 0 ? '+' : ''}${formatNumber(sorted[0]![1])}); largest decrease: ${sorted.at(-1)![0]} (${formatNumber(sorted.at(-1)![1])})`)
  }
  lines.push('These numbers are exact; copy them as they are.')
  return lines.join('\n')
}

/** One formula, or several labelled ones, as the tool result the model reads. */
export function calculateExpressions(expression: unknown, expressions: unknown): string {
  if (expression !== undefined) {
    if (typeof expression !== 'string' && typeof expression !== 'number') throw new CalculationError('expression must be a string such as "212.4 + 87.1"')
    return `${String(expression).trim()} = ${formatNumber(evaluateExpression(String(expression)))}`
  }
  let entries: Array<[string, unknown]>
  // A small model often sends a nested object as a JSON string.
  if (typeof expressions === 'string') { try { expressions = JSON.parse(expressions) } catch { expressions = [expressions] } }
  if (Array.isArray(expressions)) entries = expressions.map((value, index) => [String(index + 1), value])
  else if (expressions && typeof expressions === 'object') entries = Object.entries(expressions as Record<string, unknown>)
  else throw new CalculationError('expressions must be an object of label: formula, such as {"rent": "950 + 950"}')
  if (!entries.length || entries.length > MAX_EXPRESSIONS) throw new CalculationError(`expressions must hold 1 to ${MAX_EXPRESSIONS} formulas`)
  const lines = entries.map(([label, formula]) => {
    if (typeof formula !== 'string' && typeof formula !== 'number') return `${label}: error: the formula must be a string`
    try { return `${label} = ${formatNumber(evaluateExpression(String(formula)))}` } catch (error) { return `${label}: error: ${error instanceof Error ? error.message : 'cannot compute'}` }
  })
  return [...lines, 'These numbers are exact; copy them as they are.'].join('\n')
}
