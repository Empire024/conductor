import { createHash } from 'node:crypto'

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }
export type Direction = 'incoming' | 'outgoing' | 'neutral'
export interface Money { minorUnits: number; currency: string; direction: Direction }
const currencies = new Set(['CZK', 'EUR', 'USD', 'GBP', 'CHF', 'PLN'])
const fail = (error: string): Parsed<never> => ({ ok: false, error })

/** Explicit two-decimal currencies only. No float arithmetic, rounding, inferred separators or zero fallback. */
export function parseMoney(text: string, options: { currency?: string; direction?: Direction } = {}): Parsed<Money> {
  if (typeof text !== 'string' || text.length > 128) return fail('Invalid money text')
  let value = text.trim()
  let currency = options.currency
  const token = /^(?:([A-Z]{3})\s+)?([+-]?[\d .,\u00a0\u202f]+?)(?:\s+([A-Z]{3}))?$/.exec(value)
  if (!token || (token[1] && token[3])) return fail('Expected one exact amount and at most one currency')
  const explicit = token[1] ?? token[3]
  if (explicit && currency && explicit !== currency) return fail('Currency conflict')
  currency = explicit ?? currency
  if (!currency || !currencies.has(currency)) return fail('An explicit supported two-decimal currency is required')
  value = token[2]!.replace(/[\u00a0\u202f]/g, ' ')
  const negative = value.startsWith('-')
  const signed = /^[+-]/.test(value)
  value = value.replace(/^[+-]/, '')
  // A dot is exclusively the decimal separator; grouped numbers use spaces and comma decimals.
  if (!/^(?:\d+(?:[.,]\d{2})?|\d{1,3}(?: \d{3})+(?:,\d{2})?)$/.test(value)) return fail('Ambiguous or invalid separators/precision')
  const parts = value.replace(/ /g, '').split(/[.,]/)
  const magnitude = BigInt(parts[0]!) * 100n + BigInt(parts[1] ?? '0')
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
export interface ProcessingTarget { id: string; ref: SourceRef; criteria: Values }
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
    const plausible = sourceRecords.filter(r => satisfies(r.values, target.criteria))
    const candidateKeys = new Set<string>()
    for (const candidate of outcome.candidates) {
      const key = refKey(candidate.ref)
      const fact = records.get(key)
      if (!fact || inputs.get(candidate.ref.inputId)?.role !== 'source') add('CANDIDATE_LINEAGE', path, 'Candidate does not reference an inspected source record', 'Cite the exact source input and byte span.')
      else {
        if (!equalValues(candidate.values, fact.values)) add('EVIDENCE_MISMATCH', path, 'Candidate fields differ from inspected source (including its date)', 'Copy source fields exactly; do not substitute target date or fabricate evidence.')
        if (!satisfies(fact.values, target.criteria)) add('INCOMPATIBLE_MATCH', path, 'Source record conflicts with target criteria', 'Compare exact money/currency/direction and required reference/account or generic keys.')
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
