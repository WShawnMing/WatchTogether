import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  setNickname: (nickname: string) => ipcRenderer.invoke('app:setNickname', nickname),

  createRoom: (name: string, password?: string) => ipcRenderer.invoke('room:create', name, password),
  joinRoom: (roomId: string, nickname: string, password?: string) => ipcRenderer.invoke('room:join', roomId, nickname, password),
  joinByIp: (ip: string, port: number, password?: string) => ipcRenderer.invoke('room:joinByIp', ip, port, password),
  probeIp: (ip: string) => ipcRenderer.invoke('room:probeIp', ip),
  leaveRoom: () => ipcRenderer.invoke('room:leave'),
  refreshRooms: () => ipcRenderer.invoke('room:refresh'),

  selectVideoFile: () => ipcRenderer.invoke('player:selectFile'),
  selectSubtitleFile: () => ipcRenderer.invoke('subtitle:select'),

  // Events
  onRoomList: (cb: (rooms: unknown[]) => void) => {
    const h = (_: unknown, d: unknown[]) => cb(d)
    ipcRenderer.on('room:list', h)
    return () => { ipcRenderer.removeListener('room:list', h) }
  },
  onRoomUpdate: (cb: (data: unknown) => void) => {
    const h = (_: unknown, d: unknown) => cb(d)
    ipcRenderer.on('room:update', h)
    return () => { ipcRenderer.removeListener('room:update', h) }
  },
  onMpvState: (cb: (data: any) => void) => {
    const h = (_: unknown, d: any) => cb(d)
    ipcRenderer.on('mpv:state', h)
    return () => { ipcRenderer.removeListener('mpv:state', h) }
  },
  onMpvTracks: (cb: (data: { subs: any[]; audio: any[] }) => void) => {
    const h = (_: unknown, d: any) => cb(d)
    ipcRenderer.on('mpv:tracks', h)
    return () => { ipcRenderer.removeListener('mpv:tracks', h) }
  },
  onFileLoaded: (cb: (data: { filePath: string; fileName: string }) => void) => {
    const h = (_: unknown, d: any) => cb(d)
    ipcRenderer.on('player:fileLoaded', h)
    return () => { ipcRenderer.removeListener('player:fileLoaded', h) }
  },
  onToast: (cb: (data: unknown) => void) => {
    const h = (_: unknown, d: unknown) => cb(d)
    ipcRenderer.on('app:toast', h)
    return () => { ipcRenderer.removeListener('app:toast', h) }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) { console.error(error) }
} else {
  // @ts-ignore
  window.electron = electronAPI
  // @ts-ignore
  window.api = api
}
