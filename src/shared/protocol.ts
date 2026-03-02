import type { FileFingerprint, Member, PlaybackState } from './types'

export const DISCOVERY_PORT = 42424
export const DISCOVERY_INTERVAL_MS = 3000
export const ROOM_STALE_MS = 6000
export const SYNC_GRACE_PERIOD_MS = 2000
export const HEARTBEAT_INTERVAL_MS = 5000
export const RECONNECT_DELAY_MS = 2000
export const MAX_RECONNECT_ATTEMPTS = 5
export const FINGERPRINT_SAMPLE_SIZE = 4 * 1024 * 1024 // 4MB per chunk

export const DISCOVERY_MAGIC = 'WATCHTOGETHER_V1'

export type RoomMessage =
  | { type: 'auth'; password?: string; nickname: string; memberId: string }
  | { type: 'auth_result'; success: boolean; error?: string }
  | { type: 'room_snapshot'; members: Member[]; playbackState?: PlaybackState; hostFingerprint?: FileFingerprint }
  | { type: 'member_joined'; member: Member }
  | { type: 'member_left'; memberId: string; nickname: string }
  | { type: 'file_info'; memberId: string; fingerprint: FileFingerprint }
  | { type: 'file_match_result'; memberId: string; matched: boolean }
  | { type: 'playback_update'; state: PlaybackState; senderId: string }
  | { type: 'room_closed'; reason: string }
  | { type: 'heartbeat' }
  | { type: 'heartbeat_ack' }

export interface DiscoveryAnnounce {
  magic: typeof DISCOVERY_MAGIC
  action: 'announce'
  roomId: string
  roomName: string
  hostNickname: string
  port: number
  hasPassword: boolean
  memberCount: number
}

export interface DiscoveryProbe {
  magic: typeof DISCOVERY_MAGIC
  action: 'probe'
}

export interface DiscoveryGone {
  magic: typeof DISCOVERY_MAGIC
  action: 'gone'
  roomId: string
}
