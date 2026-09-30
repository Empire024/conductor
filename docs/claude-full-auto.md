# Claude Full Auto

Conductor keeps the owner's Full Auto authorization in its own installation database. It does not edit Claude's user or project settings and does not infer authorization from an old Auto selection, wizard status, a grant card, or an agent message.

The trusted desktop control is **Enable Full Auto for Conductor's Claude workers**, available in Settings → Runtimes (the composer shows only the confirmed mode, as the mode picker's tooltip). One owner activation covers existing and future Conductor Claude Auto sessions. Manual, Plan, and explicitly selected Guarded Auto retain their modes. Disabling revokes the policy before runtime reconciliation. A workspace name is not a filesystem sandbox: authorized processes can act within their actual OS access, including commands, deleting files, and using available credentials or services.

The policy is distinct from the provider's confirmed mode. The provider adapter reports requestedPermissionMode, permissionMode, permissionModeStatus and, on failure, permissionModeError. The UI only says Full Auto active after a native confirmation of bypassPermissions. A rejected change is blocked with the provider's error; it is never presented as active while classifier Auto continues.

Conductor uses the documented CLI permission mode and startup capability, and awaits the runtime control response. An older process without the startup capability must reach a safe checkpoint and resume with the authorized launch configuration. A busy command must not be blindly replayed or killed to change the label.

The provider's managed restrictions, explicit deny/ask rules, and hooks remain real constraints. Full Auto changes the native permission mode; it is not a claim to override managed policy. See Anthropic's [permission modes](https://code.claude.com/docs/en/permission-modes), [CLI flags](https://code.claude.com/docs/en/cli-reference), and [SDK permission controls](https://code.claude.com/docs/en/agent-sdk/permissions).

After initialization, the existing Claude channel makes one read-only `get_settings` diagnostic request with a three-second timeout. Its `get_settings/summary` notice contains only recognized source names, bounded allow/ask/deny counts, recognized permission-mode flags and hook event names. It never records raw settings, rule contents, paths, environment values or credentials. Unsupported or unrecognized responses are reported as unavailable; this diagnostic neither changes permission mode nor delays a turn. File presence alone is not proof of the runtime's loaded settings.

The owner IPC uses the same trusted top-level Conductor document check as ordinary owner controls. It is deliberately absent from app-control and MCP. Replayed grant notifications do not invoke it. Synthetic UI events are rejected. Test-profile activation by a smoke harness is recorded as fixture automation and never counted as an actual owner activation.

Scoped approvals are separate. A past classifier refusal is not a pending native permission request. Native Allow once must answer the exact live provider request; authorization, permission application, tool execution and success are separate lifecycle states. See [permission grant evidence](permissions-classifier.md).

Implementation is not acceptance: the installed application must pass the P0 A–K tests in the independent verification record before this repair is complete.

Installed-binary acceptance uses an explicit `CONDUCTOR_PACKAGED_ACCEPTANCE=1` opt-in and an existing canonical temporary profile beneath `conductor-packaged-acceptance-*/profile`. The installed app normally ignores test-profile variables. This isolated mode always parks its windows, uses its own database/feed/cache, keeps real native providers, and refuses installer execution. The harness requires the exact executable hash and packaged version receipt. Fixture UI activation never counts as the owner's activation; the real owner profile is left enabled after its single genuine activation. Update persistence must be verified by a real update of that owner profile, not the fixture's installer guard.
