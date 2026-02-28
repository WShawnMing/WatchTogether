import { randomUUID } from 'node:crypto'
import { createSocket, type RemoteInfo, type Socket as DiscoverySocket } from 'node:dgram'
import { app, BrowserWindow, ipcMain } from 'electron'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  DiscoveryAdvertisePayload,
  DiscoveryAnnouncement,
  DiscoverySession,
} from '../shared/protocol.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const APP_INSTANCE_ID = randomUUID()
const DISCOVERY_PORT = Number(process.env.WATCH_TOGETHER_DISCOVERY_PORT ?? 43153)
const DISCOVERY_INTERVAL_MS = 1_500
const DISCOVERY_TTL_MS = 4_500

process.env.WS_NO_BUFFER_UTIL = '1'
process.env.WS_NO_UTF_8_VALIDATE = '1'

let relayHandle: LocalRelayHandle | null = null
let relayStartPromise: Promise<LocalRelayHandle> | null = null
let relayStopPromise: Promise<void> | null = null

let discoverySocket: DiscoverySocket | null = null
let discoverySocketPromise: Promise<DiscoverySocket> | null = null
let discoveryBroadcastTimer: NodeJS.Timeout | null = null
let discoveryCleanupTimer: NodeJS.Timeout | null = null
let hostedDiscovery: DiscoveryAdvertisePayload | null = null

const discoveredSessions = new Map<string, DiscoverySession>()

type LocalRelayHandle = {
  close: () => Promise<void>
  port: number
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
      port: preferredPort,
      roomIdleTtlMinutes: Number(process.env.ROOM_IDLE_TTL_MINUTES ?? 120),
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
  const window = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1060,
    minHeight: 760,
    title: 'WatchTogether',
    backgroundColor: '#f4f5f7',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
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

ipcMain.handle('discovery:list', async () => {
  await ensureDiscoverySocket()
  cleanupDiscoveredSessions()

  return [...discoveredSessions.values()].sort((left, right) => {
    return right.lastSeenAt - left.lastSeenAt
  })
})

app.whenReady().then(() => {
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
