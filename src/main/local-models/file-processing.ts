import { createHash } from 'node:crypto'

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }
export type Direction = 'incoming' | 'outgoing' | 'neutral'
export interface Money { minorUnits: number; currency: string; direction: Direction }
/** ISO-style three-letter codes with minor units other than two; amounts in them are refused, never rescaled. */
const nonTwoDecimalCurrencies = new Set(['JPY', 'KRW', 'ISK', 'CLP', 'VND', 'XAF', 'XOF'])
const twoDecimalCurrency = (x: unknown): x is string => typeof x === 'string' && /^[A-Z]{3}$/.test(x) && !nonTwoDecimalCurrencies.has(x)
const fail = (error: string): Parsed<never> => ({ ok: false, error })

/** Explicit two-decimal currencies only. No float arithmetic, rounding, inferred separators or zero fallback.
 * `trimmedDecimals` additionally accepts one decimal digit (`-129,9` = 129.90), as some bank exports drop a trailing zero. */
export function parseMoney(text: string, options: { currency?: string; direction?: Direction; trimmedDecimals?: boolean } = {}): Parsed<Money> {
  if (typeof text !== 'string' || text.length > 128) return fail('Invalid money text')
  let value = text.trim()
  let currency = options.currency
  const token = /^(?:([A-Z]{3})\s+)?([+-]?[\d .,\u00a0\u202f]+?)(?:\s+([A-Z]{3}))?$/.exec(value)
  if (!token || (token[1] && token[3])) return fail('Expected one exact amount and at most one currency')
  const explicit = token[1] ?? token[3]
  if (explicit && currency && explicit !== currency) return fail('Currency conflict')
  currency = explicit ?? currency
  if (!currency || !/^[A-Z]{3}$/.test(currency)) return fail('An explicit three-letter currency code is required')
  if (!twoDecimalCurrency(currency)) return fail(`Currency ${currency} does not use two decimal places; it is not supported`)
  value = token[2]!.replace(/[\u00a0\u202f]/g, ' ')
  const negative = value.startsWith('-')
  const signed = /^[+-]/.test(value)
  value = value.replace(/^[+-]/, '')
  // A dot is exclusively the decimal separator; grouped numbers use spaces and comma decimals.
  const exact = options.trimmedDecimals === true ? /^(?:\d+(?:[.,]\d{1,2})?|\d{1,3}(?: \d{3})+(?:,\d{1,2})?)$/ : /^(?:\d+(?:[.,]\d{2})?|\d{1,3}(?: \d{3})+(?:,\d{2})?)$/
  if (!exact.test(value)) return fail('Ambiguous or invalid separators/precision')
  const parts = value.replace(/ /g, '').split(/[.,]/)
  const magnitude = BigInt(parts[0]!) * 100n + BigInt((parts[1] ?? '0').padEnd(2, '0'))
  if (magnitude > BigInt(Number.MAX_SAFE_INTEGER)) return fail('Amount exceeds exact minor-unit range')
  if (options.direction && !['incoming', 'outgoing', 'neutral'].includes(options.direction)) return fail('Invalid direction')
  const inferred: Direction = magnitude === 0n ? 'neutral' : negative ? 'outgoing' : 'incoming'
  if (options.direction && ((signed && options.direction !== inferred) || (magnitude === 0n) !== (options.direction === 'neutral'))) return fail('Sign/direction conflict')
  const direction = options.direction ?? inferred
  return { ok: true, value: { minorUnits: Number(magnitude) * (direction === 'outgoing' ? -1 : 1), currency, direction } }
}

/** Calendar-only ISO or Czech dates. Never passes through local/UTC Date conversion. */
export function parseExplicitDate(text: string): Parsed<string> {
  if (typeof text !== 'string' || text.length > 32) return fail('Invalid date text')
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim())
  const cz = /^(\d{1,2})\. ?(\d{1,2})\. ?(\d{4})$/.exec(text.trim())
  if (!iso && !cz) return fail('Expected explicit ISO or Czech calendar date')
  const [year, month, day] = iso ? [Number(iso[1]), Number(iso[2]), Number(iso[3])] : [Number(cz![3]), Number(cz![2]), Number(cz![1])]
  const leap = year! % 4 === 0 && (year! % 100 !== 0 || year! % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (!year || month! < 1 || month! > 12 || day! < 1 || day! > days[month! - 1]!) return fail('Invalid calendar date')
  return { ok: true, value: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` }
}

export type Values = Record<string, string | number | boolean | null>
export interface SourceRef { inputId: string; start: number; end: number; sha256: string }
export interface InspectedRecord { ref: SourceRef; values: Values }
export interface Counts { scanned: number; parsed: number; skipped: number; rejected: number }
export interface InputIdentity { id: string; sha256: string; bytes: number; counts: Counts }
export interface Inspection {
  identity: InputIdentity
  role: 'source' | 'target'
  bytes: Uint8Array
  records: InspectedRecord[]
  complete: boolean
}
export type Segment = { start: number; end: number }
export type RecordParse = { kind: 'record'; values: Values } | { kind: 'skipped' | 'rejected' }
export interface ProcessingTarget {
  id: string
  ref: SourceRef
  criteria: Values
  /** Optional exact evidence: only reject when target and source both have a nonempty, conflicting value. */
  evidence?: Values
  /** Optional name evidence: the target text field is compared by normalized tokens with these source text fields. */
  textEvidence?: TextEvidence
}
export interface TextEvidence { targetField: string; sourceFields: string[] }
export interface ValidationContext {
  inspections: Inspection[]
  targets: ProcessingTarget[]
  /** Evaluator/host observations, never generated from the candidate's parser or output. */
  knownPositiveExamples?: InspectedRecord[]
  allowSourceReuse?: boolean
}
export interface ProcessingOutcome {
  targetId: string
  status: 'matched' | 'ambiguous' | 'not_found' | 'blocked'
  candidates: InspectedRecord[]
  reason?: string
}
export interface FileProcessingResult { version: 1; inputs: InputIdentity[]; outcomes: ProcessingOutcome[] }
export interface ValidationDiagnostic { code: string; path: string; message: string; recovery: string }
export interface ValidationResult { ok: boolean; diagnostics: ValidationDiagnostic[] }
export const FILE_PROCESSING_LIMITS = Object.freeze({ jsonBytes: 1_048_576, inputs: 64, targets: 2048, candidates: 256, fields: 32, string: 512, records: 50_000, inputBytes: 64 * 1024 * 1024, diagnostics: 32 })
export const fingerprintBytes = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const integer = (x: unknown): x is number => Number.isSafeInteger(x) && Number(x) >= 0
const object = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype
const exactKeys = (x: Record<string, unknown>, required: string[], optional: string[] = []): boolean => required.every(k => Object.hasOwn(x, k)) && Object.keys(x).every(k => [...required, ...optional].includes(k))
const shortString = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= FILE_PROCESSING_LIMITS.string
function valuesShape(x: unknown): x is Values {
  return object(x) && Object.keys(x).length > 0 && Object.keys(x).length <= FILE_PROCESSING_LIMITS.fields && Object.entries(x).every(([k, v]) => /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(k) && !['__proto__', 'constructor', 'prototype'].includes(k) && (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isSafeInteger(v)) || (typeof v === 'string' && v.length <= FILE_PROCESSING_LIMITS.string)))
}
function refShape(x: unknown): x is SourceRef {
  return object(x) && exactKeys(x, ['inputId', 'start', 'end', 'sha256']) && shortString(x.inputId) && integer(x.start) && integer(x.end) && x.end > x.start && typeof x.sha256 === 'string' && /^[a-f0-9]{64}$/.test(x.sha256)
}
function countsShape(x: unknown): x is Counts {
  return object(x) && exactKeys(x, ['scanned', 'parsed', 'skipped', 'rejected']) && Object.values(x).every(integer) && x.scanned === Number(x.parsed) + Number(x.skipped) + Number(x.rejected)
}
const refKey = (ref: SourceRef): string => JSON.stringify([ref.inputId, ref.start, ref.end, ref.sha256])
const equalValues = (a: Values, b: Values): boolean => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => Object.hasOwn(b, k) && a[k] === b[k])
const satisfies = (values: Values, criteria: Values): boolean => Object.keys(criteria).every(k => Object.hasOwn(values, k) && values[k] === criteria[k])
const present = (value: Values[string] | undefined): boolean => value !== undefined && value !== null && (typeof value !== 'string' || value.trim().length > 0)

const fieldName = (x: unknown): x is string => typeof x === 'string' && /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(x) && !['__proto__', 'constructor', 'prototype'].includes(x)
/** Name evidence may never come from the statement owner's account/holder or from a date. */
const refusedTextField = (name: string): boolean => /date|holder|ownAccount/i.test(name)
export function textEvidenceShape(x: unknown): x is TextEvidence {
  return object(x) && exactKeys(x, ['targetField', 'sourceFields']) && fieldName(x.targetField) && !refusedTextField(x.targetField) && Array.isArray(x.sourceFields) && x.sourceFields.length >= 1 && x.sourceFields.length <= 6 && x.sourceFields.every(f => fieldName(f) && !refusedTextField(f)) && new Set(x.sourceFields).size === x.sourceFields.length
}

const tokenStoplist = new Set(['sro', 'spol', 'ltd', 'gmbh', 'inc', 'the', 'and', 'pro', 'com', 'www'])
/** Normalized name tokens: diacritics, case and punctuation removed; short tokens and legal-form words dropped. */
export function nameTokens(text: string): string[] {
  return text.slice(0, FILE_PROCESSING_LIMITS.string).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(t => t.length >= 3 && !tokenStoplist.has(t))
}
/** Equal tokens, or one a prefix of the other (bank notes truncate names; Czech surnames vary: Nováková/Novák). */
export function tokensSupport(target: string[], source: string[]): boolean {
  return target.some(t => source.some(s => t === s || t.startsWith(s) || s.startsWith(t)))
}

/** Deterministic narrowing of exact amount candidates by counterparty tokens. Recomputed identically by the validator.
 * If any candidate's text supports the target name, candidates without support (with other text or none) are dropped;
 * if none supports it, every candidate is kept. It never removes the last candidate. */
export function narrowByText(candidates: InspectedRecord[], targetValues: Values | undefined, evidence: TextEvidence | undefined): { candidates: InspectedRecord[]; reason?: string } {
  const text = evidence && targetValues ? targetValues[evidence.targetField] : undefined
  const wanted = typeof text === 'string' ? nameTokens(text) : []
  if (!evidence || !wanted.length || candidates.length === 0) return { candidates }
  const supported = candidates.filter(c => tokensSupport(wanted, evidence.sourceFields.flatMap(f => typeof c.values[f] === 'string' ? nameTokens(c.values[f] as string) : [])))
  if (!supported.length || supported.length === candidates.length) return { candidates }
  return { candidates: supported, reason: `counterparty evidence narrowed ${candidates.length} amount candidates to ${supported.length}` }
}

/** RFC 4180 cell splitting for one physical line: delimiter only outside quotes, `""` is a quote, wrapping quotes removed.
 * Returns undefined for an unterminated quote or text after a closing quote. Without `quoted` it is a plain split. */
export function splitCells(line: string, delimiter: string, quoted = false): string[] | undefined {
  if (!quoted) return line.split(delimiter)
  const cells: string[] = []
  let cell = '', inQuotes = false, wasQuoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (inQuotes) {
      if (c !== '"') cell += c
      else if (line[i + 1] === '"') { cell += '"'; i++ }
      else inQuotes = false
    } else if (c === delimiter) { cells.push(cell); cell = ''; wasQuoted = false }
    else if (c === '"' && cell.trim() === '' && !wasQuoted) { cell = ''; inQuotes = true; wasQuoted = true }
    else if (wasQuoted && c.trim() !== '') return undefined
    else if (!wasQuoted) cell += c
  }
  if (inQuotes) return undefined
  cells.push(cell)
  return cells
}

/** Exact required keys plus optional corroboration; no scores, fuzzy names or implicit date semantics. */
export function matchFileRecord(source: Values, required: Values, evidence: Values = {}): boolean {
  return Object.keys(required).length > 0 && Object.keys(required).every(k => present(required[k]) && Object.hasOwn(source, k) && source[k] === required[k]) && Object.keys(evidence).every(k => !present(evidence[k]) || !Object.hasOwn(source, k) || !present(source[k]) || source[k] === evidence[k])
}

/** Trusted adapter entry point. Segments are byte spans, including headers/whitespace for full coverage. */
export function inspectFile(input: { id: string; bytes: Uint8Array; role: Inspection['role'] }, segments: Segment[], parse: (text: string, segment: Segment) => RecordParse): Inspection {
  if (!shortString(input.id) || !['source', 'target'].includes(input.role) || input.bytes.byteLength > FILE_PROCESSING_LIMITS.inputBytes || segments.length > FILE_PROCESSING_LIMITS.records) throw new Error('Inspection limit or input identity invalid')
  const bytes = Buffer.from(input.bytes)
  const records: InspectedRecord[] = []
  const counts: Counts = { scanned: 0, parsed: 0, skipped: 0, rejected: 0 }
  let cursor = 0
  let complete = true
  for (const segment of segments) {
    if (!integer(segment.start) || !integer(segment.end) || segment.start < cursor || segment.end <= segment.start || segment.end > bytes.length) throw new Error('Invalid/overlapping byte segment')
    if (segment.start !== cursor) complete = false
    cursor = segment.end
    counts.scanned++
    const raw = bytes.subarray(segment.start, segment.end)
    let parsed: RecordParse
    try { parsed = parse(new TextDecoder('utf-8', { fatal: true }).decode(raw), { ...segment }) } catch { parsed = { kind: 'rejected' } }
    if (parsed.kind === 'record' && valuesShape(parsed.values)) {
      counts.parsed++
      records.push({ ref: { inputId: input.id, ...segment, sha256: fingerprintBytes(raw) }, values: { ...parsed.values } })
    } else if (parsed.kind === 'skipped') counts.skipped++
    else counts.rejected++
  }
  complete &&= cursor === bytes.length
  return { identity: { id: input.id, sha256: fingerprintBytes(bytes), bytes: bytes.length, counts }, role: input.role, bytes, records, complete }
}

export interface FileColumn {
  line: number
  column: number
  type: 'text' | 'integer' | 'date' | 'money'
  stripPrefix?: string
  map?: Record<string, string>
  currency?: string
  direction?: Direction
  directionField?: string
  /** Money only: the currency is this text field's value (a separate currency column), not `currency`. */
  currencyField?: string
  /** Money only: accept one decimal digit as a dropped trailing zero. */
  trimmedDecimals?: boolean
}
export interface FileRecordSchema {
  delimiter: '\t' | '|' | ';' | ','
  recordLines: number
  skipPrefixes?: string[]
  skipBlank?: boolean
  /** RFC 4180 quoted cells: delimiters inside quotes are data, `""` is a quote, wrapping quotes are removed. */
  quoted?: boolean
  fields: Record<string, FileColumn>
}

function schemaShape(x: unknown): x is FileRecordSchema {
  if (!object(x) || !exactKeys(x, ['delimiter', 'recordLines', 'fields'], ['skipPrefixes', 'skipBlank', 'quoted']) || typeof x.delimiter !== 'string' || !['\t', '|', ';', ','].includes(x.delimiter) || !integer(x.recordLines) || x.recordLines < 1 || x.recordLines > 8 || !object(x.fields)) return false
  if (x.skipPrefixes !== undefined && (!Array.isArray(x.skipPrefixes) || x.skipPrefixes.length > 16 || !x.skipPrefixes.every(s => shortString(s) && s.length <= 128))) return false
  if (x.skipBlank !== undefined && typeof x.skipBlank !== 'boolean') return false
  if (x.quoted !== undefined && typeof x.quoted !== 'boolean') return false
  const fields = Object.entries(x.fields)
  if (!fields.length || fields.length > 28 || !valuesShape(Object.fromEntries(fields.map(([k]) => [k, ''])))) return false
  const all = x.fields as Record<string, unknown>
  const textField = (name: unknown): boolean => shortString(name) && Object.hasOwn(all, name) && object(all[name]) && (all[name] as Record<string, unknown>).type === 'text'
  return fields.filter(([, f]) => object(f) && f.type === 'money').length <= 1 && fields.every(([, f]) => object(f) && exactKeys(f, ['line', 'column', 'type'], ['stripPrefix', 'map', 'currency', 'direction', 'directionField', 'currencyField', 'trimmedDecimals']) && integer(f.line) && f.line < Number(x.recordLines) && integer(f.column) && f.column <= 255 && typeof f.type === 'string' && ['text', 'integer', 'date', 'money'].includes(f.type) && (f.stripPrefix === undefined || shortString(f.stripPrefix)) && (f.currency === undefined || twoDecimalCurrency(f.currency)) && (f.direction === undefined || (typeof f.direction === 'string' && ['incoming', 'outgoing', 'neutral'].includes(f.direction))) && (f.directionField === undefined || (shortString(f.directionField) && Object.hasOwn(all, f.directionField))) && (f.currencyField === undefined || (f.type === 'money' && textField(f.currencyField))) && (f.trimmedDecimals === undefined || (f.type === 'money' && typeof f.trimmedDecimals === 'boolean')) && (f.map === undefined || (object(f.map) && Object.keys(f.map).length <= 32 && Object.entries(f.map).every(([k, v]) => shortString(k) && shortString(v)))))
}

/** Bounded, non-executable column/framing helper. A model-selected schema produces proposals, not trusted validation facts. */
export function inspectFileWithSchema(input: { id: string; bytes: Uint8Array; role: Inspection['role'] }, schema: unknown): Inspection {
  if (!schemaShape(schema)) throw new Error('Invalid bounded file record schema')
  if (input.bytes.byteLength > FILE_PROCESSING_LIMITS.inputBytes) throw new Error('Input byte limit exceeded')
  const bytes = Buffer.from(input.bytes)
  const lines: Segment[] = []
  let start = 0
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) {
    lines.push({ start, end: i + 1 }); start = i + 1
    if (lines.length > FILE_PROCESSING_LIMITS.records * 8) throw new Error('Line count limit exceeded')
  }
  if (start < bytes.length) lines.push({ start, end: bytes.length })
  const skip = (text: string): boolean => (schema.skipBlank === true && text.trim() === '') || (schema.skipPrefixes ?? []).some(prefix => text.replace(/^\ufeff/, '').startsWith(prefix))
  const skipped = new Set<number>()
  const segments: Segment[] = []
  for (let i = 0; i < lines.length;) {
    const first = lines[i]!
    const firstText = bytes.subarray(first.start, first.end).toString('utf8')
    if (skip(firstText)) { segments.push(first); skipped.add(first.start); i++; continue }
    let count = 1
    while (count < schema.recordLines && i + count < lines.length) {
      const next = lines[i + count]!
      if (skip(bytes.subarray(next.start, next.end).toString('utf8'))) break
      count++
    }
    segments.push({ start: first.start, end: lines[i + count - 1]!.end }); i += count
  }
  return inspectFile(input, segments, (text, segment) => {
    if (skipped.has(segment.start)) return { kind: 'skipped' }
    if (text.length > 65_536) return { kind: 'rejected' }
    const rows = text.replace(/^\ufeff/, '').replace(/\r?\n$/, '').split(/\r?\n/)
    if (rows.length !== schema.recordLines) return { kind: 'rejected' }
    const cells = rows.map(row => splitCells(row, schema.delimiter, schema.quoted === true))
    if (cells.some(c => c === undefined)) return { kind: 'rejected' }
    const values: Values = {}
    const entries = Object.entries(schema.fields)
    // Resolve text directions before money, independent of schema property order.
    for (const [name, field] of [...entries.filter(([, f]) => f.type !== 'money'), ...entries.filter(([, f]) => f.type === 'money')]) {
      let value = cells[field.line]?.[field.column]?.trim()
      if (value === undefined || value.length > FILE_PROCESSING_LIMITS.string) return { kind: 'rejected' }
      if (field.stripPrefix) {
        if (!value.startsWith(field.stripPrefix)) return { kind: 'rejected' }
        value = value.slice(field.stripPrefix.length).trim()
      }
      if (field.map) {
        if (!Object.hasOwn(field.map, value)) return { kind: 'rejected' }
        value = field.map[value]!
      }
      if (field.type === 'text') values[name] = value
      else if (field.type === 'integer') {
        if (!/^[+-]?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) return { kind: 'rejected' }
        values[name] = Number(value)
      } else if (field.type === 'date') {
        const date = parseExplicitDate(value)
        if (!date.ok) return { kind: 'rejected' }
        values[name] = date.value
      } else {
        const direction = field.directionField ? values[field.directionField] : field.direction
        if (direction !== undefined && direction !== 'incoming' && direction !== 'outgoing' && direction !== 'neutral') return { kind: 'rejected' }
        const currency = field.currencyField ? values[field.currencyField] : field.currency
        if (currency !== undefined && typeof currency !== 'string') return { kind: 'rejected' }
        const money = parseMoney(value, { currency, direction, trimmedDecimals: field.trimmedDecimals === true })
        if (!money.ok) return { kind: 'rejected' }
        Object.assign(values, money.value)
      }
    }
    return { kind: 'record', values }
  })
}

/** Deterministic candidate producer for a tool wrapper. Acceptance still requires an independent context. */
export function reconcileFileProcessing(context: ValidationContext): FileProcessingResult {
  if (context.targets.length > FILE_PROCESSING_LIMITS.targets || context.inspections.length > FILE_PROCESSING_LIMITS.inputs || context.inspections.reduce((n, i) => n + i.records.length, 0) > FILE_PROCESSING_LIMITS.records) throw new Error('Reconciliation context limit exceeded')
  const sources = context.inspections.filter(i => i.role === 'source')
  const complete = sources.length > 0 && sources.every(i => i.complete && i.identity.counts.rejected === 0) && sources.some(i => i.records.length > 0)
  const records = sources.flatMap(i => i.records)
  const targetRecords = new Map(context.inspections.filter(i => i.role === 'target').flatMap(i => i.records).map(r => [refKey(r.ref), r.values]))
  const outcomes: ProcessingOutcome[] = context.targets.map(target => {
    const { candidates, reason } = narrowByText(records.filter(r => matchFileRecord(r.values, target.criteria, target.evidence)), targetRecords.get(refKey(target.ref)), target.textEvidence)
    if (!complete || candidates.length > FILE_PROCESSING_LIMITS.candidates) return { targetId: target.id, status: 'blocked', candidates: [], reason: !complete ? 'Source inspection is incomplete or contains rejected records.' : 'Plausible candidate count exceeds the result limit; narrow independent criteria or split the task.' }
    return { targetId: target.id, status: candidates.length === 0 ? 'not_found' : candidates.length === 1 ? 'matched' : 'ambiguous', candidates: candidates.map(c => ({ ref: { ...c.ref }, values: { ...c.values } })), ...(reason ? { reason } : {}) }
  })
  return { version: 1, inputs: context.inspections.map(i => ({ ...i.identity, counts: { ...i.identity.counts } })), outcomes }
}

function resultShape(x: unknown): x is FileProcessingResult {
  if (!object(x) || !exactKeys(x, ['version', 'inputs', 'outcomes']) || x.version !== 1 || !Array.isArray(x.inputs) || x.inputs.length > FILE_PROCESSING_LIMITS.inputs || !Array.isArray(x.outcomes) || x.outcomes.length > FILE_PROCESSING_LIMITS.targets) return false
  if (!x.inputs.every(i => object(i) && exactKeys(i, ['id', 'sha256', 'bytes', 'counts']) && shortString(i.id) && typeof i.sha256 === 'string' && /^[a-f0-9]{64}$/.test(i.sha256) && integer(i.bytes) && countsShape(i.counts))) return false
  return x.outcomes.every(o => object(o) && exactKeys(o, ['targetId', 'status', 'candidates'], ['reason']) && shortString(o.targetId) && typeof o.status === 'string' && ['matched', 'ambiguous', 'not_found', 'blocked'].includes(o.status) && (!Object.hasOwn(o, 'reason') || shortString(o.reason)) && Array.isArray(o.candidates) && o.candidates.length <= FILE_PROCESSING_LIMITS.candidates && o.candidates.every(c => object(c) && exactKeys(c, ['ref', 'values']) && refShape(c.ref) && valuesShape(c.values)))
}

/** Validates JSON against independent host inspection, never against a second claim in stdout. */
export function validateFileProcessingResult(jsonText: string, context: ValidationContext): ValidationResult {
  const diagnostics: ValidationDiagnostic[] = []
  const add = (code: string, path: string, message: string, recovery: string): void => {
    if (diagnostics.length < FILE_PROCESSING_LIMITS.diagnostics) diagnostics.push({ code, path, message, recovery })
  }
  const done = (): ValidationResult => ({ ok: diagnostics.length === 0, diagnostics })
  if (typeof jsonText !== 'string' || Buffer.byteLength(jsonText, 'utf8') > FILE_PROCESSING_LIMITS.jsonBytes) {
    add('RESULT_SIZE', '$', 'Result exceeds JSON byte limit', 'Emit one compact v1 JSON result within the stated limit.'); return done()
  }
  let result: unknown
  try { result = JSON.parse(jsonText) } catch { add('RESULT_JSON', '$', 'Result is not valid JSON', 'Return only the JSON object, without prose or fences.'); return done() }
  if (!resultShape(result)) { add('RESULT_SHAPE', '$', 'Invalid v1 result shape, field type, count arithmetic or limit', 'Use the v1 contract with bounded scalar values and exact fields.'); return done() }
  if (context.inspections.length > FILE_PROCESSING_LIMITS.inputs || context.targets.length > FILE_PROCESSING_LIMITS.targets) {
    add('CONTEXT_LIMIT', '$', 'Host context exceeds validation limits', 'Split the work into bounded independent batches.'); return done()
  }
  const inputs = new Map<string, Inspection>()
  const records = new Map<string, InspectedRecord>()
  let recordCount = 0
  for (const inspection of context.inspections) {
    const { identity, bytes } = inspection
    if (inputs.has(identity.id) || bytes.byteLength > FILE_PROCESSING_LIMITS.inputBytes || identity.sha256 !== fingerprintBytes(bytes) || identity.bytes !== bytes.byteLength || !countsShape(identity.counts) || identity.counts.parsed !== inspection.records.length) add('INSPECTION_INVALID', identity.id, 'Host identity/counts changed or duplicate input', 'Re-inspect the actual input bytes with the trusted adapter.')
    inputs.set(identity.id, inspection)
    recordCount += inspection.records.length
    for (const record of inspection.records) {
      if (!refShape(record.ref) || record.ref.inputId !== identity.id || record.ref.end > bytes.byteLength || record.ref.sha256 !== fingerprintBytes(bytes.subarray(record.ref.start, record.ref.end)) || !valuesShape(record.values) || records.has(refKey(record.ref))) add('INSPECTION_REF', identity.id, 'Host record reference is invalid or duplicated', 'Rebuild byte-span facts from the actual source.')
      records.set(refKey(record.ref), record)
    }
  }
  if (recordCount > FILE_PROCESSING_LIMITS.records) add('CONTEXT_LIMIT', '$', 'Too many inspected records', 'Split the work into bounded independent batches.')
  if (diagnostics.length) return done()
  const reported = new Set<string>()
  for (const input of result.inputs) {
    const actual = inputs.get(input.id)
    if (!actual || reported.has(input.id)) add('INPUT_LINEAGE', input.id, 'Unknown or duplicated input identity', 'Report each inspected input exactly once.')
    else {
      if (input.sha256 !== actual.identity.sha256 || input.bytes !== actual.bytes.byteLength) add('INPUT_FINGERPRINT', input.id, 'Fingerprint/size differs from actual bytes', 'Read the correct current input; do not reuse stale results.')
      for (const k of ['scanned', 'parsed', 'skipped', 'rejected'] as const) if (input.counts[k] !== actual.identity.counts[k]) add('COUNT_MISMATCH', `${input.id}.counts.${k}`, 'Reported count differs from independent inspection', 'Fix record framing/parsing and report actual counts.')
      if (input.counts.parsed === 0 && (actual.records.length > 0 || context.knownPositiveExamples?.some(e => e.ref.inputId === input.id))) add('ZERO_PARSE', input.id, 'Zero parsed records contradict observed examples', 'Inspect an observed record and fix the parser before concluding absence.')
    }
    reported.add(input.id)
  }
  for (const id of inputs.keys()) if (!reported.has(id)) add('INPUT_MISSING', id, 'Inspected input omitted', 'Include all input identities and counts.')
  for (const example of context.knownPositiveExamples ?? []) {
    const fact = records.get(refKey(example.ref))
    if (!fact || !equalValues(fact.values, example.values)) add('POSITIVE_EXAMPLE_MISSING', example.ref.inputId, 'Independent known record was not parsed correctly', 'Repair the host adapter/record framing against this independent example; do not change the oracle.')
  }
  const targetMap = new Map<string, ProcessingTarget>()
  const targetRefs = new Set<string>()
  if (context.targets.length === 0) add('TARGET_EMPTY', '$', 'No independently inspected targets registered', 'Inspect and register the requested target records before validating a result.')
  for (const inspection of context.inspections.filter(i => i.role === 'target')) if (!inspection.complete || inspection.identity.counts.rejected > 0) add('TARGET_INSPECTION_INCOMPLETE', inspection.identity.id, 'Target file inspection is incomplete; requested target count is not known', 'Repair target framing/parsing before claiming all targets have outcomes.')
  for (const target of context.targets) {
    const fact = records.get(refKey(target.ref))
    if (!shortString(target.id) || targetMap.has(target.id) || targetRefs.has(refKey(target.ref)) || !fact || inputs.get(target.ref.inputId)?.role !== 'target' || !valuesShape(target.criteria) || (fact && !satisfies(fact.values, target.criteria))) add('TARGET_LINEAGE', target.id, 'Target is duplicate, uninspected or has criteria not present in the target', 'Construct targets from independently inspected target records.')
    if (target.evidence !== undefined && (!valuesShape(target.evidence) || (fact && !satisfies(fact.values, target.evidence)))) add('TARGET_EVIDENCE', target.id, 'Optional matching evidence must come from the inspected target', 'Select reference/account/name values from the actual target; do not invent corroboration.')
    if (target.textEvidence !== undefined && (!textEvidenceShape(target.textEvidence) || (fact && typeof fact.values[target.textEvidence.targetField] !== 'string'))) add('TARGET_EVIDENCE', target.id, 'Counterparty text evidence must name a text field of the inspected target and at most six source text fields', 'Use the target counterparty field and source note/message/counterparty fields; never an account holder, own account or date.')
    targetRefs.add(refKey(target.ref))
    // Matching money always includes its currency and direction, even if a host omitted these criteria.
    if (fact && Object.hasOwn(fact.values, 'minorUnits') && (!['minorUnits', 'currency', 'direction'].every(k => Object.hasOwn(target.criteria, k) && target.criteria[k] === fact.values[k]))) add('TARGET_MONEY', target.id, 'Money criteria must preserve target amount, currency and direction', 'Include exact signed minorUnits, currency and direction from the target.')
    targetMap.set(target.id, target)
  }
  for (const inspection of context.inspections.filter(i => i.role === 'target')) for (const record of inspection.records) if (!targetRefs.has(refKey(record.ref))) add('TARGET_UNREGISTERED', inspection.identity.id, 'An inspected target record was omitted from the host target list', 'Register every inspected target record exactly once.')
  const sources = context.inspections.filter(i => i.role === 'source')
  const fullCoverage = sources.length > 0 && sources.every(i => i.complete && i.identity.counts.rejected === 0) && sources.some(i => i.records.length > 0)
  const sourceRecords = sources.flatMap(i => i.records)
  const seenTargets = new Set<string>()
  const used = new Set<string>()
  for (const [index, outcome] of result.outcomes.entries()) {
    const path = `outcomes[${index}]`
    const target = targetMap.get(outcome.targetId)
    if (!target || seenTargets.has(outcome.targetId)) { add('TARGET_COVERAGE', path, 'Unknown or duplicate target outcome', 'Return each requested target exactly once.'); continue }
    seenTargets.add(outcome.targetId)
    // Recomputed from host facts: the target's own inspected text, never the candidate result's reason.
    const plausible = narrowByText(sourceRecords.filter(r => matchFileRecord(r.values, target.criteria, target.evidence)), records.get(refKey(target.ref))?.values, textEvidenceShape(target.textEvidence) ? target.textEvidence : undefined).candidates
    const candidateKeys = new Set<string>()
    for (const candidate of outcome.candidates) {
      const key = refKey(candidate.ref)
      const fact = records.get(key)
      if (!fact || inputs.get(candidate.ref.inputId)?.role !== 'source') add('CANDIDATE_LINEAGE', path, 'Candidate does not reference an inspected source record', 'Cite the exact source input and byte span.')
      else {
        if (!equalValues(candidate.values, fact.values)) add('EVIDENCE_MISMATCH', path, 'Candidate fields differ from inspected source (including its date)', 'Copy source fields exactly; do not substitute target date or fabricate evidence.')
        if (!matchFileRecord(fact.values, target.criteria, target.evidence)) add('INCOMPATIBLE_MATCH', path, 'Source record conflicts with target criteria or nonempty optional evidence', 'Compare exact required keys; optional reference/account/name can reject only when both values are present and disagree.')
      }
      if (candidateKeys.has(key)) add('CANDIDATE_DUPLICATE', path, 'Candidate appears twice', 'Deduplicate candidates by input identity and span.')
      candidateKeys.add(key)
    }
    if (outcome.status === 'blocked') {
      if (!outcome.reason) add('BLOCKED_REASON', path, 'Blocked result needs a reason', 'Name the missing coverage or evidence required to proceed.')
      if (fullCoverage && plausible.length <= FILE_PROCESSING_LIMITS.candidates) add('UNJUSTIFIED_BLOCK', path, 'Complete inspection permits a deterministic outcome', 'Use matched, ambiguous or not_found with all inspected candidates.')
      continue
    }
    if (!fullCoverage) add('INCOMPLETE_COVERAGE', path, 'Cannot claim absence, uniqueness or complete candidate set from incomplete inspection', 'Repair coverage/rejections first, or report blocked with the concrete gap.')
    if (candidateKeys.size !== plausible.length || plausible.some(r => !candidateKeys.has(refKey(r.ref)))) add('CANDIDATE_COVERAGE', path, 'Candidate set omits or invents plausible records', 'Include every independently plausible candidate; disambiguate only with inspected criteria.')
    const expected = plausible.length === 0 ? 'not_found' : plausible.length === 1 ? 'matched' : 'ambiguous'
    if (outcome.status !== expected) add('OUTCOME_CERTAINTY', path, `Inspected evidence requires ${expected}`, 'Do not claim a certain match while multiple plausible candidates remain.')
    if (outcome.status === 'matched' && plausible.length === 1) {
      const key = refKey(plausible[0]!.ref)
      if (used.has(key) && !context.allowSourceReuse) add('SOURCE_REUSE', path, 'One source record was matched to multiple targets', 'Resolve the duplicate assignment or explicitly authorize reuse in host policy.')
      used.add(key)
    }
  }
  for (const id of targetMap.keys()) if (!seenTargets.has(id)) add('TARGET_MISSING', id, 'Requested target has no outcome', 'Return matched, ambiguous, not_found or blocked for this target.')
  return done()
}
