import { EventEmitter } from 'events'
import { SYNC_GRACE_PERIOD_MS } from '../../shared/protocol'
import type { PlaybackState } from '../../shared/types'
import type { MpvPlayer } from './mpv-player'
import type { RoomServer } from './room-server'
import type { RoomClient } from './room-client'

/**
 * SyncEngine coordinates playback state between local mpv and the room.
 * Uses versioned state messages to prevent old state from overwriting new state.
 * Implements a grace period during seek operations to prevent "snap back".
 */
export class SyncEngine extends EventEmitter {
  private player: MpvPlayer
  private server: RoomServer | null
  private client: RoomClient | null
  private isHost: boolean

  private localVersion = 0
  private lastAppliedVersion = 0
  private seekGraceUntil = 0
  private lastBroadcast = 0
  private broadcastThrottle = 300 // ms between broadcasts
  private syncEnabled = true

  constructor(
    player: MpvPlayer,
    opts: { server?: RoomServer; client?: RoomClient; isHost: boolean }
  ) {
    super()
    this.player = player
    this.server = opts.server ?? null
    this.client = opts.client ?? null
    this.isHost = opts.isHost
    this.setup()
  }

  private setup(): void {
    this.player.on('state-change', () => this.onLocalStateChange())
    this.player.on('seeked', () => this.onLocalSeek())

    if (this.server) {
      this.server.on('remote-playback', (state: PlaybackState) => {
        this.onRemoteState(state)
      })
    }

    if (this.client) {
      this.client.on('remote-playback', (state: PlaybackState) => {
        this.onRemoteState(state)
      })
    }
  }

  async broadcastCurrentState(): Promise<void> {
    const state = await this.buildLocalState()
    this.broadcastState(state)
  }

  /**
   * Called when user performs a local action (play/pause/seek).
   * Broadcasts the new state immediately, bypassing throttle.
   */
  async onLocalAction(): Promise<void> {
    this.localVersion++
    const state = await this.buildLocalState()
    this.broadcastState(state)
  }

  async onLocalSeekAction(): Promise<void> {
    this.seekGraceUntil = Date.now() + SYNC_GRACE_PERIOD_MS
    await this.onLocalAction()
  }

  setSyncEnabled(enabled: boolean): void {
    this.syncEnabled = enabled
  }

  destroy(): void {
    this.player.removeAllListeners('state-change')
    this.player.removeAllListeners('seeked')
  }

  private async onLocalStateChange(): Promise<void> {
    const now = Date.now()
    if (now - this.lastBroadcast < this.broadcastThrottle) return

    this.localVersion++
    const state = await this.buildLocalState()
    this.broadcastState(state)
  }

  private onLocalSeek(): void {
    this.seekGraceUntil = Date.now() + SYNC_GRACE_PERIOD_MS
  }

  private async onRemoteState(state: PlaybackState): Promise<void> {
    if (!this.syncEnabled) return

    // Ignore stale states
    if (state.version <= this.lastAppliedVersion) return

    // During grace period, ignore remote seeks
    if (Date.now() < this.seekGraceUntil) return

    this.lastAppliedVersion = state.version

    try {
      const localPaused = await this.player.isPaused()
      const localPos = await this.player.getPosition()

      // Apply pause/resume
      if (state.paused && !localPaused) {
        await this.player.pause()
      } else if (!state.paused && localPaused) {
        await this.player.play()
      }

      // Apply position if difference is significant (> 1 second)
      const posDiff = Math.abs(localPos - state.position)
      if (posDiff > 1) {
        await this.player.seekTo(state.position)
      }
    } catch {
      // player might not be ready
    }

    this.emit('synced', state)
  }

  private async buildLocalState(): Promise<PlaybackState> {
    return {
      version: this.localVersion,
      timestamp: Date.now(),
      position: await this.player.getPosition(),
      paused: await this.player.isPaused(),
      speed: 1
    }
  }

  private broadcastState(state: PlaybackState): void {
    this.lastBroadcast = Date.now()

    if (this.isHost && this.server) {
      this.server.broadcastPlayback(state, 'host')
    } else if (this.client) {
      this.client.sendPlaybackUpdate(state)
    }
  }
}
