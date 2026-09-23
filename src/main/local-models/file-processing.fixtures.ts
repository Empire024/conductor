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

/** A Fio-style bank export (BOM, CRLF, every cell quoted, Czech header, separate currency column) and a headerless
 * tab-separated invoice list with a `Zobrazit PDF` filler line after each record. Every name and number is invented. */
export function generateFioFixture(): { source: Buffer; target: Buffer } {
  const quote = (cells: string[]): string => cells.map(c => `"${c.replace(/"/g, '""')}"`).join(';') + '\r\n'
  const own = '1234567890'
  const row = (date: string, amount: string, currency: string, counter: string, bank: string, message: string, note: string, type: string): string => quote([own, date, amount, currency, counter, bank, message, note, type])
  const card = (day: number, amount: string, shop: string): string => {
    const text = `Nákup: ${shop}, Hlavní ${day}, Praha, 110 00, CZE, dne ${day}.5.2026, částka  ${amount.replace('-', '').replace(',', '.')} CZK`
    return row(`${String(day).padStart(2, '0')}.05.2026`, amount, 'CZK', '', '', text, text, 'Karetní transakce')
  }
  const income = 'Bezhotovostní příjem'
  let source = '﻿' + quote(['Zdrojový účet', 'Datum', 'Objem', 'Měna', 'Protiúčet', 'Kód banky', 'Zpráva pro příjemce', 'Poznámka', 'Typ'])
  const rows = [
    row('02.05.2026', '400', 'CZK', '', '', '', '', 'Vklad v hotovosti'),
    row('03.05.2026', '-28004', 'CZK', '9876543210', '3030', '', 'nájem květen', 'Okamžitá odchozí platba'),
    // Unique amount with a payer note; one trimmed decimal digit (48250,5 = 48 250.50).
    row('06.05.2026', '48250,5', 'CZK', '1111222233', '0800', 'FA 2026-05-0001', 'NORTHWIND CZ SRO', income),
    // Two 15 000 payments from the same payer and one anonymous cash deposit of the same amount.
    row('07.05.2026', '15000', 'CZK', '5555666677', '0100', '', 'ORCHARD MEDIA SRO', income),
    row('14.05.2026', '15000', 'CZK', '', '', '', '', 'Vklad v hotovosti'),
    row('21.05.2026', '15000', 'CZK', '5555666677', '0100', 'faktura', 'ORCHARD MEDIA SRO', income),
    // Same 72 000 amount from two payers; the quoted message carries a delimiter and an escaped quote.
    row('09.05.2026', '72000', 'CZK', '5555666677', '0100', '', 'ORCHARD MEDIA S.R.O.', income),
    row('11.05.2026', '72000', 'CZK', '4444333322', '2010', 'Úhrada "FA 0002; květen"', 'KESTREL LABS SRO', income),
    // The 9 900 amount exists only as an outgoing payment.
    row('10.05.2026', '-9900', 'CZK', '7777888899', '0300', '', 'Tomáš Dvořák', 'Okamžitá odchozí platba'),
    // EUR income through the currency column, next to a CZK deposit of the same number.
    row('12.05.2026', '1800', 'EUR', 'DE89370400440532013000', 'COBADEFFXXX', '/DO2026-05-12/SP', 'HARBOR TRADING GMBH', income),
    row('13.05.2026', '1800', 'CZK', '', '', '', '', 'Vklad v hotovosti'),
    // A payer note truncated to 20 characters, next to another payer with the same amount.
    row('15.05.2026', '64000', 'CZK', '3333444455', '0600', '', 'WESTBROOK INTERNATIONAL S.R.O.'.slice(0, 20), income),
    row('18.05.2026', '64000', 'CZK', '6666777788', '0100', 'BLUEFIN STUDIO S.R.O.', 'BLUEFIN STUDIO S.R.O.', income),
    // A person paying under a shortened surname form.
    row('19.05.2026', '12500', 'CZK', '2222333344', '0800', '', 'NOVÁK JANA', income),
    row('20.05.2026', '12500', 'CZK', '4444333322', '2010', '', 'KESTREL LABS SRO', income),
    // An unsupported-but-harmless currency code: parsed, never matched.
    row('22.05.2026', '250', 'DLH', 'XX00000000000000', 'TESTXXXX', '', 'TEST PAYMENT', income),
    row('23.05.2026', '-45,5', 'EUR', '', '', 'Nákup: CAFE ALPINE, Wien, AUT', 'Nákup: CAFE ALPINE, Wien, AUT', 'Karetní transakce'),
    row('24.05.2026', '3100', 'CZK', '9999000011', '0100', 'GREYSTONE', 'GREYSTONE SRO', income),
    row('25.05.2026', '2000', 'CZK', '', '', '', '', 'Vklad v hotovosti'),
    row('26.05.2026', '-1500', 'CZK', '', '', '', '', 'Výběr v hotovosti')
  ]
  const shops = ['ALBERT HYPERMARKET', 'LIDL CESKA REPUBLIKA', 'DM DROGERIE', 'BENZINA 4455', 'KAVARNA U MOSTU', 'ROHLIK.CZ']
  for (let i = 0; i < 34; i++) rows.push(card(1 + (i * 7) % 28, `-${120 + i * 37},${i % 4 === 0 ? '9' : String(10 + (i * 13) % 90)}`, shops[i % shops.length]!))
  for (let i = 0; i < 6; i++) rows.push(row(`${String(27 + (i % 3)).padStart(2, '0')}.05.2026`, i % 2 ? '-9' : '-39', 'CZK', '', '', '', 'Poplatek za službu', i % 2 ? 'Poplatek' : 'Poplatek - platební karta'))
  source += rows.join('')
  const invoices: Array<[string, string, string, string]> = [
    ['2026-05-0001', '2026-05-04', 'NORTHWIND CZ s.r.o.', '48250.50 CZK'],
    ['2026-05-0002', '2026-05-05', 'KESTREL LABS s.r.o.', '72000.00 CZK'],
    ['2026-05-0003', '2026-05-06', 'ORCHARD MEDIA s.r.o.', '15000.00 CZK'],
    ['2026-05-0004', '2026-05-07', 'Tomáš Dvořák', '9900.00 CZK'],
    ['2026-05-0005', '2026-05-08', 'HARBOR TRADING GmbH', '1800.00 EUR'],
    ['2026-05-0006', '2026-05-09', 'WESTBROOK INTERNATIONAL s.r.o.', '64000.00 CZK'],
    ['2026-05-0007', '2026-05-10', 'Jana Nováková', '12500.00 CZK'],
    ['2026-05-0008', '2026-05-11', 'Petr Svoboda', '5400.00 CZK']
  ]
  const target = invoices.map(([id, date, name, amount]) => `${id}\t${date}\t${name}\t${amount}\tImportováno · platba neznámá\r\nZobrazit PDF`).join('\r\n')
  return { source: Buffer.from(source), target: Buffer.from(target) }
}
// Separately maintained expected outcomes for generateFioFixture, written by hand.
export const FIO_FIXTURE_ORACLE = Object.freeze({
  '2026-05-0001': { status: 'matched', sourceDates: ['2026-05-06'], narrowed: false },
  '2026-05-0002': { status: 'matched', sourceDates: ['2026-05-11'], narrowed: true },
  '2026-05-0003': { status: 'ambiguous', sourceDates: ['2026-05-07', '2026-05-21'], narrowed: true },
  '2026-05-0004': { status: 'not_found', sourceDates: [], narrowed: false },
  '2026-05-0005': { status: 'matched', sourceDates: ['2026-05-12'], narrowed: false },
  '2026-05-0006': { status: 'matched', sourceDates: ['2026-05-15'], narrowed: true },
  '2026-05-0007': { status: 'matched', sourceDates: ['2026-05-19'], narrowed: true },
  '2026-05-0008': { status: 'not_found', sourceDates: [], narrowed: false }
} as const)

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
