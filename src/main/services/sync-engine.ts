import { EventEmitter } from 'events'
import { SYNC_GRACE_PERIOD_MS } from '../../shared/protocol'
import type { PlaybackState } from '../../shared/types'
import type { RoomServer } from './room-server'
import type { RoomClient } from './room-client'

/**
 * Simplified sync engine for HTML5 video in the renderer.
 * Instead of controlling the player directly, it:
 *  - Broadcasts local user actions to the room
 *  - Receives remote state and relays commands to the renderer via a callback
 */
export class SyncEngine extends EventEmitter {
  private server: RoomServer | null
  private client: RoomClient | null
  private isHost: boolean
  private sendCommand: (cmd: unknown) => void

  private stateVersion = 0
  private seekGraceUntil = 0

  constructor(opts: {
    sendCommand: (cmd: unknown) => void
    server?: RoomServer
    client?: RoomClient
    isHost: boolean
  }) {
    super()
    this.sendCommand = opts.sendCommand
    this.server = opts.server ?? null
    this.client = opts.client ?? null
    this.isHost = opts.isHost
    this.listen()
  }

  broadcastAction(action: string, position: number, paused: boolean, speed = 1): void {
    this.stateVersion++
    if (action === 'seek') {
      this.seekGraceUntil = Date.now() + SYNC_GRACE_PERIOD_MS
    }

    const state: PlaybackState = {
      version: this.stateVersion,
      timestamp: Date.now(),
      position,
      paused,
      speed
    }

    if (this.isHost && this.server) {
      this.server.broadcastPlayback(state, 'host')
    } else if (this.client) {
      this.client.sendPlaybackUpdate(state)
    }
  }

  destroy(): void {
    this.removeAllListeners()
  }

  private listen(): void {
    if (this.server) {
      this.server.on('remote-playback', (state: PlaybackState) => {
        this.applyRemote(state)
      })
    }
    if (this.client) {
      this.client.on('remote-playback', (state: PlaybackState) => {
        this.applyRemote(state)
      })
    }
  }

  private applyRemote(state: PlaybackState): void {
    if (Date.now() < this.seekGraceUntil) return

    this.sendCommand({
      action: 'sync',
      state: { position: state.position, paused: state.paused, speed: state.speed }
    })
  }
}
