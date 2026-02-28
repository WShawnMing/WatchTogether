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
  MAX_ROOM_MEMBERS,
  normalizeRoomId,
  type JoinRoomPayload,
  type JoinRoomResult,
  type PlaybackEnvelope,
  type PlaybackReason,
  type RoomSnapshot,
  type SyncMode,
} from '../shared/protocol'

type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting'
type UploadStatus = 'idle' | 'reading' | 'uploading' | 'done' | 'error'

interface RelayStatus {
  running: boolean
  port: number | null
  localUrl: string | null
  shareUrls: string[]
  allUrls: string[]
}

interface InvitePayload {
  roomId: string
  serverUrl: string
}

const EMPTY_RELAY_STATUS: RelayStatus = {
  running: false,
  port: null,
  localUrl: null,
  shareUrls: [],
  allUrls: [],
}

function normalizeServerUrl(input: string) {
  const trimmed = input.trim()

  if (!trimmed) {
    return ''
  }

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`

  return withProtocol.replace(/\/+$/, '')
}

function encodeInvite(payload: InvitePayload) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(payload))))
}

function decodeInvite(rawValue: string) {
  const trimmed = rawValue.trim()

  if (!trimmed) {
    throw new Error('邀请内容为空')
  }

  try {
    const parsed = JSON.parse(trimmed) as InvitePayload
    if (parsed.roomId && parsed.serverUrl) {
      return parsed
    }
  } catch {
    // fall through
  }

  const decoded = decodeURIComponent(escape(atob(trimmed)))
  const payload = JSON.parse(decoded) as InvitePayload

  if (!payload.roomId || !payload.serverUrl) {
    throw new Error('邀请内容格式不正确')
  }

  return payload
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
  const [roomInput, setRoomInput] = useState(createRoomCode())
  const [inviteInput, setInviteInput] = useState('')
  const [socketId, setSocketId] = useState('')
  const [shareUrl, setShareUrl] = useState('')
  const [relayStatus, setRelayStatus] = useState<RelayStatus>(EMPTY_RELAY_STATUS)
  const [connectionState, setConnectionState] =
    useState<ConnectionState>('idle')
  const [room, setRoom] = useState<RoomSnapshot | null>(null)
  const [playback, setPlayback] = useState<PlaybackEnvelope | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [localBuffering, setLocalBuffering] = useState(false)
  const [autoplayBlocked, setAutoplayBlocked] = useState(false)
  const [roomCodeCopied, setRoomCodeCopied] = useState(false)
  const [inviteCopied, setInviteCopied] = useState(false)
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>('idle')
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploadLabel, setUploadLabel] = useState('等待导入')
  const [selectedFileName, setSelectedFileName] = useState('')
  const [relayBusy, setRelayBusy] = useState(false)

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
  const isHost = Boolean(currentMember?.isHost)
  const mediaUrl =
    room?.media && room.roomId && serverUrl
      ? buildMediaUrl(serverUrl, room.roomId, room.media.id)
      : null
  const audienceCount = room?.members.length ?? 0
  const syncMode = room?.syncMode ?? 'soft'
  const syncModeLabel = syncMode === 'strict' ? '严格同步' : '柔性同步'
  const playbackPosition = playback
    ? deriveCurrentPosition(playback.playbackState, playback.serverTime)
    : 0

  useEffect(() => {
    roomRef.current = room
  }, [room])

  useEffect(() => {
    if (!window.desktopApp?.relay) {
      return
    }

    void window.desktopApp.relay.status().then((status) => {
      setRelayStatus(status)

      if (status.localUrl && !serverUrl) {
        setServerUrl(status.localUrl)
      }

      if (!shareUrl && status.shareUrls.length > 0) {
        setShareUrl(status.shareUrls[0])
      }
    })
  }, [serverUrl, shareUrl])

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

    if (status.shareUrls.length > 0) {
      setShareUrl(status.shareUrls[0])
    }

    return status
  }

  const connectToRoom = async (
    desiredRoomId: string,
    overrideServerUrl?: string,
  ) => {
    const resolvedRoomId = normalizeRoomId(desiredRoomId) || createRoomCode()
    const resolvedNickname =
      nickname.trim() || `Viewer-${Math.floor(Math.random() * 90 + 10)}`
    const resolvedServerUrl = normalizeServerUrl(overrideServerUrl ?? serverUrl)

    if (!resolvedServerUrl) {
      setErrorMessage('请先填房主的直连地址，或由房主先启动本机分享服务')
      return
    }

    setServerUrl(resolvedServerUrl)
    setRoomInput(resolvedRoomId)
    setNickname(resolvedNickname)
    setConnectionState('connecting')
    setErrorMessage(null)
    manualDisconnectRef.current = false

    socketRef.current?.removeAllListeners()
    socketRef.current?.disconnect()

    const nextSocket = io(resolvedServerUrl, {
      transports: ['websocket', 'polling'],
      autoConnect: false,
      reconnection: true,
      reconnectionDelayMax: 4000,
    })

    joinPayloadRef.current = {
      roomId: resolvedRoomId,
      nickname: resolvedNickname,
    }

    nextSocket.on('connect', () => {
      const payload = joinPayloadRef.current

      setSocketId(nextSocket.id ?? '')

      if (!payload) {
        return
      }

      nextSocket.emit('room:join', payload, (result: JoinRoomResult) => {
        if (!result.ok || !result.snapshot) {
          setErrorMessage(result.error ?? '加入房间失败')
          setConnectionState('idle')
          nextSocket.disconnect()
          return
        }

        handleSnapshot(result.snapshot)
        setConnectionState('connected')
        nextSocket.emit('playback:request-state', {
          roomId: result.snapshot.roomId,
        })
      })
    })

    nextSocket.on('connect_error', (error: Error) => {
      setErrorMessage(error.message || '无法连接房主设备')
      setConnectionState('idle')
    })

    nextSocket.on('reconnect_attempt', () => {
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

    socketRef.current = nextSocket
    nextSocket.connect()
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
    setUploadLabel('等待导入')
    setSelectedFileName('')
    socketRef.current?.removeAllListeners()
    socketRef.current?.disconnect()
    socketRef.current = null
  }

  const copyRoomCode = async () => {
    if (!room?.roomId) {
      return
    }

    try {
      await navigator.clipboard.writeText(room.roomId)
      setRoomCodeCopied(true)
      window.setTimeout(() => setRoomCodeCopied(false), 1600)
    } catch {
      setErrorMessage('复制房间号失败，请手动发送给对方')
    }
  }

  const copyInvite = async () => {
    if (!room?.roomId || !shareUrl) {
      setErrorMessage('请先启动本机分享服务并创建房间')
      return
    }

    const token = encodeInvite({
      roomId: room.roomId,
      serverUrl: shareUrl,
    })

    try {
      await navigator.clipboard.writeText(token)
      setInviteCopied(true)
      window.setTimeout(() => setInviteCopied(false), 1600)
    } catch {
      setErrorMessage('复制邀请失败，请手动复制分享地址和房间号')
    }
  }

  const applyInvite = () => {
    try {
      const payload = decodeInvite(inviteInput)
      setServerUrl(normalizeServerUrl(payload.serverUrl))
      setRoomInput(normalizeRoomId(payload.roomId))
      setErrorMessage(null)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '邀请解析失败')
    }
  }

  const uploadMedia = async (file: File) => {
    const socket = socketRef.current
    const currentRoom = roomRef.current

    if (!socket || !currentRoom) {
      setErrorMessage('请先连接房间，再导入视频')
      return
    }

    setSelectedFileName(file.name)
    setUploadStatus('reading')
    setUploadProgress(0)
    setUploadLabel('读取视频元信息')
    setErrorMessage(null)

    const duration = await readVideoDuration(file)
    const formData = new FormData()
    formData.append('video', file)

    if (duration !== null) {
      formData.append('duration', String(duration))
    }

    setUploadStatus('uploading')
    setUploadLabel('复制到房主本机直连服务')

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
          setUploadLabel('片源已挂载，另一端会直接从你机器拉流')
          resolve()
          return
        }

        let message = '导入失败'

        try {
          const payload = JSON.parse(request.responseText) as { error?: string }
          message = payload.error ?? message
        } catch {
          // ignore malformed payloads
        }

        reject(new Error(message))
      }

      request.onerror = () => {
        reject(new Error('导入中断，请检查本机直连服务'))
      }

      request.send(formData)
    }).catch((error: unknown) => {
      setUploadStatus('error')
      setUploadLabel('导入失败')
      setErrorMessage(error instanceof Error ? error.message : '导入失败')
    })
  }

  const hostAndCreateRoom = async () => {
    try {
      setRelayBusy(true)
      const relay = await ensureLocalRelay()
      await connectToRoom(createRoomCode(), relay.localUrl)
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : '启动本机分享服务失败',
      )
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
      await window.desktopApp.relay.stop()
      setRelayStatus(EMPTY_RELAY_STATUS)
      setShareUrl('')
      setServerUrl('')
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : '停止本机分享失败',
      )
    } finally {
      setRelayBusy(false)
    }
  }

  return (
    <div className="shell">
      <header className="hero">
        <div className="hero__copy">
          <p className="eyebrow">{getPlatformLabel()} · 局域网 / 蒲公英直连</p>
          <h1>房主本机直出，对端直接拉流。</h1>
          <p className="hero__lead">
            这版按同一局域网或虚拟局域网设计。房主设备本身就是分享节点，不经过第三方中转服务器；另一端直接连接房主的 VPN/LAN 地址观看同一部电影。
          </p>
        </div>

        <div className="hero__meta">
          <div className="hero-card">
            <span>支持平台</span>
            <strong>macOS / Windows</strong>
          </div>
          <div className="hero-card">
            <span>连接方式</span>
            <strong>P2P 局域网直连</strong>
          </div>
          <div className="hero-card">
            <span>同步模式</span>
            <strong>{syncModeLabel}</strong>
          </div>
        </div>
      </header>

      <main className="layout">
        <section className="panel panel--lobby">
          <div className="panel__header">
            <div>
              <p className="panel__eyebrow">Direct Link</p>
              <h2>直连配置</h2>
            </div>
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
              {connectionState === 'connected'
                ? '观影已连接'
                : connectionState === 'reconnecting'
                  ? '房间重连中'
                  : relayStatus.running
                    ? '本机分享中'
                    : '待启动'}
            </StatusPill>
          </div>

          <div className="panel-block">
            <div className="panel-block__title">
              <h3>房主模式</h3>
              <StatusPill tone={relayStatus.running ? 'success' : 'neutral'}>
                {relayStatus.running ? '已启动' : '未启动'}
              </StatusPill>
            </div>

            <div className="actions">
              <button
                className="button button--primary"
                onClick={() => void hostAndCreateRoom()}
                disabled={relayBusy}
              >
                {relayBusy ? '处理中...' : '启动本机分享并建房'}
              </button>
              <button
                className="button button--secondary"
                onClick={() => void stopHosting()}
                disabled={relayBusy || !relayStatus.running}
              >
                停止本机分享
              </button>
            </div>

            <div className="room-card">
              <div className="room-card__row">
                <span>本机连接地址</span>
                <strong>{relayStatus.localUrl ?? '未启动'}</strong>
              </div>
              <div className="room-card__row">
                <span>推荐分享地址</span>
                <strong>{shareUrl || '未检测到外部地址'}</strong>
              </div>
              {relayStatus.shareUrls.length > 1 ? (
                <p className="hint">
                  检测到多个网卡地址：{relayStatus.shareUrls.join(' / ')}
                </p>
              ) : null}
            </div>
          </div>

          <div className="panel-block">
            <div className="panel-block__title">
              <h3>加入模式</h3>
              <StatusPill tone="accent">对端直连</StatusPill>
            </div>

            <label className="field">
              <span>邀请串</span>
              <textarea
                className="field__textarea"
                value={inviteInput}
                onChange={(event) => setInviteInput(event.target.value)}
                placeholder="贴入房主复制给你的邀请串"
              />
            </label>

            <div className="actions actions--tight">
              <button className="button button--secondary" onClick={applyInvite}>
                解析邀请
              </button>
              <button
                className="button button--secondary"
                onClick={() => {
                  void navigator.clipboard.readText().then((text) => {
                    setInviteInput(text)
                  })
                }}
              >
                粘贴剪贴板
              </button>
            </div>
          </div>

          <label className="field">
            <span>房主地址</span>
            <input
              value={serverUrl}
              onChange={(event) => setServerUrl(event.target.value)}
              placeholder="例如 http://100.64.0.12:4000"
              disabled={connectionState === 'connecting'}
            />
          </label>

          <label className="field">
            <span>你的昵称</span>
            <input
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
              placeholder="Shawn"
              maxLength={24}
            />
          </label>

          <label className="field">
            <span>房间号</span>
            <input
              value={roomInput}
              onChange={(event) => setRoomInput(event.target.value.toUpperCase())}
              placeholder="6 位房间号"
              maxLength={8}
            />
          </label>

          <div className="actions">
            <button
              className="button button--primary"
              onClick={() => {
                void connectToRoom(roomInput)
              }}
            >
              连接房主
            </button>
            <button className="button button--ghost" onClick={disconnectFromRoom}>
              断开连接
            </button>
          </div>

          {room ? (
            <div className="room-card">
              <div className="room-card__row">
                <span>当前房间</span>
                <strong>{room.roomId}</strong>
              </div>
              <div className="room-card__row">
                <span>成员数</span>
                <strong>
                  {audienceCount}/{MAX_ROOM_MEMBERS}
                </strong>
              </div>
              <div className="room-card__row">
                <span>控制策略</span>
                <strong>{syncModeLabel}</strong>
              </div>

              <div className="actions actions--tight">
                <button
                  className="button button--secondary"
                  onClick={() => {
                    void copyRoomCode()
                  }}
                >
                  {roomCodeCopied ? '已复制房间号' : '复制房间号'}
                </button>
                <button
                  className="button button--secondary"
                  onClick={() => {
                    void copyInvite()
                  }}
                >
                  {inviteCopied ? '已复制邀请' : '复制邀请串'}
                </button>
              </div>
            </div>
          ) : (
            <p className="hint">
              推荐流程是：双方先用蒲公英等工具进入同一虚拟局域网；房主点击“启动本机分享并建房”，把邀请串发给另一方；另一方解析后直接连接。
            </p>
          )}

          {isHost ? (
            <div className="panel-block">
              <div className="panel-block__title">
                <h3>共享视频</h3>
                <StatusPill tone="accent">房主操作</StatusPill>
              </div>

              <label className="upload-dropzone">
                <input
                  type="file"
                  accept="video/*"
                  onChange={(event) => {
                    const nextFile = event.target.files?.[0]

                    if (!nextFile) {
                      return
                    }

                    void uploadMedia(nextFile)
                    event.target.value = ''
                  }}
                />
                <span>选择一部本地电影挂到你的分享节点</span>
                <strong>
                  {selectedFileName || '推荐在组网稳定后导入 mp4 / mkv / mov 文件'}
                </strong>
              </label>

              <div className="progress">
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
            </div>
          ) : null}

          <div className="panel-block">
            <div className="panel-block__title">
              <h3>成员状态</h3>
              <StatusPill tone="neutral">
                {room ? `${room.members.length} 在线` : '未入房'}
              </StatusPill>
            </div>

            <div className="member-list">
              {room?.members.length ? (
                room.members.map((member) => (
                  <article className="member-card" key={member.socketId}>
                    <div>
                      <strong>{member.nickname}</strong>
                      <p>{member.isHost ? '房主' : '观影方'}</p>
                    </div>
                    <div className="member-card__tags">
                      <StatusPill tone={member.buffering ? 'warning' : 'success'}>
                        {member.buffering ? '缓冲中' : '已就绪'}
                      </StatusPill>
                    </div>
                  </article>
                ))
              ) : (
                <p className="hint">还没有房间成员。</p>
              )}
            </div>
          </div>

          {room && isHost ? (
            <div className="panel-block">
              <div className="panel-block__title">
                <h3>同步策略</h3>
                <StatusPill tone="accent">{syncModeLabel}</StatusPill>
              </div>

              <div className="actions actions--tight">
                <button
                  className={`button ${
                    syncMode === 'soft' ? 'button--primary' : 'button--secondary'
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
                  className={`button ${
                    syncMode === 'strict'
                      ? 'button--primary'
                      : 'button--secondary'
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

              <p className="hint">
                柔性同步会让缓冲方自行追帧；严格同步会在任一方卡顿时暂停全房间，等双方都恢复后再一起继续。
              </p>
            </div>
          ) : null}

          {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}
        </section>

        <section className="panel panel--player">
          <div className="panel__header">
            <div>
              <p className="panel__eyebrow">Cinema</p>
              <h2>同步播放器</h2>
            </div>
            <div className="player-badges">
              <StatusPill tone={room?.media ? 'success' : 'neutral'}>
                {room?.media ? '片源已挂载' : '等待房主导入'}
              </StatusPill>
              <StatusPill tone={localBuffering ? 'warning' : 'accent'}>
                {localBuffering ? '本地缓冲中' : '直连链路稳定'}
              </StatusPill>
            </div>
          </div>

          <div className="player-frame">
            {mediaUrl ? (
              <video
                key={room?.media?.id ?? 'empty'}
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
              />
            ) : (
              <div className="video video--placeholder">
                <div>
                  <p>还没有共享视频</p>
                  <strong>房主导入后，另一端会直接从房主设备拉取同一份片源。</strong>
                </div>
              </div>
            )}

            {autoplayBlocked ? (
              <div className="player-overlay">
                <strong>系统拦截了自动播放</strong>
                <p>点一下播放器的播放键，之后同步控制会继续生效。</p>
              </div>
            ) : null}
          </div>

          <div className="media-meta">
            <article className="meta-card">
              <span>当前片源</span>
              <strong>{room?.media?.name ?? '未导入'}</strong>
              <p>
                {room?.media
                  ? `${formatBytes(room.media.size)} · ${formatDuration(
                      room.media.duration ?? 0,
                    )}`
                  : '等待房主挂载本地视频'}
              </p>
            </article>
            <article className="meta-card">
              <span>目标进度</span>
              <strong>{formatDuration(playbackPosition)}</strong>
              <p>
                {playback?.playbackState.paused
                  ? '当前为暂停态'
                  : '正在按房主时间轴推进'}
              </p>
            </article>
            <article className="meta-card">
              <span>直连信息</span>
              <strong>{shareUrl || serverUrl || '待连接'}</strong>
              <p>
                {isHost
                  ? '对端会直接连接你的设备'
                  : '当前直接连接房主设备，不经过第三方中转'}
              </p>
            </article>
          </div>
        </section>
      </main>
    </div>
  )
}

export default App
