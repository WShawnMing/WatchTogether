import { ipcMain, dialog, BrowserWindow } from 'electron'
import { v4 as uuid } from 'uuid'
import { MediaServer } from '../services/media-server'
import { DiscoveryService } from '../services/discovery'
import { RoomServer } from '../services/room-server'
import { RoomClient } from '../services/room-client'
import { SyncEngine } from '../services/sync-engine'
import { computeFingerprint } from '../services/fingerprint'
import { DISCOVERY_MAGIC } from '../../shared/protocol'
import type { DiscoveryAnnounce } from '../../shared/protocol'
import type { FileFingerprint, ToastMessage } from '../../shared/types'

let mainWindow: BrowserWindow
let mediaServer: MediaServer | null = null
let discovery: DiscoveryService | null = null
let roomServer: RoomServer | null = null
let roomClient: RoomClient | null = null
let syncEngine: SyncEngine | null = null

let nickname = ''
const memberId = uuid()
let currentFingerprint: FileFingerprint | null = null

function send(channel: string, data: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data)
  }
}

function toast(text: string, type: ToastMessage['type'] = 'info'): void {
  send('app:toast', { id: uuid(), text, type, duration: 3000 })
}

function sendPlayerCommand(cmd: unknown): void {
  send('player:command', cmd)
}

async function ensureMediaServer(): Promise<void> {
  if (mediaServer) return
  mediaServer = new MediaServer()
  await mediaServer.start()
}

async function ensureDiscovery(): Promise<void> {
  if (discovery) return
  discovery = new DiscoveryService()
  await discovery.start()
  discovery.on('rooms-updated', (rooms) => send('room:list', rooms))
}

function setupSync(): void {
  syncEngine?.destroy()
  syncEngine = new SyncEngine({
    sendCommand: sendPlayerCommand,
    server: roomServer ?? undefined,
    client: roomClient ?? undefined,
    isHost: !!roomServer
  })
}

export function registerIpcHandlers(win: BrowserWindow): void {
  mainWindow = win

  // ── App ──
  ipcMain.handle('app:setNickname', (_e, name: string) => {
    nickname = name
  })

  // ── Room ──
  ipcMain.handle('room:refresh', async () => {
    await ensureDiscovery()
    discovery!.triggerProbe()
    send('room:list', discovery!.getRooms())
  })

  ipcMain.handle('room:create', async (_e, roomName: string, password?: string) => {
    try {
      await ensureDiscovery()
      await ensureMediaServer()

      roomServer = new RoomServer(roomName, memberId, nickname, password)
      const port = await roomServer.start()

      const announce: DiscoveryAnnounce = {
        magic: DISCOVERY_MAGIC,
        action: 'announce',
        roomId: roomServer.getRoomId(),
        roomName,
        hostNickname: nickname,
        port,
        hasPassword: !!password,
        memberCount: 1
      }
      discovery!.startAnnouncing(announce)

      roomServer.on('member-joined', (member) => {
        send('room:update', { type: 'member_joined', member })
        toast(`${member.nickname} 加入了房间`)
        announce.memberCount = roomServer!.getMemberCount()
      })

      roomServer.on('member-left', (member) => {
        send('room:update', { type: 'member_left', memberId: member.id, nickname: member.nickname })
        toast(`${member.nickname} 离开了房间`)
        announce.memberCount = roomServer!.getMemberCount()
      })

      setupSync()

      send('room:update', { type: 'joined', roomId: roomServer.getRoomId(), roomName, isHost: true })
      send('room:update', { type: 'snapshot', members: roomServer.getMembers() })
      return { success: true }
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('room:join', async (_e, roomId: string, _nick: string, password?: string) => {
    try {
      await ensureDiscovery()
      await ensureMediaServer()

      const room = discovery!.getRooms().find((r) => r.id === roomId)
      if (!room) return { success: false, error: '房间未找到' }

      roomClient = new RoomClient(room.hostIp, room.port, nickname, memberId, password)
      await roomClient.connect()

      roomClient.on('snapshot', (data) => {
        send('room:update', {
          type: 'snapshot',
          members: data.members,
          playbackState: data.playbackState,
          hostFingerprint: data.hostFingerprint
        })
      })
      roomClient.on('member-joined', (member) => {
        send('room:update', { type: 'member_joined', member })
        toast(`${member.nickname} 加入了房间`)
      })
      roomClient.on('member-left', ({ memberId: mid, nickname: nick }) => {
        send('room:update', { type: 'member_left', memberId: mid, nickname: nick })
        toast(`${nick} 离开了房间`)
      })
      roomClient.on('file-match', ({ matched }) => {
        send('room:update', { type: 'file_match', matched })
        toast(matched ? '片源匹配成功' : '片源不一致，请重新选择', matched ? 'success' : 'warning')
      })
      roomClient.on('room-closed', (reason: string) => {
        send('room:update', { type: 'closed', reason })
        toast(reason, 'warning')
        cleanupRoom()
      })

      setupSync()

      send('room:update', { type: 'joined', roomId: room.id, roomName: room.name, isHost: false })
      return { success: true }
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('room:leave', async () => {
    await cleanupRoom()
    send('room:update', { type: 'left' })
  })

  // ── Player (HTML5 video via MediaServer) ──
  ipcMain.handle('player:selectFile', async () => {
    try {
      await ensureMediaServer()

      const result = await dialog.showOpenDialog(mainWindow, {
        title: '选择视频文件',
        filters: [{ name: '视频文件', extensions: ['mp4', 'mkv', 'mov', 'webm', 'avi', 'flv', 'wmv'] }],
        properties: ['openFile']
      })
      if (result.canceled || !result.filePaths[0]) {
        return { success: false }
      }

      const filePath = result.filePaths[0]
      const url = mediaServer!.setVideo(filePath)

      // Compute fingerprint (duration will be updated when renderer reports it)
      currentFingerprint = await computeFingerprint(filePath, 0)

      // Tell renderer to load the video
      send('player:loadMedia', { url, filePath })

      return { success: true, filePath }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      toast(`文件加载失败: ${msg}`, 'error')
      return { success: false, error: msg }
    }
  })

  // Renderer reports video duration after metadata loads
  ipcMain.on('player:duration', (_e, duration: number) => {
    if (!currentFingerprint) return
    currentFingerprint.duration = duration

    if (roomServer) {
      roomServer.setHostFingerprint(currentFingerprint)
    }
    if (roomClient) {
      roomClient.sendFileInfo(currentFingerprint)
    }
  })

  // Renderer reports a user action (play / pause / seek)
  ipcMain.handle('player:action', (_e, data: { action: string; position: number; paused: boolean }) => {
    syncEngine?.broadcastAction(data.action, data.position, data.paused)
  })

  // Renderer periodically reports its player state (fire-and-forget)
  ipcMain.on('player:report', (_e, state) => {
    send('player:state', state)
  })

  // Legacy compatibility
  ipcMain.handle('player:play', () => {})
  ipcMain.handle('player:pause', () => {})
  ipcMain.handle('player:togglePause', () => {})
  ipcMain.handle('player:seek', () => {})

  // ── Subtitle ──
  ipcMain.handle('subtitle:select', async () => {
    try {
      await ensureMediaServer()

      const result = await dialog.showOpenDialog(mainWindow, {
        title: '选择字幕文件',
        filters: [{ name: '字幕文件', extensions: ['srt', 'vtt', 'ass', 'ssa'] }],
        properties: ['openFile']
      })
      if (result.canceled || !result.filePaths[0]) {
        return { success: false }
      }

      const subUrl = mediaServer!.setSubtitle(result.filePaths[0])
      send('player:loadSubtitle', { url: subUrl, filePath: result.filePaths[0] })
      return { success: true, filePath: result.filePaths[0] }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      toast(`字幕加载失败: ${msg}`, 'error')
      return { success: false, error: msg }
    }
  })

  ipcMain.handle('subtitle:remove', () => {
    mediaServer?.clearSubtitle()
    send('player:loadSubtitle', { url: null })
  })

  ipcMain.handle('subtitle:setSize', () => {})
  ipcMain.handle('subtitle:setPosition', () => {})
}

async function cleanupRoom(): Promise<void> {
  syncEngine?.destroy()
  syncEngine = null
  if (roomServer) {
    discovery?.stopAnnouncing()
    await roomServer.stop()
    roomServer = null
  }
  if (roomClient) {
    roomClient.disconnect()
    roomClient = null
  }
  currentFingerprint = null
}

export async function cleanupServices(): Promise<void> {
  await cleanupRoom()
  mediaServer?.stop()
  mediaServer = null
  if (discovery) {
    await discovery.stop()
    discovery = null
  }
}
