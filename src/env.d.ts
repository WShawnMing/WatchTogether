/// <reference types="vite/client" />

import type {
  DiscoveryAdvertisePayload,
  DiscoverySession,
} from '../shared/protocol'

declare global {
  interface Window {
    desktopApp?: {
      electronVersion: string
      platform: string
      relay: {
        start: (preferredPort?: number) => Promise<{
          port: number
          localUrl: string
          shareUrls: string[]
          allUrls: string[]
        }>
        stop: () => Promise<{ ok: true }>
        status: () => Promise<{
          running: boolean
          port: number | null
          localUrl: string | null
          shareUrls: string[]
          allUrls: string[]
        }>
      }
      discovery: {
        advertise: (
          payload: DiscoveryAdvertisePayload | null,
        ) => Promise<{ ok: true }>
        list: (options?: { force?: boolean }) => Promise<DiscoverySession[]>
      }
    }
  }
}

export {}
