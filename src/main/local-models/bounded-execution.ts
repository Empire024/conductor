/** The host creates an unpredictable delimiter and emits it before user code on both streams.
 * Split only the first occurrence: even payload code which learns/repeats it cannot reclassify
 * its own output as environment evidence. Never trim payload whitespace. */
export function splitExecutionEnvelope(stdout: string, stderr: string, marker: string): {
  stdout: string; stderr: string; environment: string; environmentStderr: string; payloadStarted: boolean
} {
  const delimiter = `\n${marker}\n`
  const out = stdout.indexOf(delimiter), err = stderr.indexOf(delimiter)
  return {
    stdout: out >= 0 ? stdout.slice(out + delimiter.length) : '',
    stderr: err >= 0 ? stderr.slice(err + delimiter.length) : '',
    environment: out >= 0 ? stdout.slice(0, out) : stdout,
    environmentStderr: err >= 0 ? stderr.slice(0, err) : stderr,
    payloadStarted: out >= 0 && err >= 0
  }
}
