import { createHash, randomUUID } from 'node:crypto'
import { createSocket, type RemoteInfo, type Socket as DiscoverySocket } from 'node:dgram'
import { app, BrowserWindow, ipcMain, nativeImage } from 'electron'
import { createReadStream } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  DiscoveryAdvertisePayload,
  DiscoveryAnnouncement,
  DiscoveryProbeResponse,
  DiscoverySession,
} from '../shared/protocol.js'
import { DEFAULT_RELAY_PORT } from '../shared/protocol.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const APP_INSTANCE_ID = randomUUID()
const DISCOVERY_PORT = Number(process.env.WATCH_TOGETHER_DISCOVERY_PORT ?? 43153)
const DISCOVERY_INTERVAL_MS = 1_500
const DISCOVERY_TTL_MS = 4_500
const DISCOVERY_PROBE_CACHE_MS = 6_000
const DISCOVERY_PROBE_TIMEOUT_MS = 300
const DISCOVERY_PROBE_CONCURRENCY = 48
const DISCOVERY_MAX_PROBE_HOSTS = 2_048
const APP_DISPLAY_NAME = 'WatchTogether'

process.env.WS_NO_BUFFER_UTIL = '1'
process.env.WS_NO_UTF_8_VALIDATE = '1'

app.setName(APP_DISPLAY_NAME)

if (process.platform === 'win32') {
  app.setAppUserModelId('com.watchtogether.desktop')
}

let relayHandle: LocalRelayHandle | null = null
let relayStartPromise: Promise<LocalRelayHandle> | null = null
let relayStopPromise: Promise<void> | null = null

let discoverySocket: DiscoverySocket | null = null
let discoverySocketPromise: Promise<DiscoverySocket> | null = null
let discoveryBroadcastTimer: NodeJS.Timeout | null = null
let discoveryCleanupTimer: NodeJS.Timeout | null = null
let hostedDiscovery: DiscoveryAdvertisePayload | null = null
let discoveryProbePromise: Promise<Map<string, DiscoverySession>> | null = null
let lastDiscoveryProbeAt = 0
let cachedProbeSessions = new Map<string, DiscoverySession>()
const successfulProbeHosts = new Set<string>()

const discoveredSessions = new Map<string, DiscoverySession>()

type LocalRelayHandle = {
  close: () => Promise<void>
  port: number
}

function hashFileSha256(filePath: string) {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)

    stream.on('data', (chunk) => {
      hash.update(chunk)
    })
    stream.on('error', (error) => {
      reject(error)
    })
    stream.on('end', () => {
      resolve(hash.digest('hex'))
    })
  })
}

function getRuntimeIconPath() {
  const root = app.getAppPath()

  if (app.isPackaged) {
    return path.join(root, 'dist', 'app-icon.png')
  }

  return path.join(root, 'public', 'app-icon.png')
}

async function loadLocalRelay() {
  return import('../server/src/localRelay')
}

function ipToInt(value: string) {
  return value.split('.').reduce((result, chunk) => {
    return (result << 8) + Number(chunk)
  }, 0) >>> 0
}

function intToIp(value: number) {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ].join('.')
}

function isInIpv4Range(value: string, base: string, prefix: number) {
  const mask =
    prefix === 0 ? 0 : ((0xffffffff << (32 - prefix)) >>> 0)

  return (ipToInt(value) & mask) >>> 0 === (ipToInt(base) & mask) >>> 0
}

function getBroadcastAddresses() {
  const broadcasts = new Set<string>(['255.255.255.255'])

  for (const network of Object.values(os.networkInterfaces())) {
    for (const address of network ?? []) {
      if (address.family !== 'IPv4' || address.internal || !address.netmask) {
        continue
      }

      try {
        const host = ipToInt(address.address)
        const netmask = ipToInt(address.netmask)
        const broadcast = (host & netmask) | (~netmask >>> 0)
        broadcasts.add(intToIp(broadcast >>> 0))
      } catch {
        // Ignore malformed addresses.
      }
    }
  }

  return [...broadcasts]
}

function getReachableUrls(port: number) {
  const urls = new Set<string>([`http://127.0.0.1:${port}`])

  for (const network of Object.values(os.networkInterfaces())) {
    for (const address of network ?? []) {
      if (address.family === 'IPv4' && !address.internal) {
        urls.add(`http://${address.address}:${port}`)
      }
    }
  }

  return [...urls]
}

function isLanLikeIPv4(value: string) {
  return (
    isInIpv4Range(value, '10.0.0.0', 8) ||
    isInIpv4Range(value, '172.16.0.0', 12) ||
    isInIpv4Range(value, '192.168.0.0', 16) ||
    isInIpv4Range(value, '100.64.0.0', 10) ||
    isInIpv4Range(value, '169.254.0.0', 16) ||
    isInIpv4Range(value, '198.18.0.0', 15)
  )
}

function prefixLengthFromNetmask(netmask: string) {
  return netmask
    .split('.')
    .map((chunk) => Number(chunk).toString(2).padStart(8, '0'))
    .join('')
    .replace(/0+$/, '')
    .length
}

function getProbeMask(prefix: number, netmask: string) {
  const hostCount = Math.max(0, 2 ** Math.max(0, 32 - prefix) - 2)

  if (prefix >= 20 && prefix <= 30 && hostCount <= DISCOVERY_MAX_PROBE_HOSTS) {
    return ipToInt(netmask)
  }

  return 0xffffff00
}

function getProbeAddresses() {
  const prioritizedAddresses: string[] = []
  const fallbackAddresses: string[] = []
  const seenAddresses = new Set<string>()
  const localAddresses = new Set<string>()

  for (const network of Object.values(os.networkInterfaces())) {
    for (const address of network ?? []) {
      if (
        address.family !== 'IPv4' ||
        address.internal ||
        !address.netmask ||
        !isLanLikeIPv4(address.address)
      ) {
        continue
      }

      localAddresses.add(address.address)

      try {
        const host = ipToInt(address.address)
        const prefix = prefixLengthFromNetmask(address.netmask)
        const mask = getProbeMask(prefix, address.netmask)
        const networkBase = (host & mask) >>> 0
        const broadcast = (networkBase | (~mask >>> 0)) >>> 0

        for (let candidate = networkBase + 1; candidate < broadcast; candidate += 1) {
          const ip = intToIp(candidate >>> 0)

          if (localAddresses.has(ip) || seenAddresses.has(ip)) {
            continue
          }

          seenAddresses.add(ip)

          if (successfulProbeHosts.has(ip)) {
            prioritizedAddresses.push(ip)
          } else {
            fallbackAddresses.push(ip)
          }
        }
      } catch {
        // Ignore malformed network info.
      }
    }
  }

  return [...prioritizedAddresses, ...fallbackAddresses]
}

async function probeAddress(address: string) {
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort()
  }, DISCOVERY_PROBE_TIMEOUT_MS)

  try {
    const response = await fetch(`http://${address}:${DEFAULT_RELAY_PORT}/api/discovery`, {
      headers: {
        accept: 'application/json',
      },
      signal: controller.signal,
    })

    if (!response.ok) {
      return []
    }

    const payload = (await response.json()) as DiscoveryProbeResponse

    if (
      payload.protocolVersion !== 1 ||
      payload.instanceId === APP_INSTANCE_ID ||
      !Array.isArray(payload.rooms)
    ) {
      return []
    }

    const lastSeenAt = Date.now()
    successfulProbeHosts.add(address)

    return payload.rooms.map((room) => ({
      instanceId: payload.instanceId,
      roomId: room.roomId,
      roomName: room.roomName,
      hostNickname: room.hostNickname,
      requiresPassword: room.requiresPassword,
      memberCount: room.memberCount,
      maxMembers: room.maxMembers,
      mediaName: room.mediaName,
      subtitleName: room.subtitleName,
      playbackState: room.playbackState,
      serverUrl: `http://${address}:${DEFAULT_RELAY_PORT}`,
      lastSeenAt,
    }))
  } catch {
    return []
  } finally {
    clearTimeout(timeout)
  }
}

async function refreshProbeSessions(force = false) {
  const now = Date.now()

  if (!force && now - lastDiscoveryProbeAt < DISCOVERY_PROBE_CACHE_MS) {
    return cachedProbeSessions
  }

  if (discoveryProbePromise) {
    return discoveryProbePromise
  }

  const addresses = getProbeAddresses()

  discoveryProbePromise = (async () => {
    const probedSessions = new Map<string, DiscoverySession>()

    if (addresses.length === 0) {
      lastDiscoveryProbeAt = Date.now()
      cachedProbeSessions = probedSessions
      return probedSessions
    }

    let cursor = 0
    const workers = Array.from(
      { length: Math.min(DISCOVERY_PROBE_CONCURRENCY, addresses.length) },
      async () => {
        while (cursor < addresses.length) {
          const address = addresses[cursor]
          cursor += 1

          const sessions = await probeAddress(address)

          for (const session of sessions) {
            probedSessions.set(`${session.instanceId}:${session.roomId}`, session)
          }

          if (sessions.length > 0) {
            cachedProbeSessions = new Map(probedSessions)
          }
        }
      },
    )

    await Promise.all(workers)

    lastDiscoveryProbeAt = Date.now()
    cachedProbeSessions = probedSessions

    return probedSessions
  })()

  try {
    return await discoveryProbePromise
  } finally {
    discoveryProbePromise = null
  }
}

function getMergedDiscoverySessions() {
  cleanupDiscoveredSessions()
  const mergedSessions = new Map(discoveredSessions)

  for (const [key, session] of cachedProbeSessions.entries()) {
    const current = mergedSessions.get(key)

    if (!current || session.lastSeenAt >= current.lastSeenAt) {
      mergedSessions.set(key, session)
    }
  }

  return [...mergedSessions.values()].sort((left, right) => {
    return right.lastSeenAt - left.lastSeenAt
  })
}

function buildAnnouncement(
  payload: DiscoveryAdvertisePayload,
): DiscoveryAnnouncement {
  return {
    type: 'watchtogether:announce',
    protocolVersion: 1,
    instanceId: APP_INSTANCE_ID,
    roomId: payload.roomId,
    roomName: payload.roomName,
    hostNickname: payload.hostNickname,
    requiresPassword: payload.requiresPassword,
    memberCount: payload.memberCount,
    maxMembers: payload.maxMembers,
    mediaName: payload.mediaName,
    subtitleName: payload.subtitleName,
    playbackState: payload.playbackState,
    port: payload.port,
    announcedAt: Date.now(),
  }
}

function cleanupDiscoveredSessions() {
  const now = Date.now()

  for (const [key, session] of discoveredSessions.entries()) {
    if (now - session.lastSeenAt > DISCOVERY_TTL_MS) {
      discoveredSessions.delete(key)
    }
  }
}

function handleDiscoveryMessage(message: Buffer, remote: RemoteInfo) {
  let payload: DiscoveryAnnouncement

  try {
    payload = JSON.parse(message.toString('utf8')) as DiscoveryAnnouncement
  } catch {
    return
  }

  if (
    payload.type !== 'watchtogether:announce' ||
    payload.protocolVersion !== 1 ||
    payload.instanceId === APP_INSTANCE_ID ||
    !payload.roomId ||
    !payload.port
  ) {
    return
  }

  discoveredSessions.set(`${payload.instanceId}:${payload.roomId}`, {
    instanceId: payload.instanceId,
    roomId: payload.roomId,
    roomName: payload.roomName,
    hostNickname: payload.hostNickname,
    requiresPassword: payload.requiresPassword,
    memberCount: payload.memberCount,
    maxMembers: payload.maxMembers,
    mediaName: payload.mediaName,
    subtitleName: payload.subtitleName,
    playbackState: payload.playbackState,
    serverUrl: `http://${remote.address}:${payload.port}`,
    lastSeenAt: Date.now(),
  })
}

async function ensureDiscoverySocket() {
  if (discoverySocket) {
    return discoverySocket
  }

  if (discoverySocketPromise) {
    return discoverySocketPromise
  }

  discoverySocketPromise = new Promise<DiscoverySocket>((resolve, reject) => {
    const socket = createSocket({ type: 'udp4', reuseAddr: true })

    const cleanup = () => {
      socket.removeAllListeners('message')
      socket.removeAllListeners('error')
      socket.removeAllListeners('listening')
    }

    socket.once('error', (error) => {
      cleanup()
      reject(error)
    })

    socket.once('listening', () => {
      cleanup()
      socket.on('message', handleDiscoveryMessage)
      socket.on('error', () => {
        // Keep discovery best-effort and avoid crashing the app.
      })
      socket.setBroadcast(true)
      discoverySocket = socket
      resolve(socket)
    })

    socket.bind(DISCOVERY_PORT, '0.0.0.0')
  })

  try {
    const socket = await discoverySocketPromise

    if (!discoveryCleanupTimer) {
      discoveryCleanupTimer = setInterval(() => {
        cleanupDiscoveredSessions()
      }, DISCOVERY_INTERVAL_MS)
    }

    return socket
  } finally {
    discoverySocketPromise = null
  }
}

async function broadcastHostedSession() {
  if (!hostedDiscovery) {
    return
  }

  const socket = await ensureDiscoverySocket()
  const packet = Buffer.from(JSON.stringify(buildAnnouncement(hostedDiscovery)))

  for (const address of getBroadcastAddresses()) {
    socket.send(packet, DISCOVERY_PORT, address, () => {
      // Discovery is best-effort.
    })
  }
}

function syncDiscoveryBroadcast() {
  if (hostedDiscovery) {
    if (!discoveryBroadcastTimer) {
      discoveryBroadcastTimer = setInterval(() => {
        void broadcastHostedSession()
      }, DISCOVERY_INTERVAL_MS)
    }

    return
  }

  if (discoveryBroadcastTimer) {
    clearInterval(discoveryBroadcastTimer)
    discoveryBroadcastTimer = null
  }
}

async function ensureRelay(preferredPort?: number) {
  if (relayHandle) {
    return relayHandle
  }

  if (relayStartPromise) {
    return relayStartPromise
  }

  relayStartPromise = (async () => {
    const { startLocalRelay } = await loadLocalRelay()

    return startLocalRelay({
      port: preferredPort ?? DEFAULT_RELAY_PORT,
      roomIdleTtlMinutes: Number(process.env.ROOM_IDLE_TTL_MINUTES ?? 120),
      instanceId: APP_INSTANCE_ID,
      storageRoot: path.join(app.getPath('userData'), 'uploads'),
    })
  })()

  try {
    relayHandle = await relayStartPromise
    return relayHandle
  } finally {
    relayStartPromise = null
  }
}

async function stopRelay() {
  if (relayStopPromise) {
    await relayStopPromise
    return
  }

  hostedDiscovery = null
  syncDiscoveryBroadcast()

  const activeHandle = relayHandle
  relayHandle = null

  if (!activeHandle) {
    return
  }

  relayStopPromise = (async () => {
    await activeHandle.close()
  })()

  try {
    await relayStopPromise
  } finally {
    relayStopPromise = null
  }
}

async function shutdownDiscovery() {
  hostedDiscovery = null
  syncDiscoveryBroadcast()

  if (discoveryCleanupTimer) {
    clearInterval(discoveryCleanupTimer)
    discoveryCleanupTimer = null
  }

  const activeSocket = discoverySocket
  discoverySocket = null

  if (!activeSocket) {
    return
  }

  await new Promise<void>((resolve) => {
    activeSocket.close(() => {
      resolve()
    })
  })
}

function createMainWindow() {
  const iconPath = getRuntimeIconPath()
  const window = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1060,
    minHeight: 760,
    title: APP_DISPLAY_NAME,
    backgroundColor: '#f4f5f7',
    autoHideMenuBar: true,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  window.on('page-title-updated', (event) => {
    event.preventDefault()
    window.setTitle(APP_DISPLAY_NAME)
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    void window.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    void window.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

ipcMain.handle('relay:start', async (_event, preferredPort?: number) => {
  const activeRelay = await ensureRelay(preferredPort)
  const urls = getReachableUrls(activeRelay.port)

  return {
    port: activeRelay.port,
    localUrl: `http://127.0.0.1:${activeRelay.port}`,
    shareUrls: urls.filter((url) => !url.includes('127.0.0.1')),
    allUrls: urls,
  }
})

ipcMain.handle('relay:stop', async () => {
  if (!relayHandle) {
    return { ok: true }
  }

  await stopRelay()

  return { ok: true }
})

ipcMain.handle('relay:status', async () => {
  if (!relayHandle) {
    return {
      running: false,
      localUrl: null,
      shareUrls: [],
      allUrls: [],
      port: null,
    }
  }

  const urls = getReachableUrls(relayHandle.port)

  return {
    running: true,
    port: relayHandle.port,
    localUrl: `http://127.0.0.1:${relayHandle.port}`,
    shareUrls: urls.filter((url) => !url.includes('127.0.0.1')),
    allUrls: urls,
  }
})

ipcMain.handle('files:hash-sha256', async (_event, filePath: string) => {
  return {
    sha256: await hashFileSha256(filePath),
  }
})

ipcMain.handle(
  'discovery:advertise',
  async (_event, payload: DiscoveryAdvertisePayload | null) => {
    if (payload) {
      await ensureDiscoverySocket()
    }

    hostedDiscovery = payload
    syncDiscoveryBroadcast()

    if (payload) {
      await broadcastHostedSession()
    }

    return { ok: true }
  },
)

ipcMain.handle('discovery:list', async (_event, options?: { force?: boolean }) => {
  await ensureDiscoverySocket()
  void refreshProbeSessions(options?.force === true).catch(() => {
    // Keep discovery best-effort.
  })
  return getMergedDiscoverySessions()
})

app.whenReady().then(() => {
  if (process.platform === 'darwin') {
    const icon = nativeImage.createFromPath(getRuntimeIconPath())

    if (!icon.isEmpty()) {
      app.dock?.setIcon(icon)
    }
  }

  void ensureDiscoverySocket()
  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  void stopRelay()
  void shutdownDiscovery()
})
