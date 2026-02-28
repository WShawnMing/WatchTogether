import { app, BrowserWindow, ipcMain } from 'electron'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
process.env.WS_NO_BUFFER_UTIL = '1'
process.env.WS_NO_UTF_8_VALIDATE = '1'
let relayHandle: LocalRelayHandle | null = null
let relayStartPromise: Promise<LocalRelayHandle> | null = null
let relayStopPromise: Promise<void> | null = null

type LocalRelayHandle = {
  close: () => Promise<void>
  port: number
}

async function loadLocalRelay() {
  return import('../server/src/localRelay')
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

function getReachableUrls(port: number) {
  const urls = new Set<string>([`http://127.0.0.1:${port}`])
  const interfaces = os.networkInterfaces()

  for (const network of Object.values(interfaces)) {
    for (const address of network ?? []) {
      if (address.family === 'IPv4' && !address.internal) {
        urls.add(`http://${address.address}:${port}`)
      }
    }
  }

  return [...urls]
}

function createMainWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1180,
    minHeight: 760,
    title: 'WatchTogether',
    backgroundColor: '#090d15',
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

app.whenReady().then(() => {
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
})
