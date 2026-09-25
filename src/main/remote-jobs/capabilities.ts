import type { ExecutionNode, NodeFacts, NodePlatform } from './types.ts'

/**
 * One probe, one round trip: `key=value` lines about the OS, hardware and the tools on the PATH a
 * job will see (the node's env.sh is loaded first, exactly as the job wrapper does).
 *
 * On a Mac without the Command Line Tools, /usr/bin/git, python3 and xcodebuild are shims that
 * open an installer dialog on the Mac's screen when run. The probe never runs them in that state;
 * it reports them as shims instead.
 */
export const PROBE_SCRIPT = String.raw`kv() { printf '%s=%s\n' "$1" "$2"; }
kv hostname "$(hostname 2>/dev/null)"
kv user "$(id -un 2>/dev/null)"
kv home "$HOME"
kv os "$(uname -s 2>/dev/null)"
kv arch "$(uname -m 2>/dev/null)"
kv kernel "$(uname -r 2>/dev/null)"
kv shell "$SHELL"
if command -v sw_vers >/dev/null 2>&1; then
  kv osName "$(sw_vers -productName 2>/dev/null)"
  kv osVersion "$(sw_vers -productVersion 2>/dev/null)"
  kv osBuild "$(sw_vers -buildVersion 2>/dev/null)"
elif [ -r /etc/os-release ]; then
  kv osName "$(. /etc/os-release; echo "$NAME")"
  kv osVersion "$(. /etc/os-release; echo "$VERSION_ID")"
fi
if [ "$(uname -s)" = Darwin ]; then
  kv model "$(sysctl -n hw.model 2>/dev/null)"
  kv cpu "$(sysctl -n machdep.cpu.brand_string 2>/dev/null)"
  kv cores "$(sysctl -n hw.ncpu 2>/dev/null)"
  kv perfCores "$(sysctl -n hw.perflevel0.physicalcpu 2>/dev/null)"
  kv memBytes "$(sysctl -n hw.memsize 2>/dev/null)"
  kv developerDir "$(xcode-select -p 2>/dev/null)"
  if /usr/bin/pgrep -q oahd 2>/dev/null; then kv rosetta yes; else kv rosetta no; fi
  kv sleep "$(pmset -g 2>/dev/null | awk '$1 == "sleep" { print $2; exit }')"
else
  kv cores "$(getconf _NPROCESSORS_ONLN 2>/dev/null)"
  kv memBytes "$(awk '/^MemTotal:/ { printf "%d", $2 * 1024 }' /proc/meminfo 2>/dev/null)"
  kv cpu "$(awk -F': ' '/^model name/ { print $2; exit }' /proc/cpuinfo 2>/dev/null)"
fi
kv diskFreeKb "$(df -Pk "$HOME" 2>/dev/null | awk 'NR == 2 { print $4 }')"
dev="$(xcode-select -p 2>/dev/null)"
for t in git node npm npx brew gh python3 xcodebuild tailscale; do
  p="$(command -v "$t" 2>/dev/null)" || continue
  case "$p" in /usr/bin/git | /usr/bin/python3 | /usr/bin/xcodebuild) if [ -z "$dev" ]; then kv "shim.$t" "$p"; continue; fi ;; esac
  if [ "$t" = xcodebuild ]; then v="$("$p" -version 2>/dev/null | head -n 1)"; else v="$("$p" --version 2>/dev/null | head -n 1)"; fi
  kv "tool.$t" "$p|$v"
done`

const platformOf = (os: string): NodePlatform | null =>
  /^darwin$/i.test(os) ? 'darwin' : /^linux$/i.test(os) ? 'linux' : /mingw|msys|cygwin|windows/i.test(os) ? 'win32' : null

const count = (value: string | undefined): number | null => {
  const number = Number(value)
  return value && Number.isFinite(number) && number > 0 ? Math.round(number) : null
}

export function parseProbe(stdout: string): NodeFacts {
  const values = new Map<string, string>()
  for (const line of stdout.split(/\r?\n/)) {
    const at = line.indexOf('=')
    if (at > 0) values.set(line.slice(0, at), line.slice(at + 1).trim())
  }
  const get = (key: string): string => values.get(key) ?? ''
  const tools: NodeFacts['tools'] = {}
  const shims: string[] = []
  for (const [key, value] of values) {
    if (key.startsWith('tool.')) {
      const bar = value.indexOf('|')
      tools[key.slice(5)] = bar < 0 ? { path: value, version: '' } : { path: value.slice(0, bar), version: value.slice(bar + 1) }
    } else if (key.startsWith('shim.')) shims.push(key.slice(5))
  }
  const memBytes = Number(get('memBytes'))
  const diskKb = Number(get('diskFreeKb'))
  const platform = platformOf(get('os'))
  return {
    hostname: get('hostname'), user: get('user'), home: get('home'), platform,
    arch: get('arch'), osName: get('osName'), osVersion: get('osVersion'), osBuild: get('osBuild'), kernel: get('kernel'),
    model: get('model'), cpu: get('cpu'), cores: count(get('cores')), performanceCores: count(get('perfCores')),
    ramGb: memBytes > 0 ? Math.round(memBytes / 2 ** 30) : null,
    diskFreeGb: diskKb > 0 ? Math.round(diskKb / 2 ** 20) : null,
    shell: get('shell'),
    developerDir: get('developerDir') || null,
    rosetta: platform === 'darwin' ? get('rosetta') === 'yes' : null,
    sleepMinutes: platform === 'darwin' ? get('sleep') || null : null,
    tools, shims
  }
}

/** Spellings a caller might use for the same capability. */
const ALIASES: Record<string, string> = {
  mac: 'macos', darwin: 'macos', osx: 'macos', 'os:darwin': 'macos', 'os:macos': 'macos',
  aarch64: 'arm64', 'arch:arm64': 'arm64', 'arch:aarch64': 'arm64', x86_64: 'x64', amd64: 'x64', 'arch:x64': 'x64',
  win32: 'windows', 'os:windows': 'windows', 'os:linux': 'linux', 'apple silicon': 'apple-silicon', xcode_clt: 'xcode-clt'
}

export function normalizeCapability(value: string): string {
  const lower = value.trim().toLowerCase()
  return ALIASES[lower] ?? lower
}

/**
 * What a node can do, from its last probe plus the owner's labels. Vocabulary: the OS (macos,
 * linux, windows), the architecture (arm64, x64), apple-silicon, rosetta, xcode-clt, xcode, and
 * each tool found (git, node, npm, brew, gh, python3) with node also as node@<major>.
 */
export function nodeCapabilities(node: Pick<ExecutionNode, 'facts' | 'labels'>): string[] {
  const found = new Set<string>()
  const facts = node.facts
  if (facts) {
    if (facts.platform === 'darwin') found.add('macos')
    if (facts.platform === 'linux') found.add('linux')
    if (facts.platform === 'win32') found.add('windows')
    const arch = normalizeCapability(facts.arch)
    if (arch === 'arm64' || arch === 'x64') found.add(arch)
    if (facts.platform === 'darwin' && arch === 'arm64') found.add('apple-silicon')
    if (facts.rosetta) found.add('rosetta')
    if (facts.developerDir) found.add('xcode-clt')
    if (facts.tools.xcodebuild?.version.startsWith('Xcode')) found.add('xcode')
    for (const tool of Object.keys(facts.tools)) if (tool !== 'xcodebuild' && tool !== 'tailscale' && tool !== 'npx') found.add(tool)
    const major = /v?(\d+)\./.exec(facts.tools.node?.version ?? '')
    if (major) found.add(`node@${major[1]}`)
  }
  for (const label of node.labels) found.add(normalizeCapability(label))
  return [...found].sort()
}

export interface NodeCandidate {
  node: ExecutionNode
  capabilities: string[]
  runningJobs: number
}

/**
 * The node a job with these requirements goes to: online, has every capability, then the one
 * with the fewest running jobs, then the one heard from most recently. When nothing qualifies the
 * error says, node by node, why - "requires macOS" must never quietly run somewhere else.
 */
export function selectNode(candidates: NodeCandidate[], requires: string[]): NodeCandidate {
  const wanted = requires.map(normalizeCapability)
  const reasons: string[] = []
  const fit = candidates.filter(candidate => {
    const missing = wanted.filter(capability => !candidate.capabilities.includes(capability))
    if (missing.length) { reasons.push(`${candidate.node.id} lacks ${missing.join(', ')}`); return false }
    if (candidate.node.status !== 'online') { reasons.push(`${candidate.node.id} is ${candidate.node.status}${candidate.node.lastError ? ` (${candidate.node.lastError})` : ''}`); return false }
    return true
  })
  if (!fit.length) {
    const what = wanted.length ? `with ${wanted.join(', ')}` : 'at all'
    throw new Error(`No online node ${what}. ${reasons.length ? reasons.join('; ') : 'No node is registered; register one with nodes.register'}.`)
  }
  fit.sort((a, b) => a.runningJobs - b.runningJobs || (b.node.lastSeenAt ?? '').localeCompare(a.node.lastSeenAt ?? '') || a.node.id.localeCompare(b.node.id))
  return fit[0]!
}
