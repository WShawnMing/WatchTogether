import dgram from 'dgram'
import os from 'os'
import { EventEmitter } from 'events'
import {
  DISCOVERY_PORT,
  DISCOVERY_INTERVAL_MS,
  ROOM_STALE_MS,
  DISCOVERY_MAGIC
} from '../../shared/protocol'
import type { DiscoveryAnnounce, DiscoveryProbe, DiscoveryGone } from '../../shared/protocol'
import type { RoomInfo } from '../../shared/types'

const MULTICAST_GROUP = '239.255.42.42'

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
        this.joinMulticast()
        resolve()
      })
      this.socket!.on('error', reject)
    })

    this.cleanupTimer = setInterval(() => this.cleanStaleRooms(), ROOM_STALE_MS / 2)
  }

  startAnnouncing(announce: DiscoveryAnnounce): void {
    this.announcing = announce
    this.sendAll()
    this.announceTimer = setInterval(() => this.sendAll(), DISCOVERY_INTERVAL_MS)
  }

  stopAnnouncing(): void {
    if (this.announcing && this.socket) {
      const gone: DiscoveryGone = {
        magic: DISCOVERY_MAGIC,
        action: 'gone',
        roomId: this.announcing.roomId
      }
      const buf = Buffer.from(JSON.stringify(gone))
      for (let i = 0; i < 3; i++) {
        setTimeout(() => this.sendEverywhere(buf), i * 200)
      }
    }
    if (this.announceTimer) {
      clearInterval(this.announceTimer)
      this.announceTimer = null
    }
    this.announcing = null
  }

  triggerProbe(): void {
    const buf = Buffer.from(JSON.stringify({ magic: DISCOVERY_MAGIC, action: 'probe' } as DiscoveryProbe))
    this.sendEverywhere(buf)
  }

  probeIp(ip: string): void {
    if (!this.socket) return
    const buf = Buffer.from(JSON.stringify({ magic: DISCOVERY_MAGIC, action: 'probe' } as DiscoveryProbe))
    try { this.socket.send(buf, 0, buf.length, DISCOVERY_PORT, ip) } catch {}
  }

  removeRoom(roomId: string): void {
    if (this.rooms.has(roomId)) {
      this.rooms.delete(roomId)
      this.emit('rooms-updated', this.getRooms())
    }
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
      try { this.socket.dropMembership(MULTICAST_GROUP) } catch {}
      this.socket.close()
      this.socket = null
    }
    this.rooms.clear()
  }

  private joinMulticast(): void {
    if (!this.socket) return

    // Join on default interface
    try { this.socket.addMembership(MULTICAST_GROUP) } catch {}

    // Also join on each specific IPv4 interface for VPN adapters
    const interfaces = os.networkInterfaces()
    for (const addrs of Object.values(interfaces)) {
      if (!addrs) continue
      for (const addr of addrs) {
        if (addr.family !== 'IPv4' || addr.internal) continue
        try { this.socket.addMembership(MULTICAST_GROUP, addr.address) } catch {}
      }
    }

    try { this.socket.setMulticastTTL(128) } catch {}
    try { this.socket.setMulticastLoopback(true) } catch {}
  }

  private handleMessage(raw: Buffer, rinfo: dgram.RemoteInfo): void {
    try {
      const data = JSON.parse(raw.toString())
      if (data.magic !== DISCOVERY_MAGIC) return

      if (data.action === 'announce') {
        this.handleAnnounce(data as DiscoveryAnnounce, rinfo.address)
      } else if (data.action === 'probe') {
        if (this.announcing) {
          const buf = Buffer.from(JSON.stringify(this.announcing))
          // Reply via unicast directly to the prober
          try { this.socket?.send(buf, 0, buf.length, DISCOVERY_PORT, rinfo.address) } catch {}
          // Also reply via multicast so others can see
          try { this.socket?.send(buf, 0, buf.length, DISCOVERY_PORT, MULTICAST_GROUP) } catch {}
        }
      } else if (data.action === 'gone') {
        this.handleGone(data as DiscoveryGone)
      }
    } catch {}
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

    if (isNew) this.emit('room-found', room)
    this.emit('rooms-updated', this.getRooms())
  }

  private handleGone(data: DiscoveryGone): void {
    if (this.rooms.has(data.roomId)) {
      this.rooms.delete(data.roomId)
      this.emit('rooms-updated', this.getRooms())
    }
  }

  private sendAll(): void {
    if (!this.announcing || !this.socket) return
    const buf = Buffer.from(JSON.stringify(this.announcing))
    this.sendEverywhere(buf)
  }

  /**
   * Send a buffer via every possible channel:
   * 1. Multicast group (works across VPN regardless of subnet)
   * 2. Subnet broadcast per interface (works on normal LAN)
   * 3. Unicast scan of /24 block per interface (fallback for blocked multicast)
   * 4. Global broadcast 255.255.255.255
   */
  private sendEverywhere(buf: Buffer): void {
    if (!this.socket) return

    const sent = new Set<string>()

    // 1. Multicast — the primary method for VPN networks
    try { this.socket.send(buf, 0, buf.length, DISCOVERY_PORT, MULTICAST_GROUP) } catch {}

    const interfaces = os.networkInterfaces()
    for (const addrs of Object.values(interfaces)) {
      if (!addrs) continue
      for (const addr of addrs) {
        if (addr.family !== 'IPv4' || addr.internal) continue

        // 2. Subnet broadcast
        const broadcast = this.calcBroadcast(addr.address, addr.netmask)
        if (!sent.has(broadcast)) {
          sent.add(broadcast)
          try { this.socket.send(buf, 0, buf.length, DISCOVERY_PORT, broadcast) } catch {}
        }

        // 3. Unicast scan /24 around our IP
        const parts = addr.address.split('.').map(Number)
        const self = parts[3]
        const base = `${parts[0]}.${parts[1]}.${parts[2]}`
        for (let i = 1; i < 255; i++) {
          if (i === self) continue
          const target = `${base}.${i}`
          if (!sent.has(target)) {
            sent.add(target)
            try { this.socket.send(buf, 0, buf.length, DISCOVERY_PORT, target) } catch {}
          }
        }
      }
    }

    // 4. Global broadcast
    if (!sent.has('255.255.255.255')) {
      try { this.socket.send(buf, 0, buf.length, DISCOVERY_PORT, '255.255.255.255') } catch {}
    }
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
    if (changed) this.emit('rooms-updated', this.getRooms())
  }

  private calcBroadcast(ip: string, mask: string): string {
    const ipParts = ip.split('.').map(Number)
    const maskParts = mask.split('.').map(Number)
    return ipParts.map((p, i) => (p | (~maskParts[i] & 255))).join('.')
  }
}
