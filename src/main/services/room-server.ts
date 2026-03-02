import { EventEmitter } from 'events'
import { WebSocketServer, WebSocket } from 'ws'
import { v4 as uuid } from 'uuid'
import type { RoomMessage } from '../../shared/protocol'
import { HEARTBEAT_INTERVAL_MS } from '../../shared/protocol'
import type { Member, FileFingerprint, PlaybackState } from '../../shared/types'

interface ClientInfo {
  ws: WebSocket
  member: Member
  fingerprint: FileFingerprint | null
  alive: boolean
}

export class RoomServer extends EventEmitter {
  private wss: WebSocketServer | null = null
  private clients = new Map<string, ClientInfo>()
  private hostId: string
  private roomId: string
  private roomName: string
  private password: string | null
  private hostFingerprint: FileFingerprint | null = null
  private playbackState: PlaybackState | null = null
  private heartbeatTimer: NodeJS.Timer | null = null
  private port = 0

  constructor(
    roomName: string,
    hostId: string,
    hostNickname: string,
    password?: string
  ) {
    super()
    this.roomId = uuid()
    this.roomName = roomName
    this.hostId = hostId
    this.password = password || null

    this.clients.set(hostId, {
      ws: null as unknown as WebSocket,
      member: { id: hostId, nickname: hostNickname, isHost: true, fileMatched: false },
      fingerprint: null,
      alive: true
    })
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ port: 0 }, () => {
        const addr = this.wss!.address()
        this.port = typeof addr === 'object' ? addr.port : 0
        this.startHeartbeat()
        resolve(this.port)
      })
      this.wss.on('error', reject)
      this.wss.on('connection', (ws) => this.handleConnection(ws))
    })
  }

  getRoomId(): string {
    return this.roomId
  }

  getPort(): number {
    return this.port
  }

  getMembers(): Member[] {
    return Array.from(this.clients.values()).map((c) => c.member)
  }

  getMemberCount(): number {
    return this.clients.size
  }

  setHostFingerprint(fp: FileFingerprint): void {
    this.hostFingerprint = fp
    const hostClient = this.clients.get(this.hostId)
    if (hostClient) {
      hostClient.fingerprint = fp
      hostClient.member.fileMatched = true
    }
  }

  getHostFingerprint(): FileFingerprint | null {
    return this.hostFingerprint
  }

  updatePlaybackState(state: PlaybackState): void {
    this.playbackState = state
    this.broadcast({
      type: 'playback_update',
      state,
      senderId: this.hostId
    })
  }

  broadcastPlayback(state: PlaybackState, senderId: string): void {
    this.playbackState = state
    this.broadcast(
      { type: 'playback_update', state, senderId },
      senderId
    )
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }

    this.broadcast({ type: 'room_closed', reason: '房主已关闭房间' })

    for (const [id, client] of this.clients) {
      if (id !== this.hostId && client.ws) {
        try { client.ws.close() } catch { /* ignore */ }
      }
    }
    this.clients.clear()

    if (this.wss) {
      this.wss.close()
      this.wss = null
    }
  }

  private handleConnection(ws: WebSocket): void {
    let authenticated = false
    let memberId = ''

    const timeout = setTimeout(() => {
      if (!authenticated) ws.close(4001, 'auth timeout')
    }, 10000)

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as RoomMessage

        if (!authenticated) {
          if (msg.type === 'auth') {
            clearTimeout(timeout)
            if (this.password && msg.password !== this.password) {
              this.send(ws, { type: 'auth_result', success: false, error: '密码错误' })
              ws.close(4003, 'wrong password')
              return
            }

            memberId = msg.memberId
            const member: Member = {
              id: memberId,
              nickname: msg.nickname,
              isHost: false,
              fileMatched: false
            }

            this.clients.set(memberId, {
              ws,
              member,
              fingerprint: null,
              alive: true
            })

            authenticated = true
            this.send(ws, { type: 'auth_result', success: true })
            this.send(ws, {
              type: 'room_snapshot',
              members: this.getMembers(),
              playbackState: this.playbackState ?? undefined,
              hostFingerprint: this.hostFingerprint ?? undefined
            })

            this.broadcast(
              { type: 'member_joined', member },
              memberId
            )
            this.emit('member-joined', member)
          }
          return
        }

        this.handleClientMessage(memberId, msg)
      } catch {
        // ignore malformed messages
      }
    })

    ws.on('close', () => {
      clearTimeout(timeout)
      if (memberId && this.clients.has(memberId)) {
        const client = this.clients.get(memberId)!
        this.clients.delete(memberId)
        this.broadcast({
          type: 'member_left',
          memberId,
          nickname: client.member.nickname
        })
        this.emit('member-left', client.member)
      }
    })

    ws.on('pong', () => {
      const client = Array.from(this.clients.values()).find((c) => c.ws === ws)
      if (client) client.alive = true
    })
  }

  private handleClientMessage(senderId: string, msg: RoomMessage): void {
    switch (msg.type) {
      case 'file_info': {
        const client = this.clients.get(senderId)
        if (!client) return
        const fp = (msg as { fingerprint: FileFingerprint }).fingerprint
        client.fingerprint = fp

        const matched = this.hostFingerprint
          ? fp.hash === this.hostFingerprint.hash && fp.size === this.hostFingerprint.size
          : false

        client.member.fileMatched = matched
        this.send(client.ws, { type: 'file_match_result', memberId: senderId, matched })
        this.emit('file-checked', { memberId: senderId, matched })
        break
      }
      case 'playback_update': {
        const state = (msg as { state: PlaybackState }).state
        this.broadcastPlayback(state, senderId)
        this.emit('remote-playback', state, senderId)
        break
      }
      case 'heartbeat': {
        const client = this.clients.get(senderId)
        if (client) this.send(client.ws, { type: 'heartbeat_ack' })
        break
      }
    }
  }

  private broadcast(msg: RoomMessage, excludeId?: string): void {
    const data = JSON.stringify(msg)
    for (const [id, client] of this.clients) {
      if (id === excludeId || id === this.hostId) continue
      if (client.ws && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data)
      }
    }
  }

  private send(ws: WebSocket, msg: RoomMessage): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      for (const [id, client] of this.clients) {
        if (id === this.hostId) continue
        if (!client.alive) {
          client.ws.terminate()
          this.clients.delete(id)
          this.broadcast({ type: 'member_left', memberId: id, nickname: client.member.nickname })
          this.emit('member-left', client.member)
          continue
        }
        client.alive = false
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.ping()
        }
      }
    }, HEARTBEAT_INTERVAL_MS)
  }
}
