import { spawn, execFile, ChildProcess } from 'child_process'
import { promisify } from 'util'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { existsSync, unlinkSync } from 'fs'
import { createConnection, Socket } from 'net'
import { EventEmitter } from 'events'
import { app } from 'electron'

const execFileAsync = promisify(execFile)

export interface MpvState {
  position: number
  duration: number
  paused: boolean
  volume: number
  speed: number
  muted: boolean
  filename: string
}

export class MpvController extends EventEmitter {
  private proc: ChildProcess | null = null
  private socket: Socket | null = null
  private socketPath: string
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private requestId = 1
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private recvBuf = ''
  private alive = false
  private exited = false

  constructor() {
    super()
    this.socketPath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\wt-mpv-${process.pid}-${Date.now()}`
        : join(tmpdir(), `wt-mpv-${process.pid}-${Date.now()}.sock`)
  }

  async start(filePath: string): Promise<void> {
    if (this.alive) {
      await this.loadFile(filePath)
      return
    }

    const mpvBin = await this.findBinary()
    if (!mpvBin) throw new Error('未找到 mpv，请先安装: brew install mpv')

    this.exited = false
    this.proc = spawn(mpvBin, [
      filePath,
      `--input-ipc-server=${this.socketPath}`,
      '--keep-open=yes',
      '--volume=100',
      '--title=WatchTogether Player'
    ], { stdio: 'ignore' })

    this.proc.on('exit', () => {
      this.exited = true
      this.cleanup()
      this.emit('exited')
    })

    this.proc.on('error', (err) => {
      console.error('mpv spawn error:', err.message)
      this.exited = true
      this.cleanup()
      this.emit('exited')
    })

    await this.connectSocket()
    this.alive = true
    this.startPolling()
  }

  async loadFile(filePath: string): Promise<void> {
    await this.command('loadfile', filePath, 'replace')
  }

  async getProperty(name: string): Promise<any> {
    return this.sendRequest(['get_property', name])
  }

  setProperty(name: string, value: any): void {
    this.sendFire(['set_property', name, value])
  }

  play(): void { this.setProperty('pause', false) }
  pause(): void { this.setProperty('pause', true) }
  togglePause(): void { this.sendFire(['cycle', 'pause']) }

  seekTo(seconds: number): void {
    this.sendFire(['set_property', 'time-pos', seconds])
  }

  setVolume(level: number): void { this.setProperty('volume', level) }
  setSpeed(spd: number): void { this.setProperty('speed', spd) }
  setMute(m: boolean): void { this.setProperty('mute', m ? 'yes' : 'no') }

  addSubtitle(filePath: string): void {
    this.sendFire(['sub-add', filePath])
  }

  async getState(): Promise<MpvState | null> {
    if (!this.alive || !this.socket) return null
    try {
      const [position, duration, paused, volume, speed, muted, filename] = await Promise.all([
        this.getProperty('time-pos').catch(() => 0),
        this.getProperty('duration').catch(() => 0),
        this.getProperty('pause').catch(() => true),
        this.getProperty('volume').catch(() => 100),
        this.getProperty('speed').catch(() => 1),
        this.getProperty('mute').catch(() => false),
        this.getProperty('media-title').catch(() => '')
      ])
      return {
        position: Number(position) || 0,
        duration: Number(duration) || 0,
        paused: Boolean(paused),
        volume: Number(volume) || 0,
        speed: Number(speed) || 1,
        muted: Boolean(muted),
        filename: String(filename || '')
      }
    } catch {
      return null
    }
  }

  async getTracks(): Promise<{ subs: any[]; audio: any[] }> {
    if (!this.alive) return { subs: [], audio: [] }
    try {
      const count = await this.getProperty('track-list/count')
      const subs: any[] = []
      const audio: any[] = []
      for (let i = 0; i < count; i++) {
        const type = await this.getProperty(`track-list/${i}/type`)
        const id = await this.getProperty(`track-list/${i}/id`)
        let title = '', lang = '', selected = false
        try { title = await this.getProperty(`track-list/${i}/title`) } catch {}
        try { lang = await this.getProperty(`track-list/${i}/lang`) } catch {}
        try { selected = await this.getProperty(`track-list/${i}/selected`) } catch {}
        const info = { id, title: title || `${type} ${id}`, lang: lang || '', selected }
        if (type === 'sub') subs.push(info)
        else if (type === 'audio') audio.push(info)
      }
      return { subs, audio }
    } catch {
      return { subs: [], audio: [] }
    }
  }

  isAlive(): boolean {
    return this.alive
  }

  destroy(): void {
    this.alive = false
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null }

    if (this.proc && !this.exited) {
      try { this.sendFire(['quit']) } catch {}
      setTimeout(() => {
        if (this.proc && !this.exited) {
          this.proc.kill('SIGTERM')
        }
      }, 500)
    }

    this.cleanupSocket()
    this.proc = null
    try { if (existsSync(this.socketPath)) unlinkSync(this.socketPath) } catch {}
  }

  private cleanup(): void {
    this.alive = false
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null }
    this.cleanupSocket()
    for (const [, p] of this.pending) {
      p.reject(new Error('mpv exited'))
    }
    this.pending.clear()
  }

  private cleanupSocket(): void {
    if (this.socket) {
      this.socket.removeAllListeners()
      try { this.socket.destroy() } catch {}
      this.socket = null
    }
  }

  private async connectSocket(timeoutMs = 8000): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (this.exited) throw new Error('mpv 进程已退出')
      try {
        await this.tryConnect()
        return
      } catch {
        await new Promise((r) => setTimeout(r, 150))
      }
    }
    throw new Error('mpv IPC 连接超时')
  }

  private tryConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = createConnection(this.socketPath)
      const timeout = setTimeout(() => {
        sock.destroy()
        reject(new Error('connect timeout'))
      }, 2000)

      sock.on('connect', () => {
        clearTimeout(timeout)
        this.socket = sock
        this.recvBuf = ''
        sock.on('data', (data) => this.onData(data))
        sock.on('error', () => {})
        sock.on('close', () => {
          if (this.alive && !this.exited) {
            this.alive = false
            this.emit('exited')
          }
        })
        resolve()
      })

      sock.on('error', (err) => {
        clearTimeout(timeout)
        sock.destroy()
        reject(err)
      })
    })
  }

  private onData(raw: Buffer): void {
    this.recvBuf += raw.toString()
    const lines = this.recvBuf.split('\n')
    this.recvBuf = lines.pop() || ''

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        if (msg.request_id !== undefined && this.pending.has(msg.request_id)) {
          const p = this.pending.get(msg.request_id)!
          this.pending.delete(msg.request_id)
          if (msg.error === 'success') {
            p.resolve(msg.data)
          } else {
            p.reject(new Error(msg.error || 'mpv error'))
          }
        }
      } catch {}
    }
  }

  private sendRequest(cmd: any[]): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.alive) {
        reject(new Error('not connected'))
        return
      }
      const id = this.requestId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('request timeout'))
      }, 3000)

      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) }
      })

      const msg = JSON.stringify({ command: cmd, request_id: id }) + '\n'
      this.socket.write(msg)
    })
  }

  private sendFire(cmd: any[]): void {
    if (!this.socket || !this.alive) return
    const msg = JSON.stringify({ command: cmd }) + '\n'
    this.socket.write(msg)
  }

  private async command(...args: any[]): Promise<any> {
    return this.sendRequest(args)
  }

  private startPolling(): void {
    this.pollTimer = setInterval(async () => {
      const state = await this.getState()
      if (state) this.emit('state', state)
    }, 250)
  }

  private async findBinary(): Promise<string | null> {
    // 1. Look for mpv bundled inside the app package
    const bundled = this.getBundledPath()
    if (bundled && existsSync(bundled)) {
      try {
        await execFileAsync(bundled, ['--no-config', '--vo=null', '--ao=null', '--version'], { timeout: 10000 })
        return bundled
      } catch {}
    }

    // 2. Common system install locations
    const candidates =
      process.platform === 'win32'
        ? ['C:\\Program Files\\mpv\\mpv.exe', 'C:\\mpv\\mpv.exe']
        : ['/opt/homebrew/bin/mpv', '/usr/local/bin/mpv', '/usr/bin/mpv']
    for (const bin of candidates) {
      try { await execFileAsync(bin, ['--version'], { timeout: 5000 }); return bin } catch {}
    }

    // 3. Fallback to PATH
    try {
      const cmd = process.platform === 'win32' ? 'where' : 'which'
      const { stdout } = await execFileAsync(cmd, ['mpv'])
      const p = stdout.trim().split('\n')[0]
      if (p) return p
    } catch {}
    return null
  }

  private getBundledPath(): string | null {
    const isPackaged = app.isPackaged
    const resourcesPath = isPackaged
      ? join(dirname(app.getPath('exe')), process.platform === 'darwin' ? '../Resources' : 'resources')
      : join(app.getAppPath(), 'resources')

    if (process.platform === 'win32') {
      return join(resourcesPath, 'mpv', 'mpv.exe')
    } else if (process.platform === 'darwin') {
      return join(resourcesPath, 'mpv', 'mpv')
    }
    return join(resourcesPath, 'mpv', 'mpv')
  }
}
