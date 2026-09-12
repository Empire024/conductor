# Local models

Two Qwen models served by llama.cpp on this machine, driven by Conductor as `local/qwen3.5-9b`
and `local/qwen3.6-35b-a3b`. Conductor remains the orchestrator: llama.cpp only performs
inference. Workspace file tools run through canonical host-side containment checks; commands
run inside a locked-down Docker container. Project memory and public research use narrow brokers.

```
Conductor (CLI or app)
   |-- 127.0.0.1:51435  llama.cpp -> Qwen3.5-9B
   |-- 127.0.0.1:51436  llama.cpp -> Qwen3.6-35B-A3B
   `-- local-agent tool calls -> Docker sandbox -> /workspace only
```

## Where everything lives on this machine

```
llama.cpp executable:
C:\Users\stilj\AppData\Local\Microsoft\WinGet\Packages\ggml.llamacpp_Microsoft.Winget.Source_8wekyb3d8bbwe\llama-server.exe
version 0.4.0-dev (build 10901, commit 28ff09582), installed with winget (ggml.llamacpp)

Conductor local data root:
D:\ConductorLocal

Models:
D:\ConductorLocal\models\qwen3.5-9b\Qwen3.5-9B-Q4_K_M.gguf
D:\ConductorLocal\models\qwen3.6-35b-a3b\Qwen3.6-35B-A3B-Q4_K_M.gguf

Agent workspaces:
D:\ConductorLocal\workspaces\<session>

Docker internal storage:
Docker Desktop 29.7.2 is installed under the owner's AppData/Local/Programs/DockerDesktop;
the engine reports /var/lib/docker. Docker's own VM disk, WSL distributions and image store stay wherever Docker Desktop puts
them - this stack never relocates them.
```

The small, package-managed llama.cpp binaries (~86 MB) intentionally stay on `C:` where winget
installed them: relocating a package manager's files by hand breaks its updates, and they neither
grow nor accumulate. That is a different matter from model weights, caches and agent workspaces,
which are large and growing and therefore always live on the local root.

## 1. Security model

Local-model output is treated as untrusted: it may be wrong, prompt-injected by repository
contents, test fixtures or dependency output, and may deliberately try to leave the workspace.

- **A local model never gets a host shell.** Tool dispatch is an allowlist in code
  (`src/main/local-models/tools.ts`): `read_file`, `list_files`, `search`, `write_file`,
  `edit_file`, `run_command`, `web_read`, `web_search`, and `conductor`. The Conductor broker
  permits only `memory.recall`, `memory.remember`, `tasks.list`, `tasks.update`, `agents.list`
  and `agents.snapshot`, bound to the registered project/session, each with its own argument
  allowlist. Read-only turns cannot remember or update tasks. Caller-supplied scope, arbitrary
  MCP calls, PowerShell, browser automation, connectors and credential access are refused.
- **Execution fails closed.** `run_command` only ever runs `docker exec` into the sandbox. If
  Docker is stopped, missing or broken, the call is refused — it never falls back to PowerShell,
  cmd.exe, WSL or a host child process.
- **Filesystem containment is canonical, not textual.** Every path is normalized, resolved with
  `realpath` and re-checked against the workspace root, so `../../`, `C:\...`, UNC paths,
  symlinks and junctions are refused (`src/main/local-models/workspace.ts`).
- **Secrets are withheld.** `.env*`, key material, `.npmrc`, `.pypirc`, credential stores and
  similar files are refused by the file tools and masked inside the container. The bounded
  recursive scan fails closed if incomplete, and changed masks recreate the container before
  the next command. Unreadable directories (including malformed names that the host cannot
  address), more than 200,000 entries, depth over 64, or more than 4,096 masks refuse shell
  execution rather than exposing an unscanned tree. File tools remain independently bounded.
  `.git` is mounted
  read-only, so a local model cannot install a hook or rewrite repository config, unless the
  owner grants repository writes for that one conversation (see *Per-conversation grants*).
- **No network in the runtime.** The container runs with `--network none`; it cannot browse,
  upload source, reach cloud metadata or talk to other machines on the LAN.
- **Credential-free GET research.** `web_read`, and `web_search` when granted, retrieve public HTTPS text on port 443,
  without inherited cookies, authorization headers or request bodies. IPv4 DNS answers must
  all be public and the chosen address is pinned for the socket; every redirect is checked
  again. IPv6-only destinations are refused. Requests have a 20-second budget, at most three
  redirects, a 256 KiB response cap and a 24,000-character tool result. Results are explicitly
  marked untrusted. Public URL paths/query strings can transmit information: this is not a
  general source-exfiltration prevention mechanism. Do not use it for confidential research
  queries. Credential filename policy likewise cannot identify secrets embedded in arbitrary
  source files, or atomically guard files another host process creates during a running command.
- **Per-conversation grants, off by default.** Two buttons in a local conversation's composer
  widen what that conversation may do, and nothing else changes them. *Repository writes*
  (`localGit`) stops re-binding `.git` read-only and supplies a `Conductor local model` commit
  identity, so the sandbox can commit, branch and stash on local history; the container still
  runs with `--network none`, so nothing can be pushed or fetched. The mount is fixed when the
  container starts, so the grant takes effect on the next container, and withdrawing it
  recreates the container too. The grant is for git itself: the host file tools still refuse
  every write under `.git` (`resolveWritablePath` takes no grant), so hooks, refs and config
  cannot be hand-edited even while commits are allowed. *Deep research* (`localResearch`) adds the `web_search` tool and
  raises the tool-round budget from 16 to 48. Both are refused on any provider other than
  `local`, are held on the conversation rather than on a message — a queued prompt cannot carry
  a grant that has since been withdrawn — and `web_search` is refused at dispatch, not merely
  withheld from the schema.
- **Cancellation reaches commands.** Stop removes only this conversation's Docker container
  and waits for removal, so a Linux command cannot continue writing after its Docker client
  disappears. Output overflow and command timeout also remove the container before returning.
  The next command recreates the isolated container.
- **No inherited environment.** The container gets an explicit minimal env allowlist; no
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AWS_*`, `GITHUB_TOKEN`, `HF_TOKEN` or agent socket.
- **Model text is never parsed by a host shell.** Commands are passed as a single argv entry to
  `bash` *inside* the container (`spawn('docker', [...], { shell: false })`).
- **llama.cpp is inference only**: bound to `127.0.0.1`, API key required, web UI off, and no
  MCP, tool runtime, agent mode or RPC. Config-supplied extra arguments that would re-enable any
  of those are rejected.

Moving the data to another drive changed none of this: the same containment code runs, and the
only host directory that crosses into a container is still one specific workspace directory.

## Bounded native coworkers

The installed catalog contains Qwen 3.5 9B and Qwen 3.6 35B-A3B, both Q4_K_M; there is no
3.8 model. `models.list` advertises the local provider from the installed configuration.
Controllers may use native `router.dispatch` with `provider: "local"`, one of the model IDs
above, and `permission: "accept-edits"` or `"read-only"`, with no effort parameter. Inherited
controller permissions still cap the coworker's authority. Prefer small read/edit/read-back
tasks and review the actual changed file before assigning another task. Local inference uses
no thinking pass for these bounded jobs; a measured short workspace task took approximately
5–7 seconds on 9B and 12 seconds on 35B-A3B on this machine. These are fixture timings, not
a broad coding-quality benchmark. Tool rounds are capped; exhaustion is a failed turn.

Local prompts receive project memory context and a token-free broker description. They do not
receive the HTTP app-control bearer briefing or CLI MCP configuration. Memory writes run through
Conductor's registered-session authority and SQLite, rather than attempting to write outside the
workspace. The session layer rechecks permissions and rejects stale runtime callbacks.

The old installed application's catalog is compiled in: it gains native local dispatch only
after the coherent update is released and the installed app restarts through its updater.
A development smoke verifies the implementation but does not update the owner's running app.

## 2. Prerequisites

- **A fixed non-system drive** with at least 60 GB free. Setup picks one automatically (the first
  qualifying fixed drive), or takes `-Root <path>` / `CONDUCTOR_LOCAL_ROOT`. A root on the system
  drive is refused, and if the configured drive goes missing later, every command fails closed
  rather than recreating anything on `C:`.
- **Docker Desktop** with Linux containers — installed and verified on this machine. Without it the
  models still answer, but `run_command` is refused. Nothing here enables Hyper-V, changes Windows
  features, or touches your WSL or Docker configuration.
- **llama.cpp with CUDA** — already installed here through winget. Setup reuses whatever is
  installed: it resolves `llama-server` from config, `CONDUCTOR_LLAMA_SERVER`, the current PATH,
  and the winget Links/Packages directories, so a shell that has not picked up the new PATH yet
  still works. Nothing is reinstalled and no binary is copied into the project.
- **Node.js 24+** (the CLI runs TypeScript directly) and ~27 GB free for the two models.

## 3. Initial setup

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\local-models\setup.ps1
```

Setup is idempotent and says what it did: `FOUND` for an existing llama.cpp install, a verified
model or a built image; `MIGRATE` for a model moved from an older location (size and SHA256
verified at the destination before the old copy is removed); `DOWNLOAD` only for what is genuinely
missing. It selects and records the data root, checks free space, creates the layout, generates
the local API key, and builds the sandbox image. Switches: `-Root <dir>`, `-Quant9b Q6_K`,
`-Context 16384`, `-LlamaServer <path>`, `-SkipModels`, `-SkipImage`.

The chosen root is recorded once, in `.local-models/root.json` beside the checkout (gitignored, a
few bytes); `CONDUCTOR_LOCAL_ROOT` overrides it. Every script and the Conductor provider derive
their paths from that single setting — no drive letter is hardcoded anywhere else. `npm.cmd run
local -- where` prints the resolved layout.

## 4. Model files and quantizations

| Model id | Repository (revision) | File | Size |
| --- | --- | --- | --- |
| `local/qwen3.5-9b` | `lmstudio-community/Qwen3.5-9B-GGUF` (`1379f25c`) | `Qwen3.5-9B-Q4_K_M.gguf` | 5.6 GB |
| `local/qwen3.6-35b-a3b` | `ggml-org/Qwen3.6-35B-A3B-GGUF` (`baec3ebe`) | `Qwen3.6-35B-A3B-Q4_K_M.gguf` | 20.4 GB |

Defaults target a 12 GB RTX 5070 with 64 GB RAM and both servers resident at once: the 9B is
fully offloaded at Q4_K_M, the 35B MoE keeps most weights in system RAM (`gpuLayers: 10`), and
context starts at 32K rather than the advertised maximum. `Q6_K` for the 9B is available
(`-Quant9b Q6_K`, checksum pinned as well) but does not leave room for the 35B on the same card.
Ports, context, GPU layers, quantization and sandbox limits are all editable in
`<root>\config\config.json`; only one model is expected to do meaningful work at a time.

Provenance (repo, revision, filename, SHA256, source) is recorded in `<root>\config\provenance.json`.
Nothing from a model repository is ever executed: no Python, no `trust_remote_code`, no bundled
scripts, no piped installers.

## 5. Start

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\local-models\start.ps1
```

Validates the local root (exists, off the system drive, directories accessible), verifies both
GGUF checksums, reports the llama.cpp executable and version actually used and Docker
availability, refuses to start a duplicate or to take an occupied port, starts both servers on
`127.0.0.1`, waits for a health check and prints status. `-Fast` verifies size only;
`-Model local/qwen3.5-9b` starts one.

## 6. Status

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\local-models\status.ps1
```

Shows the local root and its free space, model file locations and sizes, pid, port, health,
whether the API key is enforced, the resolved llama.cpp executable, Docker's engine and root
directory, and provenance.

## 7. Conductor CLI usage

```powershell
npm.cmd run local -- run --model local/qwen3.5-9b "Explain this project."
npm.cmd run local -- run --model local/qwen3.6-35b-a3b "Find the cause of the failing test."
```

Without `--cwd` the agent works in its own session workspace under
`D:\ConductorLocal\workspaces\`; `--cwd <path>` points it at a project directory instead.
`--read-only` withholds writes and execution, `--session <name>` names the workspace and
container, `--max-iterations N` bounds the tool loop. Smoke and security suites:

```powershell
npm.cmd run local:smoke
npm.cmd run local:security
```

## 7a. In the Conductor app

The new-tab launcher lists **Qwen 3.5 9B** and **Qwen 3.6 35B-A3B** beside Claude Code and
Codex (`Ctrl+T` then `L` opens the 9B directly), and they open ordinary agent tabs: the same
timeline, composer, tool cards, change history, stop control and session persistence. The
model is chosen when the tab is created and stays with that conversation; the composer's
model picker can move a conversation to the other local model, and says so when it does.

Nothing about the stack is exposed to the window. The renderer only ever names a model id;
the API key, the ports, the GGUF paths, the llama.cpp requests, the tool loop and the
container all stay in the main process behind the same IPC every provider uses.

Opening a tab health-checks that model's server and starts it if it is down, so the first
message can take a few minutes while weights load; the conversation says so while it waits.
A server is shared by every tab using it and is never stopped by closing a tab - use
`stop.ps1` for that. Modes are **Edit** (the default) and **Read only**, which withholds
`write_file`, `edit_file` and `run_command` for that turn.

The same adapter (`src/main/providers/local.ts`) backs both the app and the CLI, so the
boundary is identical in both places; a project-bound conversation mounts that project
directory and nothing else. `npm.cmd run test:local-models` drives the whole app path
against the real servers.

## 8. Stop

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\local-models\stop.ps1          # servers
powershell -ExecutionPolicy Bypass -File .\scripts\local-models\stop.ps1 -Sandbox # + container
```

Only processes recorded by this stack are stopped; this is not a general process manager.

## 9. Model storage

Everything sizeable lives under the local data root, currently `D:\ConductorLocal`:

```
D:\ConductorLocal\
  models\<model>\*.gguf    model weights
  downloads\               reserved staging area
  temp\                    part files, and TMP/TEMP for every process this stack starts
  cache\                   XDG_CACHE_HOME, HF_HOME, HF_HUB_CACHE, LLAMA_CACHE
  runtime\                 pid and port records
  logs\                    llama.cpp server logs
  config\                  config.json, api-key, provenance.json
  workspaces\<session>\    local-agent workspaces
```

A 20 GB download never passes through `%TEMP%` on `C:`: staging, caches and child-process temp
directories all resolve to this root. The only things this feature leaves on the system drive are
the pointer file and the winget-managed llama.cpp binaries.

## 10. How sandbox isolation works

One container per session from a small image (bash, git, Node, Python, ripgrep, make), started as
`--user 10001:10001 --cap-drop ALL --security-opt no-new-privileges --read-only --init` with
default seccomp, `--pids-limit`, `--memory`, `--cpus`, tmpfs for `/tmp` and `/home/agent`, and a
per-command `timeout` plus a captured-output cap. No Docker socket, no named pipe, no devices, no
host PID or IPC namespace, no user profile, no credential stores.

Exactly one host directory is bind-mounted, at `/workspace`. For a CLI session that is
`D:\ConductorLocal\workspaces\<session>`; when you deliberately point the agent at a project
(`--cwd`, or a project-bound conversation in the app) it is that one project directory. Never a
drive root and never the user profile — both are refused in code. Inside the container the agent
sees only `/workspace` and cannot tell which Windows drive backs it.

File reads, writes, edits and search are executed by Conductor itself under the same workspace
containment rules, so diffs and undo still work; only `run_command` enters the container.

## 11. Networking is disabled by default

The runtime container has no network at all. Package installs, API calls and any other network
use fail by design. There is no autonomous path to enable networking and the model cannot turn it
on; adding a download capability would be a separate, explicitly user-controlled change. The
image build is the only step that uses the network, and Conductor itself talks to llama.cpp over
loopback — the container never needs to reach the model servers.

## 12. Current limitations

- Docker Desktop is a prerequisite; until it is installed, `run_command` is refused (models and
  file tools still work). Docker's own storage (VM disk, images, WSL distributions) stays wherever
  Docker Desktop put it — usually `C:` — and is deliberately not relocated by this stack.
- If the local root drive is disconnected, every command fails closed with that reason; nothing is
  recreated on the system drive.
- Conversations are not resumable and there is no approval/question flow, plan mode or effort
  selection for local models. A restored tab keeps its provider, model and transcript, but the
  model itself starts the next turn with no memory of the conversation before the restart.
- Local tabs cannot be placed on a paired machine, and cannot be handed to a native CLI view.
- No automatic routing between local and cloud models, no benchmarking, no quant auto-selection,
  no MCP, no llama.cpp agent mode, no GUI model manager.
- Both servers can be resident, but only one should do meaningful inference at a time; if VRAM
  pressure causes instability, lower the 9B quantization or context first, then `gpuLayers` for
  the 35B.
- Startup verification re-hashes ~26 GB by default; use `-Fast` when that is too slow.
