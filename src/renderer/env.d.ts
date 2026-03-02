/// <reference types="vite/client" />

import type { RoomInfo, Member, ToastMessage, FileFingerprint, PlaybackState } from '../shared/types'

interface MpvState { position: number; duration: number; paused: boolean; volume: number; speed: number; muted: boolean; filename: string }
interface TrackItem { id: number; title: string; lang: string; selected: boolean }

interface RoomUpdate {
  type: 'joined' | 'left' | 'snapshot' | 'file_match' | 'closed' | 'member_joined' | 'member_left'
  roomId?: string; roomName?: string; members?: Member[]; member?: Member
  memberId?: string; nickname?: string; matched?: boolean; reason?: string
  playbackState?: PlaybackState; hostFingerprint?: FileFingerprint; isHost?: boolean
}

interface Api {
  setNickname: (nickname: string) => Promise<void>
  createRoom: (name: string, password?: string) => Promise<{ success: boolean; error?: string }>
  joinRoom: (roomId: string, nickname: string, password?: string) => Promise<{ success: boolean; error?: string }>
  joinByIp: (ip: string, port: number, password?: string) => Promise<{ success: boolean; error?: string }>
  probeIp: (ip: string) => Promise<void>
  leaveRoom: () => Promise<void>
  refreshRooms: () => Promise<void>

  selectVideoFile: () => Promise<{ success: boolean; filePath?: string; error?: string }>
  selectSubtitleFile: () => Promise<{ success: boolean }>

  onRoomList: (cb: (rooms: RoomInfo[]) => void) => () => void
  onRoomUpdate: (cb: (data: RoomUpdate) => void) => () => void
  onMpvState: (cb: (data: MpvState) => void) => () => void
  onMpvTracks: (cb: (data: { subs: TrackItem[]; audio: TrackItem[] }) => void) => () => void
  onFileLoaded: (cb: (data: { filePath: string; fileName: string }) => void) => () => void
  onToast: (cb: (data: ToastMessage) => void) => () => void
}

declare global {
  interface Window {
    electron: typeof import('@electron-toolkit/preload').electronAPI
    api: Api
  }
}
