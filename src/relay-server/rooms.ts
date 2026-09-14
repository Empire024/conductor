import {
  RELAY_QUEUE_MAX_BYTES,
  RELAY_QUEUE_MAX_MESSAGES,
  RELAY_QUEUE_TTL_MS,
  RELAY_ROOM_MAX_MACHINES,
  type RelayErrorCode,
  type RelayPresence,
  type RelayServerFrame
} from '../shared/relay-protocol.ts'

/**
 * Who is in a room, what they published about themselves, and where a message goes.
 *
 * All of it is in memory and none of it is worth persisting: a directory entry is republished by
 * its machine on every connect, and a queued message is only worth delivering for as long as the
 * caller is still waiting. A relay that restarts is therefore a relay that is briefly empty, not
 * one that has lost something - which is the whole reason it needs no database, no migrations and
 * no backups to run.
 *
 * Nothing in this file looks inside an envelope. It reads the routing id on the outside and moves
 * the rest along unopened.
 */

export interface RelaySocketHandle {
  readonly id: string
  send(frame: RelayServerFrame): void
  close(code: RelayErrorCode, message: string): void
}

export interface RelayJoinRequest {
  roomId: string
  machineId: string
  machineName: string
  deviceKey: string
}

interface QueuedMessage {
  envelope: unknown
  bytes: number
  queuedAt: number
}

interface RoomMachine {
  machineId: string
  machineName: string
  deviceKey: string
  entry: unknown
  socket: RelaySocketHandle | null
  lastSeenAt: number
  queue: QueuedMessage[]
  queuedBytes: number
}

interface Room {
  id: string
  machines: Map<string, RoomMachine>
}

export type RouteOutcome =
  | { ok: true; delivery: 'online' | 'queued' }
  | { ok: false; code: RelayErrorCode; message: string }

export interface RelayRoomsDependencies {
  now?(): number
  /** Called whenever a machine appears, disappears or republishes, for the server's own logging. */
  observed?(event: { room: string; machineId: string; kind: 'joined' | 'left' | 'published' }): void
}

export class RelayRooms {
  private rooms = new Map<string, Room>()
  private bySocket = new Map<string, { roomId: string; machineId: string }>()

  private readonly deps: RelayRoomsDependencies

  constructor(deps: RelayRoomsDependencies = {}) {
    this.deps = deps
  }

  private now(): number { return this.deps.now?.() ?? Date.now() }

  /**
   * Binds an authenticated socket to a machine in a room.
   *
   * One machine holds one socket. A second one is not a second presence, it is the same machine
   * reconnecting over a connection whose death this server has not noticed yet - so the older one
   * is closed rather than kept, and messages stop going to a socket nobody is reading.
   */
  join(socket: RelaySocketHandle, request: RelayJoinRequest): { ok: true; presence: RelayPresence[] } | { ok: false; code: RelayErrorCode; message: string } {
    let room = this.rooms.get(request.roomId)
    if (!room) {
      room = { id: request.roomId, machines: new Map() }
      this.rooms.set(room.id, room)
    }
    let machine = room.machines.get(request.machineId)
    if (!machine && room.machines.size >= RELAY_ROOM_MAX_MACHINES) {
      if (!this.evictStale(room)) {
        return { ok: false, code: 'room-full', message: 'This relay room already holds as many machines as it accepts.' }
      }
    }
    if (!machine) {
      machine = {
        machineId: request.machineId,
        machineName: request.machineName,
        deviceKey: request.deviceKey,
        entry: null,
        socket: null,
        lastSeenAt: this.now(),
        queue: [],
        queuedBytes: 0
      }
      room.machines.set(machine.machineId, machine)
    }

    // A machine is its device key. Reusing one machine id under a different key would let anyone
    // who holds the room secret take over an established identity's presence and queued messages -
    // the messages themselves stay sealed to the real key, but the impersonation is not something
    // to allow at the routing layer either.
    if (machine.deviceKey !== request.deviceKey) {
      if (machine.socket) {
        return { ok: false, code: 'unauthorized', message: 'Another device key is already connected as this machine.' }
      }
      machine.deviceKey = request.deviceKey
      machine.entry = null
      machine.queue = []
      machine.queuedBytes = 0
    }

    const previous = machine.socket
    machine.socket = socket
    machine.machineName = request.machineName
    machine.lastSeenAt = this.now()
    this.bySocket.set(socket.id, { roomId: room.id, machineId: machine.machineId })
    if (previous) {
      this.bySocket.delete(previous.id)
      previous.close('replaced', 'This machine connected again from somewhere else.')
    }
    this.deps.observed?.({ room: room.id, machineId: machine.machineId, kind: 'joined' })
    return { ok: true, presence: this.presenceOf(room) }
  }

  /** Drops the socket's binding. The machine stays in the room, offline, so a peer can still find
   *  its published key and leave it a message. */
  leave(socketId: string): void {
    const bound = this.bySocket.get(socketId)
    if (!bound) return
    this.bySocket.delete(socketId)
    const room = this.rooms.get(bound.roomId)
    const machine = room?.machines.get(bound.machineId)
    if (!room || !machine) return
    if (machine.socket?.id === socketId) {
      machine.socket = null
      machine.lastSeenAt = this.now()
      this.deps.observed?.({ room: room.id, machineId: machine.machineId, kind: 'left' })
      this.broadcastPresence(room)
    }
    if (![...room.machines.values()].some(entry => entry.socket)) {
      // Nobody is left to deliver to, and every machine republishes on its next connect, so the
      // room is not state worth holding on to.
      this.rooms.delete(room.id)
    }
  }

  publish(socketId: string, entry: unknown): boolean {
    const machine = this.machineFor(socketId)
    if (!machine) return false
    machine.machine.entry = entry
    machine.machine.lastSeenAt = this.now()
    this.deps.observed?.({ room: machine.room.id, machineId: machine.machine.machineId, kind: 'published' })
    this.broadcastPresence(machine.room)
    return true
  }

  /**
   * Moves one sealed envelope to the machine it is addressed to, or holds it briefly if that
   * machine is not connected. A message for a machine this room has never seen is refused outright:
   * the sender learns at once that the peer is not there, instead of waiting out its own timeout.
   */
  route(socketId: string, to: string, envelope: unknown, bytes: number): RouteOutcome {
    const sender = this.machineFor(socketId)
    if (!sender) return { ok: false, code: 'unauthorized', message: 'This socket has not said who it is.' }
    const target = sender.room.machines.get(to)
    if (!target) return { ok: false, code: 'unknown-peer', message: 'That machine is not connected to this relay.' }
    if (target.machineId === sender.machine.machineId) return { ok: false, code: 'unknown-peer', message: 'A machine cannot relay to itself.' }
    if (target.socket) {
      target.socket.send({ t: 'envelope', envelope })
      return { ok: true, delivery: 'online' }
    }
    this.dropExpired(target)
    if (target.queue.length >= RELAY_QUEUE_MAX_MESSAGES || target.queuedBytes + bytes > RELAY_QUEUE_MAX_BYTES) {
      return { ok: false, code: 'queue-full', message: 'That machine is offline and is already holding as much as this relay keeps for it.' }
    }
    target.queue.push({ envelope, bytes, queuedAt: this.now() })
    target.queuedBytes += bytes
    return { ok: true, delivery: 'queued' }
  }

  /** Hands a freshly joined machine whatever arrived while it was away, newest last. */
  drain(socketId: string): void {
    const bound = this.machineFor(socketId)
    if (!bound) return
    this.dropExpired(bound.machine)
    const queued = bound.machine.queue
    bound.machine.queue = []
    bound.machine.queuedBytes = 0
    for (const message of queued) bound.machine.socket?.send({ t: 'envelope', envelope: message.envelope })
  }

  /** Tells everyone in the room who is there now. Called after every change worth knowing about. */
  broadcastPresence(room: Room): void {
    const presence = this.presenceOf(room)
    for (const machine of room.machines.values()) machine.socket?.send({ t: 'presence', presence })
  }

  announce(socketId: string): void {
    const bound = this.machineFor(socketId)
    if (bound) this.broadcastPresence(bound.room)
  }

  presenceFor(socketId: string): RelayPresence[] {
    const bound = this.machineFor(socketId)
    return bound ? this.presenceOf(bound.room) : []
  }

  /** Drops messages nobody can still be waiting for, and rooms that have gone quiet. */
  sweep(): void {
    for (const room of [...this.rooms.values()]) {
      for (const machine of room.machines.values()) this.dropExpired(machine)
      if (![...room.machines.values()].some(machine => machine.socket)) this.rooms.delete(room.id)
    }
  }

  stats(): { rooms: number; machines: number; online: number; queued: number } {
    let machines = 0, online = 0, queued = 0
    for (const room of this.rooms.values()) {
      for (const machine of room.machines.values()) {
        machines++
        if (machine.socket) online++
        queued += machine.queue.length
      }
    }
    return { rooms: this.rooms.size, machines, online, queued }
  }

  closeAll(code: RelayErrorCode, message: string): void {
    for (const room of this.rooms.values()) {
      for (const machine of room.machines.values()) machine.socket?.close(code, message)
    }
    this.rooms.clear()
    this.bySocket.clear()
  }

  private presenceOf(room: Room): RelayPresence[] {
    return [...room.machines.values()].map(machine => ({
      machineId: machine.machineId,
      online: machine.socket !== null,
      entry: machine.entry,
      lastSeenAt: new Date(machine.lastSeenAt).toISOString()
    }))
  }

  private machineFor(socketId: string): { room: Room; machine: RoomMachine } | null {
    const bound = this.bySocket.get(socketId)
    if (!bound) return null
    const room = this.rooms.get(bound.roomId)
    const machine = room?.machines.get(bound.machineId)
    return room && machine ? { room, machine } : null
  }

  private dropExpired(machine: RoomMachine): void {
    const now = this.now()
    if (!machine.queue.length) return
    const kept = machine.queue.filter(message => now - message.queuedAt <= RELAY_QUEUE_TTL_MS)
    if (kept.length === machine.queue.length) return
    machine.queue = kept
    machine.queuedBytes = kept.reduce((total, message) => total + message.bytes, 0)
  }

  /** Makes room for a new machine by forgetting one that is offline and holding nothing. */
  private evictStale(room: Room): boolean {
    let oldest: RoomMachine | null = null
    for (const machine of room.machines.values()) {
      if (machine.socket || machine.queue.length) continue
      if (!oldest || machine.lastSeenAt < oldest.lastSeenAt) oldest = machine
    }
    if (!oldest) return false
    room.machines.delete(oldest.machineId)
    return true
  }
}
