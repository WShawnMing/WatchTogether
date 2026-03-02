import { create } from 'zustand'
import type { ToastMessage } from '../../shared/types'

export interface MpvState {
  position: number
  duration: number
  paused: boolean
  volume: number
  speed: number
  muted: boolean
  filename: string
}

export interface TrackItem {
  id: number
  title: string
  lang: string
  selected: boolean
}

interface PlayerState {
  mpv: MpvState | null
  filePath: string | null
  fileName: string | null
  subTracks: TrackItem[]
  audioTracks: TrackItem[]
  toasts: ToastMessage[]

  setMpvState: (s: MpvState) => void
  setFile: (filePath: string, fileName: string) => void
  setTracks: (subs: TrackItem[], audio: TrackItem[]) => void
  addToast: (t: ToastMessage) => void
  removeToast: (id: string) => void
  reset: () => void
}

export const usePlayerStore = create<PlayerState>((set) => ({
  mpv: null,
  filePath: null,
  fileName: null,
  subTracks: [],
  audioTracks: [],
  toasts: [],

  setMpvState: (mpv) => set({ mpv }),
  setFile: (filePath, fileName) => set({ filePath, fileName, subTracks: [], audioTracks: [] }),
  setTracks: (subTracks, audioTracks) => set({ subTracks, audioTracks }),
  addToast: (toast) => set((s) => ({ toasts: [...s.toasts.filter((t) => t.id !== toast.id), toast] })),
  removeToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  reset: () => set({ mpv: null, filePath: null, fileName: null, subTracks: [], audioTracks: [], toasts: [] })
}))
