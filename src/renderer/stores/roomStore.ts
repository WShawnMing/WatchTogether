import { create } from 'zustand'
import type { RoomInfo, Member, FileFingerprint, PlaybackState } from '../../shared/types'

interface RoomUpdate {
  type: string
  roomId?: string
  roomName?: string
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

interface RoomState {
  nickname: string
  rooms: RoomInfo[]
  currentRoom: RoomInfo | null
  members: Member[]
  isHost: boolean
  hostFingerprint: FileFingerprint | null
  fileMatched: boolean

  setNickname: (n: string) => void
  setRooms: (r: RoomInfo[]) => void
  setCurrentRoom: (r: RoomInfo | null) => void
  setMembers: (m: Member[]) => void
  setIsHost: (v: boolean) => void
  setHostFingerprint: (f: FileFingerprint | null) => void
  setFileMatched: (v: boolean) => void
  handleRoomUpdate: (data: RoomUpdate) => void
  reset: () => void
}

export const useRoomStore = create<RoomState>((set, get) => ({
  nickname: '',
  rooms: [],
  currentRoom: null,
  members: [],
  isHost: false,
  hostFingerprint: null,
  fileMatched: false,

  setNickname: (nickname) => set({ nickname }),
  setRooms: (rooms) => set({ rooms }),
  setCurrentRoom: (currentRoom) => set({ currentRoom }),
  setMembers: (members) => set({ members }),
  setIsHost: (isHost) => set({ isHost }),
  setHostFingerprint: (hostFingerprint) => set({ hostFingerprint }),
  setFileMatched: (fileMatched) => set({ fileMatched }),

  handleRoomUpdate: (data) => {
    const state = get()
    switch (data.type) {
      case 'joined': {
        const existing = state.rooms.find((r) => r.id === data.roomId)
        set({
          currentRoom: existing ?? {
            id: data.roomId ?? '',
            name: data.roomName ?? '我的房间',
            hostIp: '',
            hostNickname: state.nickname,
            port: 0,
            hasPassword: false,
            memberCount: 1,
            lastSeen: Date.now()
          },
          isHost: data.isHost ?? false,
          fileMatched: false
        })
        break
      }
      case 'snapshot':
        set({
          members: data.members ?? [],
          hostFingerprint: data.hostFingerprint ?? null
        })
        break
      case 'member_joined':
        if (data.member && !state.members.find((m) => m.id === data.member!.id)) {
          set({ members: [...state.members, data.member] })
        }
        break
      case 'member_left':
        set({
          members: state.members.filter((m) => m.id !== data.memberId)
        })
        break
      case 'file_match':
        if (data.matched !== undefined) {
          set({ fileMatched: data.matched })
        }
        break
      case 'closed':
        set({
          currentRoom: null,
          members: [],
          isHost: false,
          hostFingerprint: null,
          fileMatched: false
        })
        break
      case 'left':
        set({
          currentRoom: null,
          members: [],
          isHost: false,
          hostFingerprint: null,
          fileMatched: false
        })
        break
    }
  },

  reset: () =>
    set({
      rooms: [],
      currentRoom: null,
      members: [],
      isHost: false,
      hostFingerprint: null,
      fileMatched: false
    })
}))
