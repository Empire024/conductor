import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { calculateExpressions, evaluateExpression, formatNumber, parseAmount } from './calculate.ts'
import { runTool, toolSpecs } from './tools.ts'

// VR8c's B1 data: per-file sums were right 2/8 (groceries 299.5 or 319.5 against 350.8).
const jan = 'category,amount\nrent,950\ngroceries,212.4\ntransport,64\ngroceries,87.1\nutilities,118.25\ntransport,22.5\nfun,45\ngroceries,51.3\n'
const feb = 'category,amount\nrent,950\ngroceries,198.6\nutilities,131.75\ntransport,88\nfun,120\ngroceries,76.2\nfun,35.5\ntransport,12\n'

describe('calculate: exact arithmetic for a local model', () => {
  const roots: string[] = []
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
  const workspace = (files: Record<string, string>): string => {
    const root = mkdtempSync(join(tmpdir(), 'conductor-calculate-'))
    roots.push(root)
    for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content)
    return root
  }
  const tool = (root: string, args: Record<string, unknown>) => runTool('calculate', JSON.stringify(args), { workspace: root, readOnly: true, sandbox: null, timeoutSec: 5 })

  it('evaluates formulas without floating-point noise and refuses anything but arithmetic', () => {
    expect(formatNumber(evaluateExpression('212.4 + 87.1 + 51.3'))).toBe('350.8')
    expect(formatNumber(evaluateExpression('(1310 - 1200) / 1200 * 100'))).toBe('9.1666666667')
    expect(formatNumber(evaluateExpression('round((1310 - 1200) / 1200 * 100, 2)'))).toBe('9.17')
    expect(formatNumber(evaluateExpression('sum(950, 950) + avg(1, 2, 3) - max(1, 4) + min(2, 3)'))).toBe('1900')
    expect(formatNumber(evaluateExpression('2^10 + 2**2 - -1'))).toBe('1029')
    expect(formatNumber(evaluateExpression('15% * 240'))).toBe('36')
    expect(formatNumber(evaluateExpression('$1,234.50 + €10'))).toBe('1244.5')
    expect(formatNumber(evaluateExpression('3 x 4'))).toBe('12')
    expect(formatNumber(0.1 + 0.2)).toBe('0.3')
    for (const bad of ['process.exit(1)', 'constructor', '1 +', '(1 + 2', '1 / 0', '', 'require("fs")'])
      expect(() => formatNumber(evaluateExpression(bad)), bad).toThrow()
  })

  it('reads money cells as a spreadsheet would', () => {
    expect(parseAmount(' 1,234.50 ')).toBe(1234.5)
    expect(parseAmount('12,50')).toBe(12.5)
    expect(parseAmount('(12.50)')).toBe(-12.5)
    expect(parseAmount('$99')).toBe(99)
    expect(parseAmount('n/a')).toBeUndefined()
  })

  it('computes several labelled results at once, one bad formula not spoiling the rest', () => {
    expect(calculateExpressions(undefined, { rent: '950 + 950', groceries: '350.8 + 274.8', bad: 'x' })).toBe('rent = 1900\ngroceries = 625.6\nbad: error: unknown name "x"; functions are sum, avg, mean, average, min, max, abs, sqrt, floor, ceil, round\nThese numbers are exact; copy them as they are.')
    // A small model sends a nested object as a JSON string, or a plain list.
    expect(calculateExpressions(undefined, '{"fun": "45 + 155.5"}')).toContain('fun = 200.5')
    expect(calculateExpressions(undefined, ['1 + 1'])).toContain('1 = 2')
  })

  it('totals a CSV file per category from every row, which is what VR8c\'s coworkers got wrong', async () => {
    const root = workspace({ 'jan.csv': jan, 'feb.csv': feb, 'semi.csv': 'Kategorie;Betrag\nMiete;"1.000"\nEssen;12,50\nEssen;7,25\nEssen;oops\n' })
    const january = await tool(root, { path: 'jan.csv', column: 'amount', group_by: 'category' })
    expect(january.failed).toBe(false)
    expect(january.output).toBe('sum of amount by category in jan.csv (8 rows used)\nrent = 950\ngroceries = 350.8\ntransport = 86.5\nutilities = 118.25\nfun = 45\nall rows = 1550.55\nThese numbers are exact; copy them as they are.')
    const february = await tool(root, { path: 'feb.csv', column: 'Amount', group_by: 'Category' })
    expect(february.output).toContain('groceries = 274.8\n')
    expect(february.output).toContain('fun = 155.5\n')
    // The number column is found when it is the only one; the total hints at group_by.
    const bare = await tool(root, { path: 'jan.csv' })
    expect(bare.output).toContain('sum of amount = 1550.55')
    expect(bare.output).toContain('call again with group_by "category"')
    expect((await tool(root, { path: 'jan.csv', column: 'amount', group_by: 'category', op: 'count' })).output).toContain('groceries = 3')
    expect((await tool(root, { path: 'jan.csv', column: 'amount', op: 'average' })).output).toContain('average of amount = 193.81875')
    // Semicolons, decimal commas, a skipped non-number named by its line.
    const semi = await tool(root, { path: 'semi.csv', column: 'Betrag', group_by: 'Kategorie' })
    expect(semi.output).toContain('Essen = 19.75')
    expect(semi.output).toContain('1 skipped as not numbers: lines 5')
  })

  it('refuses what it cannot do with a reason the model can act on, and never leaves the workspace', async () => {
    const root = workspace({ 'jan.csv': jan })
    expect((await tool(root, { path: 'jan.csv', column: 'price' })).output).toBe('failed: column "price" is not a column of jan.csv; its columns are category, amount')
    expect((await tool(root, {})).output).toMatch(/^denied: Give exactly one of path, combine, expressions or expression/)
    expect((await tool(root, { expression: '1+1', path: 'jan.csv' })).output).toMatch(/^denied: Give exactly one/)
    expect((await tool(root, { path: '../outside.csv' })).output).toMatch(/^denied: path outside workspace/)
    expect((await tool(root, { expression: '1 / 0' })).output).toBe('failed: the result is not a finite number (division by zero?)')
  })

  it('merges coworker reports per label with the change from first to last, as a controller needs', async () => {
    const root = workspace({})
    // The report shapes a Dolphin swarm sent in FX40's run 1, plus an automatic report.
    const merged = await tool(root, { combine: [
      'jan.csv: rent=950, groceries=350.8, transport=86.5, utilities=118.25, fun=45',
      '[Automatic report: February ended its turn (completed) without agents.report] feb.csv: rent = 950\ngroceries = 274.8\nutilities = 131.75\ntransport = 100\nfun = 155.5\nall rows = 1612.05'
    ] })
    expect(merged.failed).toBe(false)
    expect(merged.output).toContain('rent = 1900 (950 + 950; change +0)')
    expect(merged.output).toContain('groceries = 625.6 (350.8 + 274.8; change -76)')
    expect(merged.output).toContain('transport = 186.5 (86.5 + 100; change +13.5)')
    expect(merged.output).toContain('utilities = 250 (118.25 + 131.75; change +13.5)')
    expect(merged.output).toContain('fun = 200.5 (45 + 155.5; change +110.5)')
    expect(merged.output).toContain('all labels = 3162.6')
    expect(merged.output).toContain('largest increase: fun (+110.5); largest decrease: groceries (-76)')
    expect(merged.output).not.toContain('all rows =')
    // FX40 swarm run 3: the controller copied invented totals beside the right items.
    const invented = await tool(root, { combine: ['january: rent=950, groceries=350.8, transport=86.5, utilities=118.25, fun=45, total=1600.65', 'february: rent=950, groceries=274.8, utilities=131.75, transport=100, fun=155.5, total=1661.25'] })
    expect(invented.output).not.toMatch(/^total =/m)
    expect(invented.output).not.toContain('3261.9')
    expect(invented.output).toContain('all labels = 3162.6')
    // FX40 v4 run 2: one list item per pair, the last only the file's total.
    expect((await tool(root, { combine: ['feb.csv: rent=950', 'feb.csv: fun=155.5', 'feb.csv: all rows=1612.05'] })).failed).toBe(false)
    expect((await tool(root, { combine: ['north: tea=3'] })).output).toMatch(/^failed: combine must be a list of 2 to 12 report texts/)
    expect((await tool(root, { combine: ['north: tea=3', 'nothing here'] })).output).toBe('failed: report 2 has no label = value pairs to combine')
    // Sent as one JSON string, as small models do with nested values.
    expect((await tool(root, { combine: '["a: x=1", "b: x=2"]' })).output).toContain('x = 3 (1 + 2; change +1)')
  })

  it('is offered to every ordinary conversation, read-only included, and not to a bounded coding task', () => {
    expect(toolSpecs(true).map(spec => spec.function.name)).toContain('calculate')
    expect(toolSpecs(false).map(spec => spec.function.name)).toContain('calculate')
    expect(toolSpecs(false, false, undefined, 'coding').map(spec => spec.function.name)).not.toContain('calculate')
    expect(JSON.stringify(toolSpecs(false, true).find(spec => spec.function.name === 'conductor'))).toContain('merge their numbers with calculate')
  })
})
