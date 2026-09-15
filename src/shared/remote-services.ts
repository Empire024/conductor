/**
 * Development services on a host - a dev server, a preview - reached from a paired machine.
 *
 * A service is registered on the host, by the host's owner, as a loopback port with a label. A
 * controller may list what was registered and open a tunnel to one of them, and nothing else: there
 * is no URL proxy, no port of the controller's choosing, and no route to anything but 127.0.0.1 on
 * the host at exactly the registered port. The tunnel is one WebSocket per TCP connection, opened on
 * the host's pinned HTTPS listener and signed with purpose 'tunnel', so HTTP, hot-reload WebSockets
 * and everything else the service speaks pass through byte for byte.
 *
 * On the controller the tunnel ends at a loopback port of its own, which is what the browser pane
 * loads. The page in that pane holds no credential: the device key that opened the tunnel lives in
 * the main process, and the page can reach nothing but the service it was given.
 */

export const REMOTE_TUNNEL_PATH = '/v1/tunnel'
export const TUNNEL_SERVICE_HEADER = 'x-conductor-service'
/** One binary frame, either direction. */
export const TUNNEL_MAX_FRAME_BYTES = 64 * 1024
/** Simultaneous tunnelled connections one controller may hold to one host. */
export const TUNNEL_MAX_CONNECTIONS = 64

export interface RemoteServiceRecord {
  id: string
  projectId: string
  /** Loopback port on the host; the tunnel connects to 127.0.0.1:port there and nowhere else. */
  port: number
  label: string
  createdAt: string
}

export interface RemoteServicesBridge {
  list(request: { machineId: string; projectId: string }): Promise<RemoteServiceRecord[]>
  /** Opens a loopback port on this computer that leads to that service and nothing else; the browser pane loads `localUrl`. */
  open(request: { machineId: string; projectId: string; serviceId: string }): Promise<{ localUrl: string }>
  close(request: { machineId: string; projectId: string; serviceId: string }): Promise<void>
  /** Host side: the owner's own registrations for a project on this computer. */
  registered(projectId: string): Promise<RemoteServiceRecord[]>
  register(request: { projectId: string; port: number; label: string }): Promise<RemoteServiceRecord>
  unregister(serviceId: string): Promise<void>
}
