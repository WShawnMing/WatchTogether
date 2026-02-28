export type SyncMode = 'soft' | 'strict'
export type PlaybackReason = 'user' | 'buffer_lock' | 'media_transfer'
export type PeerRole = 'host' | 'guest'
export type DiscoveryPlaybackState = 'idle' | 'paused' | 'playing'
export const MAX_ROOM_MEMBERS = 6

export interface PlaybackState {
  position: number
  paused: boolean
  playbackRate: number
  updatedAt: number
  updatedBy: string
  reason: PlaybackReason
}

export interface MediaDescriptor {
  id: string
  name: string
  size: number
  mimeType: string
  duration: number | null
}

export interface SubtitleDescriptor {
  id: string
  name: string
  format: 'vtt'
  language: string | null
}

export interface RoomMemberSnapshot {
  socketId: string
  nickname: string
  isHost: boolean
  buffering: boolean
  connectedAt: number
}

export interface MediaSnapshot extends MediaDescriptor {
  uploadedAt: number
}

export interface SubtitleSnapshot extends SubtitleDescriptor {
  uploadedAt: number
}

export interface RoomSnapshot {
  roomId: string
  roomName: string
  requiresPassword: boolean
  members: RoomMemberSnapshot[]
  media: MediaSnapshot | null
  subtitle: SubtitleSnapshot | null
  playbackState: PlaybackState
  syncMode: SyncMode
  maxMembers: number
  serverTime: number
}

export interface PlaybackEnvelope {
  roomId: string
  playbackState: PlaybackState
  bufferingUsers: string[]
  syncMode: SyncMode
  serverTime: number
}

export interface JoinRoomPayload {
  roomId: string
  nickname: string
  password?: string
  roomName?: string
}

export interface JoinRoomResult {
  ok: boolean
  error?: string
  snapshot?: RoomSnapshot
}

export interface PlaybackControlPayload {
  roomId: string
  position: number
  paused: boolean
  playbackRate: number
  reason: PlaybackReason
}

export interface BufferingPayload {
  roomId: string
  buffering: boolean
}

export interface RoomConfigPayload {
  roomId: string
  syncMode: SyncMode
}

export interface DiscoveryAnnouncement {
  type: 'watchtogether:announce'
  protocolVersion: 1
  instanceId: string
  roomId: string
  roomName: string
  hostNickname: string
  requiresPassword: boolean
  memberCount: number
  maxMembers: number
  mediaName: string | null
  subtitleName: string | null
  playbackState: DiscoveryPlaybackState
  port: number
  announcedAt: number
}

export interface DiscoveryAdvertisePayload {
  roomId: string
  roomName: string
  hostNickname: string
  requiresPassword: boolean
  memberCount: number
  maxMembers: number
  mediaName: string | null
  subtitleName: string | null
  playbackState: DiscoveryPlaybackState
  port: number
}

export interface DiscoverySession {
  instanceId: string
  roomId: string
  roomName: string
  hostNickname: string
  requiresPassword: boolean
  memberCount: number
  maxMembers: number
  mediaName: string | null
  subtitleName: string | null
  playbackState: DiscoveryPlaybackState
  serverUrl: string
  lastSeenAt: number
}

export interface PlaybackMessage {
  type: 'playback'
  playbackState: PlaybackState
}

export interface BufferingMessage {
  type: 'buffering'
  buffering: boolean
}

export interface MediaMetaMessage {
  type: 'media-meta'
  media: MediaDescriptor
}

export interface TransferCompleteMessage {
  type: 'transfer-complete'
  mediaId: string
}

export interface MediaReadyMessage {
  type: 'media-ready'
  mediaId: string
}

export interface SyncModeMessage {
  type: 'sync-mode'
  syncMode: SyncMode
}

export interface HelloMessage {
  type: 'hello'
  nickname: string
  peerId: string
  role: PeerRole
}

export interface PingMessage {
  type: 'ping'
  id: string
  sentAt: number
}

export interface PongMessage {
  type: 'pong'
  id: string
  sentAt: number
  responderAt: number
}

export type ControlMessage =
  | BufferingMessage
  | HelloMessage
  | MediaMetaMessage
  | MediaReadyMessage
  | PingMessage
  | PlaybackMessage
  | PongMessage
  | SyncModeMessage
  | TransferCompleteMessage

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function normalizeRoomId(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
}

export function createRoomCode(length = 6) {
  let roomCode = ''

  for (let index = 0; index < length; index += 1) {
    roomCode += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)]
  }

  return roomCode
}

export function createInitialPlaybackState(updatedBy = 'system'): PlaybackState {
  return {
    position: 0,
    paused: true,
    playbackRate: 1,
    updatedAt: Date.now(),
    updatedBy,
    reason: 'media_transfer',
  }
}

export function deriveCurrentPosition(
  playbackState: PlaybackState,
  referenceTime = Date.now(),
) {
  if (playbackState.paused) {
    return playbackState.position
  }

  const elapsedSeconds = Math.max(0, (referenceTime - playbackState.updatedAt) / 1000)

  return playbackState.position + elapsedSeconds * playbackState.playbackRate
}
