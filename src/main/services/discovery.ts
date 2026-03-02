import dgram from 'dgram'
import os from 'os'
import { EventEmitter } from 'events'
import {
  DISCOVERY_PORT,
  DISCOVERY_INTERVAL_MS,
  ROOM_STALE_MS,
  DISCOVERY_MAGIC
} from '../../shared/protocol'
import type { DiscoveryAnnounce, DiscoveryProbe } from '../../shared/protocol'
import type { RoomInfo } from '../../shared/types'

export class DiscoveryService extends EventEmitter {
  private socket: dgram.Socket | null = null
  private announceTimer: NodeJS.Timer | null = null
  private cleanupTimer: NodeJS.Timer | null = null
  private rooms = new Map<string, RoomInfo>()
  private announcing: DiscoveryAnnounce | null = null

  async start(): Promise<void> {
    if (this.socket) return

    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })

    this.socket.on('message', (msg, rinfo) => {
      this.handleMessage(msg, rinfo)
    })

    this.socket.on('error', (err) => {
      console.error('[Discovery] socket error:', err.message)
    })

    await new Promise<void>((resolve, reject) => {
      this.socket!.bind(DISCOVERY_PORT, () => {
        this.socket!.setBroadcast(true)
        resolve()
      })
      this.socket!.on('error', reject)
    })

    this.cleanupTimer = setInterval(() => this.cleanStaleRooms(), ROOM_STALE_MS)
  }

  startAnnouncing(announce: DiscoveryAnnounce): void {
    this.announcing = announce
    this.broadcastAnnounce()
    this.announceTimer = setInterval(() => this.broadcastAnnounce(), DISCOVERY_INTERVAL_MS)
  }

  stopAnnouncing(): void {
    if (this.announceTimer) {
      clearInterval(this.announceTimer)
      this.announceTimer = null
    }
    this.announcing = null
  }

  triggerProbe(): void {
    const msg = JSON.stringify({ magic: DISCOVERY_MAGIC, action: 'probe' } as DiscoveryProbe)
    const buf = Buffer.from(msg)
    this.broadcastToAll(buf)
  }

  getRooms(): RoomInfo[] {
    return Array.from(this.rooms.values())
  }

  async stop(): Promise<void> {
    this.stopAnnouncing()
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
    if (this.socket) {
      this.socket.close()
      this.socket = null
    }
    this.rooms.clear()
  }

  private handleMessage(raw: Buffer, rinfo: dgram.RemoteInfo): void {
    try {
      const data = JSON.parse(raw.toString())
      if (data.magic !== DISCOVERY_MAGIC) return

      if (data.action === 'announce') {
        this.handleAnnounce(data as DiscoveryAnnounce, rinfo.address)
      } else if (data.action === 'probe') {
        if (this.announcing) {
          this.broadcastAnnounce()
        }
      }
    } catch {
      // ignore malformed messages
    }
  }

  private handleAnnounce(data: DiscoveryAnnounce, ip: string): void {
    const room: RoomInfo = {
      id: data.roomId,
      name: data.roomName,
      hostIp: ip,
      hostNickname: data.hostNickname,
      port: data.port,
      hasPassword: data.hasPassword,
      memberCount: data.memberCount,
      lastSeen: Date.now()
    }

    const isNew = !this.rooms.has(room.id)
    this.rooms.set(room.id, room)

    if (isNew) {
      this.emit('room-found', room)
    }
    this.emit('rooms-updated', this.getRooms())
  }

  private broadcastAnnounce(): void {
    if (!this.announcing || !this.socket) return
    const buf = Buffer.from(JSON.stringify(this.announcing))
    this.broadcastToAll(buf)
  }

  private broadcastToAll(buf: Buffer): void {
    if (!this.socket) return

    const interfaces = os.networkInterfaces()
    const sent = new Set<string>()

    for (const addrs of Object.values(interfaces)) {
      if (!addrs) continue
      for (const addr of addrs) {
        if (addr.family !== 'IPv4' || addr.internal) continue
        const broadcast = this.calcBroadcast(addr.address, addr.netmask)
        if (sent.has(broadcast)) continue
        sent.add(broadcast)
        try {
          this.socket.send(buf, 0, buf.length, DISCOVERY_PORT, broadcast)
        } catch {
          // ignore send errors on specific interfaces
        }
      }
    }

    if (!sent.has('255.255.255.255')) {
      try {
        this.socket.send(buf, 0, buf.length, DISCOVERY_PORT, '255.255.255.255')
      } catch {
        // ignore
      }
    }
  }

  private calcBroadcast(ip: string, mask: string): string {
    const ipParts = ip.split('.').map(Number)
    const maskParts = mask.split('.').map(Number)
    return ipParts.map((p, i) => (p | (~maskParts[i] & 255))).join('.')
  }

  private cleanStaleRooms(): void {
    const now = Date.now()
    let changed = false
    for (const [id, room] of this.rooms) {
      if (now - room.lastSeen > ROOM_STALE_MS) {
        this.rooms.delete(id)
        changed = true
      }
    }
    if (changed) {
      this.emit('rooms-updated', this.getRooms())
    }
  }
}
