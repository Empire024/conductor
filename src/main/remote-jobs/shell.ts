/**
 * The remote half of a job: a bash wrapper that runs one command in its own process group and
 * owns its lifetime on the node.
 *
 * SSH alone cannot bound a job. A dropped connection does not signal a command that has no
 * terminal, and killing the local ssh process leaves the remote command running. So the wrapper:
 *
 * - starts the command in a new process group (`set -m`) with stdin from /dev/null;
 * - watches its own stdin, which the caller holds open for the whole run: EOF - a cancel, a local
 *   timeout, Conductor quitting or the connection dropping - stops the job's whole group;
 * - enforces the deadline on the node itself, so a job outlives no timeout even when this machine
 *   is gone;
 * - kills whatever the job left in its group when it ends, so nothing lingers between jobs;
 * - reports start, stop reason and exit code as tagged lines on stderr, which the caller strips.
 *
 * bash 3.2 (macOS's /bin/bash) is the floor; nothing here needs more.
 */

/** POSIX single-quoting: safe for bash, zsh and dash, which is what an SSH login shell is. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export const MARKER_PREFIX = '@@conductor-job:'

export const JOB_WRAPPER = String.raw`id=$1; cwd=$2; limit=$3; cmd=$4; tag="@@conductor-job:$5"
mark() { printf '%s %s\n' "$tag" "$1" >&2; }
state="$HOME/.conductor-node/jobs/$id"
mkdir -p "$state" || { mark error=state-dir; mark exit=125; exit 125; }
if [ -f "$HOME/.conductor-node/env.sh" ]; then . "$HOME/.conductor-node/env.sh" >/dev/null 2>&1; fi
case "$cwd" in "" | "~") cwd=$HOME ;; "~/"*) cwd="$HOME/$(printf '%s' "$cwd" | sed 's|^~/||')" ;; /*) ;; *) cwd="$HOME/$cwd" ;; esac
if ! cd "$cwd" 2>/dev/null; then mark error=cwd; mark exit=125; rm -rf "$state"; exit 125; fi
export CONDUCTOR_JOB_ID="$id"
exec 3<&0
set -m
/bin/bash -c "$cmd" </dev/null 3<&- &
pid=$!
set +m
trap '' PIPE HUP
echo "$pid" >"$state/pid"
mark "started pid=$pid"
cat <&3 >/dev/null 2>&1 &
line=$!
exec 3<&-
deadline=$(( $(date +%s) + limit ))
reason=
while kill -0 "$pid" 2>/dev/null; do
  if ! kill -0 "$line" 2>/dev/null; then reason=cancelled; break; fi
  if [ "$(date +%s)" -ge "$deadline" ]; then reason=timeout; break; fi
  sleep 1
done
if [ -n "$reason" ]; then
  mark "reason=$reason"
  kill -TERM -"$pid" 2>/dev/null
  n=0
  while kill -0 "$pid" 2>/dev/null && [ "$n" -lt 10 ]; do sleep 0.5; n=$((n + 1)); done
fi
kill "$line" 2>/dev/null
wait "$pid"; code=$?
kill -KILL -"$pid" 2>/dev/null
rm -rf "$state"
mark "exit=$code"
exit "$code"`

export interface JobCommand {
  jobId: string
  cwd: string
  timeoutSec: number
  command: string
  nonce: string
}

/** The single command line handed to ssh; the node's login shell unquotes it once. */
export function buildJobCommand(input: JobCommand): string {
  const args = [input.jobId, input.cwd, String(Math.max(1, Math.floor(input.timeoutSec))), input.command, input.nonce]
  return `/bin/bash -c ${shQuote(JOB_WRAPPER)} conductor-job ${args.map(shQuote).join(' ')}`
}

/** Stops a job whose ssh session is gone (Conductor restarted mid-run), from its pid file. */
export function buildStopCommand(jobId: string): string {
  const state = `$HOME/.conductor-node/jobs/${jobId}`
  return `/bin/bash -c ${shQuote(`p=$(cat "${state}/pid" 2>/dev/null) || exit 0; kill -TERM -"$p" 2>/dev/null; sleep 5; kill -KILL -"$p" 2>/dev/null; rm -rf "${state}"; exit 0`)}`
}

/** A plain script run under bash on the node, with the node's environment file loaded first. */
export function buildScriptCommand(script: string): string {
  const prelude = 'if [ -f "$HOME/.conductor-node/env.sh" ]; then . "$HOME/.conductor-node/env.sh" >/dev/null 2>&1; fi\n'
  return `/bin/bash -c ${shQuote(prelude + script)}`
}

export type MarkerEvent =
  | { kind: 'started'; pid: number | null }
  | { kind: 'reason'; reason: 'timeout' | 'cancelled' }
  | { kind: 'error'; error: string }
  | { kind: 'exit'; code: number }

function parseMarker(body: string): MarkerEvent | null {
  const started = /^started pid=(\d+)$/.exec(body)
  if (started) return { kind: 'started', pid: Number(started[1]) }
  const reason = /^reason=(timeout|cancelled)$/.exec(body)
  if (reason) return { kind: 'reason', reason: reason[1] as 'timeout' | 'cancelled' }
  const error = /^error=([\w-]+)$/.exec(body)
  if (error) return { kind: 'error', error: error[1]! }
  const exit = /^exit=(\d+)$/.exec(body)
  if (exit) return { kind: 'exit', code: Number(exit[1]) }
  return null
}

/**
 * Splits the wrapper's tagged lines out of stderr. Output passes straight through except for a
 * trailing fragment that could still turn out to be a tag, which waits for the rest of its line.
 */
export class MarkerScanner {
  private pending = ''
  private readonly tag: string

  constructor(nonce: string) { this.tag = `${MARKER_PREFIX}${nonce} ` }

  push(chunk: string): { text: string; events: MarkerEvent[] } {
    let buffer = this.pending + chunk
    this.pending = ''
    let text = ''
    const events: MarkerEvent[] = []
    for (;;) {
      const at = buffer.indexOf(this.tag)
      if (at < 0) break
      const end = buffer.indexOf('\n', at)
      if (end < 0) { text += buffer.slice(0, at); this.pending = buffer.slice(at); return { text, events } }
      text += buffer.slice(0, at)
      const event = parseMarker(buffer.slice(at + this.tag.length, end).replace(/\r$/, ''))
      if (event) events.push(event)
      buffer = buffer.slice(end + 1)
    }
    // Hold back a tail that is a prefix of the tag, so a tag split across chunks is still seen.
    for (let keep = Math.min(this.tag.length - 1, buffer.length); keep > 0; keep--) {
      if (this.tag.startsWith(buffer.slice(buffer.length - keep))) {
        this.pending = buffer.slice(buffer.length - keep)
        return { text: text + buffer.slice(0, buffer.length - keep), events }
      }
    }
    return { text: text + buffer, events }
  }

  /** Whatever was held back, once the stream has ended. */
  flush(): string {
    const rest = this.pending
    this.pending = ''
    return rest
  }
}
