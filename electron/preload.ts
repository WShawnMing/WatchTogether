import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('desktopApp', {
  electronVersion: process.versions.electron,
  platform: process.platform,
  relay: {
    start: (preferredPort?: number) => ipcRenderer.invoke('relay:start', preferredPort),
    stop: () => ipcRenderer.invoke('relay:stop'),
    status: () => ipcRenderer.invoke('relay:status'),
  },
})
