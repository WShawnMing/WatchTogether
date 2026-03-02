import { ipcMain, dialog, BrowserWindow } from 'electron'
import { v4 as uuid } from 'uuid'
import { basename } from 'path'
import { MpvController } from '../services/mpv-controller'
import type { MpvState } from '../services/mpv-controller'
import { DiscoveryService } from '../services/discovery'
import { RoomServer } from '../services/room-server'
import { RoomClient } from '../services/room-client'
import { SyncEngine } from '../services/sync-engine'
import { computeFingerprint } from '../services/fingerprint'
import { DISCOVERY_MAGIC } from '../../shared/protocol'
import type { DiscoveryAnnounce } from '../../shared/protocol'
import type { FileFingerprint, ToastMessage } from '../../shared/types'

let mainWindow: BrowserWindow
let mpv: MpvController | null = null
let discovery: DiscoveryService | null = null
let roomServer: RoomServer | null = null
let roomClient: RoomClient | null = null
let syncEngine: SyncEngine | null = null

let nickname = ''
const memberId = uuid()
let currentFingerprint: FileFingerprint | null = null

// ── Sync state tracking ──
let prevMpvState: MpvState | null = null
let remoteGraceUntil = 0
const REMOTE_GRACE_MS = 1500
const SEEK_DRIFT_THRESHOLD = 2.0
const POLL_INTERVAL_S = 0.25
let syncHeartbeat: ReturnType<typeof setInterval> | null = null

function send(channel: string, data: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data)
}
function toast(text: string, type: ToastMessage['type'] = 'info'): void {
  send('app:toast', { id: uuid(), text, type, duration: 3000 })
}

function onMpvState(state: MpvState): void {
  send('mpv:state', state)

  if (!syncEngine || !prevMpvState) {
    prevMpvState = state
    return
  }

  if (Date.now() < remoteGraceUntil) {
    prevMpvState = state
    return
  }

  // Detect local play/pause
  if (state.paused !== prevMpvState.paused) {
    syncEngine.broadcastAction(
      state.paused ? 'pause' : 'play',
      state.position,
      state.paused,
      state.speed
    )
  }

  // Detect local speed change
  if (Math.abs(state.speed - prevMpvState.speed) > 0.01) {
    syncEngine.broadcastAction('speed', state.position, state.paused, state.speed)
  }

  // Detect local seek
  const expectedChange = prevMpvState.paused ? 0 : POLL_INTERVAL_S * (prevMpvState.speed || 1)
  const actualChange = state.position - prevMpvState.position
  const drift = Math.abs(actualChange - expectedChange)
  if (drift > SEEK_DRIFT_THRESHOLD && state.position > 0) {
    syncEngine.broadcastAction('seek', state.position, state.paused, state.speed)
  }

  prevMpvState = state
}

function applyRemoteCommand(cmd: unknown): void {
  const c = cmd as { action: string; state?: { position: number; paused: boolean; speed?: number } }
  if (!c.state || !mpv || !mpv.isAlive()) return

  remoteGraceUntil = Date.now() + REMOTE_GRACE_MS

  if (prevMpvState) {
    const drift = Math.abs(prevMpvState.position - c.state.position)
    if (drift > SEEK_DRIFT_THRESHOLD) {
      mpv.seekTo(c.state.position)
    }
  } else {
    mpv.seekTo(c.state.position)
  }

  if (c.state.paused) mpv.pause()
  else mpv.play()

  if (c.state.speed && c.state.speed > 0) {
    const currentSpeed = prevMpvState?.speed || 1
    if (Math.abs(currentSpeed - c.state.speed) > 0.01) {
      mpv.setSpeed(c.state.speed)
    }
  }
}

function onMpvExited(): void {
  mpv = null
  prevMpvState = null
  send('mpv:state', null)
  send('player:fileLoaded', { filePath: null, fileName: null })
}

async function ensureDiscovery(): Promise<void> {
  if (discovery) return
  discovery = new DiscoveryService()
  await discovery.start()
  discovery.on('rooms-updated', (rooms) => send('room:list', rooms))
}

function setupSync(): void {
  syncEngine?.destroy()
  if (syncHeartbeat) { clearInterval(syncHeartbeat); syncHeartbeat = null }

  syncEngine = new SyncEngine({
    sendCommand: applyRemoteCommand,
    server: roomServer ?? undefined,
    client: roomClient ?? undefined,
    isHost: !!roomServer
  })

  syncHeartbeat = setInterval(() => {
    if (syncEngine && prevMpvState && !prevMpvState.paused && prevMpvState.duration > 0) {
      syncEngine.broadcastAction('sync', prevMpvState.position, prevMpvState.paused, prevMpvState.speed)
    }
  }, 5000)
}

export function registerIpcHandlers(win: BrowserWindow): void {
  mainWindow = win

  ipcMain.handle('app:setNickname', (_e, name: string) => { nickname = name })

  // ── Room ──
  ipcMain.handle('room:refresh', async () => {
    await ensureDiscovery()
    discovery!.triggerProbe()
    send('room:list', discovery!.getRooms())
  })

  ipcMain.handle('room:create', async (_e, roomName: string, password?: string) => {
    try {
      await ensureDiscovery()
      roomServer = new RoomServer(roomName, memberId, nickname, password)
      const port = await roomServer.start()
      const announce: DiscoveryAnnounce = {
        magic: DISCOVERY_MAGIC, action: 'announce',
        roomId: roomServer.getRoomId(), roomName,
        hostNickname: nickname, port,
        hasPassword: !!password, memberCount: 1
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
      const room = discovery!.getRooms().find((r) => r.id === roomId)
      if (!room) return { success: false, error: '房间未找到' }
      roomClient = new RoomClient(room.hostIp, room.port, nickname, memberId, password)
      await roomClient.connect()
      roomClient.on('snapshot', (d) => send('room:update', { type: 'snapshot', members: d.members, playbackState: d.playbackState, hostFingerprint: d.hostFingerprint }))
      roomClient.on('member-joined', (m) => { send('room:update', { type: 'member_joined', member: m }); toast(`${m.nickname} 加入了房间`) })
      roomClient.on('member-left', ({ memberId: mid, nickname: nick }) => { send('room:update', { type: 'member_left', memberId: mid, nickname: nick }); toast(`${nick} 离开了房间`) })
      roomClient.on('file-match', ({ matched }) => { send('room:update', { type: 'file_match', matched }); toast(matched ? '片源匹配成功' : '片源不一致', matched ? 'success' : 'warning') })
      roomClient.on('room-closed', (reason: string) => { send('room:update', { type: 'closed', reason }); toast(reason, 'warning'); cleanupRoom() })
      setupSync()
      send('room:update', { type: 'joined', roomId: room.id, roomName: room.name, isHost: false })
      return { success: true }
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('room:leave', async () => { await cleanupRoom(); send('room:update', { type: 'left' }) })

  // ── Player ──
  ipcMain.handle('player:selectFile', async () => {
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '选择视频文件',
        filters: [{ name: '视频文件', extensions: ['mp4', 'mkv', 'mov', 'webm', 'avi', 'flv', 'wmv', 'm4v', 'ts', 'rmvb', 'mpg', 'mpeg'] }],
        properties: ['openFile']
      })
      if (result.canceled || !result.filePaths[0]) return { success: false }

      const filePath = result.filePaths[0]

      // Destroy previous mpv instance if exists
      if (mpv) {
        mpv.destroy()
        mpv = null
      }

      // Start new mpv with the file (window opens with video immediately)
      mpv = new MpvController()
      mpv.on('state', onMpvState)
      mpv.on('exited', onMpvExited)
      prevMpvState = null
      await mpv.start(filePath)

      currentFingerprint = await computeFingerprint(filePath, 0)
      send('player:fileLoaded', { filePath, fileName: basename(filePath) })

      setTimeout(async () => {
        if (!mpv || !mpv.isAlive()) return
        const tracks = await mpv.getTracks()
        send('mpv:tracks', tracks)
        try {
          const state = await mpv.getState()
          if (state && currentFingerprint) {
            currentFingerprint.duration = state.duration
            if (roomServer) roomServer.setHostFingerprint(currentFingerprint)
            if (roomClient) roomClient.sendFileInfo(currentFingerprint)
          }
        } catch {}
      }, 1500)

      return { success: true, filePath }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      toast(`文件加载失败: ${msg}`, 'error')
      return { success: false, error: msg }
    }
  })

  // ── Subtitle ──
  ipcMain.handle('subtitle:select', async () => {
    try {
      if (!mpv || !mpv.isAlive()) { toast('请先选择视频文件', 'warning'); return { success: false } }
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '选择字幕文件',
        filters: [{ name: '字幕文件', extensions: ['srt', 'vtt', 'ass', 'ssa', 'sup', 'idx', 'sub'] }],
        properties: ['openFile']
      })
      if (result.canceled || !result.filePaths[0]) return { success: false }
      mpv.addSubtitle(result.filePaths[0])
      toast('字幕已加载')
      return { success: true }
    } catch (err: unknown) {
      toast(`字幕加载失败: ${err instanceof Error ? err.message : err}`, 'error')
      return { success: false }
    }
  })
}

async function cleanupRoom(): Promise<void> {
  syncEngine?.destroy(); syncEngine = null
  if (syncHeartbeat) { clearInterval(syncHeartbeat); syncHeartbeat = null }
  if (roomServer) { discovery?.stopAnnouncing(); await roomServer.stop(); roomServer = null }
  if (roomClient) { roomClient.disconnect(); roomClient = null }
  currentFingerprint = null
  prevMpvState = null
}

export async function cleanupServices(): Promise<void> {
  await cleanupRoom()
  if (mpv) { mpv.destroy(); mpv = null }
  if (discovery) { await discovery.stop(); discovery = null }
}
