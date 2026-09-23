import { describe, expect, it } from 'vitest'
import { FILE_PROCESSING_LIMITS, inspectFile, inspectFileWithSchema, matchFileRecord, reconcileFileProcessing, parseExplicitDate, parseMoney, validateFileProcessingResult, splitCells, nameTokens, tokensSupport, narrowByText, type FileProcessingResult, type FileRecordSchema, type InspectedRecord, type ValidationContext, type Values } from './file-processing'
import { BANK_FIXTURE_ORACLE, INVENTORY_FIXTURE_ORACLE, generateBankFixture, generateInventoryFixture, inspectFixture } from './file-processing.fixtures'

// Builds submitted results from separately maintained fixture expectations, not the matching algorithm.
function oracleResult(context: ValidationContext, inventory = false): FileProcessingResult {
  const oracle = inventory ? INVENTORY_FIXTURE_ORACLE : BANK_FIXTURE_ORACLE
  const source = context.inspections.filter(i => i.role === 'source').flatMap(i => i.records)
  return { version: 1, inputs: context.inspections.map(i => structuredClone(i.identity)), outcomes: Object.entries(oracle).map(([targetId, expected]) => {
    const identifiers: readonly string[] = 'lots' in expected ? expected.lots : expected.transactions
    return { targetId, status: expected.status, candidates: identifiers.map(id => structuredClone(source.find(r => r.values[inventory ? 'lot' : 'transaction'] === id)!)) }
  }) }
}
const codes = (result: unknown, context: ValidationContext): string[] => validateFileProcessingResult(JSON.stringify(result), context).diagnostics.map(d => d.code)
const setup = (): { context: ValidationContext; result: FileProcessingResult } => {
  const context = inspectFixture(generateBankFixture('principal', 0))
  return { context, result: oracleResult(context) }
}

describe('exact locale values', () => {
  it.each(['85 000,00 CZK', '85\u00a0000,00 CZK', '85\u202f000,00 CZK', '85000.00 CZK', 'CZK 85000.00', '+85000,00 CZK'])('parses %s in exact minor units', text => {
    expect(parseMoney(text)).toEqual({ ok: true, value: { minorUnits: 8_500_000, currency: 'CZK', direction: 'incoming' } })
  })
  it('preserves sign and explicit direction without treating bad data as zero', () => {
    expect(parseMoney('85000.00', { currency: 'CZK', direction: 'outgoing' })).toEqual({ ok: true, value: { minorUnits: -8_500_000, currency: 'CZK', direction: 'outgoing' } })
    expect(parseMoney('-0.01 CZK')).toEqual({ ok: true, value: { minorUnits: -1, currency: 'CZK', direction: 'outgoing' } })
    expect(parseMoney('0.00 CZK')).toEqual({ ok: true, value: { minorUnits: 0, currency: 'CZK', direction: 'neutral' } })
    expect(parseMoney('90071992547409.91 CZK')).toMatchObject({ ok: true, value: { minorUnits: Number.MAX_SAFE_INTEGER } })
    expect(parseMoney('90071992547409.92 CZK').ok).toBe(false)
  })
  it.each(['', 'not money', 'NaN CZK', '85.000 CZK', '85,000 CZK', '85,000.00 CZK', '85.000,00 CZK', '8 50 00,00 CZK', '85 000.00 CZK', '85000,0 CZK', '85000.000 CZK', '1e3 CZK', '(12.00) CZK', '--12 CZK', '85000.00', '12.00 JPY', 'CZK 12.00 EUR', '1\n200 CZK'])('rejects invalid/ambiguous %s', text => expect(parseMoney(text).ok).toBe(false))
  it('rejects sign/currency/direction conflicts', () => {
    expect(parseMoney('-12.00 CZK', { direction: 'incoming' }).ok).toBe(false)
    expect(parseMoney('+12.00 CZK', { direction: 'outgoing' }).ok).toBe(false)
    expect(parseMoney('12.00 CZK', { currency: 'EUR' }).ok).toBe(false)
    expect(parseMoney('0.00 CZK', { direction: 'incoming' }).ok).toBe(false)
  })
  it.each([['15.04.2026', '2026-04-15'], ['23. 4. 2026', '2026-04-23'], ['2024-02-29', '2024-02-29'], ['31.12.2026', '2026-12-31']])('parses calendar date %s', (text, expected) => expect(parseExplicitDate(text)).toEqual({ ok: true, value: expected }))
  it.each(['2026-02-29', '31.04.2026', '00.01.2026', '2026-13-01', '0000-01-01', '04/05/2026', '15.04.26', '2026-04-15T00:00:00Z', '2026-4-15', '2100-02-29'])('rejects invalid/ambiguous date %s', text => expect(parseExplicitDate(text).ok).toBe(false))
})

describe('independent fixtures and evidence', () => {
  it.each(['principal', 'heldout'] as const)('validates the ~1 MiB %s fixture using the separate oracle', variant => {
    const fixture = generateBankFixture(variant)
    const bank = fixture.inputs.find(i => i.id === 'bank')!
    expect(bank.bytes.length).toBeGreaterThanOrEqual(1_048_576)
    expect(bank.bytes.length).toBeLessThan(1_049_000)
    const context = inspectFixture(fixture)
    expect(context.inspections.every(i => i.complete && i.identity.counts.rejected === 0)).toBe(true)
    expect(context.inspections[1]!.records.length).toBeGreaterThan(5000)
    const result = oracleResult(context)
    expect(validateFileProcessingResult(JSON.stringify(result), context)).toEqual({ ok: true, diagnostics: [] })
    for (const [id, expected] of Object.entries(BANK_FIXTURE_ORACLE)) {
      const outcome = result.outcomes.find(o => o.targetId === id)!
      expect(outcome.candidates.map(c => c.values.date)).toEqual(expected.sourceDates)
      for (const candidate of outcome.candidates) expect(candidate.values.minorUnits).toBe(expected.minorUnits)
    }
    expect(context.inspections[0]!.records[0]!.values.date).toBe('2026-04-15')
    expect(result.outcomes[0]!.candidates[0]!.values.date).toBe('2026-04-23')
  })
  it('supports inventory scalar keys without finance assumptions', () => {
    const context = inspectFixture(generateInventoryFixture())
    expect(codes(oracleResult(context, true), context)).toEqual([])
  })
  it('detects changed bytes even if model copies the old fingerprint', () => {
    const { context, result } = setup()
    context.inspections[1]!.bytes[12] = context.inspections[1]!.bytes[12]! ^ 1
    expect(codes(result, context)).toContain('INSPECTION_INVALID')
  })
  it.each(['sha256', 'bytes'] as const)('rejects fabricated input %s', key => {
    const { context, result } = setup()
    if (key === 'sha256') result.inputs[1]!.sha256 = 'a'.repeat(64)
    else result.inputs[1]!.bytes++
    expect(codes(result, context)).toContain('INPUT_FINGERPRINT')
  })
  it('rejects missing, duplicate and invented input identities', () => {
    const { context, result } = setup()
    result.inputs.pop()
    expect(codes(result, context)).toContain('INPUT_MISSING')
    result.inputs.push(result.inputs[0]!)
    expect(codes(result, context)).toContain('INPUT_LINEAGE')
    result.inputs[1] = { ...result.inputs[1]!, id: 'fabricated' }
    expect(codes(result, context)).toContain('INPUT_LINEAGE')
  })
  it('rejects zero-parse claims despite observed rows and independently detects a broken host parser', () => {
    const { context, result } = setup()
    expect(context.knownPositiveExamples).toHaveLength(1)
    const count = result.inputs[1]!.counts
    count.skipped += count.parsed; count.parsed = 0
    expect(codes(result, context)).toContain('ZERO_PARSE')
    const bank = context.inspections[1]!
    bank.identity.counts = { ...count }; bank.records = []
    expect(codes(result, context)).toContain('POSITIVE_EXAMPLE_MISSING')
  })
  it.each(['date', 'minorUnits', 'currency', 'direction', 'reference', 'account'] as const)('rejects fabricated source %s', field => {
    const { context, result } = setup()
    result.outcomes[0]!.candidates[0]!.values[field] = field === 'minorUnits' ? 0 : 'fabricated'
    expect(codes(result, context)).toContain('EVIDENCE_MISMATCH')
  })
  it('rejects replacing the payment date with the invoice date', () => {
    const { context, result } = setup()
    result.outcomes[0]!.candidates[0]!.values.date = '2026-04-15'
    expect(codes(result, context)).toContain('EVIDENCE_MISMATCH')
  })
  it.each(['wrong-ref', 'wrong-account', 'outgoing'])('rejects a real same-amount record with %s', scenario => {
    const { context, result } = setup()
    const transaction = scenario === 'wrong-ref' ? 'TX-004999' : scenario === 'wrong-account' ? 'TX-994107' : 'TX-884107'
    result.outcomes[0]!.candidates = [structuredClone(context.inspections[1]!.records.find(r => r.values.transaction === transaction)!)]
    expect(codes(result, context)).toContain('INCOMPATIBLE_MATCH')
  })
  it.each(['85000.00 EUR', '84999.99 CZK'])('rejects an independently inspected incompatible amount/currency %s', amount => {
    const fixture = generateBankFixture('principal', 0)
    const bank = fixture.inputs[1]!
    bank.bytes = Buffer.concat([bank.bytes, Buffer.from(`23.04.2026\t${amount}\tPŘÍJEM\tTX-INCOMPATIBLE\r\n  VS: 4107\tÚČET: 123456789/0100\tZPRÁVA: Úhrada\r\n`)])
    const context = inspectFixture(fixture)
    const result = oracleResult(context)
    result.outcomes[0]!.candidates = [context.inspections[1]!.records.find(r => r.values.transaction === 'TX-INCOMPATIBLE')!]
    expect(codes(result, context)).toContain('INCOMPATIBLE_MATCH')
  })
  it('rejects certainty when multiple plausible candidates remain', () => {
    const { context, result } = setup()
    result.outcomes[1]!.status = 'matched'
    result.outcomes[1]!.candidates.pop()
    expect(codes(result, context)).toContain('OUTCOME_CERTAINTY')
    expect(codes(result, context)).toContain('CANDIDATE_COVERAGE')
  })
  it('rejects missing, duplicated and invented targets', () => {
    const { context, result } = setup()
    result.outcomes.pop()
    expect(codes(result, context)).toContain('TARGET_MISSING')
    result.outcomes.push(result.outcomes[0]!)
    expect(codes(result, context)).toContain('TARGET_COVERAGE')
    result.outcomes[3] = { ...result.outcomes[3]!, targetId: 'invented' }
    expect(codes(result, context)).toContain('TARGET_COVERAGE')
  })
  it('rejects host target omission and wrong/duplicate target lineage', () => {
    const { context, result } = setup()
    context.targets.pop()
    expect(codes(result, context)).toContain('TARGET_UNREGISTERED')
    context.targets[1]!.ref = context.targets[0]!.ref
    expect(codes(result, context)).toContain('TARGET_LINEAGE')
    context.targets[0]!.ref = context.inspections[1]!.records[0]!.ref
    expect(codes(result, context)).toContain('TARGET_LINEAGE')
  })
  it('rejects fabricated byte spans, wrong lineage and duplicate candidates', () => {
    const { context, result } = setup()
    result.outcomes[0]!.candidates[0]!.ref.start++
    expect(codes(result, context)).toContain('CANDIDATE_LINEAGE')
    result.outcomes[0]!.candidates = [structuredClone(context.inspections[0]!.records[0]!)]
    expect(codes(result, context)).toContain('CANDIDATE_LINEAGE')
    result.outcomes[1]!.candidates.push(result.outcomes[1]!.candidates[0]!)
    expect(codes(result, context)).toContain('CANDIDATE_DUPLICATE')
  })
  it.each(['gap', 'rejected', 'empty'])('blocks absence and certainty with %s source coverage', condition => {
    const { context, result } = setup()
    const bank = context.inspections[1]!
    if (condition === 'gap') bank.complete = false
    else if (condition === 'rejected') { bank.identity.counts.rejected++; bank.identity.counts.scanned++ }
    else { bank.identity.counts = { scanned: 0, parsed: 0, skipped: 0, rejected: 0 }; bank.records = []; context.knownPositiveExamples = [] }
    result.inputs[1] = structuredClone(bank.identity)
    expect(codes(result, context)).toContain('INCOMPLETE_COVERAGE')
    for (const outcome of result.outcomes) { outcome.status = 'blocked'; outcome.reason = 'Source inspection incomplete'; outcome.candidates = [] }
    expect(codes(result, context)).toEqual([])
  })
  it('does not accept a blanket blocked answer with complete inspected facts', () => {
    const { context, result } = setup()
    result.outcomes[0]!.status = 'blocked'
    expect(codes(result, context)).toContain('BLOCKED_REASON')
    expect(codes(result, context)).toContain('UNJUSTIFIED_BLOCK')
  })
  it('rejects incomplete target inspection and an empty task', () => {
    const { context, result } = setup()
    context.inspections[0]!.complete = false
    expect(codes(result, context)).toContain('TARGET_INSPECTION_INCOMPLETE')
    expect(codes({ version: 1, inputs: [], outcomes: [] }, { inspections: [], targets: [] })).toContain('TARGET_EMPTY')
  })
  it('requires target money currency/direction and rejects arbitrary host criteria', () => {
    const { context, result } = setup()
    delete context.targets[0]!.criteria.currency
    expect(codes(result, context)).toContain('TARGET_MONEY')
    context.targets[0]!.criteria.account = 'different-account'
    expect(codes(result, context)).toContain('TARGET_LINEAGE')
  })
  it('rejects source reuse unless the host explicitly permits it', () => {
    const fixture = generateInventoryFixture()
    fixture.inputs[0]!.bytes = Buffer.from('id\tsku\twarehouse\nfirst\tA-100\tBrno\nsecond\tA-100\tBrno\n')
    const context = inspectFixture(fixture)
    const candidate = context.inspections[1]!.records[0]!
    const result: FileProcessingResult = { version: 1, inputs: context.inspections.map(i => i.identity), outcomes: context.targets.map(t => ({ targetId: t.id, status: 'matched', candidates: [candidate] })) }
    expect(codes(result, context)).toContain('SOURCE_REUSE')
    context.allowSourceReuse = true
    expect(codes(result, context)).toEqual([])
  })
})

describe('untrusted machine JSON bounds and inspection errors', () => {
  it.each([null, [], { version: 2, inputs: [], outcomes: [] }, { version: 1, inputs: [], outcomes: [], success: true }, { version: 1, inputs: 'all read', outcomes: [] }])('rejects invalid result shape %j', result => expect(codes(result, setup().context)).toContain('RESULT_SHAPE'))
  it('rejects prose, huge input, malicious nested values/prototype keys and illegal count arithmetic', () => {
    const { context, result } = setup()
    expect(validateFileProcessingResult('```json\n{}\n```', context).diagnostics[0]!.code).toBe('RESULT_JSON')
    expect(validateFileProcessingResult(' '.repeat(FILE_PROCESSING_LIMITS.jsonBytes + 1), context).diagnostics[0]!.code).toBe('RESULT_SIZE')
    const candidate = result.outcomes[0]!.candidates[0]!
    candidate.values = { ...candidate.values, ...JSON.parse('{"__proto__":{"authorized":true}}') }
    expect(codes(result, context)).toContain('RESULT_SHAPE')
    expect(({} as Record<string, unknown>).authorized).toBeUndefined()
    delete candidate.values.__proto__
    candidate.values.account = 'x'.repeat(513)
    expect(codes(result, context)).toContain('RESULT_SHAPE')
    result.inputs[0]!.counts.scanned = -1
    expect(codes(result, context)).toContain('RESULT_SHAPE')
  })
  it('bounds diagnostics and returns actionable recovery hints', () => {
    const { context, result } = setup()
    result.outcomes = Array.from({ length: 200 }, () => ({ targetId: 'invented', status: 'not_found', candidates: [] }))
    const validation = validateFileProcessingResult(JSON.stringify(result), context)
    expect(validation.diagnostics).toHaveLength(FILE_PROCESSING_LIMITS.diagnostics)
    expect(validation.diagnostics.every(d => d.path && d.message && d.recovery)).toBe(true)
  })
  it('rejects coercion traps and deeply nested fabricated evidence without throwing', () => {
    const { context, result } = setup()
    const poison = JSON.parse(JSON.stringify(result))
    poison.outcomes[0].status = { toString: null, valueOf: null }
    expect(codes(poison, context)).toContain('RESULT_SHAPE')
    poison.outcomes[0].status = 'matched'
    poison.outcomes[0].candidates[0].values.account = { nested: { stdout: 'verified' } }
    expect(codes(poison, context)).toContain('RESULT_SHAPE')
    poison.outcomes[0].candidates = Array.from({ length: 257 }, () => result.outcomes[0]!.candidates[0])
    expect(codes(poison, context)).toContain('RESULT_SHAPE')
  })
  it('inspects UTF-8 byte spans, gaps, overlap, invalid encoding and parser errors', () => {
    const bytes = Buffer.from('číslo\r\n')
    const valid = inspectFile({ id: 'x', bytes, role: 'source' }, [{ start: 0, end: bytes.length }], text => ({ kind: 'record', values: { text } }))
    expect(valid.complete).toBe(true)
    expect(valid.records[0]!.ref.end).toBe(bytes.length)
    const gap = inspectFile({ id: 'x', bytes, role: 'source' }, [{ start: 2, end: bytes.length }], () => ({ kind: 'skipped' }))
    expect(gap.complete).toBe(false)
    expect(() => inspectFile({ id: 'x', bytes, role: 'source' }, [{ start: 0, end: 4 }, { start: 3, end: 5 }], () => ({ kind: 'skipped' }))).toThrow('overlapping')
    expect(inspectFile({ id: 'x', bytes: Buffer.from([255]), role: 'source' }, [{ start: 0, end: 1 }], () => ({ kind: 'record', values: { text: 'fabricated' } })).identity.counts.rejected).toBe(1)
    expect(inspectFile({ id: 'x', bytes, role: 'source' }, [{ start: 0, end: bytes.length }], () => { throw new Error('bad parser') }).identity.counts.rejected).toBe(1)
  })
})

describe('bounded selected-schema helper', () => {
  const schema: FileRecordSchema = { delimiter: '\t', recordLines: 2, skipPrefixes: ['DATUM\t'], fields: {
    money: { line: 0, column: 1, type: 'money', directionField: 'direction' },
    date: { line: 0, column: 0, type: 'date' },
    direction: { line: 0, column: 2, type: 'text', map: { PŘÍJEM: 'incoming', VÝDAJ: 'outgoing' } },
    transaction: { line: 0, column: 3, type: 'text' },
    reference: { line: 1, column: 0, type: 'text', stripPrefix: 'VS:' },
    account: { line: 1, column: 1, type: 'text', stripPrefix: 'ÚČET:' }
  } }
  it('parses multiline BOM/CRLF bank records and matches the independent fixture oracle', () => {
    const fixture = generateBankFixture()
    const trusted = inspectFixture(fixture)
    const proposal = inspectFileWithSchema(fixture.inputs[1]!, schema)
    expect(proposal).toEqual(trusted.inspections[1])
    const proposedContext = { ...trusted, inspections: [trusted.inspections[0]!, proposal] }
    const result = reconcileFileProcessing(proposedContext)
    expect(result).toEqual(oracleResult(trusted))
    expect(codes(result, trusted)).toEqual([])
  })
  it('does not trust a schema selected to skip every positive record', () => {
    const fixture = generateBankFixture('principal', 0)
    const trusted = inspectFixture(fixture)
    const dishonest = inspectFileWithSchema(fixture.inputs[1]!, { ...schema, skipPrefixes: ['DATUM', '23.', '15.', '2026', '24.', '25.', '  '] })
    expect(dishonest.records).toHaveLength(0)
    const result = reconcileFileProcessing({ ...trusted, inspections: [trusted.inspections[0]!, dishonest] })
    expect(codes(result, trusted)).toContain('ZERO_PARSE')
  })
  it('supports generic inventory integer columns and detects malformed values', () => {
    const input = generateInventoryFixture().inputs[1]!
    const inventory: FileRecordSchema = { delimiter: '\t', recordLines: 1, skipPrefixes: ['lot\t'], fields: { lot: { line: 0, column: 0, type: 'text' }, sku: { line: 0, column: 1, type: 'text' }, warehouse: { line: 0, column: 2, type: 'text' }, quantity: { line: 0, column: 3, type: 'integer' } } }
    expect(inspectFileWithSchema(input, inventory).records[0]!.values.quantity).toBe(12)
    input.bytes = Buffer.from(input.bytes.toString().replace('\t12\n', '\tNaN\n'))
    expect(inspectFileWithSchema(input, inventory).identity.counts.rejected).toBe(1)
  })
  it.each([{ ...schema, recordLines: 0 }, { ...schema, recordLines: 9 }, { ...schema, delimiter: 'regex' }, { ...schema, regex: '(a+)+' }, { ...schema, fields: { bad: { type: { toString: null }, line: 0, column: 0 } } }, { ...schema, fields: { bad: { type: 'text', line: 0, column: 999 } } }])('rejects an untrusted executable/out-of-bound schema', invalid => {
    expect(() => inspectFileWithSchema(generateBankFixture('principal', 0).inputs[1]!, invalid)).toThrow('Invalid bounded')
  })
  it('rejects missing continuation, invalid dates, amounts and direction maps instead of inventing values', () => {
    for (const change of [(s: string) => s.replace('23.04.2026', '31.04.2026'), (s: string) => s.replace('85\u00a0000,00', 'invalid'), (s: string) => s.replace('PŘÍJEM', 'unknown'), (s: string) => s.replace(/  VS: 4107[^\n]*\n/, '')]) {
      const fixture = generateBankFixture('principal', 0)
      const input = fixture.inputs[1]!
      input.bytes = Buffer.from(change(input.bytes.toString()))
      expect(inspectFileWithSchema(input, schema).identity.counts.rejected).toBeGreaterThan(0)
    }
  })
})

describe('Fio-style cells, currency codes and counterparty tokens', () => {
  it('accepts any two-decimal three-letter code and refuses zero-decimal ones', () => {
    expect(parseMoney('250', { currency: 'DLH' })).toEqual({ ok: true, value: { minorUnits: 25_000, currency: 'DLH', direction: 'incoming' } })
    expect(parseMoney('12.00 SEK')).toMatchObject({ ok: true, value: { currency: 'SEK' } })
    for (const code of ['JPY', 'KRW', 'ISK', 'CLP', 'VND', 'XAF', 'XOF']) expect(parseMoney('12', { currency: code })).toEqual({ ok: false, error: `Currency ${code} does not use two decimal places; it is not supported` })
    expect(parseMoney('12', { currency: 'Kč' }).ok).toBe(false)
  })
  it('accepts a dropped trailing decimal zero only when the schema says so', () => {
    expect(parseMoney('-129,9', { currency: 'CZK', trimmedDecimals: true })).toEqual({ ok: true, value: { minorUnits: -12_990, currency: 'CZK', direction: 'outgoing' } })
    expect(parseMoney('-274,12', { currency: 'CZK', trimmedDecimals: true })).toMatchObject({ ok: true, value: { minorUnits: -27_412 } })
    expect(parseMoney('-129,9', { currency: 'CZK' }).ok).toBe(false)
    for (const text of ['85.000', '1,2,3', '12,345', '12,']) expect(parseMoney(text, { currency: 'CZK', trimmedDecimals: true }).ok).toBe(false)
  })
  it('splits RFC 4180 quoted cells', () => {
    expect(splitCells('"a";"b ""c""; d";"";e', ';', true)).toEqual(['a', 'b "c"; d', '', 'e'])
    expect(splitCells('"a";"b', ';', true)).toBeUndefined()
    expect(splitCells('"a"x;"b"', ';', true)).toBeUndefined()
    expect(splitCells('"a";"b"', ';')).toEqual(['"a"', '"b"'])
  })
  it('normalizes name tokens and supports truncation and surname variants', () => {
    expect(nameTokens('NORTHWIND CZ, s.r.o.')).toEqual(['northwind'])
    expect(nameTokens('Jana Nováková')).toEqual(['jana', 'novakova'])
    expect(tokensSupport(nameTokens('WESTBROOK INTERNATIONAL s.r.o.'), nameTokens('INTERNATIO'))).toBe(true)
    expect(tokensSupport(nameTokens('Jana Nováková'), nameTokens('NOVÁK'))).toBe(true)
    expect(tokensSupport(nameTokens('KESTREL LABS s.r.o.'), nameTokens('ORCHARD MEDIA SRO'))).toBe(false)
    expect(tokensSupport(nameTokens('Spol s.r.o. Ltd'), nameTokens('SPOL SRO LTD'))).toBe(false)
  })
  it('narrows only when a candidate supports the name and keeps unsupported sets whole', () => {
    const record = (start: number, values: Values): InspectedRecord => ({ ref: { inputId: 's', start, end: start + 1, sha256: 'a'.repeat(64) }, values })
    const evidence = { targetField: 'counterparty', sourceFields: ['note', 'message'] }
    const target = { counterparty: 'KESTREL LABS s.r.o.' }
    const named = record(0, { note: 'KESTREL LABS SRO' }), other = record(1, { note: 'ORCHARD MEDIA' }), blank = record(2, { note: '', message: '' })
    expect(narrowByText([named, other, blank], target, evidence)).toEqual({ candidates: [named], reason: 'counterparty evidence narrowed 3 amount candidates to 1' })
    expect(narrowByText([other, blank], target, evidence)).toEqual({ candidates: [other, blank] })
    expect(narrowByText([named], target, evidence)).toEqual({ candidates: [named] })
    expect(narrowByText([named, other], { counterparty: 's.r.o.' }, evidence)).toEqual({ candidates: [named, other] })
    expect(narrowByText([named, other], target, undefined)).toEqual({ candidates: [named, other] })
  })
  it('validates quoted, currencyField and trimmedDecimals schema options', () => {
    const input = { id: 's', role: 'source' as const, bytes: Buffer.from('"1";"-129,9";"CZK"\r\n"2";"5";"DLH"\r\n') }
    const fields = { id: { line: 0, column: 0, type: 'text' as const }, amount: { line: 0, column: 1, type: 'money' as const, currencyField: 'code', trimmedDecimals: true }, code: { line: 0, column: 2, type: 'text' as const } }
    const records = inspectFileWithSchema(input, { delimiter: ';', recordLines: 1, quoted: true, fields }).records.map(r => r.values)
    expect(records).toEqual([{ id: '1', code: 'CZK', minorUnits: -12_990, currency: 'CZK', direction: 'outgoing' }, { id: '2', code: 'DLH', minorUnits: 500, currency: 'DLH', direction: 'incoming' }])
    expect(inspectFileWithSchema(input, { delimiter: ';', recordLines: 1, fields }).identity.counts.rejected).toBe(2)
    for (const invalid of [{ quoted: 'yes' }, { fields: { ...fields, amount: { ...fields.amount, currencyField: 'missing' } } }, { fields: { ...fields, amount: { ...fields.amount, currencyField: 'id', type: 'text' } } }, { fields: { ...fields, amount: { ...fields.amount, trimmedDecimals: 1 } } }, { fields: { ...fields, amount: { ...fields.amount, currency: 'JPY' } } }]) {
      expect(() => inspectFileWithSchema(input, { delimiter: ';', recordLines: 1, fields, ...invalid })).toThrow('Invalid bounded')
    }
  })
})

describe('optional matching evidence', () => {
  it('matches exact required keys and refines only when optional values are both present', () => {
    const base = { minorUnits: 10000, currency: 'CZK', direction: 'incoming' }
    expect(matchFileRecord({ ...base, reference: '4107' }, base, { reference: '4107' })).toBe(true)
    expect(matchFileRecord({ ...base, reference: '9999' }, base, { reference: '4107' })).toBe(false)
    for (const reference of ['', '  ', null]) expect(matchFileRecord({ ...base, reference }, base, { reference: '4107' })).toBe(true)
    expect(matchFileRecord(base, base, { reference: '4107' })).toBe(true)
    expect(matchFileRecord({ ...base, reference: '4107' }, base, { reference: '' })).toBe(true)
    expect(matchFileRecord({ ...base, currency: 'EUR' }, base)).toBe(false)
    expect(matchFileRecord({ value: null }, { value: null })).toBe(false)
    expect(matchFileRecord({ value: 0 }, { value: 0 })).toBe(true)
    expect(matchFileRecord({ ...base, date: '2026-04-23' }, base, { account: '' })).toBe(true)
  })
  it('keeps missing-reference candidates plausible and rejects unsupported certainty', () => {
    const { context } = setup()
    const target = context.targets[0]!
    target.evidence = { reference: target.criteria.reference!, account: target.criteria.account! }
    delete target.criteria.reference; delete target.criteria.account
    expect(reconcileFileProcessing(context).outcomes[0]!.status).toBe('matched')
    const bank = context.inspections[1]!
    // Host fact for this test deliberately observes a missing reference on the otherwise compatible row.
    const missing = bank.records.find(r => r.values.transaction === 'TX-004999')!
    missing.values.reference = ''
    const result = reconcileFileProcessing(context)
    expect(result.outcomes[0]!.status).toBe('ambiguous')
    expect(result.outcomes[0]!.candidates).toHaveLength(2)
    expect(codes(result, context)).toEqual([])
    result.outcomes[0]!.status = 'matched'; result.outcomes[0]!.candidates.pop()
    expect(codes(result, context)).toContain('OUTCOME_CERTAINTY')
    target.evidence.account = 'fabricated'
    expect(codes(result, context)).toContain('TARGET_EVIDENCE')
  })
})
