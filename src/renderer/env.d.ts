/// <reference types="vite/client" />

import type { RoomInfo, Member, PlayerStatus, ToastMessage, FileFingerprint, PlaybackState } from '../shared/types'

interface RoomUpdate {
  type: 'joined' | 'left' | 'snapshot' | 'file_match' | 'closed' | 'member_joined' | 'member_left'
  roomId?: string
  members?: Member[]
  member?: Member
  memberId?: string
  nickname?: string
  matched?: boolean
  reason?: string
  playbackState?: PlaybackState
  hostFingerprint?: FileFingerprint
  isHost?: boolean
}

interface Api {
  setNickname: (nickname: string) => Promise<void>
  createRoom: (name: string, password?: string) => Promise<{ success: boolean; error?: string }>
  joinRoom: (roomId: string, nickname: string, password?: string) => Promise<{ success: boolean; error?: string }>
  leaveRoom: () => Promise<void>
  refreshRooms: () => Promise<void>
  selectVideoFile: () => Promise<{ success: boolean; filePath?: string; fingerprint?: FileFingerprint; error?: string }>
  play: () => Promise<void>
  pause: () => Promise<void>
  togglePause: () => Promise<void>
  seek: (position: number) => Promise<void>
  selectSubtitleFile: () => Promise<{ success: boolean; filePath?: string; error?: string }>
  removeSubtitle: () => Promise<void>
  setSubtitleSize: (size: number) => Promise<void>
  setSubtitlePosition: (pos: number) => Promise<void>
  onRoomList: (cb: (rooms: RoomInfo[]) => void) => () => void
  onRoomUpdate: (cb: (data: RoomUpdate) => void) => () => void
  onPlayerState: (cb: (data: PlayerStatus) => void) => () => void
  onToast: (cb: (data: ToastMessage) => void) => () => void
}

declare global {
  interface Window {
    electron: typeof import('@electron-toolkit/preload').electronAPI
    api: Api
  }
}
