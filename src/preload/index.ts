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
  reportAction: (data: { action: string; position: number; paused: boolean }) =>
    ipcRenderer.invoke('player:action', data),
  reportPlayerState: (state: unknown) => ipcRenderer.send('player:report', state),
  reportDuration: (duration: number) => ipcRenderer.send('player:duration', duration),

  // Legacy player controls (still called by keyboard shortcuts in App.tsx)
  play: () => ipcRenderer.invoke('player:play'),
  pause: () => ipcRenderer.invoke('player:pause'),
  togglePause: () => ipcRenderer.invoke('player:togglePause'),
  seek: (position: number) => ipcRenderer.invoke('player:seek', position),

  selectSubtitleFile: () => ipcRenderer.invoke('subtitle:select'),
  removeSubtitle: () => ipcRenderer.invoke('subtitle:remove'),
  setSubtitleSize: (size: number) => ipcRenderer.invoke('subtitle:setSize', size),
  setSubtitlePosition: (pos: number) => ipcRenderer.invoke('subtitle:setPosition', pos),

  // Events: main → renderer
  onRoomList: (cb: (rooms: unknown[]) => void) => {
    const h = (_: unknown, data: unknown[]) => cb(data)
    ipcRenderer.on('room:list', h)
    return () => { ipcRenderer.removeListener('room:list', h) }
  },
  onRoomUpdate: (cb: (data: unknown) => void) => {
    const h = (_: unknown, data: unknown) => cb(data)
    ipcRenderer.on('room:update', h)
    return () => { ipcRenderer.removeListener('room:update', h) }
  },
  onPlayerState: (cb: (data: unknown) => void) => {
    const h = (_: unknown, data: unknown) => cb(data)
    ipcRenderer.on('player:state', h)
    return () => { ipcRenderer.removeListener('player:state', h) }
  },
  onPlayerCommand: (cb: (data: unknown) => void) => {
    const h = (_: unknown, data: unknown) => cb(data)
    ipcRenderer.on('player:command', h)
    return () => { ipcRenderer.removeListener('player:command', h) }
  },
  onLoadMedia: (cb: (data: { url: string; filePath: string }) => void) => {
    const h = (_: unknown, data: { url: string; filePath: string }) => cb(data)
    ipcRenderer.on('player:loadMedia', h)
    return () => { ipcRenderer.removeListener('player:loadMedia', h) }
  },
  onLoadSubtitle: (cb: (data: { url: string | null; filePath?: string }) => void) => {
    const h = (_: unknown, data: { url: string | null; filePath?: string }) => cb(data)
    ipcRenderer.on('player:loadSubtitle', h)
    return () => { ipcRenderer.removeListener('player:loadSubtitle', h) }
  },
  onToast: (cb: (data: unknown) => void) => {
    const h = (_: unknown, data: unknown) => cb(data)
    ipcRenderer.on('app:toast', h)
    return () => { ipcRenderer.removeListener('app:toast', h) }
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
