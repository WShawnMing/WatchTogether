import { randomUUID } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
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
  deriveCurrentPosition,
  MAX_ROOM_MEMBERS,
  normalizeRoomId,
  type BufferingPayload,
  type JoinRoomPayload,
  type JoinRoomResult,
  type MediaSnapshot,
  type PlaybackControlPayload,
  type PlaybackEnvelope,
  type PlaybackState,
  type RoomConfigPayload,
  type RoomMemberSnapshot,
  type RoomSnapshot,
  type SyncMode,
} from '../../shared/protocol.js'

interface StoredMedia extends MediaSnapshot {
  filePath: string
}

interface RoomState {
  id: string
  hostSocketId: string
  members: Map<string, RoomMemberSnapshot>
  media: StoredMedia | null
  playbackState: PlaybackState
  syncMode: SyncMode
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
}

export async function startLocalRelay(
  options: StartLocalRelayOptions = {},
): Promise<LocalRelayHandle> {
  const rooms = new Map<string, RoomState>()
  const socketToRoom = new Map<string, string>()
  const roomIdleTtlMs = (options.roomIdleTtlMinutes ?? 120) * 60 * 1000
  const uploadRoot = path.resolve(
    options.storageRoot ?? process.env.WATCH_TOGETHER_STORAGE_DIR ?? '.watchtogether/uploads',
  )
  let isClosed = false
  let closePromise: Promise<void> | null = null

  mkdirSync(uploadRoot, { recursive: true })

  function createRoom(roomId: string, hostSocketId: string) {
    const now = Date.now()

    const room: RoomState = {
      id: roomId,
      hostSocketId,
      members: new Map(),
      media: null,
      playbackState: createInitialPlaybackState(hostSocketId),
      syncMode: 'soft',
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

  function ensureRoom(roomId: string, hostSocketId: string) {
    return rooms.get(roomId) ?? createRoom(roomId, hostSocketId)
  }

  function getBufferingUsers(room: RoomState) {
    return [...room.members.values()]
      .filter((member) => member.buffering)
      .map((member) => member.socketId)
  }

  function toRoomSnapshot(room: RoomState): RoomSnapshot {
    const members = [...room.members.values()]
      .map((member) => ({
        ...member,
        isHost: member.socketId === room.hostSocketId,
      }))
      .sort((left, right) => Number(right.isHost) - Number(left.isHost))

    return {
      roomId: room.id,
      members,
      media: room.media
        ? {
            id: room.media.id,
            name: room.media.name,
            size: room.media.size,
            mimeType: room.media.mimeType,
            duration: room.media.duration,
            uploadedAt: room.media.uploadedAt,
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

  function deleteMedia(room: RoomState) {
    if (!room.media) {
      return
    }

    try {
      rmSync(room.media.filePath, { force: true })
    } catch {
      // noop
    }

    room.media = null
  }

  function deleteRoom(roomId: string) {
    const room = rooms.get(roomId)

    if (!room) {
      return
    }

    deleteMedia(room)

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

  function applyBuffering(io: Server, room: RoomState) {
    if (room.syncMode !== 'strict') {
      room.resumeAfterBuffer = false
      return
    }

    const bufferingUsers = getBufferingUsers(room)

    if (bufferingUsers.length > 0 && !room.playbackState.paused) {
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

    if (bufferingUsers.length === 0 && room.resumeAfterBuffer) {
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
      const extension = path.extname(file.originalname)
      const basename = path
        .basename(file.originalname, extension)
        .replace(/[^\w\u4e00-\u9fa5.-]+/g, '-')
        .slice(0, 80)
      callback(null, `${Date.now()}-${basename || 'movie'}${extension}`)
    },
  })

  const upload = multer({
    storage,
    limits: {
      fileSize: 15 * 1024 * 1024 * 1024,
    },
  })

  const app = express()
  const httpServer = createServer(app)
  const io = new Server(httpServer, {
    cors: {
      origin: true,
      credentials: true,
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

  app.post('/api/rooms/:roomId/media', upload.single('video'), (request, response) => {
    const room = resolveRoomFromRequest(request)
    const socketId = request.header('x-socket-id') ?? ''

    if (!room) {
      response.status(404).json({ error: '房间不存在' })
      return
    }

    if (!room.members.has(socketId) || room.hostSocketId !== socketId) {
      response.status(403).json({ error: '只有房主可以上传视频' })
      return
    }

    if (!request.file) {
      response.status(400).json({ error: '没有收到视频文件' })
      return
    }

    deleteMedia(room)

    const parsedDuration = Number(request.body.duration)
    room.media = {
      id: randomUUID(),
      name: request.file.originalname,
      size: request.file.size,
      mimeType:
        request.file.mimetype ||
        mime.lookup(request.file.originalname) ||
        'application/octet-stream',
      duration: Number.isFinite(parsedDuration) ? parsedDuration : null,
      uploadedAt: Date.now(),
      filePath: request.file.path,
    }

    for (const member of room.members.values()) {
      member.buffering = false
    }

    room.playbackState = createInitialPlaybackState(socketId)
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
        uploadedAt: room.media.uploadedAt,
      },
    })
  })

  app.get('/api/rooms/:roomId/media/:mediaId', (request, response) => {
    const room = resolveRoomFromRequest(request)

    if (!room?.media || room.media.id !== request.params.mediaId) {
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

  io.on('connection', (socket) => {
    socket.on(
      'room:join',
      (payload: JoinRoomPayload, callback?: (result: JoinRoomResult) => void) => {
        const roomId = normalizeRoomId(payload.roomId) || createRoomCode()
        const nickname = sanitizeNickname(payload.nickname)
        const room = ensureRoom(roomId, socket.id)

        if (!room.members.has(socket.id) && room.members.size >= MAX_ROOM_MEMBERS) {
          callback?.({
            ok: false,
            error: '房间已满，只支持两人同看',
          })
          return
        }

        room.members.set(socket.id, {
          socketId: socket.id,
          nickname,
          isHost: socket.id === room.hostSocketId,
          buffering: false,
          connectedAt: Date.now(),
        })

        socket.join(roomId)
        socketToRoom.set(socket.id, roomId)
        room.lastActiveAt = Date.now()

        callback?.({
          ok: true,
          snapshot: toRoomSnapshot(room),
        })

        emitRoomSnapshot(io, room)
        emitPlaybackState(io, room, socket.id)
      },
    )

    socket.on('playback:control', (payload: PlaybackControlPayload) => {
      const roomId = normalizeRoomId(payload.roomId)
      const room = rooms.get(roomId)

      if (!room || !room.members.has(socket.id) || !room.media) {
        return
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

      member.buffering = payload.buffering
      room.lastActiveAt = Date.now()
      emitRoomSnapshot(io, room)
      applyBuffering(io, room)
    })

    socket.on('playback:request-state', ({ roomId }: { roomId: string }) => {
      const room = rooms.get(normalizeRoomId(roomId))

      if (!room || !room.members.has(socket.id)) {
        return
      }

      emitPlaybackState(io, room, socket.id)
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

    socket.on('disconnect', () => {
      const roomId = socketToRoom.get(socket.id)

      if (!roomId) {
        return
      }

      socketToRoom.delete(socket.id)

      const room = rooms.get(roomId)

      if (!room) {
        return
      }

      room.members.delete(socket.id)
      room.lastActiveAt = Date.now()
      reassignHostIfNeeded(room)

      if (room.members.size === 0) {
        return
      }

      emitRoomSnapshot(io, room)
      applyBuffering(io, room)
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
    httpServer.listen(options.port ?? 0, '0.0.0.0')
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
