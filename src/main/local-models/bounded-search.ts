import { runInNewContext } from 'node:vm'

export interface BoundedSearchResult {
  hits: Array<{ line: number; column: number; excerpt: string }>
  skippedLines: number[]
  skippedCount: number
  stopped: boolean
  timedOut: boolean
}

/** Only fixed code runs in the VM; user pattern/text are data. The VM interrupt bounds even
 * catastrophic regex backtracking. Giant lines are explicitly skipped instead of applying
 * an unbounded regex on Electron's main thread. Each file yields back to async filesystem IO. */
export function boundedSearch(content: string, pattern: string, limit: number): BoundedSearchResult {
  try {
    return runInNewContext(`(() => {
      const expression = new RegExp(pattern, 'g');
      const hits = [], skippedLines = []; let skippedCount = 0, start = 0, line = 1;
      while (start <= content.length && line <= 100000) {
        const newline = content.indexOf('\\n', start), end = newline < 0 ? content.length : newline;
        if (end - start > 16384) { skippedCount++; if (skippedLines.length < 20) skippedLines.push(line); }
        else {
          const value = content.slice(start, end); expression.lastIndex = 0;
          const match = expression.exec(value);
          if (match) {
            const column = match.index, preview = Math.max(0, column - 80);
            hits.push({ line, column: column + 1, excerpt: (preview ? '[prefix omitted] ' : '') + value.slice(preview, preview + 300) + (value.length > preview + 300 ? ' [line truncated; use read_file bytes]' : '') });
            if (hits.length >= limit) return { hits, skippedLines, skippedCount, stopped: true, timedOut: false };
          }
        }
        if (newline < 0) return { hits, skippedLines, skippedCount, stopped: false, timedOut: false };
        start = end + 1; line++;
      }
      return { hits, skippedLines, skippedCount, stopped: true, timedOut: false };
    })()`, { content, pattern, limit }, { timeout: 25, contextCodeGeneration: { strings: false, wasm: false } }) as BoundedSearchResult
  } catch (error) {
    if ((error as { code?: string }).code !== 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw error
    return { hits: [], skippedLines: [], skippedCount: 0, stopped: true, timedOut: true }
  }
}
