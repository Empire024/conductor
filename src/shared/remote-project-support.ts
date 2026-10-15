/**
 * What each project-scoped main-process entry point does for a project that lives on a paired
 * machine (a "Remote: MAIN" project on the laptop).
 *
 * This table exists because the answer used to be implicit, and wrong in a way nobody could see: a
 * handler either knew about remote projects or it threw "This project lives on MAIN ..." - and the
 * renderer offered the action anyway, so the owner met "Error invoking remote method" on renaming,
 * on the task list, and nearly everywhere else in such a project. Every entry is now one of:
 *
 * - `host`: carried out on the machine that holds the project, under that machine's grant checks
 *   (src/main/remote-project-actions.ts on this side, remote-control-host.ts on the other).
 * - `here`: answered on this computer, correctly, for either id of the project (the project list,
 *   its workspaces, conversation history, and the task dispatcher's empty target list).
 * - `counterpart`: refused here, because the renderer sends a remote project to a dedicated
 *   remote surface instead (`remote:files-*`, the mirrored tab, `remote:terminals-*`).
 * - `local-only`: a view of this computer's own state (git delivery, memory, schedules,
 *   production, logic loops, durable jobs, cloud runs, a folder move). Refused with a sentence that
 *   names the host; the renderer does not offer it for a remote project.
 *
 * `src/main/remote-project-support.test.ts` fails when a project-scoped handler in main is not
 * listed here, so a handler added later has to decide rather than inherit a silent refusal.
 */
export type RemoteProjectHandling = 'host' | 'here' | 'counterpart' | 'local-only'

export interface RemoteProjectChannel {
  handling: RemoteProjectHandling
  /** The feature, as the refusal sentence names it. */
  feature: string
}

const host = (feature: string): RemoteProjectChannel => ({ handling: 'host', feature })
const here = (feature: string): RemoteProjectChannel => ({ handling: 'here', feature })
const counterpart = (feature: string): RemoteProjectChannel => ({ handling: 'counterpart', feature })
const localOnly = (feature: string): RemoteProjectChannel => ({ handling: 'local-only', feature })

/** Keyed by IPC channel. A key ending in `:*` covers a registered module whose one guard covers all of its channels. */
export const REMOTE_PROJECT_CHANNELS: Readonly<Record<string, RemoteProjectChannel>> = {
  'projects:rename': host('Renaming the project folder'),
  'projects:remove': here('Removing the project from this list'),
  'projects:move': localOnly('Moving the project folder'),
  'projects:reveal': localOnly('Showing the folder in File Explorer'),
  'project-tasks:get': host('The task list'),
  'project-tasks:edit': host('Editing the task list'),
  'project-tasks:changes': host('Reviewing changes'),
  'project-tasks:set-source-control': host('Source control'),
  'project-tasks:dispatch-options': here('The task list'),
  'project-tasks:dispatch': localOnly('Dispatching a task'),
  'files:import-image': localOnly('Importing an image into the project'),
  'files:open-pasted-text': localOnly('Opening pasted text'),
  'files:attach-context': counterpart('Attaching a project file'),
  'files:import-context-path': counterpart('Importing a file into the project'),
  'files:move-external-drop': counterpart('Dropping a file into the project'),
  'files:browser-url': counterpart('Previewing a file'),
  'files:open-in-browser': counterpart('Opening a file in your browser'),
  'files:list': counterpart('The file tree'),
  'files:read': counterpart('Files'),
  'files:stat': counterpart('Files'),
  'files:read-for-editor': counterpart('The code editor'),
  'files:read-data-url': counterpart('Files'),
  'files:write': counterpart('The code editor'),
  'files:save-copy': counterpart('The code editor'),
  'files:create-untitled': counterpart('Creating a file'),
  'files:create': counterpart('Creating a file'),
  'files:rename': counterpart('Renaming a file'),
  'files:move': counterpart('Moving a file'),
  'files:trash': counterpart('Deleting a file'),
  'files:reveal': counterpart('Files'),
  'files:open-external': counterpart('Files'),
  'agent:ensure': counterpart('Running an agent'),
  'agent:restart': counterpart('Running an agent'),
  'memory:*': localOnly('Memory'),
  'schedules:*': localOnly('Schedules'),
  'production:*': localOnly('Production'),
  'delivery:*': localOnly('Source control'),
  'logic-loops:*': localOnly('Logic loops'),
  'durable-jobs:*': localOnly('Durable jobs'),
  'cloud:*': localOnly('Cloud sessions')
}

/** The entry for a channel, falling back to its module's `prefix:*` entry. */
export function remoteProjectChannel(channel: string): RemoteProjectChannel | undefined {
  const exact = REMOTE_PROJECT_CHANNELS[channel]
  if (exact) return exact
  const prefix = channel.includes(':') ? `${channel.slice(0, channel.indexOf(':'))}:*` : ''
  return prefix ? REMOTE_PROJECT_CHANNELS[prefix] : undefined
}

/**
 * Whether the renderer may offer this action for a project that lives on another machine. Only a
 * `local-only` entry is withheld; `counterpart` entries are offered through their remote surface.
 */
export function offeredForRemoteProject(channel: string): boolean {
  return remoteProjectChannel(channel)?.handling !== 'local-only'
}
