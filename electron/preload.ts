import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('desktopApp', {
  electronVersion: process.versions.electron,
  platform: process.platform,
})
