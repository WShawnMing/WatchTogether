import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  createReadStream,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server as HttpServer } from 'node:http'
import path from 'node:path'
import cors from 'cors'
import express, { type Request } from 'express'
import mime from 'mime-types'
import multer from 'multer'
import { Server } from 'socket.io'
import {
  createInitialPlaybackState,
  createRoomCode,
  DEFAULT_RELAY_PORT,
  deriveCurrentPosition,
  MAX_ROOM_MEMBERS,
  normalizeRoomId,
  type BufferingPayload,
  type DiscoveryProbeResponse,
  type JoinRoomPayload,
  type JoinRoomResult,
  type LocalMediaSelectionPayload,
  type MediaSnapshot,
  type PlaybackControlPayload,
  type PlaybackEnvelope,
  type PlaybackState,
  type RoomConfigPayload,
  type RoomMemberSnapshot,
  type RoomSnapshot,
  type SubtitleSnapshot,
  type SyncMode,
} from '../../shared/protocol.js'

interface StoredMedia extends MediaSnapshot {
  filePath: string | null
}

interface StoredSubtitle extends SubtitleSnapshot {
  filePath: string
}

interface TrackedRoomMember extends RoomMemberSnapshot {
  selectedMediaSha256: string | null
  selectedMediaSize: number | null
  selectedMediaDuration: number | null
  bufferingStartedAt: number | null
  lastBufferReportAt: number
}

interface RoomState {
  id: string
  roomName: string
  password: string | null
  hostSocketId: string
  members: Map<string, TrackedRoomMember>
  media: StoredMedia | null
  subtitle: StoredSubtitle | null
  playbackState: PlaybackState
  syncMode: SyncMode
  startupGateActive: boolean
  pendingStartRequested: boolean
  startupBufferTargetSeconds: number
  playbackResumeBufferTargetSeconds: number
  resumeAfterBuffer: boolean
  lastActiveAt: number
}

export interface LocalRelayHandle {
  close: () => Promise<void>
  port: number
}

interface StartLocalRelayOptions {
  port?: number
  roomIdleTtlMinutes?: number
  storageRoot?: string
  instanceId?: string
}

interface ProbedMedia {
  duration: number | null
  bitrate: number | null
  videoCodec: string | null
  audioCodec: string | null
}

export async function startLocalRelay(
  options: StartLocalRelayOptions = {},
): Promise<LocalRelayHandle> {
  const rooms = new Map<string, RoomState>()
  const socketToRoom = new Map<string, string>()
  const roomIdleTtlMs = (options.roomIdleTtlMinutes ?? 120) * 60 * 1000
  const roomSnapshotHeartbeatMs = 4_000
  const directStreamBitrateLimit = Number(
    process.env.WATCH_TOGETHER_DIRECT_STREAM_MAX_BPS ?? 900_000,
  )
  const uploadRoot = path.resolve(
    options.storageRoot ?? process.env.WATCH_TOGETHER_STORAGE_DIR ?? '.watchtogether/uploads',
  )
  let isClosed = false
  let closePromise: Promise<void> | null = null

  mkdirSync(uploadRoot, { recursive: true })

  function createRoom(
    roomId: string,
    hostSocketId: string,
    roomName: string,
    password: string | null,
  ) {
    const now = Date.now()

    const room: RoomState = {
      id: roomId,
      roomName,
      password,
      hostSocketId,
      members: new Map(),
      media: null,
      subtitle: null,
      playbackState: createInitialPlaybackState(hostSocketId),
      syncMode: 'soft',
      startupGateActive: false,
      pendingStartRequested: false,
      startupBufferTargetSeconds: 12,
      playbackResumeBufferTargetSeconds: 6,
      resumeAfterBuffer: false,
      lastActiveAt: now,
    }

    rooms.set(roomId, room)

    return room
  }

  function sanitizeNickname(value: string) {
    const trimmed = value.trim()

    return trimmed
      ? trimmed.slice(0, 24)
      : `Viewer-${Math.floor(Math.random() * 90 + 10)}`
  }

  function sanitizeRoomName(value: string, fallbackNickname: string) {
    const trimmed = value.trim()

    return trimmed ? trimmed.slice(0, 32) : `${fallbackNickname} 的共享放映室`
  }

  function sanitizePassword(value?: string) {
    const trimmed = value?.trim() ?? ''

    return trimmed ? trimmed.slice(0, 64) : null
  }

  function decodeMultipartName(value: string) {
    if (!value) {
      return ''
    }

    const looksMojibake =
      /[ÃÂÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]/.test(
        value,
      )

    if (!looksMojibake) {
      return value
    }

    try {
      const decoded = Buffer.from(value, 'latin1').toString('utf8')

      return decoded.includes('\uFFFD') ? value : decoded
    } catch {
      return value
    }
  }

  function ensureRoom(
    roomId: string,
    hostSocketId: string,
    roomName: string,
    password: string | null,
  ) {
    return rooms.get(roomId) ?? createRoom(roomId, hostSocketId, roomName, password)
  }

  function getBufferingUsers(room: RoomState) {
    return [...room.members.values()]
      .filter((member) => member.buffering)
      .map((member) => member.socketId)
  }

  function createTrackedMember(socketId: string, nickname: string, isHost: boolean): TrackedRoomMember {
    return {
      socketId,
      nickname,
      isHost,
      mediaMatchState: 'missing',
      selectedMediaName: null,
      selectedMediaSha256: null,
      selectedMediaSize: null,
      selectedMediaDuration: null,
      buffering: false,
      startupReady: false,
      bufferAheadSeconds: 0,
      readyState: 0,
      canPlayThrough: false,
      connectedAt: Date.now(),
      bufferingStartedAt: null,
      lastBufferReportAt: 0,
    }
  }

  function resetMemberPlaybackState(member: TrackedRoomMember) {
    member.buffering = false
    member.startupReady = false
    member.bufferAheadSeconds = 0
    member.readyState = 0
    member.canPlayThrough = false
    member.bufferingStartedAt = null
    member.lastBufferReportAt = 0
  }

  function toRoomSnapshot(room: RoomState): RoomSnapshot {
    const members = [...room.members.values()]
      .map((member) => ({
        socketId: member.socketId,
        nickname: member.nickname,
        isHost: member.socketId === room.hostSocketId,
        mediaMatchState: member.mediaMatchState,
        selectedMediaName: member.selectedMediaName,
        buffering: member.buffering,
        startupReady: member.startupReady,
        bufferAheadSeconds: member.bufferAheadSeconds,
        readyState: member.readyState,
        canPlayThrough: member.canPlayThrough,
        connectedAt: member.connectedAt,
      }))
      .sort((left, right) => Number(right.isHost) - Number(left.isHost))

    return {
      roomId: room.id,
      roomName: room.roomName,
      requiresPassword: Boolean(room.password),
      isPreparing: room.startupGateActive,
      startupBufferTargetSeconds: room.startupBufferTargetSeconds,
      members,
      media: room.media
        ? {
            id: room.media.id,
            name: room.media.name,
            size: room.media.size,
            mimeType: room.media.mimeType,
            duration: room.media.duration,
            sha256: room.media.sha256,
            selectedAt: room.media.selectedAt,
          }
        : null,
      subtitle: room.subtitle
        ? {
            id: room.subtitle.id,
            name: room.subtitle.name,
            format: room.subtitle.format,
            language: room.subtitle.language,
            uploadedAt: room.subtitle.uploadedAt,
          }
        : null,
      playbackState: room.playbackState,
      syncMode: room.syncMode,
      maxMembers: MAX_ROOM_MEMBERS,
      serverTime: Date.now(),
    }
  }

  function toPlaybackEnvelope(room: RoomState): PlaybackEnvelope {
    return {
      roomId: room.id,
      playbackState: room.playbackState,
      bufferingUsers: getBufferingUsers(room),
      syncMode: room.syncMode,
      serverTime: Date.now(),
    }
  }

  function clampPlaybackRate(value: number) {
    if (!Number.isFinite(value)) {
      return 1
    }

    return Math.max(0.5, Math.min(2, value))
  }

  function getStartupBufferTargetSeconds(duration: number | null) {
    if (!Number.isFinite(duration) || !duration || duration <= 0) {
      return 12
    }

    return Math.min(24, Math.max(8, duration * 0.02))
  }

  function getPlaybackResumeBufferTargetSeconds(duration: number | null) {
    if (!Number.isFinite(duration) || !duration || duration <= 0) {
      return 6
    }

    return Math.min(10, Math.max(3, duration * 0.01))
  }

  function getCurrentPlaybackPosition(room: RoomState) {
    return Math.max(0, deriveCurrentPosition(room.playbackState))
  }

  function getEffectiveBufferTarget(room: RoomState, baseTargetSeconds: number) {
    if (!room.media?.duration || !Number.isFinite(room.media.duration)) {
      return baseTargetSeconds
    }

    const remainingDuration = Math.max(
      0,
      room.media.duration - getCurrentPlaybackPosition(room),
    )

    if (remainingDuration <= 0) {
      return 0
    }

    return Math.max(0.8, Math.min(baseTargetSeconds, remainingDuration))
  }

  function isMemberReadyForBufferTarget(
    room: RoomState,
    member: TrackedRoomMember,
    baseTargetSeconds: number,
  ) {
    if (!room.media) {
      return true
    }

    if (member.canPlayThrough || member.readyState >= 4) {
      return true
    }

    return (
      member.readyState >= 3 &&
      member.bufferAheadSeconds >= getEffectiveBufferTarget(room, baseTargetSeconds)
    )
  }

  function isMemberStartupReady(room: RoomState, member: TrackedRoomMember) {
    if (!room.media || !room.startupGateActive) {
      return true
    }

    if (member.mediaMatchState !== 'matched') {
      return false
    }

    return isMemberReadyForBufferTarget(
      room,
      member,
      room.startupBufferTargetSeconds,
    )
  }

  function isMemberReadyToResumePlayback(room: RoomState, member: TrackedRoomMember) {
    return (
      member.mediaMatchState === 'matched' &&
      !member.buffering &&
      isMemberReadyForBufferTarget(
        room,
        member,
        room.playbackResumeBufferTargetSeconds,
      )
    )
  }

  function syncMemberStartupReadiness(room: RoomState) {
    for (const member of room.members.values()) {
      member.startupReady = isMemberStartupReady(room, member)
    }
  }

  function areAllMembersStartupReady(room: RoomState) {
    if (!room.media || room.members.size === 0) {
      return false
    }

    syncMemberStartupReadiness(room)

    return [...room.members.values()].every((member) => member.startupReady)
  }

  function areAllMembersReadyToResumePlayback(room: RoomState) {
    if (!room.media || room.members.size === 0) {
      return false
    }

    return [...room.members.values()].every((member) =>
      isMemberReadyToResumePlayback(room, member),
    )
  }

  function deleteMedia(room: RoomState) {
    if (!room.media) {
      return
    }

    if (room.media.filePath) {
      try {
        rmSync(room.media.filePath, { force: true })
      } catch {
        // noop
      }
    }

    room.media = null
  }

  function deleteSubtitle(room: RoomState) {
    if (!room.subtitle) {
      return
    }

    try {
      rmSync(room.subtitle.filePath, { force: true })
    } catch {
      // noop
    }

    room.subtitle = null
  }

  function normalizeStoredBaseName(fileName: string) {
    return path
      .basename(fileName, path.extname(fileName))
      .replace(/[^\w\u4e00-\u9fa5.-]+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 80)
  }

  function detectSubtitleLanguage(fileName: string) {
    const stem = path.basename(fileName, path.extname(fileName)).toLowerCase()
    const parts = stem.split(/[._\-\s]+/).filter(Boolean)
    const maybeLanguage = parts.at(-1)

    if (!maybeLanguage || maybeLanguage.length > 8) {
      return null
    }

    return maybeLanguage
  }

  function convertSrtToVtt(content: string) {
    const normalized = content.replace(/^\uFEFF/, '').replace(/\r+/g, '')
    const withCueTimes = normalized.replace(
      /(\d{2}:\d{2}:\d{2}),(\d{3})/g,
      '$1.$2',
    )

    return `WEBVTT\n\n${withCueTimes}`
  }

  function normalizeSubtitleText(buffer: Buffer) {
    return buffer.toString('utf8').replace(/^\uFEFF/, '').replace(/\r+/g, '')
  }

  function getSubtitleFormat(originalName: string) {
    const extension = path.extname(originalName).toLowerCase()

    if (['.ass', '.ssa'].includes(extension)) {
      return 'ass' as const
    }

    return 'vtt' as const
  }

  function getSubtitleFileExtension(originalName: string) {
    return getSubtitleFormat(originalName) === 'ass'
      ? path.extname(originalName).toLowerCase() || '.ass'
      : '.vtt'
  }

  function getSubtitleContentType(originalName: string) {
    return getSubtitleFormat(originalName) === 'ass'
      ? 'text/x-ssa; charset=utf-8'
      : 'text/vtt; charset=utf-8'
  }

  function getSubtitleText(buffer: Buffer, originalName: string) {
    const extension = path.extname(originalName).toLowerCase()
    const decodedText = normalizeSubtitleText(buffer)

    if (['.ass', '.ssa'].includes(extension)) {
      return decodedText
    }

    if (extension === '.srt') {
      return convertSrtToVtt(decodedText)
    }

    return decodedText.startsWith('WEBVTT') ? decodedText : `WEBVTT\n\n${decodedText}`
  }

  function getMediaBitrate(size: number, duration: number | null) {
    if (!duration || !Number.isFinite(duration) || duration <= 0) {
      return null
    }

    return Math.round((size * 8) / duration)
  }

  function runBinary(command: string, args: string[]) {
    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString()
      })

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString()
      })

      child.on('error', (error) => {
        reject(error)
      })

      child.on('close', (code) => {
        if (code === 0) {
          resolve({ stdout, stderr })
          return
        }

        reject(new Error(stderr.trim() || `${command} exited with code ${code ?? 1}`))
      })
    })
  }

  async function probeMedia(filePath: string): Promise<ProbedMedia> {
    try {
      const { stdout } = await runBinary(process.env.FFPROBE_PATH || 'ffprobe', [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_entries',
        'format=duration,bit_rate:stream=codec_type,codec_name',
        filePath,
      ])
      const payload = JSON.parse(stdout) as {
        format?: { duration?: string; bit_rate?: string }
        streams?: Array<{ codec_type?: string; codec_name?: string }>
      }
      const videoStream = payload.streams?.find((stream) => stream.codec_type === 'video')
      const audioStream = payload.streams?.find((stream) => stream.codec_type === 'audio')
      const duration = Number(payload.format?.duration)
      const bitrate = Number(payload.format?.bit_rate)

      return {
        duration: Number.isFinite(duration) ? duration : null,
        bitrate: Number.isFinite(bitrate) ? bitrate : null,
        videoCodec: videoStream?.codec_name ?? null,
        audioCodec: audioStream?.codec_name ?? null,
      }
    } catch {
      return {
        duration: null,
        bitrate: null,
        videoCodec: null,
        audioCodec: null,
      }
    }
  }

  function shouldCreateCompatibilityProxy(
    originalName: string,
    mimeType: string,
    probed: ProbedMedia,
    fallbackBitrate: number | null,
  ) {
    if (process.env.WATCH_TOGETHER_DISABLE_COMPAT_PROXY === '1') {
      return false
    }

    const extension = path.extname(originalName).toLowerCase()
    const bitrate = probed.bitrate ?? fallbackBitrate

    if (['.mov', '.mkv', '.avi', '.wmv'].includes(extension)) {
      return true
    }

    if (mimeType.includes('quicktime')) {
      return true
    }

    if (probed.videoCodec && probed.videoCodec !== 'h264') {
      return true
    }

    if (probed.audioCodec && !['aac', 'mp3'].includes(probed.audioCodec)) {
      return true
    }

    return Boolean(bitrate && bitrate > directStreamBitrateLimit)
  }

  async function createCompatibilityProxy(inputPath: string, outputPath: string) {
    await runBinary(process.env.FFMPEG_PATH || 'ffmpeg', [
      '-y',
      '-i',
      inputPath,
      '-map',
      '0:v:0',
      '-map',
      '0:a?:0',
      '-sn',
      '-vf',
      "scale='min(640,iw)':-2:force_original_aspect_ratio=decrease",
      '-r',
      '24',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-profile:v',
      'main',
      '-pix_fmt',
      'yuv420p',
      '-crf',
      '32',
      '-maxrate',
      '420k',
      '-bufsize',
      '840k',
      '-movflags',
      '+faststart',
      '-c:a',
      'aac',
      '-b:a',
      '64k',
      '-ac',
      '2',
      '-ar',
      '48000',
      outputPath,
    ])
  }

  function applyNewRoomMedia(
    room: RoomState,
    hostSocketId: string,
    media: MediaSnapshot,
  ) {
    deleteMedia(room)
    deleteSubtitle(room)

    room.media = {
      ...media,
      filePath: null,
    }

    for (const member of room.members.values()) {
      resetMemberPlaybackState(member)
      member.mediaMatchState =
        member.socketId === hostSocketId
          ? 'matched'
          : member.selectedMediaSha256 === media.sha256 &&
              member.selectedMediaSize === media.size &&
              Math.abs((member.selectedMediaDuration ?? 0) - (media.duration ?? 0)) <= 0.25
            ? 'matched'
            : 'missing'
      member.selectedMediaName =
        member.socketId === hostSocketId
          ? media.name
          : member.mediaMatchState === 'matched'
            ? member.selectedMediaName
            : null
    }

    room.playbackState = createInitialPlaybackState(hostSocketId)
    room.startupGateActive = true
    room.pendingStartRequested = false
    room.startupBufferTargetSeconds = getStartupBufferTargetSeconds(media.duration)
    room.playbackResumeBufferTargetSeconds = getPlaybackResumeBufferTargetSeconds(
      media.duration,
    )
    room.resumeAfterBuffer = false
    room.lastActiveAt = Date.now()
  }

  function matchesRoomMedia(roomMedia: MediaSnapshot, selectedMedia: MediaSnapshot) {
    return (
      roomMedia.sha256 === selectedMedia.sha256 &&
      roomMedia.size === selectedMedia.size &&
      Math.abs((roomMedia.duration ?? 0) - (selectedMedia.duration ?? 0)) <= 0.25
    )
  }

  function deleteRoom(roomId: string) {
    const room = rooms.get(roomId)

    if (!room) {
      return
    }

    deleteMedia(room)
    deleteSubtitle(room)

    try {
      rmSync(path.join(uploadRoot, roomId), { recursive: true, force: true })
    } catch {
      // noop
    }

    rooms.delete(roomId)
  }

  function markPlayback(
    room: RoomState,
    patch: Pick<PlaybackState, 'position' | 'paused' | 'playbackRate' | 'updatedBy'>,
    reason: PlaybackState['reason'],
  ) {
    room.playbackState = {
      position: Math.max(0, patch.position),
      paused: patch.paused,
      playbackRate: clampPlaybackRate(patch.playbackRate),
      updatedAt: Date.now(),
      updatedBy: patch.updatedBy,
      reason,
    }
    room.lastActiveAt = Date.now()
  }

  function reassignHostIfNeeded(room: RoomState) {
    if (room.members.has(room.hostSocketId)) {
      return
    }

    const nextHost = room.members.keys().next().value

    if (nextHost) {
      room.hostSocketId = nextHost
    }
  }

  function emitRoomSnapshot(io: Server, room: RoomState) {
    io.to(room.id).emit('room:snapshot', toRoomSnapshot(room))
  }

  function emitPlaybackState(io: Server, room: RoomState, socketId?: string) {
    const payload = toPlaybackEnvelope(room)

    if (socketId) {
      io.to(socketId).emit('playback:state', payload)
      return
    }

    io.to(room.id).emit('playback:state', payload)
  }

  function removeMemberFromRoom(socketId: string) {
    const roomId = socketToRoom.get(socketId)

    if (!roomId) {
      return
    }

    socketToRoom.delete(socketId)

    const room = rooms.get(roomId)

    if (!room) {
      return
    }

    room.members.delete(socketId)
    room.lastActiveAt = Date.now()
    reassignHostIfNeeded(room)

    if (room.members.size === 0) {
      return
    }

    syncMemberStartupReadiness(room)
    emitRoomSnapshot(io, room)
    syncStartupGate(io, room)
    applyBuffering(io, room)
  }

  function getSoftBufferGraceMs(room: RoomState) {
    if (!room.media?.duration || !Number.isFinite(room.media.duration)) {
      return 900
    }

    const remainingDuration = Math.max(
      0,
      room.media.duration - getCurrentPlaybackPosition(room),
    )

    if (remainingDuration <= 5) {
      return 0
    }

    if (remainingDuration <= 15) {
      return 350
    }

    return 900
  }

  function shouldPauseForBuffering(room: RoomState) {
    const bufferingMembers = [...room.members.values()].filter((member) => member.buffering)

    if (bufferingMembers.length === 0) {
      return false
    }

    if (room.syncMode === 'strict') {
      return true
    }

    const now = Date.now()
    const graceMs = getSoftBufferGraceMs(room)

    return bufferingMembers.some((member) => {
      if (member.readyState < 3) {
        return true
      }

      if (member.bufferingStartedAt === null) {
        return false
      }

      return now - member.bufferingStartedAt >= graceMs
    })
  }

  function applyBuffering(io: Server, room: RoomState) {
    const bufferingUsers = getBufferingUsers(room)

    if (shouldPauseForBuffering(room) && !room.playbackState.paused) {
      markPlayback(
        room,
        {
          position: deriveCurrentPosition(room.playbackState),
          paused: true,
          playbackRate: room.playbackState.playbackRate,
          updatedBy: bufferingUsers[0],
        },
        'buffer_lock',
      )
      room.resumeAfterBuffer = true
      emitPlaybackState(io, room)
      return
    }

    if (
      room.resumeAfterBuffer &&
      bufferingUsers.length === 0 &&
      areAllMembersReadyToResumePlayback(room)
    ) {
      markPlayback(
        room,
        {
          position: room.playbackState.position,
          paused: false,
          playbackRate: room.playbackState.playbackRate,
          updatedBy: room.hostSocketId,
        },
        'buffer_lock',
      )
      room.resumeAfterBuffer = false
      emitPlaybackState(io, room)
    }
  }

  function syncStartupGate(io: Server, room: RoomState) {
    if (!room.startupGateActive) {
      return
    }

    if (!areAllMembersStartupReady(room)) {
      emitRoomSnapshot(io, room)
      return
    }

    emitRoomSnapshot(io, room)

    if (!room.pendingStartRequested || !room.playbackState.paused) {
      return
    }

    room.startupGateActive = false
    room.pendingStartRequested = false
    markPlayback(
      room,
      {
        position: room.playbackState.position,
        paused: false,
        playbackRate: room.playbackState.playbackRate,
        updatedBy: room.hostSocketId,
      },
      'startup_gate',
    )
    emitPlaybackState(io, room)
  }

  function resolveRoomFromRequest(request: Request) {
    const rawRoomId = Array.isArray(request.params.roomId)
      ? request.params.roomId[0]
      : request.params.roomId ?? ''
    const roomId = normalizeRoomId(rawRoomId)

    if (!roomId) {
      return null
    }

    return rooms.get(roomId) ?? null
  }

  function getDiscoveryPlaybackState(room: RoomState) {
    if (!room.media) {
      return 'idle' as const
    }

    return room.playbackState.paused ? ('paused' as const) : ('playing' as const)
  }

  const storage = multer.diskStorage({
    destination: (request, _file, callback) => {
      const rawRoomId = Array.isArray(request.params.roomId)
        ? request.params.roomId[0]
        : request.params.roomId ?? ''
      const roomId = normalizeRoomId(rawRoomId) || createRoomCode()
      const roomDir = path.join(uploadRoot, roomId)
      mkdirSync(roomDir, { recursive: true })
      callback(null, roomDir)
    },
    filename: (_request, file, callback) => {
      const decodedName = decodeMultipartName(file.originalname)
      const extension = path.extname(decodedName)
      const basename = normalizeStoredBaseName(decodedName)
      callback(null, `${Date.now()}-${basename || 'movie'}${extension}`)
    },
  })

  const mediaUpload = multer({
    storage,
    limits: {
      fileSize: 15 * 1024 * 1024 * 1024,
    },
  })

  const subtitleUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 5 * 1024 * 1024,
    },
  })

  const app = express()
  const httpServer = createServer(app)
  const io = new Server(httpServer, {
    cors: {
      origin: true,
      credentials: true,
    },
    pingInterval: 15_000,
    pingTimeout: 30_000,
    connectionStateRecovery: {
      maxDisconnectionDuration: 30_000,
      skipMiddlewares: true,
    },
  })

  app.use(cors())
  app.use(express.json())

  app.get('/api/health', (_request, response) => {
    response.json({
      ok: true,
      roomCount: rooms.size,
      timestamp: Date.now(),
    })
  })

  app.get('/api/discovery', (_request, response) => {
    const payload: DiscoveryProbeResponse = {
      protocolVersion: 1,
      instanceId: options.instanceId ?? `local-${DEFAULT_RELAY_PORT}`,
      rooms: [...rooms.values()]
        .filter((room) => room.members.size > 0)
        .map((room) => {
          const hostMember = room.members.get(room.hostSocketId)

          return {
            roomId: room.id,
            roomName: room.roomName,
            hostNickname: hostMember?.nickname ?? 'Host',
            requiresPassword: Boolean(room.password),
            memberCount: room.members.size,
            maxMembers: MAX_ROOM_MEMBERS,
            mediaName: room.media?.name ?? null,
            subtitleName: room.subtitle?.name ?? null,
            playbackState: getDiscoveryPlaybackState(room),
          }
        }),
    }

    response.setHeader('Cache-Control', 'no-store')
    response.json(payload)
  })

  function resolveHostRoom(request: Request, response: express.Response) {
    const room = resolveRoomFromRequest(request)
    const socketId = request.header('x-socket-id') ?? ''

    if (!room) {
      response.status(404).json({ error: '房间不存在' })
      return null
    }

    if (!room.members.has(socketId) || room.hostSocketId !== socketId) {
      response.status(403).json({ error: '只有房主可以上传视频' })
      return null
    }

    return { room, socketId }
  }

  app.post('/api/rooms/:roomId/media', mediaUpload.single('video'), async (request, response) => {
    const context = resolveHostRoom(request, response)

    if (!context) {
      return
    }

    if (!request.file) {
      response.status(400).json({ error: '没有收到视频文件' })
      return
    }

    const { room, socketId } = context
    const resolvedName = decodeMultipartName(request.file.originalname)
    deleteMedia(room)
    deleteSubtitle(room)

    const parsedDuration = Number(request.body.duration)
    const fallbackDuration = Number.isFinite(parsedDuration) ? parsedDuration : null
    const originalMimeType =
      request.file.mimetype ||
      mime.lookup(resolvedName) ||
      'application/octet-stream'
    let finalPath = request.file.path
    let finalName = resolvedName
    let finalMimeType = originalMimeType
    let finalSize = request.file.size
    let finalDuration = fallbackDuration
    let optimizedForNetwork = false
    const sourceProbe = await probeMedia(request.file.path)
    const sourceBitrate =
      sourceProbe.bitrate ?? getMediaBitrate(request.file.size, fallbackDuration)

    if (
      shouldCreateCompatibilityProxy(
        resolvedName,
        originalMimeType,
        sourceProbe,
        sourceBitrate,
      )
    ) {
      const proxyPath = path.join(
        path.dirname(request.file.path),
        `${path.basename(request.file.path, path.extname(request.file.path))}-compat.mp4`,
      )

      try {
        await createCompatibilityProxy(request.file.path, proxyPath)
        const proxyStat = statSync(proxyPath)
        const proxyProbe = await probeMedia(proxyPath)

        finalPath = proxyPath
        finalName = `${path.basename(resolvedName, path.extname(resolvedName))}.mp4`
        finalMimeType = 'video/mp4'
        finalSize = proxyStat.size
        finalDuration = proxyProbe.duration ?? sourceProbe.duration ?? fallbackDuration
        optimizedForNetwork = true

        try {
          rmSync(request.file.path, { force: true })
        } catch {
          // noop
        }
      } catch {
        try {
          rmSync(proxyPath, { force: true })
        } catch {
          // noop
        }
      }
    }

    room.media = {
      id: randomUUID(),
      name: finalName,
      size: finalSize,
      mimeType: finalMimeType,
      duration: finalDuration,
      sha256: randomUUID(),
      selectedAt: Date.now(),
      filePath: finalPath,
    }

    for (const member of room.members.values()) {
      resetMemberPlaybackState(member)
      member.mediaMatchState = member.socketId === socketId ? 'matched' : 'missing'
      member.selectedMediaName = member.socketId === socketId ? finalName : null
      member.selectedMediaSha256 = member.socketId === socketId ? room.media.sha256 : null
      member.selectedMediaSize = member.socketId === socketId ? room.media.size : null
      member.selectedMediaDuration =
        member.socketId === socketId ? room.media.duration : null
    }

    room.playbackState = createInitialPlaybackState(socketId)
    room.startupGateActive = true
    room.pendingStartRequested = false
    room.startupBufferTargetSeconds = getStartupBufferTargetSeconds(
      room.media.duration,
    )
    room.playbackResumeBufferTargetSeconds = getPlaybackResumeBufferTargetSeconds(
      room.media.duration,
    )
    room.resumeAfterBuffer = false
    room.lastActiveAt = Date.now()

    emitRoomSnapshot(io, room)
    emitPlaybackState(io, room)

    response.json({
      media: {
        id: room.media.id,
        name: room.media.name,
        size: room.media.size,
        mimeType: room.media.mimeType,
        duration: room.media.duration,
        sha256: room.media.sha256,
        selectedAt: room.media.selectedAt,
      },
      optimizedForNetwork,
      sourceBitrateMbps: sourceBitrate ? sourceBitrate / 1_000_000 : null,
    })
  })

  app.post(
    '/api/rooms/:roomId/subtitle',
    subtitleUpload.single('subtitle'),
    (request, response) => {
      const context = resolveHostRoom(request, response)

      if (!context) {
        return
      }

      if (!request.file) {
        response.status(400).json({ error: '没有收到字幕文件' })
        return
      }

      const { room } = context
      const originalName = decodeMultipartName(request.file.originalname)
      const extension = path.extname(originalName).toLowerCase()
      const subtitleFormat = getSubtitleFormat(originalName)

      if (!['.srt', '.vtt', '.ass', '.ssa'].includes(extension)) {
        response.status(400).json({ error: '目前只支持 .srt、.vtt、.ass 和 .ssa 字幕' })
        return
      }

      const roomDir = path.join(uploadRoot, room.id)
      mkdirSync(roomDir, { recursive: true })

      const subtitlePath = path.join(
        roomDir,
        `${Date.now()}-${normalizeStoredBaseName(originalName) || 'subtitle'}${getSubtitleFileExtension(
          originalName,
        )}`,
      )

      deleteSubtitle(room)
      writeFileSync(
        subtitlePath,
        getSubtitleText(request.file.buffer, originalName),
        'utf8',
      )

      room.subtitle = {
        id: randomUUID(),
        name: originalName,
        format: subtitleFormat,
        language: detectSubtitleLanguage(originalName),
        uploadedAt: Date.now(),
        filePath: subtitlePath,
      }
      room.lastActiveAt = Date.now()

      emitRoomSnapshot(io, room)

      response.json({
        subtitle: {
          id: room.subtitle.id,
          name: room.subtitle.name,
          format: room.subtitle.format,
          language: room.subtitle.language,
          uploadedAt: room.subtitle.uploadedAt,
        },
      })
    },
  )

  app.get('/api/rooms/:roomId/media/:mediaId', (request, response) => {
    const room = resolveRoomFromRequest(request)

    if (!room?.media || room.media.id !== request.params.mediaId || !room.media.filePath) {
      response.status(404).json({ error: '视频不存在' })
      return
    }

    if (!existsSync(room.media.filePath)) {
      response.status(404).json({ error: '源文件已经被清理' })
      return
    }

    const fileStat = statSync(room.media.filePath)
    const fileSize = fileStat.size
    const range = request.headers.range

    response.setHeader('Accept-Ranges', 'bytes')
    response.setHeader('Content-Type', room.media.mimeType)
    response.setHeader('Cache-Control', 'no-store')

    if (!range) {
      response.setHeader('Content-Length', fileSize)
      createReadStream(room.media.filePath).pipe(response)
      return
    }

    const matches = /bytes=(\d*)-(\d*)/.exec(range)

    if (!matches) {
      response.status(416).end()
      return
    }

    const start = matches[1] ? Number(matches[1]) : 0
    const end = matches[2] ? Number(matches[2]) : fileSize - 1

    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start > end ||
      end >= fileSize
    ) {
      response.status(416).end()
      return
    }

    response.status(206)
    response.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`)
    response.setHeader('Content-Length', end - start + 1)

    createReadStream(room.media.filePath, { start, end }).pipe(response)
  })

  app.get('/api/rooms/:roomId/subtitles/:subtitleId', (request, response) => {
    const room = resolveRoomFromRequest(request)

    if (!room?.subtitle || room.subtitle.id !== request.params.subtitleId) {
      response.status(404).json({ error: '字幕不存在' })
      return
    }

    if (!existsSync(room.subtitle.filePath)) {
      response.status(404).json({ error: '字幕文件已经被清理' })
      return
    }

    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Content-Type', getSubtitleContentType(room.subtitle.name))
    createReadStream(room.subtitle.filePath).pipe(response)
  })

  io.on('connection', (socket) => {
    socket.on(
      'room:join',
      (payload: JoinRoomPayload, callback?: (result: JoinRoomResult) => void) => {
        const roomId = normalizeRoomId(payload.roomId) || createRoomCode()
        const nickname = sanitizeNickname(payload.nickname)
        const requestedPassword = sanitizePassword(payload.password)
        const existingRoom = rooms.get(roomId)

        if (existingRoom?.password && existingRoom.password !== requestedPassword) {
          callback?.({
            ok: false,
            error: '房间密码不正确',
          })
          return
        }

        const room = ensureRoom(
          roomId,
          socket.id,
          sanitizeRoomName(payload.roomName ?? '', nickname),
          requestedPassword,
        )
        const memberAlreadyJoined = room.members.has(socket.id)
        const memberCountBeforeJoin = room.members.size
        const wasPlaying = room.media ? !room.playbackState.paused : false
        let pausedForJoinGate = false

        if (!memberAlreadyJoined && room.members.size >= MAX_ROOM_MEMBERS) {
          callback?.({
            ok: false,
            error: '房间人数已满',
          })
          return
        }

        const member = createTrackedMember(
          socket.id,
          nickname,
          socket.id === room.hostSocketId,
        )
        member.startupReady = !room.media || !room.startupGateActive
        room.members.set(socket.id, member)

        if (room.media && !memberAlreadyJoined && memberCountBeforeJoin > 0) {
          room.startupGateActive = true
          room.pendingStartRequested = wasPlaying
          syncMemberStartupReadiness(room)

          if (wasPlaying) {
            pausedForJoinGate = true
            markPlayback(
              room,
              {
                position: getCurrentPlaybackPosition(room),
                paused: true,
                playbackRate: room.playbackState.playbackRate,
                updatedBy: room.hostSocketId,
              },
              'startup_gate',
            )
          }
        }

        socket.join(roomId)
        socketToRoom.set(socket.id, roomId)
        room.lastActiveAt = Date.now()

        callback?.({
          ok: true,
          snapshot: toRoomSnapshot(room),
        })

        emitRoomSnapshot(io, room)
        if (pausedForJoinGate) {
          emitPlaybackState(io, room)
        } else {
          emitPlaybackState(io, room, socket.id)
        }
      },
    )

    socket.on('room:select-media', (payload: LocalMediaSelectionPayload) => {
      const roomId = normalizeRoomId(payload.roomId)
      const room = rooms.get(roomId)
      const member = room?.members.get(socket.id)

      if (!room || !member) {
        return
      }

      const selectedMedia: MediaSnapshot = {
        ...payload.media,
        selectedAt: Date.now(),
      }

      member.selectedMediaName = selectedMedia.name
      member.selectedMediaSha256 = selectedMedia.sha256
      member.selectedMediaSize = selectedMedia.size
      member.selectedMediaDuration = selectedMedia.duration
      resetMemberPlaybackState(member)

      if (socket.id === room.hostSocketId) {
        applyNewRoomMedia(room, socket.id, selectedMedia)
        emitRoomSnapshot(io, room)
        emitPlaybackState(io, room)
        return
      }

      if (!room.media) {
        member.mediaMatchState = 'missing'
        room.lastActiveAt = Date.now()
        emitRoomSnapshot(io, room)
        io.to(socket.id).emit('room:error', '等待房主先选择本地片源')
        return
      }

      member.mediaMatchState = matchesRoomMedia(room.media, selectedMedia)
        ? 'matched'
        : 'mismatch'
      room.lastActiveAt = Date.now()
      syncMemberStartupReadiness(room)
      emitRoomSnapshot(io, room)
      syncStartupGate(io, room)
      applyBuffering(io, room)

      if (member.mediaMatchState === 'mismatch') {
        io.to(socket.id).emit('room:error', '本地文件与房主片源不一致，请重新选择')
      }
    })

    socket.on('playback:control', (payload: PlaybackControlPayload) => {
      const roomId = normalizeRoomId(payload.roomId)
      const room = rooms.get(roomId)

      if (!room || !room.members.has(socket.id) || !room.media) {
        return
      }

      if (!payload.paused && room.startupGateActive) {
        if (!areAllMembersStartupReady(room)) {
          room.pendingStartRequested = true
          markPlayback(
            room,
            {
              position: payload.position,
              paused: true,
              playbackRate: payload.playbackRate,
              updatedBy: socket.id,
            },
            'startup_gate',
          )
          emitRoomSnapshot(io, room)
          emitPlaybackState(io, room)
          return
        }

        room.startupGateActive = false
        room.pendingStartRequested = false
        emitRoomSnapshot(io, room)
      }

      if (room.syncMode === 'strict' && getBufferingUsers(room).length > 0 && !payload.paused) {
        return
      }

      markPlayback(
        room,
        {
          position: payload.position,
          paused: payload.paused,
          playbackRate: payload.playbackRate,
          updatedBy: socket.id,
        },
        payload.reason,
      )
      emitPlaybackState(io, room)
    })

    socket.on('client:buffering', (payload: BufferingPayload) => {
      const roomId = normalizeRoomId(payload.roomId)
      const room = rooms.get(roomId)
      const member = room?.members.get(socket.id)

      if (!room || !member) {
        return
      }

      const nextBuffering = Boolean(payload.buffering)
      const now = Date.now()

      member.buffering = nextBuffering
      member.bufferAheadSeconds = Math.max(0, payload.bufferAheadSeconds ?? 0)
      member.readyState = Math.max(0, payload.readyState ?? 0)
      member.canPlayThrough = Boolean(payload.canPlayThrough)
      member.lastBufferReportAt = now
      member.bufferingStartedAt = nextBuffering
        ? member.bufferingStartedAt ?? now
        : null
      room.lastActiveAt = now
      syncMemberStartupReadiness(room)
      emitRoomSnapshot(io, room)
      syncStartupGate(io, room)
      applyBuffering(io, room)
    })

    socket.on('playback:request-state', ({ roomId }: { roomId: string }) => {
      const room = rooms.get(normalizeRoomId(roomId))

      if (!room || !room.members.has(socket.id)) {
        return
      }

      emitPlaybackState(io, room, socket.id)
    })

    socket.on('room:request-snapshot', ({ roomId }: { roomId: string }) => {
      const room = rooms.get(normalizeRoomId(roomId))

      if (!room || !room.members.has(socket.id)) {
        return
      }

      io.to(socket.id).emit('room:snapshot', toRoomSnapshot(room))
    })

    socket.on('room:config', (payload: RoomConfigPayload) => {
      const room = rooms.get(normalizeRoomId(payload.roomId))

      if (!room || room.hostSocketId !== socket.id) {
        return
      }

      room.syncMode = payload.syncMode
      room.lastActiveAt = Date.now()

      if (payload.syncMode === 'soft') {
        room.resumeAfterBuffer = false
      } else {
        applyBuffering(io, room)
      }

      emitRoomSnapshot(io, room)
      emitPlaybackState(io, room)
    })

    socket.on(
      'room:leave',
      (
        payload: { roomId?: string } | undefined,
        callback?: (result: { ok: boolean }) => void,
      ) => {
        const roomId = socketToRoom.get(socket.id)
        const requestedRoomId = normalizeRoomId(payload?.roomId ?? '')

        if (roomId && (!requestedRoomId || requestedRoomId === roomId)) {
          removeMemberFromRoom(socket.id)
        }

        callback?.({ ok: true })
      },
    )

    socket.on('disconnect', () => {
      removeMemberFromRoom(socket.id)
    })
  })

  const playbackTimer = setInterval(() => {
    for (const room of rooms.values()) {
      if (room.members.size === 0 || !room.media) {
        continue
      }

      emitPlaybackState(io, room)
    }
  }, 1500)

  const snapshotTimer = setInterval(() => {
    for (const room of rooms.values()) {
      if (room.members.size === 0) {
        continue
      }

      emitRoomSnapshot(io, room)
    }
  }, roomSnapshotHeartbeatMs)

  const cleanupTimer = setInterval(() => {
    const now = Date.now()

    for (const [roomId, room] of rooms.entries()) {
      if (room.members.size === 0 && now - room.lastActiveAt > roomIdleTtlMs) {
        deleteRoom(roomId)
      }
    }
  }, 60_000)

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      httpServer.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      httpServer.off('error', onError)
      resolve()
    }

    httpServer.once('error', onError)
    httpServer.once('listening', onListening)
    httpServer.listen(options.port ?? DEFAULT_RELAY_PORT, '0.0.0.0')
  })

  const address = httpServer.address()

  if (!address || typeof address === 'string') {
    throw new Error('无法确定本地直连服务端口')
  }

  async function closeServer(server: HttpServer) {
    if (!server.listening) {
      return
    }

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
          reject(error)
          return
        }

        resolve()
      })
    })
  }

  async function closeIoServer(server: Server) {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
  }

  return {
    port: address.port,
    close: async () => {
      if (isClosed) {
        return
      }

      if (closePromise) {
        return closePromise
      }

      closePromise = (async () => {
        clearInterval(playbackTimer)
        clearInterval(snapshotTimer)
        clearInterval(cleanupTimer)

        for (const roomId of [...rooms.keys()]) {
          deleteRoom(roomId)
        }

        io.removeAllListeners()
        await closeIoServer(io)
        await closeServer(httpServer)
        isClosed = true
      })()

      try {
        await closePromise
      } finally {
        closePromise = null
      }
    },
  }
}
