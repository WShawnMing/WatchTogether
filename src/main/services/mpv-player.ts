import { EventEmitter } from 'events'
import { exec } from 'child_process'
import { promisify } from 'util'
import { access } from 'fs/promises'
import path from 'path'

const execAsync = promisify(exec)

// node-mpv v1.5.0 uses CommonJS and has no TS types
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mpvAPI = require('node-mpv')

import type { PlayerStatus } from '../../shared/types'

export class MpvPlayer extends EventEmitter {
  private mpv: any = null
  private currentFile: string | null = null
  private currentSubtitle: string | null = null
  private ready = false
  private positionTimer: ReturnType<typeof setInterval> | null = null

  async initialize(): Promise<void> {
    const binary = await this.findBinary()
    if (!binary) {
      throw new Error(
        'mpv 未安装。请先安装 mpv:\nmacOS: brew install mpv\nWindows: scoop install mpv'
      )
    }

    const socketPath = this.getSocketPath()

    // v1.5 constructor spawns mpv immediately
    this.mpv = new mpvAPI(
      {
        binary,
        socket: socketPath,
        time_update: 1,
        verbose: false
      },
      ['--idle', '--no-terminal', '--keep-open=yes']
    )

    // Wait for IPC socket to be ready
    await new Promise<void>((resolve) => setTimeout(resolve, 1500))
    this.ready = true
    this.setupListeners()
    this.startPositionPolling()
  }

  private setupListeners(): void {
    if (!this.mpv) return

    this.mpv.on('paused', () => this.emit('state-change'))
    this.mpv.on('resumed', () => this.emit('state-change'))
    this.mpv.on('started', () => this.emit('state-change'))

    this.mpv.on('stopped', () => {
      this.currentFile = null
      this.emit('state-change')
    })

    this.mpv.on('seek', () => {
      this.emit('seeked')
      this.emit('state-change')
    })
  }

  private startPositionPolling(): void {
    this.positionTimer = setInterval(() => {
      if (this.ready && this.currentFile) {
        this.emit('state-change')
      }
    }, 500)
  }

  loadFile(filePath: string): void {
    if (!this.mpv) throw new Error('mpv not initialized')
    this.currentSubtitle = null
    this.currentFile = filePath
    this.mpv.load(filePath)
    this.emit('file-loaded', filePath)
    this.emit('state-change')
  }

  play(): void {
    if (!this.mpv || !this.currentFile) return
    this.mpv.play()
  }

  pause(): void {
    if (!this.mpv || !this.currentFile) return
    this.mpv.pause()
  }

  togglePause(): void {
    if (!this.mpv || !this.currentFile) return
    this.mpv.togglePause()
  }

  seekTo(seconds: number): void {
    if (!this.mpv || !this.currentFile) return
    this.mpv.goToPosition(seconds)
  }

  async getPosition(): Promise<number> {
    if (!this.mpv || !this.currentFile) return 0
    try {
      const pos = await this.mpv.getProperty('time-pos')
      return typeof pos === 'number' ? pos : 0
    } catch {
      return 0
    }
  }

  async getDuration(): Promise<number> {
    if (!this.mpv || !this.currentFile) return 0
    try {
      const dur = await this.mpv.getProperty('duration')
      return typeof dur === 'number' ? dur : 0
    } catch {
      return 0
    }
  }

  async isPaused(): Promise<boolean> {
    if (!this.mpv || !this.currentFile) return true
    try {
      return !!(await this.mpv.getProperty('pause'))
    } catch {
      return true
    }
  }

  async getStatus(): Promise<PlayerStatus> {
    return {
      file: this.currentFile,
      playing: this.currentFile !== null && !(await this.isPaused()),
      position: await this.getPosition(),
      duration: await this.getDuration(),
      paused: await this.isPaused(),
      speed: 1,
      subtitleFile: this.currentSubtitle
    }
  }

  loadSubtitle(filePath: string): void {
    if (!this.mpv) throw new Error('mpv not initialized')
    try {
      this.mpv.addSubtitles(filePath, 'select')
      this.currentSubtitle = filePath
      this.emit('state-change')
    } catch (err) {
      this.currentSubtitle = null
      throw new Error(`字幕加载失败: ${err}`)
    }
  }

  removeSubtitle(): void {
    if (!this.mpv) return
    try {
      this.mpv.setProperty('sid', 'no')
      this.currentSubtitle = null
      this.emit('state-change')
    } catch {
      // ignore
    }
  }

  setSubtitleSize(size: number): void {
    if (!this.mpv) return
    this.mpv.setProperty('sub-font-size', size)
  }

  setSubtitlePosition(pos: number): void {
    if (!this.mpv) return
    this.mpv.setProperty('sub-pos', pos)
  }

  quit(): void {
    if (this.positionTimer) {
      clearInterval(this.positionTimer)
      this.positionTimer = null
    }
    if (this.mpv) {
      try {
        this.mpv.quit()
      } catch {
        // mpv already quit
      }
      this.mpv = null
    }
    this.ready = false
    this.currentFile = null
    this.currentSubtitle = null
  }

  isReady(): boolean {
    return this.ready
  }

  getCurrentFile(): string | null {
    return this.currentFile
  }

  private async findBinary(): Promise<string | null> {
    const candidates =
      process.platform === 'darwin'
        ? ['/opt/homebrew/bin/mpv', '/usr/local/bin/mpv']
        : process.platform === 'win32'
          ? [
              path.join(process.env.LOCALAPPDATA || '', 'Programs', 'mpv', 'mpv.exe'),
              'C:\\Program Files\\mpv\\mpv.exe'
            ]
          : ['/usr/bin/mpv', '/usr/local/bin/mpv']

    for (const p of candidates) {
      try {
        await access(p)
        return p
      } catch {
        // not found at this location
      }
    }

    try {
      const cmd = process.platform === 'win32' ? 'where mpv' : 'which mpv'
      const { stdout } = await execAsync(cmd)
      const found = stdout.trim().split('\n')[0]
      if (found) return found
    } catch {
      // not in PATH
    }

    return null
  }

  private getSocketPath(): string {
    if (process.platform === 'win32') {
      return '\\\\.\\pipe\\watchtogether-mpv-' + process.pid
    }
    return `/tmp/watchtogether-mpv-${process.pid}.sock`
  }
}
