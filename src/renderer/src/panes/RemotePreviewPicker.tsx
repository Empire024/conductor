import { useEffect, useState } from 'react'
import { LoaderCircle, MonitorPlay, RefreshCw } from 'lucide-react'
import type { RemoteServiceRecord } from '../../../shared/remote-services'
import { noServicesMessage, orderServices, serviceActionLabel } from './preview-services'

const fail = (reason: unknown): string => reason instanceof Error ? reason.message : String(reason)

/**
 * The controller half: the services a host has registered, and the only way this pane reaches one.
 *
 * There is no address bar behaviour to add here and deliberately no way to type a host port. A
 * controller may open exactly what the host's owner listed and nothing else, so the picker *is* the
 * interface - what it does not offer genuinely cannot be reached.
 */
export function RemotePreviewPicker({
  machineId, machineName, projectId, activeServiceId, onOpen
}: {
  machineId: string
  machineName: string
  projectId: string
  activeServiceId: string | null
  onOpen(service: RemoteServiceRecord): void
}): React.JSX.Element {
  const [services, setServices] = useState<RemoteServiceRecord[] | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const read = (): void => {
    setLoading(true); setError('')
    void window.conductor.remote.services.list({ machineId, projectId })
      .then(list => setServices(orderServices(list)))
      .catch(reason => { setServices([]); setError(fail(reason)) })
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    let live = true
    setServices(null)
    setLoading(true); setError('')
    void window.conductor.remote.services.list({ machineId, projectId })
      .then(list => { if (live) setServices(orderServices(list)) })
      .catch(reason => { if (live) { setServices([]); setError(fail(reason)) } })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [machineId, projectId])

  return (
    <div className="remote-preview-picker" aria-label={`Preview services on ${machineName}`}>
      <div className="remote-preview-head">
        <span><MonitorPlay size={13} /> Preview from {machineName}</span>
        <button title={`Ask ${machineName} what it is sharing now`} disabled={loading} onClick={read}>
          <RefreshCw size={12} className={loading ? 'spin' : undefined} /> Check again
        </button>
      </div>
      {loading && services === null && <div className="remote-preview-empty"><LoaderCircle className="spin" size={15} /> Asking {machineName}…</div>}
      {error && <div className="remote-preview-error" role="alert">{error}</div>}
      {services !== null && services.length === 0 && !error && (
        <div className="remote-preview-empty">{noServicesMessage(machineName)}</div>
      )}
      {services !== null && services.length > 0 && (
        <ul className="remote-preview-list">
          {services.map(service => (
            <li key={service.id}>
              <button
                className={service.id === activeServiceId ? 'active' : ''}
                aria-current={service.id === activeServiceId}
                onClick={() => onOpen(service)}
              >
                <strong>{serviceActionLabel(service, machineName)}</strong>
                <small>Port {service.port} on {machineName}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
