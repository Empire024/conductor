/** Evaluator-only fixtures. Never copy this module, adapters or oracle into a live model workspace. */
import { fingerprintBytes, inspectFile, parseExplicitDate, parseMoney, type InspectedRecord, type Inspection, type RecordParse, type Segment, type ValidationContext, type Values } from './file-processing'

export interface FixtureInput { id: string; name: string; role: 'source' | 'target'; bytes: Buffer }
export interface SyntheticFixture { variant: 'principal' | 'heldout' | 'inventory'; inputs: FixtureInput[] }

/** Byte-size controlled deterministic data. Only `.inputs[*].bytes` belongs in a model workspace. */
export function generateBankFixture(variant: 'principal' | 'heldout' = 'principal', minimumBytes = 1_048_576): SyntheticFixture {
  if (!Number.isSafeInteger(minimumBytes) || minimumBytes < 0 || minimumBytes > 8_388_608) throw new Error('Fixture size outside 0..8 MiB')
  const invoiceHeader = 'id\tdate\tamount\tdirection\treference\taccount\r\n'
  const invoices = invoiceHeader + [
    'invoice-positive\t15.04.2026\t85\u202f000,00 CZK\tPŘÍJEM\t4107\t123456789/0100',
    'invoice-ambiguous\t16.04.2026\t1 200,00 CZK\tPŘÍJEM\t5108\t456789123/0300',
    'invoice-absent\t17.04.2026\t999.99 CZK\tPŘÍJEM\t9109\t555555555/0800',
    'invoice-outgoing\t18.04.2026\t1 200,00 CZK\tVÝDAJ\t6109\t789123456/0600'
  ].join('\r\n') + '\r\n'
  const header = variant === 'principal' ? 'DATUM\tČÁSTKA\tSMĚR\tID TRANSAKCE\r\n' : '# account|reference|direction|amount|date|transaction\n'
  const row = (date: string, amount: string, direction: string, transaction: string, reference: string, account: string): string => variant === 'principal'
    ? `${date}\t${amount}\t${direction}\t${transaction}\r\n  VS: ${reference}\tÚČET: ${account}\tZPRÁVA: Úhrada faktury – číslo ${reference}\r\n`
    : `${account}|${reference}|${direction}|${amount}|${date}|${transaction}\n`
  let bank = '\ufeff' + header
  // Hand-authored examples, deliberately independent of the evaluator oracle below.
  bank += row('23.04.2026', '85\u00a0000,00 CZK', 'PŘÍJEM', 'TX-004107', '4107', '123456789/0100')
  bank += row('15.04.2026', '85000.00 CZK', 'PŘÍJEM', 'TX-994107', '4107', '999999999/0100')
  bank += row('23.04.2026', '85 000,00 CZK', 'PŘÍJEM', 'TX-004999', '4999', '123456789/0100')
  bank += row('23.04.2026', '-85000.00 CZK', 'VÝDAJ', 'TX-884107', '4107', '123456789/0100')
  bank += row('2026-04-22', '1200.00 CZK', 'PŘÍJEM', 'TX-005108', '5108', '456789123/0300')
  bank += row('24.04.2026', '1\u202f200,00 CZK', 'PŘÍJEM', 'TX-775108', '5108', '456789123/0300')
  bank += row('25.04.2026', '1 200,00 CZK', 'VÝDAJ', 'TX-006109', '6109', '789123456/0600')
  let byteLength = Buffer.byteLength(bank)
  for (let i = 0; byteLength < minimumBytes; i++) {
    const addition = (i % 61 === 0 ? header : '') + row('2026-04-23', i % 5 === 0 ? '85 000,00 CZK' : `${100 + i % 900}.00 CZK`, i % 2 ? 'PŘÍJEM' : 'VÝDAJ', `FILL-${String(i).padStart(8, '0')}`, `8${String(i % 1000).padStart(3, '0')}`, '222222222/2010')
    bank += addition
    byteLength += Buffer.byteLength(addition)
  }
  return { variant, inputs: [{ id: 'invoices', name: 'invoices.tsv', role: 'target', bytes: Buffer.from('\ufeff' + invoices) }, { id: 'bank', name: variant === 'principal' ? 'bank.txt' : 'bank.psv', role: 'source', bytes: Buffer.from(bank) }] }
}

export function generateInventoryFixture(): SyntheticFixture {
  return { variant: 'inventory', inputs: [
    { id: 'requests', name: 'requests.tsv', role: 'target', bytes: Buffer.from('id\tsku\twarehouse\nrequest-one\tA-100\tBrno\nrequest-many\tB-200\tPraha\nrequest-none\tC-300\tBrno\n') },
    { id: 'stock', name: 'stock.tsv', role: 'source', bytes: Buffer.from('lot\tsku\twarehouse\tquantity\nlot-1\tA-100\tBrno\t12\nlot-2\tB-200\tPraha\t4\nlot-3\tB-200\tPraha\t9\nlot-4\tA-100\tPraha\t12\n') }
  ] }
}

// Separately maintained expected outcomes. Never computed by matching/parser code under test.
export const BANK_FIXTURE_ORACLE = Object.freeze({
  'invoice-positive': { status: 'matched', transactions: ['TX-004107'], sourceDates: ['2026-04-23'], minorUnits: 8_500_000 },
  'invoice-ambiguous': { status: 'ambiguous', transactions: ['TX-005108', 'TX-775108'], sourceDates: ['2026-04-22', '2026-04-24'], minorUnits: 120_000 },
  'invoice-absent': { status: 'not_found', transactions: [], sourceDates: [], minorUnits: 99_999 },
  'invoice-outgoing': { status: 'matched', transactions: ['TX-006109'], sourceDates: ['2026-04-25'], minorUnits: -120_000 }
} as const)
export const INVENTORY_FIXTURE_ORACLE = Object.freeze({ 'request-one': { status: 'matched', lots: ['lot-1'] }, 'request-many': { status: 'ambiguous', lots: ['lot-2', 'lot-3'] }, 'request-none': { status: 'not_found', lots: [] } } as const)

/** Fixture-specific trusted adapter; deliberately not a universal bank/document parser. */
export function inspectFixture(fixture: SyntheticFixture): ValidationContext {
  const inspections: Inspection[] = fixture.inputs.map(input => {
    const segments: Segment[] = []
    let start = 0
    for (let i = 0; i < input.bytes.length; i++) {
      if (input.bytes[i] !== 10) continue
      if (fixture.variant === 'principal' && input.id === 'bank' && input.bytes[i + 1] === 32) continue
      segments.push({ start, end: i + 1 }); start = i + 1
    }
    if (start < input.bytes.length) segments.push({ start, end: input.bytes.length })
    return inspectFile(input, segments, raw => {
      const text = raw.replace(/^\ufeff/, '').trimEnd()
      if (/^(id\t|lot\t|DATUM\t|# account\|)/.test(text)) return { kind: 'skipped' }
      if (fixture.variant === 'inventory') {
        const parts = text.split('\t')
        if (input.role === 'target' && parts.length === 3) return { kind: 'record', values: { id: parts[0]!, sku: parts[1]!, warehouse: parts[2]! } }
        if (input.role === 'source' && parts.length === 4 && /^\d+$/.test(parts[3]!)) return { kind: 'record', values: { lot: parts[0]!, sku: parts[1]!, warehouse: parts[2]!, quantity: Number(parts[3]) } }
        return { kind: 'rejected' }
      }
      if (input.role === 'target') {
        const p = text.split('\t')
        return p.length === 6 ? bankValues(p[1]!, p[2]!, p[3]!, { id: p[0]!, reference: p[4]!, account: p[5]! }) : { kind: 'rejected' }
      }
      if (fixture.variant === 'heldout') {
        const p = text.split('|')
        return p.length === 6 ? bankValues(p[4]!, p[3]!, p[2]!, { transaction: p[5]!, reference: p[1]!, account: p[0]! }) : { kind: 'rejected' }
      }
      const m = /^([^\t]+)\t([^\t]+)\t([^\t]+)\t([^\r]+)\r\n  VS: ([^\t]+)\tÚČET: ([^\t]+)\tZPRÁVA: [^\r\n]+$/.exec(text)
      return m ? bankValues(m[1]!, m[2]!, m[3]!, { transaction: m[4]!, reference: m[5]!, account: m[6]! }) : { kind: 'rejected' }
    })
  })
  const targets = inspections.filter(i => i.role === 'target').flatMap(i => i.records.map(r => ({ id: String(r.values.id), ref: r.ref, criteria: fixture.variant === 'inventory'
    ? { sku: r.values.sku!, warehouse: r.values.warehouse! }
    : { minorUnits: r.values.minorUnits!, currency: r.values.currency!, direction: r.values.direction!, reference: r.values.reference!, account: r.values.account! } as Values })))
  return { inspections, targets, knownPositiveExamples: fixture.variant === 'inventory' ? [] : [independentBankExample(fixture)] }
}

/** Independent observation: exact raw span and literal expected fields, never the adapter's output. */
export function independentBankExample(fixture: SyntheticFixture): InspectedRecord {
  const input = fixture.inputs.find(i => i.id === 'bank')
  if (!input) throw new Error('Bank fixture required')
  const raw = Buffer.from(fixture.variant === 'principal'
    ? '23.04.2026\t85\u00a0000,00 CZK\tPŘÍJEM\tTX-004107\r\n  VS: 4107\tÚČET: 123456789/0100\tZPRÁVA: Úhrada faktury – číslo 4107\r\n'
    : '123456789/0100|4107|PŘÍJEM|85\u00a0000,00 CZK|23.04.2026|TX-004107\n')
  const start = input.bytes.indexOf(raw)
  if (start < 0) throw new Error('Independent positive example missing from fixture bytes')
  return { ref: { inputId: 'bank', start, end: start + raw.length, sha256: fingerprintBytes(raw) }, values: { transaction: 'TX-004107', reference: '4107', account: '123456789/0100', minorUnits: 8_500_000, currency: 'CZK', direction: 'incoming', date: '2026-04-23' } }
}

function bankValues(dateText: string, amount: string, directionText: string, fields: Values): RecordParse {
  if (!['PŘÍJEM', 'VÝDAJ'].includes(directionText)) return { kind: 'rejected' }
  const money = parseMoney(amount, { direction: directionText === 'PŘÍJEM' ? 'incoming' : 'outgoing' })
  const date = parseExplicitDate(dateText)
  return money.ok && date.ok ? { kind: 'record', values: { ...fields, ...money.value, date: date.value } } : { kind: 'rejected' }
}
