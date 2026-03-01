import { contextBridge, ipcRenderer } from 'electron'
import type {
  DiscoveryAdvertisePayload,
  DiscoverySession,
} from '../shared/protocol.js'

contextBridge.exposeInMainWorld('desktopApp', {
  electronVersion: process.versions.electron,
  platform: process.platform,
  relay: {
    start: (preferredPort?: number) => ipcRenderer.invoke('relay:start', preferredPort),
    stop: () => ipcRenderer.invoke('relay:stop'),
    status: () => ipcRenderer.invoke('relay:status'),
  },
  files: {
    hashSha256: (filePath: string) =>
      ipcRenderer.invoke('files:hash-sha256', filePath) as Promise<{ sha256: string }>,
    preparePlayback: (options: {
      filePath: string
      originalName: string
      mimeType: string
      sha256?: string
    }) =>
      ipcRenderer.invoke('files:prepare-playback', options) as Promise<{
        playableUrl: string
        source: 'original' | 'proxy'
        duration: number | null
        videoCodec: string | null
        audioCodec: string | null
        warning: string | null
      }>,
  },
  discovery: {
    advertise: (payload: DiscoveryAdvertisePayload | null) =>
      ipcRenderer.invoke('discovery:advertise', payload),
    list: (options?: { force?: boolean }) =>
      ipcRenderer.invoke('discovery:list', options) as Promise<DiscoverySession[]>,
  },
})
