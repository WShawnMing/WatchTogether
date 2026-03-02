import { EventEmitter } from 'events'
import WebSocket from 'ws'
import type { RoomMessage } from '../../shared/protocol'
import { RECONNECT_DELAY_MS, MAX_RECONNECT_ATTEMPTS, HEARTBEAT_INTERVAL_MS } from '../../shared/protocol'
import type { FileFingerprint, PlaybackState } from '../../shared/types'

export class RoomClient extends EventEmitter {
  private ws: WebSocket | null = null
  private url: string
  private nickname: string
  private memberId: string
  private password: string | null
  private reconnectAttempts = 0
  private reconnectTimer: NodeJS.Timer | null = null
  private heartbeatTimer: NodeJS.Timer | null = null
  private closed = false

  constructor(host: string, port: number, nickname: string, memberId: string, password?: string) {
    super()
    this.url = `ws://${host}:${port}`
    this.nickname = nickname
    this.memberId = memberId
    this.password = password || null
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url)

      this.ws.on('open', () => {
        this.reconnectAttempts = 0
        this.send({
          type: 'auth',
          nickname: this.nickname,
          memberId: this.memberId,
          password: this.password ?? undefined
        } as RoomMessage)
        this.startHeartbeat()
      })

      let resolved = false

      this.ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as RoomMessage
          if (!resolved && msg.type === 'auth_result') {
            resolved = true
            if ((msg as { success: boolean }).success) {
              resolve()
            } else {
              reject(new Error((msg as { error?: string }).error || '认证失败'))
            }
            return
          }
          this.handleMessage(msg)
        } catch {
          // ignore
        }
      })

      this.ws.on('close', (code) => {
        this.stopHeartbeat()
        if (!resolved) {
          resolved = true
          reject(new Error('连接已关闭'))
          return
        }
        if (!this.closed && code !== 4003) {
          this.tryReconnect()
        }
        this.emit('disconnected')
      })

      this.ws.on('error', (err) => {
        if (!resolved) {
          resolved = true
          reject(err)
        }
      })
    })
  }

  sendFileInfo(fingerprint: FileFingerprint): void {
    this.send({ type: 'file_info', memberId: this.memberId, fingerprint } as RoomMessage)
  }

  sendPlaybackUpdate(state: PlaybackState): void {
    this.send({ type: 'playback_update', state, senderId: this.memberId } as RoomMessage)
  }

  disconnect(): void {
    this.closed = true
    this.stopHeartbeat()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      try { this.ws.close() } catch { /* ignore */ }
      this.ws = null
    }
  }

  private handleMessage(msg: RoomMessage): void {
    switch (msg.type) {
      case 'room_snapshot':
        this.emit('snapshot', msg)
        break
      case 'member_joined':
        this.emit('member-joined', (msg as { member: unknown }).member)
        break
      case 'member_left':
        this.emit('member-left', {
          memberId: (msg as { memberId: string }).memberId,
          nickname: (msg as { nickname: string }).nickname
        })
        break
      case 'file_match_result':
        this.emit('file-match', {
          memberId: (msg as { memberId: string }).memberId,
          matched: (msg as { matched: boolean }).matched
        })
        break
      case 'playback_update':
        this.emit('remote-playback', (msg as { state: PlaybackState }).state)
        break
      case 'room_closed':
        this.closed = true
        this.emit('room-closed', (msg as { reason: string }).reason)
        this.disconnect()
        break
      case 'heartbeat_ack':
        break
    }
  }

  private send(msg: RoomMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  private tryReconnect(): void {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.emit('room-closed', '连接断开，重连失败')
      return
    }
    this.reconnectAttempts++
    const delay = RECONNECT_DELAY_MS * Math.pow(1.5, this.reconnectAttempts - 1)
    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect()
        this.emit('reconnected')
      } catch {
        this.tryReconnect()
      }
    }, delay)
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: 'heartbeat' } as RoomMessage)
    }, HEARTBEAT_INTERVAL_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }
}
