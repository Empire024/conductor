import { useEffect, useRef, useState } from 'react'
import { Plus, Server, X } from 'lucide-react'
import type { RemoteServiceRecord } from '../../../shared/remote-services'
import { HOST_PORT_HINT, HOST_SERVICE_NOTE, orderServices, validateRegistration } from './preview-services'
import './PreviewServices.css'

const fail = (reason: unknown): string => reason instanceof Error ? reason.message : String(reason)

/**
 * The host half: the ports on *this* computer the owner is willing to let their paired machines
 * look at. It lives in the browser toolbar because that is where the owner already is when they
 * are thinking about a dev server, and because registering one is only ever about a port that is
 * already listening in front of them.
 *
 * There is deliberately no "test it", no URL field and no address anywhere: a registration is a
 * label and a loopback port, and the only thing that can reach it is a paired machine going
 * through Conductor. Offering a URL would suggest there is some other way in, and there is not.
 */
export function PreviewServices({ projectId }: { projectId: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [services, setServices] = useState<RemoteServiceRecord[]>([])
  const [label, setLabel] = useState('')
  const [port, setPort] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)

  const read = (): void => {
    void window.conductor.remote.services.registered(projectId)
      .then(list => setServices(orderServices(list)))
      .catch(reason => setError(fail(reason)))
  }

  useEffect(() => { if (open) read() }, [open, projectId])

  useEffect(() => {
    if (!open) return
    const dismiss = (event: MouseEvent): void => {
      if (event.target instanceof Node && !popoverRef.current?.contains(event.target)) setOpen(false)
    }
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    window.addEventListener('mousedown', dismiss)
    window.addEventListener('keydown', escape)
    return () => { window.removeEventListener('mousedown', dismiss); window.removeEventListener('keydown', escape) }
  }, [open])

  const register = (): void => {
    const checked = validateRegistration({ label, port }, services)
    if (!checked.ok) { setError(checked.message); return }
    setBusy(true); setError('')
    void window.conductor.remote.services.register({ projectId, port: checked.port, label: checked.label })
      .then(() => { setLabel(''); setPort(''); read() })
      .catch(reason => setError(fail(reason)))
      .finally(() => setBusy(false))
  }

  const remove = (serviceId: string): void => {
    setError('')
    void window.conductor.remote.services.unregister(serviceId).then(read).catch(reason => setError(fail(reason)))
  }

  return (
    <div className="preview-services" ref={popoverRef}>
      <button
        className={services.length ? 'has-services' : ''}
        title="Ports on this computer your paired machines may preview"
        aria-expanded={open}
        onClick={() => setOpen(current => !current)}
      >
        <Server size={13} />{services.length > 0 && <span>{services.length}</span>}
      </button>
      {open && (
        <div className="preview-services-popover" role="dialog" aria-label="Preview services">
          <strong>Preview services</strong>
          <p className="preview-services-note">{HOST_SERVICE_NOTE}</p>

          {services.length === 0
            ? <p className="preview-services-empty">Nothing registered yet. Your paired machines cannot reach any port on this computer until you list one here.</p>
            : <ul className="preview-services-list">
              {orderServices(services).map(service => (
                <li key={service.id}>
                  <span><strong>{service.label}</strong><small>127.0.0.1:{service.port}</small></span>
                  <button aria-label={`Remove ${service.label}`} title={`Stop sharing ${service.label}`} onClick={() => remove(service.id)}><X size={13} /></button>
                </li>
              ))}
            </ul>}

          <div className="preview-services-form">
            <input
              aria-label="Service name"
              placeholder="Dev server"
              maxLength={60}
              value={label}
              onChange={event => { setError(''); setLabel(event.target.value) }}
            />
            <input
              aria-label="Port on this computer"
              placeholder="5173"
              inputMode="numeric"
              value={port}
              onChange={event => { setError(''); setPort(event.target.value.replace(/[^0-9]/g, '').slice(0, 5)) }}
              onKeyDown={event => { if (event.key === 'Enter') register() }}
            />
            <button className="preview-services-add" disabled={busy} onClick={register}><Plus size={13} /> Register</button>
          </div>
          <small className="preview-services-hint">{HOST_PORT_HINT}</small>
          {error && <p className="preview-services-error" role="alert">{error}</p>}
        </div>
      )}
    </div>
  )
}
