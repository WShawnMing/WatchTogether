import http from 'http'
import { createReadStream, statSync, readFileSync } from 'fs'
import { extname } from 'path'

const VIDEO_MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.flv': 'video/x-flv',
  '.wmv': 'video/x-ms-wmv',
  '.ogg': 'video/ogg'
}

export class MediaServer {
  private server: http.Server | null = null
  private port = 0
  private videoPath: string | null = null
  private subtitleVtt: string | null = null

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => this.handle(req, res))
      this.server.listen(0, '127.0.0.1', () => {
        this.port = (this.server!.address() as { port: number }).port
        resolve()
      })
    })
  }

  setVideo(filePath: string): string {
    this.videoPath = filePath
    return `http://127.0.0.1:${this.port}/video`
  }

  setSubtitle(filePath: string): string {
    try {
      const ext = extname(filePath).toLowerCase()
      let content = readFileSync(filePath, 'utf-8')

      if (ext === '.srt') {
        content = this.srtToVtt(content)
      } else if (ext === '.ass' || ext === '.ssa') {
        content = this.assToVtt(content)
      } else if (ext !== '.vtt') {
        content = 'WEBVTT\n\n'
      }

      this.subtitleVtt = content
      return `http://127.0.0.1:${this.port}/subtitle.vtt`
    } catch {
      this.subtitleVtt = null
      throw new Error('字幕文件读取失败')
    }
  }

  clearSubtitle(): void {
    this.subtitleVtt = null
  }

  getPort(): number {
    return this.port
  }

  stop(): void {
    if (this.server) {
      this.server.close()
      this.server = null
    }
    this.videoPath = null
    this.subtitleVtt = null
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = (req.url || '/').split('?')[0]

    res.setHeader('Access-Control-Allow-Origin', '*')

    if (url === '/video' && this.videoPath) {
      this.serveVideo(req, res)
    } else if (url === '/subtitle.vtt' && this.subtitleVtt) {
      this.serveSubtitle(res)
    } else {
      res.writeHead(404)
      res.end()
    }
  }

  private serveVideo(req: http.IncomingMessage, res: http.ServerResponse): void {
    const filePath = this.videoPath!
    let fileStat: ReturnType<typeof statSync>
    try {
      fileStat = statSync(filePath)
    } catch {
      res.writeHead(404)
      res.end()
      return
    }

    const ext = extname(filePath).toLowerCase()
    const mime = VIDEO_MIME[ext] || 'application/octet-stream'
    const range = req.headers.range

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-')
      const start = parseInt(parts[0], 10)
      const end = parts[1] ? parseInt(parts[1], 10) : fileStat.size - 1
      const chunkSize = end - start + 1

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileStat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': mime
      })
      createReadStream(filePath, { start, end }).pipe(res)
    } else {
      res.writeHead(200, {
        'Content-Length': fileStat.size,
        'Content-Type': mime,
        'Accept-Ranges': 'bytes'
      })
      createReadStream(filePath).pipe(res)
    }
  }

  private serveSubtitle(res: http.ServerResponse): void {
    const content = this.subtitleVtt!
    res.writeHead(200, {
      'Content-Type': 'text/vtt; charset=utf-8',
      'Content-Length': Buffer.byteLength(content)
    })
    res.end(content)
  }

  private srtToVtt(srt: string): string {
    const cleaned = srt.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    const converted = cleaned.replace(
      /(\d{2}:\d{2}:\d{2}),(\d{3})/g,
      '$1.$2'
    )
    return 'WEBVTT\n\n' + converted
  }

  private assToVtt(ass: string): string {
    const lines = ass.split(/\r?\n/)
    let vtt = 'WEBVTT\n\n'
    let index = 1

    for (const line of lines) {
      if (!line.startsWith('Dialogue:')) continue
      const parts = line.substring(line.indexOf(':') + 1).split(',')
      if (parts.length < 10) continue

      const startRaw = parts[1].trim()
      const endRaw = parts[2].trim()
      const text = parts
        .slice(9)
        .join(',')
        .replace(/\\N/g, '\n')
        .replace(/\\n/g, '\n')
        .replace(/\{[^}]*\}/g, '')
        .trim()

      if (!text) continue

      vtt += `${index}\n`
      vtt += `${this.formatAssTime(startRaw)} --> ${this.formatAssTime(endRaw)}\n`
      vtt += `${text}\n\n`
      index++
    }

    return vtt
  }

  private formatAssTime(raw: string): string {
    const parts = raw.split(':')
    if (parts.length !== 3) return raw
    const h = parts[0].padStart(2, '0')
    const m = parts[1].padStart(2, '0')
    const secParts = parts[2].split('.')
    const s = secParts[0].padStart(2, '0')
    const cs = secParts[1] || '00'
    const ms = (parseInt(cs, 10) * 10).toString().padStart(3, '0')
    return `${h}:${m}:${s}.${ms}`
  }
}
