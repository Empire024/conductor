import { useEffect, useState } from 'react'
import { Archive, Bot, Compass, ExternalLink, ListPlus, Loader2, Play, X } from 'lucide-react'
import type { IdeaDetail, IdeaEvent, IdeaLink, IdeaSection, IdeaStatus } from '../../../../shared/ideas'
import { IDEA_STATUSES, IDEA_STATUS_LABELS } from '../../../../shared/ideas'
import type { ProjectRecord } from '../../../../shared/models'
import {
  actorLabel, briefView, defaultProjectId, exploredLine, formatDateTime, groupIdeaLinks, isExploring, linkProvenance,
  sectionAuthorLine, showOriginalText, timelineEvents, workedOnLine
} from './ideas-model'
import { IdeaRunPanel } from './IdeaRunPanel'

export type IdeaWorkProvider = 'claude' | 'codex'
export type IdeaAction = 'status' | 'work' | 'explore' | 'task' | 'archive' | 'link'

interface IdeaDetailPanelProps {
  idea: IdeaDetail
  projects: ProjectRecord[]
  now: number
  /** The action in flight, if any; its button shows a spinner and the others wait. */
  busy: IdeaAction | null
  onStatus(status: IdeaStatus): void
  onWork(projectId: string, provider: IdeaWorkProvider): void
  onExplore(): void
  onCreateTask(projectId: string): void
  onArchive(): void
  onOpenLink(linkId: string): void
  onUnlink(linkId: string): void
}

/** The idea's secondary column: status, progress, actions, the latest brief, related work, timeline. */
export function IdeaDetailPanel(props: IdeaDetailPanelProps): React.JSX.Element {
  const { idea, projects, now, busy } = props
  const projectIds = projects.map(project => project.id)
  const [projectId, setProjectId] = useState(() => defaultProjectId(idea, projectIds))
  const [provider, setProvider] = useState<IdeaWorkProvider>('claude')
  // The parent keys this panel by idea id, so only a project list that arrives or changes late
  // needs following; a choice the owner already made stays.
  const projectKey = projectIds.join('|')
  useEffect(() => {
    setProjectId(current => current && projectIds.includes(current) ? current : defaultProjectId(idea, projectIds))
  }, [projectKey])

  const exploring = isExploring(idea)
  const spin = (action: IdeaAction): React.JSX.Element | null => busy === action ? <Loader2 size={13} className="ideas-spin" /> : null

  return (
    <aside className="ideas-panel" aria-label="Idea details">
      <section className="ideas-panel-section ideas-facts">
        <label className="ideas-field">
          <span>Status</span>
          <select value={idea.status} disabled={busy !== null} onChange={event => props.onStatus(event.target.value as IdeaStatus)}>
            {IDEA_STATUSES.map(status => <option key={status} value={status}>{IDEA_STATUS_LABELS[status]}</option>)}
          </select>
        </label>
        <p className="ideas-fact"><span>Worked on</span><strong className={idea.workedOn ? 'yes' : 'no'}>{workedOnLine(idea)}</strong></p>
        <p className="ideas-fact"><span>Explored</span><strong>{exploring && <Loader2 size={11} className="ideas-spin" />}{exploredLine(idea, now)}</strong></p>
        <p className="ideas-fact"><span>Captured</span><strong>{formatDateTime(idea.createdAt, now)} · {idea.capturedFrom}</strong></p>
      </section>

      <section className="ideas-panel-section ideas-actions" aria-label="Actions">
        <label className="ideas-field">
          <span>Project</span>
          <select value={projectId} onChange={event => setProjectId(event.target.value)} disabled={!projects.length}>
            {!projects.length && <option value="">No projects</option>}
            {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>
        <div className="ideas-action-row">
          <select aria-label="Agent" value={provider} onChange={event => setProvider(event.target.value as IdeaWorkProvider)}>
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
          </select>
          <button className="primary" disabled={busy !== null || !projectId} onClick={() => props.onWork(projectId, provider)} title="Open an agent tab in the project, briefed with this idea">
            {spin('work') ?? <Play size={13} />} Work on this idea
          </button>
        </div>
        <div className="ideas-action-row">
          <button disabled={busy !== null || !projectId} onClick={() => props.onCreateTask(projectId)} title="Add a project task for this idea">
            {spin('task') ?? <ListPlus size={13} />} Create task
          </button>
          <button disabled={busy !== null || exploring} onClick={props.onExplore} title="A bounded, read-only exploration on a local model; never a cloud model">
            {spin('explore') ?? <Compass size={13} />} {exploring ? 'Exploring…' : 'Explore with local model'}
          </button>
          {idea.status !== 'archived' && (
            <button className="danger" disabled={busy !== null} onClick={props.onArchive}>{spin('archive') ?? <Archive size={13} />} Archive</button>
          )}
        </div>
      </section>

      <IdeaRunPanel ideaId={idea.id} projectId={projectId} />

      {idea.latestBrief && (
        <details className="ideas-panel-section" open>
          <summary>Latest brief</summary>
          <IdeaBrief section={idea.latestBrief} now={now} />
        </details>
      )}

      {showOriginalText(idea) && (
        <details className="ideas-panel-section">
          <summary>Original note</summary>
          <pre className="ideas-original">{idea.originalText}</pre>
        </details>
      )}

      <details className="ideas-panel-section" open={idea.links.length > 0}>
        <summary>Related work{idea.links.length ? <span className="ideas-count">{idea.links.length}</span> : null}</summary>
        <IdeaRelatedWork links={idea.links} disabled={busy !== null} onOpen={props.onOpenLink} onUnlink={props.onUnlink} />
      </details>

      <details className="ideas-panel-section">
        <summary>Timeline<span className="ideas-count">{idea.events.length}</span></summary>
        <IdeaTimeline events={idea.events} now={now} />
      </details>
    </aside>
  )
}

/** An agent-written brief, labeled as such, never mixed with the owner's words. */
export function IdeaBrief({ section, now }: { section: IdeaSection; now: number }): React.JSX.Element {
  const view = briefView(section)
  return (
    <div className="ideas-brief">
      <p className="ideas-brief-author"><Bot size={12} /> Agent-generated · {sectionAuthorLine(section, now)}</p>
      {view.kind === 'structured' ? (
        <dl>
          {view.concept && <><dt>Concept</dt><dd>{view.concept}</dd></>}
          {view.openQuestions.length > 0 && <><dt>Open questions</dt><dd><ul>{view.openQuestions.map((item, index) => <li key={index}>{item}</li>)}</ul></dd></>}
          {view.nextStep && <><dt>Next step</dt><dd>{view.nextStep}</dd></>}
          {view.observations.length > 0 && <><dt>Observations</dt><dd><ul>{view.observations.map((item, index) => <li key={index}>{item}</li>)}</ul></dd></>}
        </dl>
      ) : (
        <pre className="ideas-brief-body">{view.body}</pre>
      )}
    </div>
  )
}

export function IdeaRelatedWork({ links, disabled, onOpen, onUnlink }: { links: IdeaLink[]; disabled?: boolean; onOpen(linkId: string): void; onUnlink(linkId: string): void }): React.JSX.Element {
  const groups = groupIdeaLinks(links)
  if (!groups.length) return <p className="ideas-muted">Nothing linked yet. Work on the idea, create a task, or let an agent link what it made.</p>
  return (
    <div className="ideas-links">
      {groups.map(group => (
        <div key={group.kind} className="ideas-link-group">
          <h4>{group.label}</h4>
          <ul>
            {group.links.map(link => (
              <li key={link.id}>
                <button className="ideas-link" onClick={() => onOpen(link.id)} title={link.targetId}>
                  <ExternalLink size={11} /><span>{link.label || link.targetId}</span>
                </button>
                <button className="ideas-icon" aria-label={`Unlink ${link.label || link.targetId}`} title="Unlink" disabled={disabled} onClick={() => onUnlink(link.id)}><X size={12} /></button>
                <small>{linkProvenance(link)}</small>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

export function IdeaTimeline({ events, now }: { events: IdeaEvent[]; now: number }): React.JSX.Element {
  const ordered = timelineEvents(events)
  if (!ordered.length) return <p className="ideas-muted">No events yet.</p>
  return (
    <ol className="ideas-timeline">
      {ordered.map(event => (
        <li key={event.id} className={`kind-${event.kind}`}>
          <time dateTime={event.at}>{formatDateTime(event.at, now)}</time>
          <span>{event.message}</span>
          <small>{actorLabel(event.actor)}</small>
        </li>
      ))}
    </ol>
  )
}
