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
  discovery: {
    advertise: (payload: DiscoveryAdvertisePayload | null) =>
      ipcRenderer.invoke('discovery:advertise', payload),
    list: (options?: { force?: boolean }) =>
      ipcRenderer.invoke('discovery:list', options) as Promise<DiscoverySession[]>,
  },
})
