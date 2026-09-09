/** Electron prefixes every rejected invoke with its channel, which is noise to
 * the person who clicked. Only the message the main process wrote survives. */
export const cleanIpcError = (reason: unknown): string => {
  const message = reason instanceof Error ? reason.message : String(reason)
  return message.replace(/^Error invoking remote method '[^']+': [A-Za-z]*Error: /, '')
}

/** The main process refuses binary and oversized text reads by error name,
 * which is the only structure that survives that serialisation. */
export const isBinaryFileRefusal = (reason: unknown): boolean =>
  /BinaryFileError|FileTooLargeError/.test(reason instanceof Error ? reason.message : String(reason))

/** A binary sniff is a judgement the reader may overrule; the size ceiling is not. */
export const isOverridableFileRefusal = (reason: unknown): boolean =>
  /BinaryFileError/.test(reason instanceof Error ? reason.message : String(reason))
