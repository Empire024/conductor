# Smart schedules

Schedules are fixed, registry-backed jobs. Renderer IPC can select a known job id, enable it,
change its interval, run it now, show its history, or reveal a stored artifact. It cannot provide a
shell command, URL, or prompt.

## Latest models and methods

The installed migration creates this enabled daily schedule once for the first registered project
whose package is `conductor-desktop`. The unique `(project, job)` key prevents
duplicates, and later owner changes (including disabling it) are preserved.

The check reads these fixed primary sources:

- OpenAI's all-models catalog on `developers.openai.com`.
- Anthropic's models overview on `platform.claude.com`.
- the official `ggml-org/llama.cpp` latest-release record from GitHub's API.
- pinned `Qwen/Qwen3.5-9B` repository metadata from Hugging Face.
- Conductor's local native runtime model/method catalog.

Remote reads have a ten-second timeout, a streaming 256 KB ceiling, no cookies, and no redirects.
ETag and Last-Modified validators are reused. Normalized equal content and HTTP 304 responses write
no changed artifact and start no agent turn. Changed evidence is written as JSON before cache state
is committed; the UI shows a compact summary and lets the owner reveal the artifact. Agent review
is always a separate explicit action.

For a standalone zero-token primary-source snapshot, run:

```powershell
node scripts/check-latest-models-methods.mjs
```

It prints versioned JSON validity evidence and accepts no URL or shell input.
