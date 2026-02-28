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

const DEFAULT_SERVER_URL =
  import.meta.env.VITE_SERVER_URL?.trim() || 'http://localhost:4000'

function normalizeServerUrl(input: string) {
  const trimmed = input.trim()

  if (!trimmed) {
    return DEFAULT_SERVER_URL
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
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL)
  const [nickname, setNickname] = useState('')
  const [roomInput, setRoomInput] = useState(createRoomCode())
  const [socketId, setSocketId] = useState('')
  const [connectionState, setConnectionState] =
    useState<ConnectionState>('idle')
  const [room, setRoom] = useState<RoomSnapshot | null>(null)
  const [playback, setPlayback] = useState<PlaybackEnvelope | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [localBuffering, setLocalBuffering] = useState(false)
  const [autoplayBlocked, setAutoplayBlocked] = useState(false)
  const [roomCodeCopied, setRoomCodeCopied] = useState(false)
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>('idle')
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploadLabel, setUploadLabel] = useState('等待上传')
  const [selectedFileName, setSelectedFileName] = useState('')

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
    room?.media && room.roomId
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

  const connectToRoom = async (desiredRoomId: string) => {
    const resolvedRoomId = normalizeRoomId(desiredRoomId) || createRoomCode()
    const resolvedNickname =
      nickname.trim() || `Viewer-${Math.floor(Math.random() * 90 + 10)}`
    const resolvedServerUrl = normalizeServerUrl(serverUrl)

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
      setErrorMessage(error.message || '连接服务器失败')
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
    setUploadLabel('等待上传')
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
    setUploadLabel('上传到共享媒体服务')

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
          setUploadLabel('视频已就绪，双方可直接同看')
          resolve()
          return
        }

        let message = '上传失败'

        try {
          const payload = JSON.parse(request.responseText) as { error?: string }
          message = payload.error ?? message
        } catch {
          // ignore malformed payloads
        }

        reject(new Error(message))
      }

      request.onerror = () => {
        reject(new Error('上传中断，请检查网络后重试'))
      }

      request.send(formData)
    }).catch((error: unknown) => {
      setUploadStatus('error')
      setUploadLabel('上传失败')
      setErrorMessage(error instanceof Error ? error.message : '上传失败')
    })
  }

  return (
    <div className="shell">
      <header className="hero">
        <div className="hero__copy">
          <p className="eyebrow">{getPlatformLabel()} · 双端异地同看</p>
          <h1>同一份视频源，同一条进度线。</h1>
          <p className="hero__lead">
            房主导入本地电影后，媒体会上传到共享服务，双方从同一份文件流式播放。播放、暂停、拖动和缓冲状态都会同步。
          </p>
        </div>

        <div className="hero__meta">
          <div className="hero-card">
            <span>支持平台</span>
            <strong>macOS / Windows</strong>
          </div>
          <div className="hero-card">
            <span>房间容量</span>
            <strong>{MAX_ROOM_MEMBERS} 人</strong>
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
              <p className="panel__eyebrow">Room</p>
              <h2>连接配置</h2>
            </div>
            <StatusPill
              tone={
                connectionState === 'connected'
                  ? 'success'
                  : connectionState === 'reconnecting'
                    ? 'warning'
                    : 'neutral'
              }
            >
              {connectionState === 'connected'
                ? '已连接'
                : connectionState === 'reconnecting'
                  ? '重连中'
                  : connectionState === 'connecting'
                    ? '连接中'
                    : '未连接'}
            </StatusPill>
          </div>

          <label className="field">
            <span>同步服务器</span>
            <input
              value={serverUrl}
              onChange={(event) => setServerUrl(event.target.value)}
              placeholder="http://localhost:4000"
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
                void connectToRoom(createRoomCode())
              }}
            >
              新建房间
            </button>
            <button
              className="button button--secondary"
              onClick={() => {
                void connectToRoom(roomInput)
              }}
            >
              加入房间
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
                  className="button button--ghost"
                  onClick={disconnectFromRoom}
                >
                  断开连接
                </button>
              </div>
            </div>
          ) : (
            <p className="hint">
              双方先连到同一个同步服务器，再通过房间号碰头。房主随后导入本地视频，另一端会自动拿到同一份播放源。
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
                <span>选择一部本地电影导入房间</span>
                <strong>
                  {selectedFileName || '支持 mp4 / mkv / mov 等常见视频格式'}
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
                {room?.media ? '视频已加载' : '等待房主导入'}
              </StatusPill>
              <StatusPill tone={localBuffering ? 'warning' : 'accent'}>
                {localBuffering ? '本地缓冲中' : '播放链路稳定'}
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
                  <strong>
                    房主上传后，双方都会从同一份源文件开始播放。
                  </strong>
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
              <strong>{room?.media?.name ?? '未上传'}</strong>
              <p>
                {room?.media
                  ? `${formatBytes(room.media.size)} · ${formatDuration(
                      room.media.duration ?? 0,
                    )}`
                  : '等待房主导入本地视频'}
              </p>
            </article>
            <article className="meta-card">
              <span>目标进度</span>
              <strong>{formatDuration(playbackPosition)}</strong>
              <p>
                {playback?.playbackState.paused
                  ? '当前为暂停态'
                  : '正在按服务端时间轴推进'}
              </p>
            </article>
            <article className="meta-card">
              <span>网络策略</span>
              <strong>{syncModeLabel}</strong>
              <p>
                {syncMode === 'strict'
                  ? '任一端卡顿会暂停全员'
                  : '卡顿端恢复后自动追平时间轴'}
              </p>
            </article>
          </div>
        </section>
      </main>
    </div>
  )
}

export default App
