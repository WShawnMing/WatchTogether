export interface RoomInfo {
  id: string
  name: string
  hostIp: string
  hostNickname: string
  port: number
  hasPassword: boolean
  memberCount: number
  lastSeen: number
}

export interface Member {
  id: string
  nickname: string
  isHost: boolean
  fileMatched: boolean
}

export interface FileFingerprint {
  hash: string
  size: number
  duration: number
  fileName: string
}

export interface PlaybackState {
  version: number
  timestamp: number
  position: number
  paused: boolean
  speed: number
}

export interface PlayerStatus {
  file: string | null
  playing: boolean
  position: number
  duration: number
  paused: boolean
  speed: number
  subtitleFile: string | null
}

export interface ToastMessage {
  id: string
  text: string
  type: 'info' | 'success' | 'warning' | 'error'
  duration?: number
}
