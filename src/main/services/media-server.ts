import http from 'http'
import { createReadStream, statSync, readFileSync } from 'fs'
import { extname } from 'path'

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.m4v': 'video/mp4',
  '.ogg': 'video/ogg',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo'
}

export class MediaServer {
  private server: http.Server | null = null
  private port = 0
  private videoPath: string | null = null
  private subtitles: Map<string, string> = new Map()

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

  addSubtitleTrack(id: string, vttContent: string): string {
    this.subtitles.set(id, vttContent)
    return `http://127.0.0.1:${this.port}/sub/${id}.vtt`
  }

  setExternalSubtitle(filePath: string): string {
    const ext = extname(filePath).toLowerCase()
    let content = readFileSync(filePath, 'utf-8')
    if (ext === '.srt') content = this.srtToVtt(content)
    else if (ext === '.ass' || ext === '.ssa') content = this.assToVtt(content)
    else if (ext !== '.vtt') content = 'WEBVTT\n\n'
    this.subtitles.set('external', content)
    return `http://127.0.0.1:${this.port}/sub/external.vtt`
  }

  clearSubtitles(): void {
    this.subtitles.clear()
  }

  getPort(): number {
    return this.port
  }

  stop(): void {
    this.server?.close()
    this.server = null
    this.videoPath = null
    this.subtitles.clear()
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = (req.url || '/').split('?')[0]
    res.setHeader('Access-Control-Allow-Origin', '*')

    if (url === '/video' && this.videoPath) {
      this.serveVideo(req, res)
    } else if (url.startsWith('/sub/') && url.endsWith('.vtt')) {
      const id = url.slice(5, -4)
      const vtt = this.subtitles.get(id)
      if (vtt) this.serveVtt(res, vtt)
      else { res.writeHead(404); res.end() }
    } else {
      res.writeHead(404); res.end()
    }
  }

  private serveVideo(req: http.IncomingMessage, res: http.ServerResponse): void {
    const filePath = this.videoPath!
    let stat: ReturnType<typeof statSync>
    try { stat = statSync(filePath) } catch { res.writeHead(404); res.end(); return }

    const ext = extname(filePath).toLowerCase()
    const mime = MIME[ext] || 'video/mp4'
    const range = req.headers.range

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-')
      const start = parseInt(parts[0], 10)
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': mime
      })
      createReadStream(filePath, { start, end }).pipe(res)
    } else {
      res.writeHead(200, {
        'Content-Length': stat.size,
        'Content-Type': mime,
        'Accept-Ranges': 'bytes'
      })
      createReadStream(filePath).pipe(res)
    }
  }

  private serveVtt(res: http.ServerResponse, content: string): void {
    res.writeHead(200, {
      'Content-Type': 'text/vtt; charset=utf-8',
      'Content-Length': Buffer.byteLength(content)
    })
    res.end(content)
  }

  // ── subtitle converters ──

  private srtToVtt(srt: string): string {
    return 'WEBVTT\n\n' + srt
      .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
  }

  private assToVtt(ass: string): string {
    const lines = ass.split(/\r?\n/)
    let vtt = 'WEBVTT\n\n'
    let idx = 1
    for (const line of lines) {
      if (!line.startsWith('Dialogue:')) continue
      const parts = line.substring(line.indexOf(':') + 1).split(',')
      if (parts.length < 10) continue
      const text = parts.slice(9).join(',')
        .replace(/\\N/g, '\n').replace(/\\n/g, '\n').replace(/\{[^}]*\}/g, '').trim()
      if (!text) continue
      const s = this.fmtAss(parts[1].trim())
      const e = this.fmtAss(parts[2].trim())
      vtt += `${idx}\n${s} --> ${e}\n${text}\n\n`
      idx++
    }
    return vtt
  }

  private fmtAss(raw: string): string {
    const p = raw.split(':')
    if (p.length !== 3) return raw
    const h = p[0].padStart(2, '0')
    const m = p[1].padStart(2, '0')
    const sp = p[2].split('.')
    const s = sp[0].padStart(2, '0')
    const ms = ((parseInt(sp[1] || '0', 10) * 10)).toString().padStart(3, '0')
    return `${h}:${m}:${s}.${ms}`
  }
}
