import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  setNickname: (nickname: string) => ipcRenderer.invoke('app:setNickname', nickname),

  createRoom: (name: string, password?: string) =>
    ipcRenderer.invoke('room:create', name, password),
  joinRoom: (roomId: string, nickname: string, password?: string) =>
    ipcRenderer.invoke('room:join', roomId, nickname, password),
  leaveRoom: () => ipcRenderer.invoke('room:leave'),
  refreshRooms: () => ipcRenderer.invoke('room:refresh'),

  selectVideoFile: () => ipcRenderer.invoke('player:selectFile'),
  play: () => ipcRenderer.invoke('player:play'),
  pause: () => ipcRenderer.invoke('player:pause'),
  togglePause: () => ipcRenderer.invoke('player:togglePause'),
  seek: (position: number) => ipcRenderer.invoke('player:seek', position),

  selectSubtitleFile: () => ipcRenderer.invoke('subtitle:select'),
  removeSubtitle: () => ipcRenderer.invoke('subtitle:remove'),
  setSubtitleSize: (size: number) => ipcRenderer.invoke('subtitle:setSize', size),
  setSubtitlePosition: (pos: number) => ipcRenderer.invoke('subtitle:setPosition', pos),

  onRoomList: (cb: (rooms: unknown[]) => void) => {
    const handler = (_: unknown, data: unknown[]) => cb(data)
    ipcRenderer.on('room:list', handler)
    return () => { ipcRenderer.removeListener('room:list', handler) }
  },
  onRoomUpdate: (cb: (data: unknown) => void) => {
    const handler = (_: unknown, data: unknown) => cb(data)
    ipcRenderer.on('room:update', handler)
    return () => { ipcRenderer.removeListener('room:update', handler) }
  },
  onPlayerState: (cb: (data: unknown) => void) => {
    const handler = (_: unknown, data: unknown) => cb(data)
    ipcRenderer.on('player:state', handler)
    return () => { ipcRenderer.removeListener('player:state', handler) }
  },
  onToast: (cb: (data: unknown) => void) => {
    const handler = (_: unknown, data: unknown) => cb(data)
    ipcRenderer.on('app:toast', handler)
    return () => { ipcRenderer.removeListener('app:toast', handler) }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore
  window.electron = electronAPI
  // @ts-ignore
  window.api = api
}
