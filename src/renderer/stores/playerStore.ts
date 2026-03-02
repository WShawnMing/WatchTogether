import { create } from 'zustand'
import type { PlayerStatus, ToastMessage } from '../../shared/types'

interface PlayerState {
  status: PlayerStatus
  toasts: ToastMessage[]
  subtitleSize: number
  subtitlePosition: number

  setStatus: (s: PlayerStatus) => void
  addToast: (t: ToastMessage) => void
  removeToast: (id: string) => void
  setSubtitleSize: (n: number) => void
  setSubtitlePosition: (n: number) => void
  reset: () => void
}

const defaultStatus: PlayerStatus = {
  file: null,
  playing: false,
  position: 0,
  duration: 0,
  paused: true,
  speed: 1,
  subtitleFile: null
}

export const usePlayerStore = create<PlayerState>((set) => ({
  status: { ...defaultStatus },
  toasts: [],
  subtitleSize: 48,
  subtitlePosition: 100,

  setStatus: (status) => set({ status }),

  addToast: (toast) =>
    set((state) => ({
      toasts: [...state.toasts.filter((t) => t.id !== toast.id), toast]
    })),

  removeToast: (id) =>
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id)
    })),

  setSubtitleSize: (subtitleSize) => set({ subtitleSize }),
  setSubtitlePosition: (subtitlePosition) => set({ subtitlePosition }),

  reset: () => set({ status: { ...defaultStatus }, toasts: [] })
}))
