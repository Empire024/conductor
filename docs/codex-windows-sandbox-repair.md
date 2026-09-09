# Codex Windows sandbox setup repair

Observed on 2026-09-08 with the installed `codex-cli 0.153.4`, from the affected Conductor session. The [official OpenAI Windows sandbox documentation](https://learn.chatgpt.com/docs/windows/windows-sandbox) identifies filesystem permissions as a common native sandbox failure source and documents the stronger `elevated` implementation used here.

## Actual cause

`Get-Location` failed before the shell started with `helper_unknown_error: setup refresh had errors`. The native `.codex/.sandbox/sandbox.2026-09-08.log` showed two precise errors:

```text
write ACE failed on C:\Claude\conductor: SetNamedSecurityInfoW failed: 5
deny ACE failed on C:\Claude\conductor\.git: SetNamedSecurityInfoW failed: 5
```

Both directory owners were `CodexSandboxOffline`. The human user inherited Modify access, without permission to change those directory ACLs. Codex's normal setup-refresh process therefore could neither install the current workspace capability ACE nor protect `.git`.

The authorized ownership repair changed only the owners of the workspace directory and `.git` to the human owner. It did not recurse or change either DACL. An administrator process verified both DACLs remained identical. Subsequent native setup refresh logged `errors=[]`, and the same affected session could start its normal sandboxed PowerShell, read `package.json`, and create/read/delete a root-level probe. `whoami` reported `codexsandboxoffline`, confirming the stronger sandbox still ran.

## Remaining inherited-permission repair

Some existing descendants did not inherit the native workspace capability ACE during normal setup refresh, because that process could not modify their existing sandbox-owned ACLs. Root-level writes work; probes under `src`, `scripts`, and `artifacts` still report access denied. The sandbox correctly refuses probes under `.git` and `.codex`.

A bounded inventory initially counted 32,940 ordinary descendants, including 3,521 directories. 10,691 lacked the current workspace capability. There were 80 entries with explicit ACEs and no directories with inheritance disabled. Seven junctions were excluded from traversal; Windows handle resolution verified every target stays within this workspace, including two short-name aliases. Counts can change as coworkers create files.

Automatic approval review rejected refreshing inherited ACLs across the existing tree, including junctions, because that persistent permission-change scope required explicit owner authorization. No inheritance repair has run as of this record. The runtime task remains incomplete until deep workspace writes are verified.

## Reviewable repair tools

- `scripts/repair-codex-workspace-owner.ps1` defaults to diagnosis. `-Repair` requires an administrator process and changes only sandbox-owned workspace and `.git` directory owners. It refuses filesystem roots and reparse-point ancestors, skips worktree `.git` files, preserves original ACLs in a temporary backup, and verifies DACL equality.
- `scripts/repair-codex-workspace-inheritance.ps1` defaults to a read-only inventory. After explicit authorization, `-Repair` requires the administrator identity to match the root owner and an existing native Codex workspace Modify ACE. It resolves junction targets through Windows handles, refuses targets outside the workspace or ancestor cycles, records all original ACLs, and reapplies the unchanged root DACL. It then verifies existing owners, explicit ACEs, and protected ACLs. It does not change sandbox modes, approval policies, accounts, firewall rules, or Codex configuration.

After any authorized inheritance repair, repeat normal sandbox read/create/edit/delete probes under the workspace root, `src`, `scripts`, and `artifacts`; verify `.git` and `.codex` writes remain denied; inspect native setup-refresh logs for `errors=[]`. Only then mark runtime access repaired.

## Inheritance repair completed 2026-09-09

The owner authorized the pending inheritance repair. `scripts/repair-codex-workspace-inheritance.ps1 -Repair`
ran from an elevated PowerShell whose identity matched the workspace root owner.

Read-only inventory immediately before the run: 35,526 entries, 10,867 missing the current workspace
capability `S-1-5-21-2410288451-1089401000-3698464964-1738057620`, 80 with explicit ACEs, 0 with
inheritance disabled, and 8 reparse points whose handle-resolved targets all stayed inside the workspace.

The run reported `Missing capability after refresh: 0. Concurrently removed entries: 0`, having verified
the root DACL was byte-identical before and after, and that no entry's owner, explicit ACEs, or protected
ACL changed. Original ACLs were recorded to a temporary backup inventory before the single native write.

Acceptance probes from the affected native Codex session, in its own sandboxed shell: `Get-Location`,
`Get-Content package.json`, and `Get-Content src/main/project-file-search.ts` succeeded, and a
create/read/delete cycle on `src/.probe2.tmp` returned `PASS`. The same create under `src` had failed with
`Access to the path ... is denied` immediately before the repair, so the write path is repaired rather
than merely untested. Native setup refresh logs report `errors=[]`; the only remaining denial in the
sandbox log is the unrelated `hide users` attempt on the default user profile directory.

## Verification

`node --test scripts/repair-codex-workspace-owner.test.mjs`: 7 passed on Windows. Coverage includes diagnostic immutability, filesystem-root refusal, workspace-junction refusal, linked `.git` refusal, and preservation of worktree pointer files, and refusal of unsafe roots or junction workspaces by the inheritance repair. The inheritance script's read-only inventory also passed against the affected workspace. Administrator ownership repair and subsequent native sandbox probes are live local evidence; the inheritance operation is still pending authorization.
