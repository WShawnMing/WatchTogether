import { ipcMain, dialog, BrowserWindow } from 'electron'
import { v4 as uuid } from 'uuid'
import { MpvPlayer } from '../services/mpv-player'
import { DiscoveryService } from '../services/discovery'
import { RoomServer } from '../services/room-server'
import { RoomClient } from '../services/room-client'
import { SyncEngine } from '../services/sync-engine'
import { computeFingerprint } from '../services/fingerprint'
import { DISCOVERY_MAGIC } from '../../shared/protocol'
import type { DiscoveryAnnounce } from '../../shared/protocol'
import type { FileFingerprint, ToastMessage } from '../../shared/types'

let mainWindow: BrowserWindow
let mpvPlayer: MpvPlayer | null = null
let discovery: DiscoveryService | null = null
let roomServer: RoomServer | null = null
let roomClient: RoomClient | null = null
let syncEngine: SyncEngine | null = null

let nickname = ''
const memberId = uuid()
let currentFingerprint: FileFingerprint | null = null

function sendToRenderer(channel: string, data: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data)
  }
}

function toast(text: string, type: ToastMessage['type'] = 'info'): void {
  sendToRenderer('app:toast', { id: uuid(), text, type, duration: 3000 })
}

async function initMpv(): Promise<void> {
  if (mpvPlayer) return
  mpvPlayer = new MpvPlayer()
  try {
    await mpvPlayer.initialize()
    mpvPlayer.on('state-change', async () => {
      if (mpvPlayer) {
        const status = await mpvPlayer.getStatus()
        sendToRenderer('player:state', status)
      }
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    mpvPlayer = null
    toast(message, 'error')
    throw err
  }
}

async function initDiscovery(): Promise<void> {
  if (discovery) return
  discovery = new DiscoveryService()
  await discovery.start()
  discovery.on('rooms-updated', (rooms) => {
    sendToRenderer('room:list', rooms)
  })
}

function setupSyncEngine(): void {
  if (!mpvPlayer) return
  syncEngine?.destroy()

  syncEngine = new SyncEngine(mpvPlayer, {
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
    await initDiscovery()
    discovery!.triggerProbe()
    sendToRenderer('room:list', discovery!.getRooms())
  })

  ipcMain.handle('room:create', async (_e, roomName: string, password?: string) => {
    try {
      await initDiscovery()
      await initMpv()

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
        sendToRenderer('room:update', { type: 'member_joined', member })
        toast(`${member.nickname} 加入了房间`, 'info')
        announce.memberCount = roomServer!.getMemberCount()
      })

      roomServer.on('member-left', (member) => {
        sendToRenderer('room:update', {
          type: 'member_left',
          memberId: member.id,
          nickname: member.nickname
        })
        toast(`${member.nickname} 离开了房间`, 'info')
        announce.memberCount = roomServer!.getMemberCount()
      })

      roomServer.on('remote-playback', (state) => {
        // SyncEngine handles this
      })

      setupSyncEngine()

      sendToRenderer('room:update', {
        type: 'joined',
        roomId: roomServer.getRoomId(),
        roomName,
        isHost: true
      })
      sendToRenderer('room:update', {
        type: 'snapshot',
        members: roomServer.getMembers()
      })

      return { success: true }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return { success: false, error: message }
    }
  })

  ipcMain.handle('room:join', async (_e, roomId: string, _nick: string, password?: string) => {
    try {
      await initDiscovery()
      await initMpv()

      const rooms = discovery!.getRooms()
      const room = rooms.find((r) => r.id === roomId)
      if (!room) return { success: false, error: '房间未找到' }

      roomClient = new RoomClient(room.hostIp, room.port, nickname, memberId, password)
      await roomClient.connect()

      roomClient.on('snapshot', (data) => {
        sendToRenderer('room:update', {
          type: 'snapshot',
          members: data.members,
          playbackState: data.playbackState,
          hostFingerprint: data.hostFingerprint
        })
      })

      roomClient.on('member-joined', (member) => {
        sendToRenderer('room:update', { type: 'member_joined', member })
        toast(`${member.nickname} 加入了房间`, 'info')
      })

      roomClient.on('member-left', ({ memberId: mid, nickname: nick }) => {
        sendToRenderer('room:update', { type: 'member_left', memberId: mid, nickname: nick })
        toast(`${nick} 离开了房间`, 'info')
      })

      roomClient.on('file-match', ({ matched }) => {
        sendToRenderer('room:update', { type: 'file_match', matched })
        toast(matched ? '片源匹配成功' : '片源不一致，请重新选择', matched ? 'success' : 'warning')
      })

      roomClient.on('room-closed', (reason: string) => {
        sendToRenderer('room:update', { type: 'closed', reason })
        toast(reason, 'warning')
        cleanupRoom()
      })

      roomClient.on('remote-playback', () => {
        // SyncEngine handles this
      })

      setupSyncEngine()

      sendToRenderer('room:update', {
        type: 'joined',
        roomId: room.id,
        roomName: room.name,
        isHost: false
      })

      return { success: true }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return { success: false, error: message }
    }
  })

  ipcMain.handle('room:leave', async () => {
    await cleanupRoom()
    sendToRenderer('room:update', { type: 'left' })
  })

  // ── Player ──
  ipcMain.handle('player:selectFile', async () => {
    try {
      await initMpv()
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '选择视频文件',
        filters: [
          { name: '视频文件', extensions: ['mp4', 'mkv', 'mov', 'webm', 'avi', 'flv', 'wmv'] }
        ],
        properties: ['openFile']
      })

      if (result.canceled || !result.filePaths[0]) {
        return { success: false, error: '未选择文件' }
      }

      const filePath = result.filePaths[0]

      // Load into mpv to get duration and test playback
      mpvPlayer!.loadFile(filePath)

      // Wait for mpv to parse the file
      await new Promise((r) => setTimeout(r, 1000))

      const duration = await mpvPlayer!.getDuration()
      const fingerprint = await computeFingerprint(filePath, duration)
      currentFingerprint = fingerprint

      // If we're hosting, set the host fingerprint
      if (roomServer) {
        roomServer.setHostFingerprint(fingerprint)
      }

      // If we're a guest, send fingerprint to host for matching
      if (roomClient) {
        roomClient.sendFileInfo(fingerprint)
      }

      return { success: true, filePath, fingerprint }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      toast(`文件加载失败: ${message}`, 'error')
      return { success: false, error: message }
    }
  })

  ipcMain.handle('player:play', async () => {
    if (!mpvPlayer) return
    mpvPlayer.play()
    await syncEngine?.onLocalAction()
  })

  ipcMain.handle('player:pause', async () => {
    if (!mpvPlayer) return
    mpvPlayer.pause()
    await syncEngine?.onLocalAction()
  })

  ipcMain.handle('player:togglePause', async () => {
    if (!mpvPlayer) return
    mpvPlayer.togglePause()
    await syncEngine?.onLocalAction()
  })

  ipcMain.handle('player:seek', async (_e, position: number) => {
    if (!mpvPlayer) return
    mpvPlayer.seekTo(position)
    await syncEngine?.onLocalSeekAction()
  })

  // ── Subtitle ──
  ipcMain.handle('subtitle:select', async () => {
    try {
      if (!mpvPlayer) return { success: false, error: 'mpv 未初始化' }

      const result = await dialog.showOpenDialog(mainWindow, {
        title: '选择字幕文件',
        filters: [
          { name: '字幕文件', extensions: ['srt', 'vtt', 'ass', 'ssa'] }
        ],
        properties: ['openFile']
      })

      if (result.canceled || !result.filePaths[0]) {
        return { success: false, error: '未选择文件' }
      }

      mpvPlayer.loadSubtitle(result.filePaths[0])
      return { success: true, filePath: result.filePaths[0] }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      toast(`字幕加载失败: ${message}`, 'error')
      return { success: false, error: message }
    }
  })

  ipcMain.handle('subtitle:remove', () => {
    if (mpvPlayer) mpvPlayer.removeSubtitle()
  })

  ipcMain.handle('subtitle:setSize', (_e, size: number) => {
    if (mpvPlayer) mpvPlayer.setSubtitleSize(size)
  })

  ipcMain.handle('subtitle:setPosition', (_e, pos: number) => {
    if (mpvPlayer) mpvPlayer.setSubtitlePosition(pos)
  })
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
  if (mpvPlayer) {
    mpvPlayer.quit()
    mpvPlayer = null
  }
  if (discovery) {
    await discovery.stop()
    discovery = null
  }
}
