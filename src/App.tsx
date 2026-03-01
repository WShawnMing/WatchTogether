import {
  startTransition,
  type CSSProperties,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import ASSRenderer from 'assjs'
import Plyr from 'plyr'
import { io, type Socket } from 'socket.io-client'
import 'plyr/dist/plyr.css'
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
  type MediaDescriptor,
  type PlaybackEnvelope,
  type PlaybackReason,
  type RoomSnapshot,
} from '../shared/protocol'

type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting'
type UploadStatus = 'idle' | 'reading' | 'uploading' | 'done' | 'error'
type SubtitleStatus = 'idle' | 'uploading' | 'done' | 'error'

interface LocalFileWithPath extends File {
  path?: string
}

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

interface PresenceToast {
  id: string
  title: string
  detail: string
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
const SUBTITLE_ACCEPT = '.srt,.vtt,.ass,.ssa'

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

function formatPresenceSummary(names: string[], verb: '加入' | '离开') {
  if (names.length === 0) {
    return ''
  }

  if (names.length === 1) {
    return `${names[0]} ${verb}了房间`
  }

  if (names.length === 2) {
    return `${names[0]} 和 ${names[1]} ${verb}了房间`
  }

  return `${names[0]}、${names[1]} 等 ${names.length} 人${verb}了房间`
}

function isTextEntryTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false
  }

  if (target.isContentEditable) {
    return true
  }

  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
    return true
  }

  if (target instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'file', 'radio', 'range', 'reset', 'submit'].includes(
      target.type.toLowerCase(),
    )
  }

  return false
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

async function hashFileSha256(file: LocalFileWithPath) {
  if (file.path && window.desktopApp?.files) {
    const result = await window.desktopApp.files.hashSha256(file.path)
    return result.sha256
  }

  const buffer = await file.arrayBuffer()
  const digest = await window.crypto.subtle.digest('SHA-256', buffer)

  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
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
    return '房主先选择本地片源，其他成员选择相同文件后即可只同步进度，不再传视频。'
  }

  const extension = mediaName.split('.').pop()?.toLowerCase() ?? ''

  if (['mkv', 'avi', 'wmv'].includes(extension)) {
    return '当前房间只同步进度。若本地无法播放，通常是编码不被内置播放器支持，建议优先使用 H.264/AAC。'
  }

  return '所有成员选择相同本地文件后，只同步时间轴和播放控制。'
}

function getBufferedAheadSeconds(video: HTMLVideoElement) {
  const currentTime = video.currentTime

  for (let index = 0; index < video.buffered.length; index += 1) {
    const start = video.buffered.start(index)
    const end = video.buffered.end(index)

    if (currentTime >= start && currentTime <= end) {
      return Math.max(0, end - currentTime)
    }

    if (currentTime < start) {
      return Math.max(0, end - start)
    }
  }

  return 0
}

function isVideoFullyBuffered(video: HTMLVideoElement, duration: number | null) {
  if (!duration || !Number.isFinite(duration) || duration <= 0) {
    return false
  }

  for (let index = 0; index < video.buffered.length; index += 1) {
    const start = video.buffered.start(index)
    const end = video.buffered.end(index)

    if (video.currentTime >= start && video.currentTime <= end) {
      return end >= duration - 0.25
    }
  }

  return false
}

function getMediaBitrateMbps(size: number, duration: number | null) {
  if (!duration || !Number.isFinite(duration) || duration <= 0) {
    return null
  }

  return (size * 8) / duration / 1_000_000
}

function getPreparationLabel(
  room: RoomSnapshot | null,
  localBuffering: boolean,
  currentMember: RoomSnapshot['members'][number] | null,
) {
  if (!room?.media) {
    return '等待片源'
  }

  if (currentMember?.mediaMatchState === 'missing') {
    return currentMember.isHost ? '等待选片' : '等待匹配'
  }

  if (currentMember?.mediaMatchState === 'mismatch') {
    return '文件不一致'
  }

  if (localBuffering) {
    return '本地缓冲中'
  }

  if (room.isPreparing) {
    if (room.members.every((member) => member.startupReady)) {
      return '已准备，等待开播'
    }

    return '准备中'
  }

  return '片源已就绪'
}

function getMemberStatusLabel(room: RoomSnapshot | null, member: RoomSnapshot['members'][number]) {
  if (member.mediaMatchState === 'missing') {
    return member.isHost ? '待选片' : '待匹配'
  }

  if (member.mediaMatchState === 'mismatch') {
    return '不一致'
  }

  if (member.buffering) {
    return '缓冲中'
  }

  if (room?.isPreparing && !member.startupReady) {
    return `准备 ${Math.max(0, Math.round(member.bufferAheadSeconds))}s`
  }

  return '已就绪'
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
  const [discoveryRefreshing, setDiscoveryRefreshing] = useState(false)
  const [connectionState, setConnectionState] =
    useState<ConnectionState>('idle')
  const [room, setRoom] = useState<RoomSnapshot | null>(null)
  const [playback, setPlayback] = useState<PlaybackEnvelope | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [localBuffering, setLocalBuffering] = useState(false)
  const [autoplayBlocked, setAutoplayBlocked] = useState(false)
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>('idle')
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploadLabel, setUploadLabel] = useState('还没有选择本地片源')
  const [selectedFileName, setSelectedFileName] = useState('')
  const [localMediaDescriptor, setLocalMediaDescriptor] = useState<MediaDescriptor | null>(null)
  const [localMediaUrl, setLocalMediaUrl] = useState<string | null>(null)
  const [subtitleStatus, setSubtitleStatus] =
    useState<SubtitleStatus>('idle')
  const [subtitleLabel, setSubtitleLabel] = useState('还没有字幕')
  const [selectedSubtitleName, setSelectedSubtitleName] = useState('')
  const [relayBusy, setRelayBusy] = useState(false)
  const [joiningRoomId, setJoiningRoomId] = useState<string | null>(null)
  const [subtitleScale, setSubtitleScale] = useState(1)
  const [subtitleOffsetY, setSubtitleOffsetY] = useState(0)
  const [subtitlePanelOpen, setSubtitlePanelOpen] = useState(false)
  const [presenceToasts, setPresenceToasts] = useState<PresenceToast[]>([])
  const [hostedRoomId, setHostedRoomId] = useState<string | null>(null)
  const [bufferTelemetry, setBufferTelemetry] = useState<{
    estimatedMbps: number | null
    realtimeRatio: number | null
    mediaBitrateMbps: number | null
    etaSeconds: number | null
    fullyBuffered: boolean
  }>({
    estimatedMbps: null,
    realtimeRatio: null,
    mediaBitrateMbps: null,
    etaSeconds: null,
    fullyBuffered: false,
  })

  const plyrRef = useRef<Plyr | null>(null)
  const socketRef = useRef<Socket | null>(null)
  const roomRef = useRef<RoomSnapshot | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const playerFrameRef = useRef<HTMLDivElement | null>(null)
  const subtitleMenuRef = useRef<HTMLDivElement | null>(null)
  const subtitleLayerRef = useRef<HTMLDivElement | null>(null)
  const assRendererRef = useRef<ASSRenderer | null>(null)
  const localMediaUrlRef = useRef<string | null>(null)
  const joinPayloadRef = useRef<JoinRoomPayload | null>(null)
  const pendingPlaybackRef = useRef<PlaybackEnvelope | null>(null)
  const playbackRef = useRef<PlaybackEnvelope | null>(null)
  const suppressEventsRef = useRef(false)
  const suppressTimeoutRef = useRef<number | null>(null)
  const localBufferingRef = useRef(false)
  const localUserActionUntilRef = useRef(0)
  const localSeekingRef = useRef(false)
  const manualDisconnectRef = useRef(false)
  const lastRoomSnapshotAtRef = useRef(0)
  const lastPlaybackStateAtRef = useRef(0)
  const canPlayThroughRef = useRef(false)
  const lastPublishedBufferStateRef = useRef('')
  const toastTimersRef = useRef<Map<string, number>>(new Map())
  const memberPresencePrimedRef = useRef(false)
  const lastBufferSampleRef = useRef<{
    at: number
    currentTime: number
    bufferAhead: number
  } | null>(null)

  const currentMember =
    room?.members.find((member) => member.socketId === socketId) ?? null
  const hostMember = room?.members.find((member) => member.isHost) ?? null
  const isHost =
    Boolean(currentMember?.isHost) ||
    Boolean(room?.roomId && hostedRoomId && room.roomId === hostedRoomId)
  const localMediaMatchesRoom =
    Boolean(room?.media && localMediaDescriptor && room.media.sha256 === localMediaDescriptor.sha256)
  const mediaUrl = room?.media && localMediaMatchesRoom ? localMediaUrl : null
  const subtitleUrl =
    room?.subtitle && room.roomId && serverUrl
      ? buildSubtitleUrl(serverUrl, room.roomId, room.subtitle.id)
      : null
  const subtitleFormat = room?.subtitle?.format ?? null
  const audienceCount = room?.members.length ?? 0
  const playbackPosition = playback
    ? deriveCurrentPosition(playback.playbackState, playback.serverTime)
    : 0
  const connectionLabel = getConnectionLabel(
    connectionState,
    relayStatus.running,
  )
  const videoKey = `${room?.media?.id ?? 'empty'}:${localMediaDescriptor?.sha256 ?? 'nomatch'}:${room?.subtitle?.id ?? 'nosub'}`
  const isMediaUploading = uploadStatus === 'reading' || uploadStatus === 'uploading'
  const isSubtitleUploading = subtitleStatus === 'uploading'
  const bufferTelemetryLabel =
    room?.media && !localMediaMatchesRoom
      ? '等待本地匹配'
      : bufferTelemetry.fullyBuffered
        ? '已缓存完成'
        : bufferTelemetry.estimatedMbps !== null && bufferTelemetry.realtimeRatio !== null
          ? `缓存 ${bufferTelemetry.estimatedMbps.toFixed(2)} Mbps · ${bufferTelemetry.realtimeRatio.toFixed(2)}x`
          : '缓存速率观测中'
  const mediaButtonLabel = isMediaUploading
    ? '校验片源中...'
    : uploadStatus === 'done'
      ? isHost
        ? '片源已发布'
        : '已匹配片源'
      : uploadStatus === 'error'
        ? '重试选择片源'
        : isHost
          ? '选择本地影片'
          : '匹配本地影片'
  const subtitleButtonLabel = isSubtitleUploading
    ? '上传字幕中...'
    : subtitleStatus === 'done'
      ? '字幕已更新'
      : subtitleStatus === 'error'
        ? '重试字幕上传'
        : '上传字幕'
  const mediaButtonMeta =
    selectedFileName ||
    room?.media?.name ||
    (isHost ? '选择要分享的本地文件' : '选择与你朋友相同的本地文件')
  const subtitleButtonMeta =
    selectedSubtitleName || room?.subtitle?.name || '.srt / .vtt / .ass'

  useEffect(() => {
    roomRef.current = room
  }, [room])

  useEffect(() => {
    playbackRef.current = playback
  }, [playback])

  useEffect(() => {
    const savedNickname = window.localStorage.getItem('watchtogether:nickname')
    const savedSubtitleScale = Number(
      window.localStorage.getItem('watchtogether:subtitle-scale') ?? '1',
    )
    const savedSubtitleOffset = Number(
      window.localStorage.getItem('watchtogether:subtitle-offset-y') ?? '0',
    )

    if (savedNickname) {
      setNickname(savedNickname)
    }

    if (Number.isFinite(savedSubtitleScale) && savedSubtitleScale >= 0.7 && savedSubtitleScale <= 1.6) {
      setSubtitleScale(savedSubtitleScale)
    }

    if (Number.isFinite(savedSubtitleOffset) && savedSubtitleOffset >= -120 && savedSubtitleOffset <= 120) {
      setSubtitleOffsetY(savedSubtitleOffset)
    }
  }, [])

  useEffect(() => {
    if (nickname.trim()) {
      window.localStorage.setItem('watchtogether:nickname', nickname.trim())
    }
  }, [nickname])

  useEffect(() => {
    window.localStorage.setItem(
      'watchtogether:subtitle-scale',
      subtitleScale.toFixed(2),
    )
  }, [subtitleScale])

  useEffect(() => {
    window.localStorage.setItem(
      'watchtogether:subtitle-offset-y',
      String(Math.round(subtitleOffsetY)),
    )
  }, [subtitleOffsetY])

  useEffect(() => {
    return () => {
      if (localMediaUrlRef.current) {
        URL.revokeObjectURL(localMediaUrlRef.current)
      }
    }
  }, [])

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

  const refreshDiscoveredSessions = useCallback(
    async (showBusy = false, force = false) => {
      if (!window.desktopApp?.discovery) {
        return
      }

      if (showBusy) {
        setDiscoveryRefreshing(true)
      }

      try {
        const sessions = await window.desktopApp.discovery.list({ force })

        startTransition(() => {
          setDiscoveredSessions(sessions)
        })

        if (force) {
          window.setTimeout(() => {
            void window.desktopApp?.discovery
              ?.list()
              .then((nextSessions) => {
                startTransition(() => {
                  setDiscoveredSessions(nextSessions)
                })
              })
              .catch(() => {
                // Keep discovery best-effort.
              })
          }, 900)
        }
      } catch {
        setDiscoveredSessions([])
      } finally {
        if (showBusy) {
          setDiscoveryRefreshing(false)
        }
      }
    },
    [],
  )

  useEffect(() => {
    if (!window.desktopApp?.discovery) {
      return
    }

    let disposed = false

    const refresh = async () => {
      await refreshDiscoveredSessions()
    }

    void refresh()

    const interval = window.setInterval(() => {
      if (!disposed) {
        void refresh()
      }
    }, 2_000)

    return () => {
      disposed = true
      window.clearInterval(interval)
    }
  }, [refreshDiscoveredSessions])

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

      if (
        socketId &&
        incoming.playbackState.reason === 'user' &&
        incoming.playbackState.updatedBy === socketId &&
        Date.now() < localUserActionUntilRef.current
      ) {
        return
      }

      if (localSeekingRef.current) {
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
    [socketId, suppressLocalPlaybackEvents],
  )

  useEffect(() => {
    if (playback && room?.media) {
      applyRemotePlayback(playback)
    }
  }, [applyRemotePlayback, playback, room?.media])

  useEffect(() => {
    if (currentMember?.isHost && room?.roomId) {
      setHostedRoomId((current) => current ?? room.roomId)
    }
  }, [currentMember?.isHost, room?.roomId])

  useEffect(() => {
    if (!room?.subtitle || subtitleFormat !== 'ass') {
      setSubtitlePanelOpen(false)
    }
  }, [room?.subtitle, subtitleFormat])

  useEffect(() => {
    if (!subtitlePanelOpen) {
      return
    }

    const handlePointerDown = (event: PointerEvent) => {
      const menu = subtitleMenuRef.current

      if (menu && event.target instanceof Node && !menu.contains(event.target)) {
        setSubtitlePanelOpen(false)
      }
    }

    window.addEventListener('pointerdown', handlePointerDown)

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [subtitlePanelOpen])

  useEffect(() => {
    const video = videoRef.current

    plyrRef.current?.destroy()
    plyrRef.current = null

    if (!video || !mediaUrl) {
      return
    }

    const player = new Plyr(video, {
      controls: [
        'play-large',
        'play',
        'progress',
        'current-time',
        'duration',
        'mute',
        'volume',
        'captions',
        'settings',
        'fullscreen',
      ],
      settings: subtitleFormat === 'vtt' ? ['captions', 'speed'] : ['speed'],
      captions: {
        active: subtitleFormat === 'vtt',
        language: room?.subtitle?.language ?? 'auto',
        update: true,
      },
      clickToPlay: true,
      disableContextMenu: true,
      displayDuration: true,
      fullscreen: {
        enabled: true,
        fallback: true,
        iosNative: false,
        container: '.player-frame',
      },
      hideControls: true,
      keyboard: {
        focused: true,
        global: true,
      },
      muted: false,
      volume: 1,
      storage: {
        enabled: false,
      },
      seekTime: 5,
      tooltips: {
        controls: true,
        seek: true,
      },
    })

    plyrRef.current = player
    player.muted = false
    video.muted = false
    video.volume = Math.max(video.volume, 0.8)

    return () => {
      player.destroy()

      if (plyrRef.current === player) {
        plyrRef.current = null
      }
    }
  }, [mediaUrl, room?.subtitle?.language, subtitleFormat, videoKey])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const player = plyrRef.current
      const target = event.target instanceof HTMLElement ? event.target : null

      if (!player || !mediaUrl || event.metaKey || event.ctrlKey || event.altKey) {
        return
      }

      if (target?.closest('.subtitle-popover')) {
        return
      }

      if (isTextEntryTarget(target)) {
        return
      }

      switch (event.key.toLowerCase()) {
        case ' ':
        case 'k':
          event.preventDefault()
          void player.togglePlay()
          break
        case 'j':
          event.preventDefault()
          player.rewind(10)
          break
        case 'l':
          event.preventDefault()
          player.forward(10)
          break
        case 'arrowleft':
          event.preventDefault()
          player.rewind(5)
          break
        case 'arrowright':
          event.preventDefault()
          player.forward(5)
          break
        case 'arrowup':
          event.preventDefault()
          player.increaseVolume(0.1)
          break
        case 'arrowdown':
          event.preventDefault()
          player.decreaseVolume(0.1)
          break
        case 'm':
          event.preventDefault()
          player.muted = !player.muted
          break
        case 'f':
          event.preventDefault()
          player.fullscreen.toggle()
          break
        default:
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [mediaUrl])

  useEffect(() => {
    assRendererRef.current?.destroy()
    assRendererRef.current = null

    const subtitleLayer = subtitleLayerRef.current

    if (subtitleLayer) {
      subtitleLayer.replaceChildren()
    }

    if (
      !subtitleUrl ||
      subtitleFormat !== 'ass' ||
      !videoRef.current ||
      !subtitleLayer
    ) {
      return
    }

    let cancelled = false

    const attachAssSubtitle = async () => {
      try {
        const response = await fetch(subtitleUrl)

        if (!response.ok) {
          throw new Error('字幕文件加载失败')
        }

        const content = await response.text()

        if (cancelled || !videoRef.current || !subtitleLayerRef.current) {
          return
        }

        const renderer = new ASSRenderer(content, videoRef.current, {
          container: subtitleLayerRef.current,
          resampling: 'video_height',
        })

        assRendererRef.current = renderer
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(
            error instanceof Error ? error.message : 'ASS 字幕渲染失败',
          )
        }
      }
    }

    void attachAssSubtitle()

    return () => {
      cancelled = true
      assRendererRef.current?.destroy()
      assRendererRef.current = null

      subtitleLayer.replaceChildren()
    }
  }, [subtitleFormat, subtitleUrl, videoKey])

  useEffect(() => {
    const toastTimers = toastTimersRef.current

    return () => {
      if (suppressTimeoutRef.current !== null) {
        window.clearTimeout(suppressTimeoutRef.current)
      }

      for (const timer of toastTimers.values()) {
        window.clearTimeout(timer)
      }

      toastTimers.clear()

      plyrRef.current?.destroy()
      assRendererRef.current?.destroy()
      void window.desktopApp?.discovery?.advertise(null)
      socketRef.current?.disconnect()
    }
  }, [])

  const handleSnapshot = (snapshot: RoomSnapshot) => {
    lastRoomSnapshotAtRef.current = Date.now()
    const previousRoom = roomRef.current
    const previousPlayback = playbackRef.current
    const previousMediaId = roomRef.current?.media?.id ?? null
    const nextMediaId = snapshot.media?.id ?? null
    const nextSelfMember =
      snapshot.members.find((member) => member.socketId === socketId) ?? null
    const selfIsHost =
      Boolean(nextSelfMember?.isHost) ||
      Boolean(snapshot.roomId && hostedRoomId && snapshot.roomId === hostedRoomId)

    if (previousMediaId !== nextMediaId) {
      setAutoplayBlocked(false)
      setLocalBuffering(false)
      localBufferingRef.current = false
      pendingPlaybackRef.current = null
      localUserActionUntilRef.current = 0
      canPlayThroughRef.current = false
      lastPublishedBufferStateRef.current = ''
    }

    if (
      memberPresencePrimedRef.current &&
      previousRoom?.roomId === snapshot.roomId
    ) {
      const previousMembers = new Map(
        previousRoom.members.map((member) => [member.socketId, member]),
      )
      const currentMembers = new Map(
        snapshot.members.map((member) => [member.socketId, member]),
      )
      const joinedMembers = snapshot.members
        .filter((member) => !previousMembers.has(member.socketId))
        .filter((member) => member.socketId !== socketId)
      const leftMembers = previousRoom.members
        .filter((member) => !currentMembers.has(member.socketId))
        .filter((member) => member.socketId !== socketId)

      if (joinedMembers.length > 0) {
        const toastId = `${Date.now()}-join-${joinedMembers.map((member) => member.socketId).join('-')}`
        const timer = window.setTimeout(() => {
          setPresenceToasts((current) => current.filter((item) => item.id !== toastId))
          toastTimersRef.current.delete(toastId)
        }, 2600)

        toastTimersRef.current.set(toastId, timer)
        setPresenceToasts((current) => [
          ...current.slice(-2),
          {
            id: toastId,
            title: formatPresenceSummary(
              joinedMembers.map((member) => member.nickname),
              '加入',
            ),
            detail: '已加入当前放映室',
          },
        ])
      }

      if (leftMembers.length > 0) {
        const toastId = `${Date.now()}-leave-${leftMembers.map((member) => member.socketId).join('-')}`
        const timer = window.setTimeout(() => {
          setPresenceToasts((current) => current.filter((item) => item.id !== toastId))
          toastTimersRef.current.delete(toastId)
        }, 2600)

        toastTimersRef.current.set(toastId, timer)
        setPresenceToasts((current) => [
          ...current.slice(-2),
          {
            id: toastId,
            title: formatPresenceSummary(
              leftMembers.map((member) => member.nickname),
              '离开',
            ),
            detail: '已离开当前放映室',
          },
        ])
      }
    }

    roomRef.current = snapshot
    memberPresencePrimedRef.current = true
    const nextPlayback = roomSnapshotToPlayback(snapshot)
    const shouldAdoptSnapshotPlayback =
      !previousPlayback ||
      nextPlayback.playbackState.updatedAt >= previousPlayback.playbackState.updatedAt

    startTransition(() => {
      setRoom(snapshot)

      if (shouldAdoptSnapshotPlayback) {
        setPlayback(nextPlayback)
      }
    })

    if (shouldAdoptSnapshotPlayback) {
      playbackRef.current = nextPlayback
    }

    if (snapshot.subtitle) {
      setSelectedSubtitleName(snapshot.subtitle.name)
      setSubtitleLabel('字幕已同步给所有人')
    } else {
      setSelectedSubtitleName('')
      setSubtitleLabel('还没有字幕')
    }

    if (!snapshot.media) {
      setUploadStatus('idle')
      setUploadProgress(0)
      setUploadLabel(selfIsHost ? '请先选择本地片源' : '等待房主选择本地片源')
    } else if (localMediaDescriptor?.sha256 === snapshot.media.sha256) {
      setUploadStatus('done')
      setUploadProgress(100)
      setUploadLabel(
        selfIsHost ? '片源指纹已发布，等待成员匹配' : '本地片源已匹配，可参与同步播放',
      )
    } else if (nextSelfMember?.mediaMatchState === 'mismatch') {
      setUploadStatus('error')
      setUploadProgress(100)
      setUploadLabel('本地文件与房主片源不一致')
    } else if (nextSelfMember?.mediaMatchState === 'missing') {
      setUploadStatus('idle')
      setUploadProgress(0)
      setUploadLabel(
        selfIsHost ? '请先选择本地片源' : '请选择与你朋友相同的本地文件',
      )
    }

    setErrorMessage(null)
  }

  const handlePlayback = (incoming: PlaybackEnvelope) => {
    lastPlaybackStateAtRef.current = Date.now()
    playbackRef.current = incoming
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

    if (reason === 'user') {
      localUserActionUntilRef.current = Date.now() + 1_500
    }

    const mediaDuration = currentRoom.media?.duration ?? null

    if (
      !video.paused &&
      mediaDuration &&
      Number.isFinite(mediaDuration) &&
      video.currentTime >= mediaDuration - 0.12
    ) {
      video.currentTime = 0
    }

    socket.emit('playback:control', {
      roomId: currentRoom.roomId,
      position: video.currentTime,
      paused: video.paused,
      playbackRate: video.playbackRate,
      reason,
    })
  }

  const publishBufferState = (buffering: boolean, force = false) => {
    const socket = socketRef.current
    const currentRoom = roomRef.current
    const video = videoRef.current

    if (!socket || !currentRoom || !video) {
      return
    }

    const bufferAheadSeconds = Number(getBufferedAheadSeconds(video).toFixed(1))
    const readyState = video.readyState
    const canPlayThrough =
      canPlayThroughRef.current || readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA

    localBufferingRef.current = buffering
    setLocalBuffering(buffering)

    const payload = {
      roomId: currentRoom.roomId,
      buffering,
      startupReady:
        canPlayThrough ||
        (readyState >= HTMLMediaElement.HAVE_FUTURE_DATA &&
          bufferAheadSeconds >= (currentRoom.startupBufferTargetSeconds || 12)),
      bufferAheadSeconds,
      readyState,
      canPlayThrough,
    }
    const signature = JSON.stringify(payload)

    if (!force && signature === lastPublishedBufferStateRef.current) {
      return
    }

    lastPublishedBufferStateRef.current = signature
    socket.emit('client:buffering', payload)
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

  const requestFreshRoomSnapshot = () => {
    const socket = socketRef.current
    const currentRoom = roomRef.current

    if (!socket || !currentRoom) {
      return
    }

    socket.emit('room:request-snapshot', {
      roomId: currentRoom.roomId,
    })
  }

  useEffect(() => {
    if (!room?.media || !socketId) {
      return
    }

    const publishStatus = () => {
      const video = videoRef.current

      if (!video) {
        return
      }

      const buffering =
        localBufferingRef.current ||
        (!video.paused && video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA)

      publishBufferState(buffering)
    }

    publishStatus()

    const interval = window.setInterval(publishStatus, 1_000)

    return () => {
      window.clearInterval(interval)
    }
  }, [room?.media, room?.media?.id, room?.startupBufferTargetSeconds, socketId])

  useEffect(() => {
    const activeMedia = room?.media ?? null
    lastBufferSampleRef.current = null
    setBufferTelemetry({
      estimatedMbps: null,
      realtimeRatio: null,
      mediaBitrateMbps: activeMedia
        ? getMediaBitrateMbps(activeMedia.size, activeMedia.duration)
        : null,
      etaSeconds: null,
      fullyBuffered: false,
    })
  }, [room?.media])

  useEffect(() => {
    if (!room?.media) {
      return
    }

    const mediaBitrateMbps = getMediaBitrateMbps(
      room.media.size,
      room.media.duration,
    )

    const sample = () => {
      const video = videoRef.current

      if (!video || !mediaBitrateMbps) {
        return
      }

      const now = Date.now()
      const bufferAhead = getBufferedAheadSeconds(video)
      const currentTime = video.currentTime
      const fullyBuffered = isVideoFullyBuffered(video, room.media?.duration ?? null)
      const previous = lastBufferSampleRef.current

      lastBufferSampleRef.current = {
        at: now,
        currentTime,
        bufferAhead,
      }

      if (!previous) {
        setBufferTelemetry((current) => ({
          ...current,
          mediaBitrateMbps,
          fullyBuffered,
          etaSeconds: fullyBuffered
            ? 0
            : current.etaSeconds,
        }))
        return
      }

      const wallDeltaSeconds = (now - previous.at) / 1_000

      if (wallDeltaSeconds < 0.4) {
        return
      }

      const playedDelta = Math.max(0, currentTime - previous.currentTime)
      const bufferGrowthSeconds = bufferAhead - previous.bufferAhead
      const downloadedMediaSeconds = Math.max(
        0,
        bufferGrowthSeconds + playedDelta,
      )
      const realtimeRatio = downloadedMediaSeconds / wallDeltaSeconds
      const estimatedMbps = mediaBitrateMbps * realtimeRatio
      const remainingDuration = Math.max(
        0,
        (room.media?.duration ?? 0) - currentTime - bufferAhead,
      )
      const etaSeconds =
        fullyBuffered || realtimeRatio <= 0.01
          ? fullyBuffered
            ? 0
            : null
          : remainingDuration / realtimeRatio

      setBufferTelemetry((current) => ({
        estimatedMbps:
          current.estimatedMbps === null
            ? estimatedMbps
            : current.estimatedMbps * 0.55 + estimatedMbps * 0.45,
        realtimeRatio:
          current.realtimeRatio === null
            ? realtimeRatio
            : current.realtimeRatio * 0.55 + realtimeRatio * 0.45,
        mediaBitrateMbps,
        etaSeconds,
        fullyBuffered,
      }))
    }

    sample()

    const interval = window.setInterval(sample, 1_000)

    return () => {
      window.clearInterval(interval)
    }
  }, [room?.media])

  useEffect(() => {
    if (connectionState !== 'connected' || !room) {
      return
    }

    const heartbeatIntervalMs = 4_000
    const staleThresholdMs = 12_000

    const tick = () => {
      const socket = socketRef.current

      if (!socket?.connected || !roomRef.current) {
        return
      }

      requestFreshRoomSnapshot()
      requestFreshPlaybackState()

      const latestActivityAt = Math.max(
        lastRoomSnapshotAtRef.current,
        lastPlaybackStateAtRef.current,
      )

      if (
        latestActivityAt > 0 &&
        Date.now() - latestActivityAt > staleThresholdMs
      ) {
        setErrorMessage('房间状态校验超时，正在尝试重新同步...')
      }
    }

    tick()

    const interval = window.setInterval(tick, heartbeatIntervalMs)

    return () => {
      window.clearInterval(interval)
    }
  }, [connectionState, room])

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

    await notifyLeaveRoom()
    socketRef.current?.removeAllListeners()
    socketRef.current?.disconnect()

    const nextSocket = io(resolvedServerUrl, {
      transports: ['websocket', 'polling'],
      autoConnect: false,
      reconnection: true,
      reconnectionDelay: 1_200,
      reconnectionDelayMax: 4_000,
      timeout: 12_000,
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

        if (nextSocket.recovered && roomRef.current) {
          setConnectionState('connected')
          requestFreshRoomSnapshot()
          requestFreshPlaybackState()
          resolveOnce()
          return
        }

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

      nextSocket.io.on('reconnect_failed', () => {
        disconnectFromRoom('房主已离开或房间已失效')
      })

      nextSocket.on('disconnect', () => {
        setSocketId('')
        memberPresencePrimedRef.current = false

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

      nextSocket.on('room:closed', (message?: string) => {
        disconnectFromRoom(message ?? '房主已离开，房间已关闭')
      })

      nextSocket.connect()
    })
  }

  const disconnectFromRoom = (nextErrorMessage: string | null = null) => {
    manualDisconnectRef.current = true
    joinPayloadRef.current = null
    pendingPlaybackRef.current = null
    playbackRef.current = null
    localBufferingRef.current = false
    localUserActionUntilRef.current = 0
    localSeekingRef.current = false
    lastRoomSnapshotAtRef.current = 0
    lastPlaybackStateAtRef.current = 0
    canPlayThroughRef.current = false
    lastPublishedBufferStateRef.current = ''
    memberPresencePrimedRef.current = false
    roomRef.current = null
    setSocketId('')
    setConnectionState('idle')
    setRoom(null)
    setPlayback(null)
    setErrorMessage(nextErrorMessage)
    setLocalBuffering(false)
    setAutoplayBlocked(false)
    setUploadStatus('idle')
    setUploadProgress(0)
    setUploadLabel('还没有选择本地片源')
    setSelectedFileName('')
    setLocalMediaDescriptor(null)
    if (localMediaUrlRef.current) {
      URL.revokeObjectURL(localMediaUrlRef.current)
      localMediaUrlRef.current = null
    }
    setLocalMediaUrl(null)
    setSubtitleStatus('idle')
    setSubtitleLabel('还没有字幕')
    setSelectedSubtitleName('')
    setJoiningRoomId(null)
    setHostedRoomId(null)
    setPresenceToasts([])
    for (const timer of toastTimersRef.current.values()) {
      window.clearTimeout(timer)
    }
    toastTimersRef.current.clear()
    socketRef.current?.removeAllListeners()
    socketRef.current?.disconnect()
    socketRef.current = null
  }

  const notifyLeaveRoom = async () => {
    const socket = socketRef.current
    const currentRoom = roomRef.current

    if (!socket || !currentRoom || !socket.connected) {
      return
    }

    try {
      await socket.timeout(400).emitWithAck('room:leave', {
        roomId: currentRoom.roomId,
      })
    } catch {
      // The disconnect event remains the fallback.
    }
  }

  const startSharing = async () => {
    setRelayBusy(true)
    setErrorMessage(null)

    try {
      const relay = await ensureLocalRelay()
      const nextRoomId = createRoomCode()
      setHostedRoomId(nextRoomId)
      await connectToRoom({
        roomId: nextRoomId,
        serverUrl: relay.localUrl,
        password: hostPassword,
        roomName: buildRoomName(nickname),
      })
    } catch (error) {
      setHostedRoomId(null)
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
      await notifyLeaveRoom()
      disconnectFromRoom()
      await window.desktopApp.discovery.advertise(null)
      await window.desktopApp.relay.stop()
      setRelayStatus(EMPTY_RELAY_STATUS)
      setServerUrl('')
      setHostedRoomId(null)
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

    void notifyLeaveRoom().finally(() => {
      disconnectFromRoom()
    })
  }

  const joinDiscoveredRoom = async (session: DiscoverySession) => {
    const sessionKey = `${session.instanceId}:${session.roomId}`
    const currentRoomId = roomRef.current?.roomId ?? ''

    if (currentRoomId && currentRoomId === session.roomId) {
      return
    }

    setJoiningRoomId(sessionKey)
    setErrorMessage(null)
    setHostedRoomId(null)

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
      setErrorMessage('请先加入房间，再选择本地片源')
      return
    }

    setSelectedFileName(file.name)
    setUploadStatus('reading')
    setUploadProgress(15)
    setUploadLabel('读取本地片源信息')
    setErrorMessage(null)

    try {
      const duration = await readVideoDuration(file)
      setUploadStatus('uploading')
      setUploadProgress(55)
      setUploadLabel('正在校验本地文件指纹')
      const sha256 = await hashFileSha256(file as LocalFileWithPath)
      const nextDescriptor: MediaDescriptor = {
        id: sha256,
        name: file.name,
        size: file.size,
        mimeType: file.type || 'application/octet-stream',
        duration,
        sha256,
      }

      if (localMediaUrlRef.current) {
        URL.revokeObjectURL(localMediaUrlRef.current)
      }

      const objectUrl = URL.createObjectURL(file)
      localMediaUrlRef.current = objectUrl
      setLocalMediaUrl(objectUrl)
      setLocalMediaDescriptor(nextDescriptor)
      setUploadStatus('done')
      setUploadProgress(100)
      setUploadLabel(
        isHost ? '片源指纹已发布，等待其他成员匹配同一文件' : '本地片源已提交校验',
      )

      socket.emit('room:select-media', {
        roomId: currentRoom.roomId,
        media: nextDescriptor,
      })
    } catch (error) {
      setUploadStatus('error')
      setUploadLabel('本地片源校验失败')
      setErrorMessage(error instanceof Error ? error.message : '片源校验失败')
    }
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
      {presenceToasts.length ? (
        <div className="toast-stack" aria-live="polite" aria-atomic="true">
          {presenceToasts.map((toast) => (
            <article className="toast" key={toast.id}>
              <strong>{toast.title}</strong>
              <p>{toast.detail}</p>
            </article>
          ))}
        </div>
      ) : null}

      <header className="topbar">
        <div className="topbar__copy">
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
          <section className="panel panel--profile">
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

          <section className="panel panel--nearby">
            <div className="panel__header">
              <div>
                <p className="panel__eyebrow">Nearby</p>
                <h2>附近正在共享</h2>
              </div>
              <div className="panel__header-actions">
                <StatusPill tone="neutral">{`${discoveredSessions.length} 个房间`}</StatusPill>
                <button
                  className="button button--secondary button--compact"
                  onClick={() => void refreshDiscoveredSessions(true, true)}
                  disabled={discoveryRefreshing}
                  type="button"
                >
                  {discoveryRefreshing ? '刷新中...' : '刷新'}
                </button>
              </div>
            </div>

            <div className="session-list">
              {discoveredSessions.length ? (
                discoveredSessions.map((session) => {
                  const sessionKey = `${session.instanceId}:${session.roomId}`
                  const isCurrentSession =
                    room?.roomId === session.roomId && connectionState !== 'idle'
                  const joinButtonLabel = isCurrentSession
                    ? '已在房间中'
                    : joiningRoomId === sessionKey
                      ? '加入中...'
                      : '加入观看'

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
                          disabled={joiningRoomId === sessionKey || isCurrentSession}
                        >
                          {joinButtonLabel}
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
            <section className="panel panel--room">
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
                  <span>在线成员</span>
                  <strong>{audienceCount}</strong>
                </div>
              </div>

              <div className="member-list">
                {room.members.map((member) => (
                  <article className="member-card" key={member.socketId}>
                    <div>
                      <strong>{member.nickname}</strong>
                      <p>
                        {member.isHost ? '房主' : '正在观看'}
                        {member.selectedMediaName
                          ? ` · ${member.selectedMediaName}`
                          : ''}
                        {room.isPreparing
                          ? ` · 已缓存 ${Math.max(0, Math.round(member.bufferAheadSeconds))}s`
                          : ''}
                      </p>
                    </div>
                    <StatusPill
                      tone={
                        member.mediaMatchState === 'mismatch'
                          ? 'warning'
                          : member.mediaMatchState === 'missing'
                            ? 'neutral'
                            : member.buffering
                              ? 'warning'
                              : 'success'
                      }
                    >
                      {getMemberStatusLabel(room, member)}
                    </StatusPill>
                  </article>
                ))}
              </div>

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
                <StatusPill
                  tone={
                    !room?.media
                      ? 'neutral'
                      : room.isPreparing || localBuffering
                        ? 'warning'
                        : 'success'
                  }
                >
                  {getPreparationLabel(room, localBuffering, currentMember)}
                </StatusPill>
                <StatusPill tone={room?.subtitle ? 'accent' : 'neutral'}>
                  {room?.subtitle ? '字幕已同步' : '暂无字幕'}
                </StatusPill>
                {room?.media ? (
                  <StatusPill
                    tone={
                      bufferTelemetry.fullyBuffered
                        ? 'success'
                        : bufferTelemetry.realtimeRatio !== null &&
                            bufferTelemetry.realtimeRatio >= 1
                          ? 'accent'
                          : 'warning'
                    }
                  >
                    {bufferTelemetryLabel}
                  </StatusPill>
                ) : null}
              </div>
            </div>

            {room ? (
              <div className="upload-toolbar">
                <div className="segment upload-segment">
                  <label
                    className={`segment__button segment__button--file ${
                      uploadStatus === 'done'
                        ? 'segment__button--success'
                        : uploadStatus === 'error'
                          ? 'segment__button--warning'
                          : isMediaUploading
                            ? 'segment__button--active'
                            : ''
                    }`}
                  >
                    <span className="segment__title">{mediaButtonLabel}</span>
                    <span className="segment__meta">{mediaButtonMeta}</span>
                    <input
                      type="file"
                      accept={VIDEO_ACCEPT}
                      disabled={isMediaUploading || isSubtitleUploading}
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

                  {isHost ? (
                    <label
                      className={`segment__button segment__button--file ${
                        subtitleStatus === 'done'
                          ? 'segment__button--success'
                          : subtitleStatus === 'error'
                            ? 'segment__button--warning'
                            : isSubtitleUploading
                              ? 'segment__button--active'
                              : ''
                      }`}
                    >
                      <span className="segment__title">{subtitleButtonLabel}</span>
                      <span className="segment__meta">{subtitleButtonMeta}</span>
                      <input
                        type="file"
                        accept={SUBTITLE_ACCEPT}
                        disabled={isMediaUploading || isSubtitleUploading}
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
                  ) : null}
                </div>

                <p className="support-note">{formatSupportHint(selectedFileName || room?.media?.name)}</p>
              </div>
            ) : (
              <p className="support-note">{formatSupportHint(null)}</p>
            )}

            <div className="player-frame" ref={playerFrameRef}>
              <div className="player-stage">
                {mediaUrl ? (
                  <video
                    key={videoKey}
                    ref={videoRef}
                    className="video"
                    controls
                    controlsList="nodownload noremoteplayback"
                    src={mediaUrl}
                    disablePictureInPicture
                    disableRemotePlayback
                    playsInline
                    preload="auto"
                    onContextMenu={(event) => {
                      event.preventDefault()
                    }}
                    onPlay={() => {
                      setAutoplayBlocked(false)
                      publishPlaybackIntent('user')
                    }}
                    onPause={() => {
                      publishPlaybackIntent('user')
                    }}
                    onSeeking={() => {
                      localSeekingRef.current = true
                      pendingPlaybackRef.current = null
                      localUserActionUntilRef.current = Date.now() + 1500
                    }}
                    onSeeked={() => {
                      localSeekingRef.current = false
                      localUserActionUntilRef.current = Date.now() + 2200
                      publishPlaybackIntent('user')
                    }}
                    onRateChange={() => publishPlaybackIntent('user')}
                    onLoadedMetadata={() => {
                      const pending = pendingPlaybackRef.current ?? playback

                      publishBufferState(false, true)

                      if (pending) {
                        applyRemotePlayback(pending)
                      }
                    }}
                    onLoadedData={() => {
                      const video = videoRef.current

                      if (!video) {
                        return
                      }

                      if (video.currentTime === 0) {
                        video.currentTime = 0.001
                      }

                      publishBufferState(false, true)
                    }}
                    onProgress={() => publishBufferState(localBufferingRef.current)}
                    onWaiting={() => publishBufferState(true, true)}
                    onStalled={() => publishBufferState(true, true)}
                    onCanPlay={() => {
                      if (localBufferingRef.current) {
                        publishBufferState(false, true)
                      }
                    }}
                    onCanPlayThrough={() => {
                      canPlayThroughRef.current = true
                      publishBufferState(false, true)
                    }}
                    onPlaying={() => {
                      setAutoplayBlocked(false)

                      if (localBufferingRef.current) {
                        publishBufferState(false, true)
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
                    {subtitleUrl && subtitleFormat === 'vtt' ? (
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
                      <p>{room?.media ? '等待本地匹配片源' : '还没有共享视频'}</p>
                      <strong>
                        {room?.media
                          ? isHost
                            ? '你已经发布了片源指纹，等待成员选择相同本地文件。'
                            : '请选择与你朋友相同的本地文件，通过校验后就会直接本地播放。'
                          : '房主选择本地片源后，大家会各自匹配同一份文件，只同步时间轴。'}
                      </strong>
                    </div>
                  </div>
                )}

                <div
                  className={`subtitle-layer ${
                    subtitleFormat === 'ass' ? 'subtitle-layer--active' : ''
                  }`}
                  ref={subtitleLayerRef}
                  style={
                    {
                      '--subtitle-scale': subtitleScale,
                      '--subtitle-offset-y': `${subtitleOffsetY}px`,
                    } as CSSProperties
                  }
                />

                {subtitleFormat === 'ass' ? (
                  <div className="player-floating-actions">
                    <div className="player-subtitle-menu" ref={subtitleMenuRef}>
                      <button
                        className={`player-subtitle-button ${
                          subtitlePanelOpen ? 'player-subtitle-button--active' : ''
                        }`}
                        onClick={() => {
                          setSubtitlePanelOpen((current) => !current)
                        }}
                        type="button"
                      >
                        字幕
                      </button>

                      {subtitlePanelOpen ? (
                        <div className="subtitle-popover subtitle-popover--floating">
                          <div className="subtitle-popover__header">
                            <strong>字幕</strong>
                            <span>ASS 渲染</span>
                          </div>

                          <label className="subtitle-control">
                            <span>字号</span>
                            <input
                              type="range"
                              min="0.7"
                              max="1.6"
                              step="0.05"
                              value={subtitleScale}
                              onChange={(event) => {
                                setSubtitleScale(Number(event.target.value))
                              }}
                            />
                            <strong>{Math.round(subtitleScale * 100)}%</strong>
                          </label>

                          <label className="subtitle-control">
                            <span>位置</span>
                            <input
                              type="range"
                              min="-120"
                              max="120"
                              step="4"
                              value={subtitleOffsetY}
                              onChange={(event) => {
                                setSubtitleOffsetY(Number(event.target.value))
                              }}
                            />
                            <strong>
                              {subtitleOffsetY > 0
                                ? `+${subtitleOffsetY}`
                                : subtitleOffsetY}
                              px
                            </strong>
                          </label>

                          <div className="subtitle-popover__footer">
                            <p>支持实时调整字号和上下位置。</p>
                            <button
                              className="button button--secondary"
                              onClick={() => {
                                setSubtitleScale(1)
                                setSubtitleOffsetY(0)
                              }}
                              type="button"
                            >
                              重置
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                {autoplayBlocked ? (
                  <div className="player-overlay">
                    <strong>系统拦截了自动播放</strong>
                    <p>手动点一次播放键，后续同步控制会继续生效。</p>
                  </div>
                ) : null}
              </div>
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
                  {room?.isPreparing
                    ? '正在等待所有成员达到启动缓冲阈值'
                    : playback?.playbackState.paused
                      ? '当前为暂停状态'
                      : '正在沿着同一条时间轴播放'}
                </p>
              </article>

            </div>

            {room ? (
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
