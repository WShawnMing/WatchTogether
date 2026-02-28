import {
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { io, type Socket } from 'socket.io-client'
import './App.css'
import {
  createRoomCode,
  deriveCurrentPosition,
  normalizeRoomId,
  type DiscoveryAdvertisePayload,
  type DiscoveryPlaybackState,
  type DiscoverySession,
  type JoinRoomPayload,
  type JoinRoomResult,
  type PlaybackEnvelope,
  type PlaybackReason,
  type RoomSnapshot,
  type SyncMode,
} from '../shared/protocol'

type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting'
type UploadStatus = 'idle' | 'reading' | 'uploading' | 'done' | 'error'
type SubtitleStatus = 'idle' | 'uploading' | 'done' | 'error'

interface RelayStatus {
  running: boolean
  port: number | null
  localUrl: string | null
  shareUrls: string[]
  allUrls: string[]
}

interface ConnectRoomOptions {
  roomId: string
  serverUrl: string
  password?: string
  roomName?: string
}

const EMPTY_RELAY_STATUS: RelayStatus = {
  running: false,
  port: null,
  localUrl: null,
  shareUrls: [],
  allUrls: [],
}

const VIDEO_ACCEPT =
  '.mp4,.m4v,.mov,.webm,.mkv,.avi,.ts,.mpeg,.mpg,.ogv,.wmv'
const SUBTITLE_ACCEPT = '.srt,.vtt'

function normalizeServerUrl(input: string) {
  const trimmed = input.trim()

  if (!trimmed) {
    return ''
  }

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`

  return withProtocol.replace(/\/+$/, '')
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '--:--'
  }

  const rounded = Math.floor(seconds)
  const hours = Math.floor(rounded / 3600)
  const minutes = Math.floor((rounded % 3600) / 60)
  const remainder = rounded % 60

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
  }

  return `${minutes}:${String(remainder).padStart(2, '0')}`
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return '0 B'
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const level = Math.min(
    Math.floor(Math.log(value) / Math.log(1024)),
    units.length - 1,
  )
  const amount = value / 1024 ** level

  return `${amount.toFixed(level === 0 ? 0 : 1)} ${units[level]}`
}

function buildMediaUrl(serverUrl: string, roomId: string, mediaId: string) {
  return new URL(
    `/api/rooms/${roomId}/media/${mediaId}`,
    `${normalizeServerUrl(serverUrl)}/`,
  ).toString()
}

function buildSubtitleUrl(serverUrl: string, roomId: string, subtitleId: string) {
  return new URL(
    `/api/rooms/${roomId}/subtitles/${subtitleId}`,
    `${normalizeServerUrl(serverUrl)}/`,
  ).toString()
}

function roomSnapshotToPlayback(snapshot: RoomSnapshot): PlaybackEnvelope {
  return {
    roomId: snapshot.roomId,
    playbackState: snapshot.playbackState,
    bufferingUsers: snapshot.members
      .filter((member) => member.buffering)
      .map((member) => member.socketId),
    serverTime: snapshot.serverTime,
    syncMode: snapshot.syncMode,
  }
}

function getPlatformLabel() {
  switch (window.desktopApp?.platform) {
    case 'darwin':
      return 'macOS'
    case 'win32':
      return 'Windows'
    default:
      return 'Desktop'
  }
}

function readVideoDuration(file: File) {
  return new Promise<number | null>((resolve) => {
    const objectUrl = URL.createObjectURL(file)
    const probe = document.createElement('video')
    probe.preload = 'metadata'
    probe.src = objectUrl

    probe.onloadedmetadata = () => {
      resolve(Number.isFinite(probe.duration) ? probe.duration : null)
      URL.revokeObjectURL(objectUrl)
    }

    probe.onerror = () => {
      resolve(null)
      URL.revokeObjectURL(objectUrl)
    }
  })
}

function getPlaybackLabel(state: DiscoveryPlaybackState) {
  switch (state) {
    case 'playing':
      return '播放中'
    case 'paused':
      return '暂停中'
    default:
      return '等待开始'
  }
}

function getConnectionLabel(state: ConnectionState, relayRunning: boolean) {
  switch (state) {
    case 'connected':
      return '已连接'
    case 'connecting':
      return '连接中'
    case 'reconnecting':
      return '重连中'
    default:
      return relayRunning ? '正在共享' : '空闲'
  }
}

function buildRoomName(nickname: string) {
  const trimmed = nickname.trim()
  return `${trimmed || 'Someone'} 的共享放映室`
}

function formatSupportHint(mediaName?: string | null) {
  if (!mediaName) {
    return '推荐 MP4/H.264 最稳；MKV 已允许导入，最终是否可播取决于编码。'
  }

  const extension = mediaName.split('.').pop()?.toLowerCase() ?? ''

  if (['mkv', 'avi', 'wmv'].includes(extension)) {
    return '当前片源已导入。若无法播放，通常是编码不被内置播放器支持，建议优先使用 H.264/AAC。'
  }

  return '当前格式通常可直接播放。'
}

function StatusPill({
  tone,
  children,
}: {
  tone: 'neutral' | 'accent' | 'warning' | 'success'
  children: string
}) {
  return <span className={`status-pill status-pill--${tone}`}>{children}</span>
}

function App() {
  const [serverUrl, setServerUrl] = useState('')
  const [nickname, setNickname] = useState('')
  const [hostPassword, setHostPassword] = useState('')
  const [joinPasswords, setJoinPasswords] = useState<Record<string, string>>({})
  const [socketId, setSocketId] = useState('')
  const [relayStatus, setRelayStatus] = useState<RelayStatus>(EMPTY_RELAY_STATUS)
  const [discoveredSessions, setDiscoveredSessions] = useState<DiscoverySession[]>([])
  const [connectionState, setConnectionState] =
    useState<ConnectionState>('idle')
  const [room, setRoom] = useState<RoomSnapshot | null>(null)
  const [playback, setPlayback] = useState<PlaybackEnvelope | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [localBuffering, setLocalBuffering] = useState(false)
  const [autoplayBlocked, setAutoplayBlocked] = useState(false)
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>('idle')
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploadLabel, setUploadLabel] = useState('还没有选片')
  const [selectedFileName, setSelectedFileName] = useState('')
  const [subtitleStatus, setSubtitleStatus] =
    useState<SubtitleStatus>('idle')
  const [subtitleLabel, setSubtitleLabel] = useState('还没有字幕')
  const [selectedSubtitleName, setSelectedSubtitleName] = useState('')
  const [relayBusy, setRelayBusy] = useState(false)
  const [joiningRoomId, setJoiningRoomId] = useState<string | null>(null)

  const socketRef = useRef<Socket | null>(null)
  const roomRef = useRef<RoomSnapshot | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const joinPayloadRef = useRef<JoinRoomPayload | null>(null)
  const pendingPlaybackRef = useRef<PlaybackEnvelope | null>(null)
  const suppressEventsRef = useRef(false)
  const suppressTimeoutRef = useRef<number | null>(null)
  const localBufferingRef = useRef(false)
  const manualDisconnectRef = useRef(false)

  const currentMember =
    room?.members.find((member) => member.socketId === socketId) ?? null
  const hostMember = room?.members.find((member) => member.isHost) ?? null
  const isHost = Boolean(currentMember?.isHost)
  const mediaUrl =
    room?.media && room.roomId && serverUrl
      ? buildMediaUrl(serverUrl, room.roomId, room.media.id)
      : null
  const subtitleUrl =
    room?.subtitle && room.roomId && serverUrl
      ? buildSubtitleUrl(serverUrl, room.roomId, room.subtitle.id)
      : null
  const audienceCount = room?.members.length ?? 0
  const syncMode = room?.syncMode ?? 'soft'
  const syncModeLabel = syncMode === 'strict' ? '严格同步' : '柔性同步'
  const playbackPosition = playback
    ? deriveCurrentPosition(playback.playbackState, playback.serverTime)
    : 0
  const connectionLabel = getConnectionLabel(
    connectionState,
    relayStatus.running,
  )
  const videoKey = `${room?.media?.id ?? 'empty'}:${room?.subtitle?.id ?? 'nosub'}`

  useEffect(() => {
    roomRef.current = room
  }, [room])

  useEffect(() => {
    const savedNickname = window.localStorage.getItem('watchtogether:nickname')

    if (savedNickname) {
      setNickname(savedNickname)
    }
  }, [])

  useEffect(() => {
    if (nickname.trim()) {
      window.localStorage.setItem('watchtogether:nickname', nickname.trim())
    }
  }, [nickname])

  useEffect(() => {
    if (!window.desktopApp?.relay) {
      return
    }

    void window.desktopApp.relay.status().then((status: RelayStatus) => {
      setRelayStatus(status)

      if (status.localUrl && !serverUrl) {
        setServerUrl(status.localUrl)
      }
    })
  }, [serverUrl])

  useEffect(() => {
    if (!window.desktopApp?.discovery) {
      return
    }

    let disposed = false

    const refresh = async () => {
      try {
        const sessions = await window.desktopApp?.discovery.list()

        if (!disposed && sessions) {
          startTransition(() => {
            setDiscoveredSessions(sessions)
          })
        }
      } catch {
        if (!disposed) {
          setDiscoveredSessions([])
        }
      }
    }

    void refresh()

    const interval = window.setInterval(() => {
      void refresh()
    }, 2_000)

    return () => {
      disposed = true
      window.clearInterval(interval)
    }
  }, [])

  useEffect(() => {
    if (!window.desktopApp?.discovery || !relayStatus.running || !relayStatus.port || !room || !isHost) {
      void window.desktopApp?.discovery?.advertise(null)
      return
    }

    const payload: DiscoveryAdvertisePayload = {
      roomId: room.roomId,
      roomName: room.roomName,
      hostNickname: hostMember?.nickname ?? (nickname.trim() || 'Host'),
      requiresPassword: room.requiresPassword,
      memberCount: room.members.length,
      maxMembers: room.maxMembers,
      mediaName: room.media?.name ?? null,
      subtitleName: room.subtitle?.name ?? null,
      playbackState: room.media
        ? playback?.playbackState.paused
          ? 'paused'
          : 'playing'
        : 'idle',
      port: relayStatus.port,
    }

    void window.desktopApp.discovery.advertise(payload)

    return () => {
      void window.desktopApp?.discovery?.advertise(null)
    }
  }, [
    hostMember?.nickname,
    isHost,
    nickname,
    playback?.playbackState.paused,
    relayStatus.port,
    relayStatus.running,
    room,
  ])

  const suppressLocalPlaybackEvents = useCallback((duration = 300) => {
    suppressEventsRef.current = true

    if (suppressTimeoutRef.current !== null) {
      window.clearTimeout(suppressTimeoutRef.current)
    }

    suppressTimeoutRef.current = window.setTimeout(() => {
      suppressEventsRef.current = false
      suppressTimeoutRef.current = null
    }, duration)
  }, [])

  const applyRemotePlayback = useCallback(
    (incoming: PlaybackEnvelope) => {
      const video = videoRef.current
      const currentRoom = roomRef.current

      if (!video || !currentRoom?.media) {
        return
      }

      if (video.readyState < 1) {
        pendingPlaybackRef.current = incoming
        return
      }

      const targetTime = Math.max(
        deriveCurrentPosition(incoming.playbackState, incoming.serverTime),
        0,
      )
      const drift = targetTime - video.currentTime
      const absoluteDrift = Math.abs(drift)
      const targetRate = incoming.playbackState.playbackRate

      if (absoluteDrift > 1.1) {
        suppressLocalPlaybackEvents(450)
        video.currentTime = targetTime
      } else if (!incoming.playbackState.paused && absoluteDrift > 0.25) {
        const driftCorrectedRate = Math.max(
          0.85,
          Math.min(1.15, targetRate + drift * 0.08),
        )

        if (Math.abs(video.playbackRate - driftCorrectedRate) > 0.01) {
          suppressLocalPlaybackEvents(250)
          video.playbackRate = driftCorrectedRate
        }
      } else if (Math.abs(video.playbackRate - targetRate) > 0.01) {
        suppressLocalPlaybackEvents(250)
        video.playbackRate = targetRate
      }

      if (incoming.playbackState.paused) {
        if (absoluteDrift > 0.16) {
          suppressLocalPlaybackEvents(400)
          video.currentTime = targetTime
        }

        if (!video.paused) {
          suppressLocalPlaybackEvents(250)
          video.pause()
        }

        return
      }

      if (localBufferingRef.current) {
        pendingPlaybackRef.current = incoming
        return
      }

      if (video.paused) {
        suppressLocalPlaybackEvents(300)
        void video.play().catch(() => {
          setAutoplayBlocked(true)
        })
      }
    },
    [suppressLocalPlaybackEvents],
  )

  useEffect(() => {
    if (playback && room?.media) {
      applyRemotePlayback(playback)
    }
  }, [applyRemotePlayback, playback, room?.media])

  useEffect(() => {
    return () => {
      if (suppressTimeoutRef.current !== null) {
        window.clearTimeout(suppressTimeoutRef.current)
      }

      void window.desktopApp?.discovery?.advertise(null)
      socketRef.current?.disconnect()
    }
  }, [])

  const handleSnapshot = (snapshot: RoomSnapshot) => {
    const previousMediaId = roomRef.current?.media?.id ?? null
    const nextMediaId = snapshot.media?.id ?? null

    if (previousMediaId !== nextMediaId) {
      setAutoplayBlocked(false)
      setLocalBuffering(false)
      localBufferingRef.current = false
      pendingPlaybackRef.current = null
    }

    roomRef.current = snapshot

    startTransition(() => {
      setRoom(snapshot)
      setPlayback(roomSnapshotToPlayback(snapshot))
    })

    if (snapshot.subtitle) {
      setSelectedSubtitleName(snapshot.subtitle.name)
      setSubtitleLabel('字幕已同步给所有人')
    } else {
      setSelectedSubtitleName('')
      setSubtitleLabel('还没有字幕')
    }

    setErrorMessage(null)
  }

  const handlePlayback = (incoming: PlaybackEnvelope) => {
    startTransition(() => {
      setPlayback(incoming)
    })
  }

  const publishPlaybackIntent = (reason: PlaybackReason) => {
    const socket = socketRef.current
    const video = videoRef.current
    const currentRoom = roomRef.current

    if (!socket || !currentRoom || !video || suppressEventsRef.current) {
      return
    }

    socket.emit('playback:control', {
      roomId: currentRoom.roomId,
      position: video.currentTime,
      paused: video.paused,
      playbackRate: video.playbackRate,
      reason,
    })
  }

  const publishBufferState = (buffering: boolean) => {
    const socket = socketRef.current
    const currentRoom = roomRef.current

    if (!socket || !currentRoom) {
      return
    }

    localBufferingRef.current = buffering
    setLocalBuffering(buffering)

    socket.emit('client:buffering', {
      roomId: currentRoom.roomId,
      buffering,
    })
  }

  const requestFreshPlaybackState = () => {
    const socket = socketRef.current
    const currentRoom = roomRef.current

    if (!socket || !currentRoom) {
      return
    }

    socket.emit('playback:request-state', {
      roomId: currentRoom.roomId,
    })
  }

  const ensureLocalRelay = async () => {
    if (!window.desktopApp?.relay) {
      throw new Error('当前环境没有桌面端直连能力')
    }

    const status = await window.desktopApp.relay.start()

    setRelayStatus({
      running: true,
      port: status.port,
      localUrl: status.localUrl,
      shareUrls: status.shareUrls,
      allUrls: status.allUrls,
    })
    setServerUrl(status.localUrl)

    return status
  }

  const connectToRoom = async ({
    roomId,
    serverUrl: nextServerUrl,
    password,
    roomName,
  }: ConnectRoomOptions) => {
    const resolvedRoomId = normalizeRoomId(roomId) || createRoomCode()
    const resolvedNickname = nickname.trim()
    const resolvedServerUrl = normalizeServerUrl(nextServerUrl)

    if (!resolvedNickname) {
      throw new Error('先输入一个昵称')
    }

    if (!resolvedServerUrl) {
      throw new Error('房主地址不可用')
    }

    setServerUrl(resolvedServerUrl)
    setConnectionState('connecting')
    setErrorMessage(null)
    manualDisconnectRef.current = false

    socketRef.current?.removeAllListeners()
    socketRef.current?.disconnect()

    const nextSocket = io(resolvedServerUrl, {
      transports: ['websocket', 'polling'],
      autoConnect: false,
      reconnection: true,
      reconnectionDelayMax: 4_000,
    })

    joinPayloadRef.current = {
      roomId: resolvedRoomId,
      nickname: resolvedNickname,
      password: password?.trim() || undefined,
      roomName,
    }

    socketRef.current = nextSocket

    await new Promise<void>((resolve, reject) => {
      let settled = false

      const resolveOnce = () => {
        if (settled) {
          return
        }

        settled = true
        resolve()
      }

      const rejectOnce = (error: Error) => {
        if (settled) {
          return
        }

        settled = true
        reject(error)
      }

      nextSocket.on('connect', () => {
        const payload = joinPayloadRef.current

        setSocketId(nextSocket.id ?? '')

        if (!payload) {
          rejectOnce(new Error('加入参数丢失'))
          return
        }

        nextSocket.emit('room:join', payload, (result: JoinRoomResult) => {
          if (!result.ok || !result.snapshot) {
            const error = new Error(result.error ?? '加入房间失败')
            setErrorMessage(error.message)
            setConnectionState('idle')
            setJoiningRoomId(null)
            nextSocket.disconnect()
            rejectOnce(error)
            return
          }

          handleSnapshot(result.snapshot)
          setConnectionState('connected')
          setJoiningRoomId(null)
          nextSocket.emit('playback:request-state', {
            roomId: result.snapshot.roomId,
          })
          resolveOnce()
        })
      })

      nextSocket.on('connect_error', (error: Error) => {
        const nextError = new Error(error.message || '无法连接房主设备')
        setErrorMessage(nextError.message)
        setConnectionState('idle')
        setJoiningRoomId(null)
        rejectOnce(nextError)
      })

      nextSocket.io.on('reconnect_attempt', () => {
        setConnectionState('reconnecting')
      })

      nextSocket.on('disconnect', () => {
        setSocketId('')

        if (manualDisconnectRef.current) {
          setConnectionState('idle')
          return
        }

        setConnectionState('reconnecting')
      })

      nextSocket.on('room:snapshot', (snapshot: RoomSnapshot) => {
        handleSnapshot(snapshot)
      })

      nextSocket.on('playback:state', (incoming: PlaybackEnvelope) => {
        handlePlayback(incoming)
      })

      nextSocket.on('room:error', (message: string) => {
        setErrorMessage(message)
      })

      nextSocket.connect()
    })
  }

  const disconnectFromRoom = () => {
    manualDisconnectRef.current = true
    joinPayloadRef.current = null
    pendingPlaybackRef.current = null
    localBufferingRef.current = false
    roomRef.current = null
    setSocketId('')
    setConnectionState('idle')
    setRoom(null)
    setPlayback(null)
    setErrorMessage(null)
    setLocalBuffering(false)
    setAutoplayBlocked(false)
    setUploadStatus('idle')
    setUploadProgress(0)
    setUploadLabel('还没有选片')
    setSelectedFileName('')
    setSubtitleStatus('idle')
    setSubtitleLabel('还没有字幕')
    setSelectedSubtitleName('')
    setJoiningRoomId(null)
    socketRef.current?.removeAllListeners()
    socketRef.current?.disconnect()
    socketRef.current = null
  }

  const startSharing = async () => {
    setRelayBusy(true)
    setErrorMessage(null)

    try {
      const relay = await ensureLocalRelay()
      await connectToRoom({
        roomId: createRoomCode(),
        serverUrl: relay.localUrl,
        password: hostPassword,
        roomName: buildRoomName(nickname),
      })
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '启动共享失败')
    } finally {
      setRelayBusy(false)
    }
  }

  const stopHosting = async () => {
    if (!window.desktopApp?.relay) {
      setErrorMessage('当前环境没有桌面端直连能力')
      return
    }

    setRelayBusy(true)
    setErrorMessage(null)

    try {
      disconnectFromRoom()
      await window.desktopApp.discovery.advertise(null)
      await window.desktopApp.relay.stop()
      setRelayStatus(EMPTY_RELAY_STATUS)
      setServerUrl('')
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '停止共享失败')
    } finally {
      setRelayBusy(false)
    }
  }

  const leaveRoom = () => {
    if (isHost) {
      void stopHosting()
      return
    }

    disconnectFromRoom()
  }

  const joinDiscoveredRoom = async (session: DiscoverySession) => {
    const sessionKey = `${session.instanceId}:${session.roomId}`

    setJoiningRoomId(sessionKey)
    setErrorMessage(null)

    try {
      await connectToRoom({
        roomId: session.roomId,
        serverUrl: session.serverUrl,
        password: joinPasswords[sessionKey] ?? '',
      })
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '加入共享失败')
    } finally {
      setJoiningRoomId(null)
    }
  }

  const uploadMedia = async (file: File) => {
    const socket = socketRef.current
    const currentRoom = roomRef.current

    if (!socket || !currentRoom) {
      setErrorMessage('请先加入房间，再导入视频')
      return
    }

    setSelectedFileName(file.name)
    setUploadStatus('reading')
    setUploadProgress(0)
    setUploadLabel('读取片源信息')
    setErrorMessage(null)

    const duration = await readVideoDuration(file)
    const formData = new FormData()
    formData.append('video', file)

    if (duration !== null) {
      formData.append('duration', String(duration))
    }

    setUploadStatus('uploading')
    setUploadLabel('正在把片源挂到你的本机共享服务')

    await new Promise<void>((resolve, reject) => {
      const request = new XMLHttpRequest()
      request.open(
        'POST',
        `${normalizeServerUrl(serverUrl)}/api/rooms/${currentRoom.roomId}/media`,
      )
      request.setRequestHeader('x-socket-id', socket.id ?? '')

      request.upload.onprogress = (event) => {
        if (!event.lengthComputable) {
          return
        }

        setUploadProgress(Math.round((event.loaded / event.total) * 100))
      }

      request.onload = () => {
        if (request.status >= 200 && request.status < 300) {
          setUploadStatus('done')
          setUploadProgress(100)
          setUploadLabel('片源已同步，其他人会直接从你的设备拉流')
          resolve()
          return
        }

        let message = '导入失败'

        try {
          const payload = JSON.parse(request.responseText) as { error?: string }
          message = payload.error ?? message
        } catch {
          // Ignore malformed payloads.
        }

        reject(new Error(message))
      }

      request.onerror = () => {
        reject(new Error('导入中断，请检查本机共享服务'))
      }

      request.send(formData)
    }).catch((error: unknown) => {
      setUploadStatus('error')
      setUploadLabel('片源导入失败')
      setErrorMessage(error instanceof Error ? error.message : '导入失败')
    })
  }

  const uploadSubtitle = async (file: File) => {
    const socket = socketRef.current
    const currentRoom = roomRef.current

    if (!socket || !currentRoom) {
      setErrorMessage('请先加入房间，再上传字幕')
      return
    }

    setSelectedSubtitleName(file.name)
    setSubtitleStatus('uploading')
    setSubtitleLabel('正在同步字幕文件')
    setErrorMessage(null)

    const formData = new FormData()
    formData.append('subtitle', file)

    try {
      const response = await fetch(
        `${normalizeServerUrl(serverUrl)}/api/rooms/${currentRoom.roomId}/subtitle`,
        {
          method: 'POST',
          headers: {
            'x-socket-id': socket.id ?? '',
          },
          body: formData,
        },
      )

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: string }
          | null
        throw new Error(payload?.error ?? '字幕上传失败')
      }

      setSubtitleStatus('done')
      setSubtitleLabel('字幕已同步给所有人')
    } catch (error) {
      setSubtitleStatus('error')
      setSubtitleLabel('字幕上传失败')
      setErrorMessage(error instanceof Error ? error.message : '字幕上传失败')
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="topbar__eyebrow">WatchTogether</p>
          <h1>同一局域网，直接一起看。</h1>
          <p className="topbar__lead">
            两边进入同一个局域网或虚拟局域网后，输入昵称即可发现正在共享的房间。房主选片后，播放、暂停、拖动和字幕会自动同步。
          </p>
        </div>

        <div className="topbar__meta">
          <StatusPill tone="neutral">{getPlatformLabel()}</StatusPill>
          <StatusPill
            tone={
              connectionState === 'connected'
                ? 'success'
                : connectionState === 'reconnecting'
                  ? 'warning'
                  : relayStatus.running
                    ? 'accent'
                    : 'neutral'
            }
          >
            {connectionLabel}
          </StatusPill>
        </div>
      </header>

      {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}

      <main className="workspace">
        <aside className="sidebar">
          <section className="panel">
            <div className="panel__header">
              <div>
                <p className="panel__eyebrow">Profile</p>
                <h2>我的身份</h2>
              </div>
              <StatusPill tone="accent">自动发现</StatusPill>
            </div>

            <label className="field">
              <span>昵称</span>
              <input
                value={nickname}
                onChange={(event) => setNickname(event.target.value)}
                placeholder="输入一个昵称"
                maxLength={24}
              />
            </label>

            <label className="field">
              <span>房间密码（可选）</span>
              <input
                type="password"
                value={hostPassword}
                onChange={(event) => setHostPassword(event.target.value)}
                placeholder="不填就是公开房间"
                maxLength={64}
                disabled={isHost}
              />
            </label>

            <div className="button-row">
              <button
                className="button button--primary"
                onClick={() => void startSharing()}
                disabled={relayBusy || isHost}
              >
                {relayBusy ? '处理中...' : isHost ? '你正在共享' : '开始共享'}
              </button>
              <button
                className="button button--secondary"
                onClick={leaveRoom}
                disabled={!room && !relayStatus.running}
              >
                {isHost ? '停止共享' : '离开房间'}
              </button>
            </div>

            <p className="support-note">
              {relayStatus.running && relayStatus.shareUrls[0]
                ? `共享地址已经就绪，附近设备会自动看到你。`
                : '如果虚拟局域网不转发广播，后续可以再补一个高级直连入口。'}
            </p>
          </section>

          <section className="panel">
            <div className="panel__header">
              <div>
                <p className="panel__eyebrow">Nearby</p>
                <h2>附近正在共享</h2>
              </div>
              <StatusPill tone="neutral">{`${discoveredSessions.length} 个房间`}</StatusPill>
            </div>

            <div className="session-list">
              {discoveredSessions.length ? (
                discoveredSessions.map((session) => {
                  const sessionKey = `${session.instanceId}:${session.roomId}`

                  return (
                    <article className="session-card" key={sessionKey}>
                      <div className="session-card__header">
                        <div>
                          <strong>{session.roomName}</strong>
                          <p>
                            {session.hostNickname} · {session.memberCount}/
                            {session.maxMembers} 在线
                          </p>
                        </div>

                        <div className="session-card__pills">
                          <StatusPill
                            tone={session.requiresPassword ? 'warning' : 'success'}
                          >
                            {session.requiresPassword ? '已加密' : '公开'}
                          </StatusPill>
                          <StatusPill tone="neutral">
                            {getPlaybackLabel(session.playbackState)}
                          </StatusPill>
                        </div>
                      </div>

                      <p className="session-card__meta">
                        {session.mediaName ?? '房主还没有选片'}
                      </p>
                      <p className="session-card__submeta">
                        {session.subtitleName
                          ? `字幕：${session.subtitleName}`
                          : '当前没有字幕'}
                      </p>

                      <div className="session-card__actions">
                        {session.requiresPassword ? (
                          <input
                            type="password"
                            value={joinPasswords[sessionKey] ?? ''}
                            onChange={(event) => {
                              const nextValue = event.target.value
                              setJoinPasswords((current) => ({
                                ...current,
                                [sessionKey]: nextValue,
                              }))
                            }}
                            placeholder="输入房间密码"
                          />
                        ) : null}

                        <button
                          className="button button--secondary"
                          onClick={() => void joinDiscoveredRoom(session)}
                          disabled={joiningRoomId === sessionKey}
                        >
                          {joiningRoomId === sessionKey ? '加入中...' : '加入观看'}
                        </button>
                      </div>
                    </article>
                  )
                })
              ) : (
                <div className="empty-state">
                  <strong>还没有发现共享房间</strong>
                  <p>确认双方已经在同一个局域网或蒲公英等虚拟局域网里。</p>
                </div>
              )}
            </div>
          </section>

          {room ? (
            <section className="panel">
              <div className="panel__header">
                <div>
                  <p className="panel__eyebrow">Room</p>
                  <h2>当前房间</h2>
                </div>
                <StatusPill tone={isHost ? 'accent' : 'neutral'}>
                  {isHost ? '房主' : '观影方'}
                </StatusPill>
              </div>

              <div className="summary-list">
                <div className="summary-item">
                  <span>房间名</span>
                  <strong>{room.roomName}</strong>
                </div>
                <div className="summary-item">
                  <span>同步模式</span>
                  <strong>{syncModeLabel}</strong>
                </div>
                <div className="summary-item">
                  <span>在线成员</span>
                  <strong>{audienceCount}</strong>
                </div>
              </div>

              <div className="member-list">
                {room.members.map((member) => (
                  <article className="member-card" key={member.socketId}>
                    <div>
                      <strong>{member.nickname}</strong>
                      <p>{member.isHost ? '房主' : '正在观看'}</p>
                    </div>
                    <StatusPill tone={member.buffering ? 'warning' : 'success'}>
                      {member.buffering ? '缓冲中' : '已就绪'}
                    </StatusPill>
                  </article>
                ))}
              </div>

              {isHost ? (
                <div className="segment">
                  <button
                    className={`segment__button ${
                      syncMode === 'soft' ? 'segment__button--active' : ''
                    }`}
                    onClick={() => {
                      socketRef.current?.emit('room:config', {
                        roomId: room.roomId,
                        syncMode: 'soft' as SyncMode,
                      })
                    }}
                  >
                    柔性同步
                  </button>
                  <button
                    className={`segment__button ${
                      syncMode === 'strict' ? 'segment__button--active' : ''
                    }`}
                    onClick={() => {
                      socketRef.current?.emit('room:config', {
                        roomId: room.roomId,
                        syncMode: 'strict' as SyncMode,
                      })
                    }}
                  >
                    严格同步
                  </button>
                </div>
              ) : null}
            </section>
          ) : null}
        </aside>

        <section className="content">
          <section className="panel panel--session">
            <div className="panel__header panel__header--stack">
              <div>
                <p className="panel__eyebrow">Session</p>
                <h2>{room?.roomName ?? '先开始共享，或加入附近房间'}</h2>
                <p className="session-copy">
                  {room
                    ? `${hostMember?.nickname ?? '房主'} 正在共享这场观影。`
                    : '你不需要再手动发房间号或邀请串。只要在同一个网络里，房间会直接出现在左侧。'}
                </p>
              </div>

              <div className="panel__chips">
                <StatusPill tone={room?.media ? 'success' : 'neutral'}>
                  {room?.media ? '片源已就绪' : '等待片源'}
                </StatusPill>
                <StatusPill tone={room?.subtitle ? 'accent' : 'neutral'}>
                  {room?.subtitle ? '字幕已同步' : '暂无字幕'}
                </StatusPill>
                <StatusPill tone={localBuffering ? 'warning' : 'neutral'}>
                  {localBuffering ? '本地缓冲中' : syncModeLabel}
                </StatusPill>
              </div>
            </div>

            {isHost ? (
              <div className="upload-toolbar">
                <label className="button button--primary button--file">
                  选择影片
                  <input
                    type="file"
                    accept={VIDEO_ACCEPT}
                    onChange={(event) => {
                      const nextFile = event.target.files?.[0]

                      if (!nextFile) {
                        return
                      }

                      void uploadMedia(nextFile)
                      event.target.value = ''
                    }}
                  />
                </label>

                <label className="button button--secondary button--file">
                  上传字幕
                  <input
                    type="file"
                    accept={SUBTITLE_ACCEPT}
                    onChange={(event) => {
                      const nextFile = event.target.files?.[0]

                      if (!nextFile) {
                        return
                      }

                      void uploadSubtitle(nextFile)
                      event.target.value = ''
                    }}
                  />
                </label>

                <p className="support-note">{formatSupportHint(selectedFileName || room?.media?.name)}</p>
              </div>
            ) : (
              <p className="support-note">{formatSupportHint(room?.media?.name)}</p>
            )}

            <div className="player-frame">
              {mediaUrl ? (
                <video
                  key={videoKey}
                  ref={videoRef}
                  className="video"
                  src={mediaUrl}
                  controls
                  playsInline
                  preload="auto"
                  onPlay={() => {
                    setAutoplayBlocked(false)
                    publishPlaybackIntent('user')
                  }}
                  onPause={() => publishPlaybackIntent('user')}
                  onSeeked={() => publishPlaybackIntent('user')}
                  onRateChange={() => publishPlaybackIntent('user')}
                  onLoadedMetadata={() => {
                    const pending = pendingPlaybackRef.current ?? playback

                    if (pending) {
                      applyRemotePlayback(pending)
                    }
                  }}
                  onWaiting={() => publishBufferState(true)}
                  onStalled={() => publishBufferState(true)}
                  onCanPlay={() => {
                    if (localBufferingRef.current) {
                      publishBufferState(false)
                    }
                  }}
                  onPlaying={() => {
                    setAutoplayBlocked(false)

                    if (localBufferingRef.current) {
                      publishBufferState(false)
                      requestFreshPlaybackState()
                    }
                  }}
                  onEnded={() => publishPlaybackIntent('user')}
                  onError={() => {
                    setErrorMessage(
                      '当前片源的编码可能不被内置播放器支持。建议优先使用 H.264/AAC 的 MP4，或确认 MKV 内部编码可播放。',
                    )
                  }}
                >
                  {subtitleUrl ? (
                    <track
                      default
                      kind="subtitles"
                      label={room?.subtitle?.name ?? '字幕'}
                      src={subtitleUrl}
                      srcLang={room?.subtitle?.language ?? 'zh'}
                    />
                  ) : null}
                </video>
              ) : (
                <div className="video video--placeholder">
                  <div>
                    <p>还没有共享视频</p>
                    <strong>房主选片后，大家会直接拉取同一份片源并保持时间轴一致。</strong>
                  </div>
                </div>
              )}

              {autoplayBlocked ? (
                <div className="player-overlay">
                  <strong>系统拦截了自动播放</strong>
                  <p>手动点一次播放键，后续同步控制会继续生效。</p>
                </div>
              ) : null}
            </div>

            <div className="meta-grid">
              <article className="meta-card">
                <span>当前片源</span>
                <strong>{room?.media?.name ?? (selectedFileName || '未选择')}</strong>
                <p>
                  {room?.media
                    ? `${formatBytes(room.media.size)} · ${formatDuration(
                        room.media.duration ?? 0,
                      )}`
                    : uploadLabel}
                </p>
              </article>

              <article className="meta-card">
                <span>当前字幕</span>
                <strong>{room?.subtitle?.name ?? (selectedSubtitleName || '未上传')}</strong>
                <p>
                  {subtitleStatus === 'uploading'
                    ? '正在同步字幕文件'
                    : subtitleLabel}
                </p>
              </article>

              <article className="meta-card">
                <span>同步进度</span>
                <strong>{formatDuration(playbackPosition)}</strong>
                <p>
                  {playback?.playbackState.paused
                    ? '当前为暂停状态'
                    : '正在沿着同一条时间轴播放'}
                </p>
              </article>
            </div>

            {isHost ? (
              <div className="progress-block">
                <div className="progress__track">
                  <div
                    className="progress__fill"
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
                <div className="progress__meta">
                  <span>{uploadLabel}</span>
                  <strong>{uploadStatus === 'idle' ? '--' : `${uploadProgress}%`}</strong>
                </div>
              </div>
            ) : null}
          </section>
        </section>
      </main>
    </div>
  )
}

export default App
