/** The single vocabulary for "what are this project's agents doing", shared by the main-process
 *  aggregation (which sees every project) and the renderer's Workspaces project rows. */
export type ProjectActivityStatus = 'attention' | 'waiting' | 'working' | 'done' | 'idle'

/** Status per project id. Every known project is present, so a project that fell quiet reports
 *  'idle' explicitly instead of leaving a stale entry behind in the renderer. */
export type ProjectActivitySnapshot = Record<string, ProjectActivityStatus>
