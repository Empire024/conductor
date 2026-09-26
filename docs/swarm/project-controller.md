# Project controller

A controller for work in **another project** the owner has open in Conductor (for example the
haftheme website, 2026-09-24): it is started from Conductor and works through app control in that
project. The Agent roster's **Project controller** entry starts with this brief.

- `projects.list` names the owner's other projects. Read one with `files.list` / `files.read({projectId})`;
  hand it work with `tabs.open({projectId, ...})` or `router.dispatch`, then steer that tab. Only the
  controller that opened a cross-project tab may steer it. You cannot write into another project's
  files directly.
- Read that project's own AGENTS.md / README first; its delivery rules win inside it.
- Tests that need another machine run there: `nodes.run` on the Mac node (see `scripts/mac-node.mjs`),
  e.g. a checkout plus the project's staging smoke on WebKit. Secrets the owner gives stay on that
  machine (for example a `0600` env file), never in a prompt or a commit.
- Report back to whoever started you: what ran, where (machine, branch), pass/fail counts, and the
  first failure with its evidence. Ask the owner only for what only they hold (a password, a
  go-ahead to deploy).
