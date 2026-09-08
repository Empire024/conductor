# Project tasks and prompt images

Every added project gets a `feature-list.md` if one does not exist. Existing projects receive the same file on startup. Existing files are read without reformatting or replacing them. The Project tasks activity-rail button opens the project view in main and detached windows, including projects with no open runtime.

The view imports numbered bug/feature lists (including `[Implemented]`) and ordinary Markdown checklists. It supports adding bugs/features, inline renaming, search, type filters, completion, reopening, and an explicit in-progress state. Done items collapse by default, and the expansion preference is remembered per project. The task file opens in the ordinary editor from the view.

Assignments are stored in Markdown comments with stable task IDs. The UI lists project agent conversations and workspaces, shows their reported phase, and can focus a tab in the current workspace window. Agent-side file edits appear automatically while the view is open. Main and detached views share the file, with independent project files and preferences.

Agents receive project-task coordination context and their Conductor conversation ID. A native CLI also receives `CONDUCTOR_AGENT_ID` and `CONDUCTOR_TASK_FILE`. Agents claim requested work using `[~]` and `agent=ID` inside the task marker, then use `[x]` only when finished. Completion is an explicit file/UI update; ending a model turn does not automatically declare the task done. The briefing explicitly limits updates to the owner's requested scope.

Example:

```md
## Bugs
- [~] Fix the layout <!-- conductor-task:layout-fix agent=agent_123 -->
## Features
- [ ] Add keyboard navigation <!-- conductor-task:keyboard-navigation -->
```

UI actions compare the file revision and use Conductor's atomic, conflict-checking editor writer. A stale view cannot replace an agent's newer file contents; new-task and rename text remain in the UI after an error. Existing editor conflict protection also applies when the same task file is open for text editing.

## Prompt images

Codex and Claude Chat prompts support image selection, clipboard image paste, and drag/drop. Drafts show thumbnails; sent images also have clickable previews. Uploads are saved as unique workspace images under `.conductor/prompt-images/`, with an exclusive `.gitignore` that excludes the image cache from Git by default. Original input files are not changed. Restored drafts and queued messages keep references to those persistent files rather than storing image data in browser draft storage.

The importer checks raster signatures and decoding, limits input files to 20 MB, and prepares PNG/JPEG copies with a maximum edge of 4096 pixels and at most 2 MiB of encoded image data. Oversized copies are resized/compressed. Animated formats become a static image. Existing provider message limits still apply, including Claude's combined JSON message limit. Claude's native image capability is now advertised to the composer; both adapters submit native image inputs.

## Validation

- `npm.cmd test`: 403 Vitest tests in 51 files plus 13 Node tests, all passed.
- `npm.cmd run build`: typecheck and production main/preload/renderer builds passed.
- `node scripts/smoke-project-tasks-images.mjs` and `--provider=claude`: seven Electron check groups each, using the production IPC, filesystem, SQLite, adapters and renderer with explicitly synthetic provider subprocesses.
- Verified automatic file creation, legacy import, preservation of surrounding file content, done collapse, owner assignment, external completion sync, current-window agent navigation, separate project files, and live updates across main/detached windows.
- Verified file input, simulated clipboard/drop events, thumbnail recovery across project switches and reload, native image bytes delivered through each adapter, sent-image inspection, invalid-image rejection, and queue recovery after a full app restart without automatic replay.
- Native screenshots visually inspected. No live provider inference or installed-owner profile mutation was used for acceptance. The fixture images are generated test pixels, and the development executable reports Electron's version in screenshots.

Evidence: [task view](evidence/project-tasks-images/project-tasks.png), [prompt images](evidence/project-tasks-images/prompt-images.png), [Codex checks](evidence/project-tasks-images/codex.json), [Claude checks](evidence/project-tasks-images/claude.json).

The release state was tested in an isolated worktree so unrelated unfinished edits remain preserved in the shared main checkout.
