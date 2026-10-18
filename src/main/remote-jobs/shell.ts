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
markfd=2
mark() { printf '%s %s\n' "$tag" "$1" >&$markfd; }
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
# From here the wrapper's own stderr (bash job notices such as "Terminated: 15") goes nowhere;
# the job keeps the real one, and marks go to a copy of it.
exec 4>&2 2>/dev/null
markfd=4
trap '' PIPE HUP
echo "$pid" >"$state/pid"
mark "started pid=$pid"
cat <&3 >/dev/null 2>&1 4>&- &
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

/**
 * A detached job: the command runs under a supervisor that owns it on the node, apart from any
 * ssh session, so it survives a dropped connection, a restart of Conductor here and this machine
 * sleeping. Its state directory holds everything this side needs to come back to it:
 *
 *   stdout, stderr   the job's output, appended as it runs
 *   pid              the job's process (and process group) id
 *   supervisor       the supervisor's pid; gone while there is no exit file means the node lost it
 *   deadline         epoch seconds; the supervisor stops the group then, whoever is watching
 *   cancel           created by Conductor to ask the supervisor to stop the group
 *   reason, exit     why it was stopped (timeout | cancelled) and its exit code, written last
 *   cwd              the resolved working directory, for artifact fetches
 *
 * The supervisor polls once a second (bash 3.2 has no `wait -n` with a timeout).
 */
export const DETACHED_SUPERVISOR = String.raw`state=$1; cmd=$2
trap '' HUP PIPE
deadline=$(cat "$state/deadline")
set -m
/bin/bash -c "$cmd" </dev/null >>"$state/stdout" 2>>"$state/stderr" &
pid=$!
set +m
echo "$pid" >"$state/pid.tmp" && mv "$state/pid.tmp" "$state/pid"
reason=
while kill -0 "$pid" 2>/dev/null; do
  if [ -e "$state/cancel" ]; then reason=cancelled; break; fi
  if [ "$(date +%s)" -ge "$deadline" ]; then reason=timeout; break; fi
  sleep 1
done
if [ -n "$reason" ]; then
  echo "$reason" >"$state/reason"
  kill -TERM -"$pid" 2>/dev/null
  n=0
  while kill -0 "$pid" 2>/dev/null && [ "$n" -lt 20 ]; do sleep 0.5; n=$((n + 1)); done
fi
wait "$pid"; code=$?
kill -KILL -"$pid" 2>/dev/null
echo "$code" >"$state/exit.tmp" && mv "$state/exit.tmp" "$state/exit"`

/** Starts a detached job and returns once it runs: reports `started pid=N` (or an error) and exits. */
export const DETACHED_LAUNCHER = String.raw`id=$1; cwd=$2; limit=$3; cmd=$4; tag="@@conductor-job:$5"; supervisor=$6
mark() { printf '%s %s\n' "$tag" "$1" >&2; }
jobs="$HOME/.conductor-node/jobs"
state="$jobs/$id"
mkdir -p "$state" || { mark error=state-dir; mark exit=125; exit 125; }
# State of detached jobs that no Conductor came back for.
find "$jobs" -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf {} + 2>/dev/null
if [ -f "$HOME/.conductor-node/env.sh" ]; then . "$HOME/.conductor-node/env.sh" >/dev/null 2>&1; fi
case "$cwd" in "" | "~") cwd=$HOME ;; "~/"*) cwd="$HOME/$(printf '%s' "$cwd" | sed 's|^~/||')" ;; /*) ;; *) cwd="$HOME/$cwd" ;; esac
if ! cd "$cwd" 2>/dev/null; then mark error=cwd; mark exit=125; rm -rf "$state"; exit 125; fi
pwd -P >"$state/cwd"
: >"$state/stdout"; : >"$state/stderr"
echo $(( $(date +%s) + limit )) >"$state/deadline"
export CONDUCTOR_JOB_ID="$id"
set -m
nohup /bin/bash -c "$supervisor" conductor-supervise "$state" "$cmd" </dev/null >/dev/null 2>"$state/supervisor.log" &
echo "$!" >"$state/supervisor"
set +m
n=0
while [ ! -s "$state/pid" ] && [ "$n" -lt 100 ]; do sleep 0.1; n=$((n + 1)); done
pid=$(cat "$state/pid" 2>/dev/null)
if [ -z "$pid" ]; then mark error=supervisor; exit 125; fi
mark "started pid=$pid"
exit 0`

/**
 * Streams a detached job's output from byte offsets as framed chunks on stdout, for up to `max`
 * seconds or until it ends. A frame is one header line - `<tag> frame out=N err=M pid=P alive=A
 * exit=C reason=R` - followed by exactly N bytes of stdout and M bytes of stderr. `exit` is only
 * set on the frame that carries the last of the output; `gone` means the node has no such job.
 * `cancel=1` first asks the supervisor to stop it.
 */
export const DETACHED_FOLLOW = String.raw`id=$1; out=$2; err=$3; max=$4; tag="@@conductor-job:$5"; cancel=$6
s="$HOME/.conductor-node/jobs/$id"
if [ ! -f "$s/stdout" ]; then printf '%s gone\n' "$tag"; exit 0; fi
if [ "$cancel" = 1 ]; then : >"$s/cancel"; fi
end=$(( $(date +%s) + max ))
cap=1048576
first=1
while :; do
  # Liveness first: the supervisor writes exit before it ends, so dead and no exit means lost.
  alive=0; sup=$(cat "$s/supervisor" 2>/dev/null)
  if [ -n "$sup" ] && kill -0 "$sup" 2>/dev/null; then alive=1; fi
  code=; if [ -f "$s/exit" ]; then code=$(cat "$s/exit"); fi
  reason=-; if [ -f "$s/reason" ]; then reason=$(cat "$s/reason"); fi
  o=$(( $(wc -c <"$s/stdout") )); e=$(( $(wc -c <"$s/stderr") ))
  pid=$(cat "$s/pid" 2>/dev/null); [ -n "$pid" ] || pid=0
  lo=$((o - out)); if [ "$lo" -gt "$cap" ]; then lo=$cap; fi; if [ "$lo" -lt 0 ]; then lo=0; fi
  le=$((e - err)); if [ "$le" -gt "$cap" ]; then le=$cap; fi; if [ "$le" -lt 0 ]; then le=0; fi
  final=-
  if [ -n "$code" ] && [ $((out + lo)) -ge "$o" ] && [ $((err + le)) -ge "$e" ]; then final=$code; fi
  if [ "$first" = 1 ] || [ "$lo" -gt 0 ] || [ "$le" -gt 0 ] || [ "$final" != - ] || [ "$alive" = 0 ]; then
    printf '%s frame out=%d err=%d pid=%s alive=%d exit=%s reason=%s\n' "$tag" "$lo" "$le" "$pid" "$alive" "$final" "$reason"
    if [ "$lo" -gt 0 ]; then tail -c +$((out + 1)) "$s/stdout" | head -c "$lo"; fi
    if [ "$le" -gt 0 ]; then tail -c +$((err + 1)) "$s/stderr" | head -c "$le"; fi
    out=$((out + lo)); err=$((err + le)); first=0
  fi
  if [ "$final" != - ]; then exit 0; fi
  if [ -z "$code" ] && [ "$alive" = 0 ]; then exit 0; fi
  if [ "$(date +%s)" -ge "$end" ]; then exit 0; fi
  if [ "$lo" -lt "$cap" ] && [ "$le" -lt "$cap" ]; then sleep 1; fi
done`

const jobIdOk = (jobId: string): string => {
  if (!/^[\w-]{1,80}$/.test(jobId)) throw new Error(`Not a job id: ${jobId}`)
  return jobId
}

export function buildLaunchCommand(input: JobCommand): string {
  const args = [jobIdOk(input.jobId), input.cwd, String(Math.max(1, Math.floor(input.timeoutSec))), input.command, input.nonce, DETACHED_SUPERVISOR]
  return `/bin/bash -c ${shQuote(DETACHED_LAUNCHER)} conductor-launch ${args.map(shQuote).join(' ')}`
}

export interface FollowCommand { jobId: string; stdoutOffset: number; stderrOffset: number; maxSeconds: number; nonce: string; cancel: boolean }

export function buildFollowCommand(input: FollowCommand): string {
  const args = [jobIdOk(input.jobId), String(Math.max(0, Math.floor(input.stdoutOffset))), String(Math.max(0, Math.floor(input.stderrOffset))), String(Math.max(1, Math.floor(input.maxSeconds))), input.nonce, input.cancel ? '1' : '0']
  return `/bin/bash -c ${shQuote(DETACHED_FOLLOW)} conductor-follow ${args.map(shQuote).join(' ')}`
}

/** Asks a detached job's supervisor to stop it; any process may send it, the runner sees the result. */
export function buildCancelCommand(jobId: string): string {
  return `/bin/bash -c ${shQuote('s="$HOME/.conductor-node/jobs/$1"; [ -d "$s" ] || exit 0; : >"$s/cancel"; exit 0')} conductor-cancel ${shQuote(jobIdOk(jobId))}`
}

/** Removes a finished detached job's state on the node once its output and artifacts are here. */
export function buildCleanCommand(jobId: string): string {
  return `/bin/bash -c ${shQuote('rm -rf "$HOME/.conductor-node/jobs/$1"')} conductor-clean ${shQuote(jobIdOk(jobId))}`
}

export type FollowEvent =
  | { kind: 'frame'; stdout: Buffer; stderr: Buffer; pid: number | null; alive: boolean; exit: number | null; reason: 'timeout' | 'cancelled' | null }
  | { kind: 'gone' }

/** Reads DETACHED_FOLLOW's frames back out of the raw stdout bytes, across any chunking. */
export class FrameReader {
  private buffer: Buffer = Buffer.alloc(0)
  private header: { out: number; err: number; pid: number | null; alive: boolean; exit: number | null; reason: 'timeout' | 'cancelled' | null } | null = null
  private readonly tag: string

  constructor(nonce: string) { this.tag = `${MARKER_PREFIX}${nonce} ` }

  push(chunk: Buffer): FollowEvent[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    const events: FollowEvent[] = []
    for (;;) {
      if (!this.header) {
        const newline = this.buffer.indexOf(0x0a)
        if (newline < 0) break
        const line = this.buffer.subarray(0, newline).toString('utf8').replace(/\r$/, '')
        this.buffer = this.buffer.subarray(newline + 1)
        if (!line.startsWith(this.tag)) continue
        const body = line.slice(this.tag.length)
        if (body === 'gone') { events.push({ kind: 'gone' }); continue }
        const frame = /^frame out=(\d+) err=(\d+) pid=(\d+) alive=([01]) exit=(\d+|-) reason=(\S+)$/.exec(body)
        if (!frame) continue
        const reason = frame[6] === 'timeout' || frame[6] === 'cancelled' ? frame[6] : null
        this.header = { out: Number(frame[1]), err: Number(frame[2]), pid: Number(frame[3]) || null, alive: frame[4] === '1', exit: frame[5] === '-' ? null : Number(frame[5]), reason }
        continue
      }
      const { out, err } = this.header
      if (this.buffer.length < out + err) break
      events.push({ kind: 'frame', stdout: Buffer.from(this.buffer.subarray(0, out)), stderr: Buffer.from(this.buffer.subarray(out, out + err)), pid: this.header.pid, alive: this.header.alive, exit: this.header.exit, reason: this.header.reason })
      this.buffer = this.buffer.subarray(out + err)
      this.header = null
    }
    return events
  }
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
