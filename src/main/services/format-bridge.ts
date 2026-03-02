import { execFile, spawn, type ChildProcess } from 'child_process'
import { promisify } from 'util'
import { tmpdir } from 'os'
import { join, basename, extname } from 'path'
import { mkdirSync, existsSync, unlinkSync, readdirSync, readFileSync } from 'fs'

const execFileAsync = promisify(execFile)
const TEMP_DIR = join(tmpdir(), 'watchtogether-media')

// Chromium on macOS supports HEVC via VideoToolbox, MKV container, FLAC audio, etc.
const DIRECT_PLAY_CONTAINERS = new Set(['.mp4', '.m4v', '.webm', '.ogg', '.mkv', '.mov'])
const CHROMIUM_VIDEO = new Set(['h264', 'hevc', 'h265', 'vp8', 'vp9', 'av1', 'theora', 'mpeg4', 'mpeg2video'])
const CHROMIUM_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_f32le'])
// AC-3 / EAC-3 supported on macOS via AudioToolbox in Electron
const MACOS_EXTRA_AUDIO = new Set(['ac3', 'eac3'])

export interface SubTrack {
  index: number
  lang: string
  title: string
  codec: string
}

export interface ProbeResult {
  videoCodec: string | null
  audioCodec: string | null
  duration: number
  canDirectPlay: boolean
  needsRemux: boolean
  subtitleTracks: SubTrack[]
}

let ffmpegBin: string | null = null
let ffprobeBin: string | null = null
let checked = false

async function findBin(name: string): Promise<string | null> {
  for (const p of [
    name,
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`
  ]) {
    try { await execFileAsync(p, ['-version']); return p } catch {}
  }
  return null
}

export async function init(): Promise<boolean> {
  if (checked) return !!ffmpegBin
  checked = true
  ;[ffmpegBin, ffprobeBin] = await Promise.all([findBin('ffmpeg'), findBin('ffprobe')])
  return !!ffmpegBin
}

export function available(): boolean { return !!ffmpegBin && !!ffprobeBin }

function isAudioCompat(codec: string | null): boolean {
  if (!codec) return true
  if (CHROMIUM_AUDIO.has(codec)) return true
  if (process.platform === 'darwin' && MACOS_EXTRA_AUDIO.has(codec)) return true
  return false
}

export async function probe(filePath: string): Promise<ProbeResult> {
  if (!ffprobeBin) throw new Error('ffprobe not found')
  const { stdout } = await execFileAsync(ffprobeBin, [
    '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath
  ])
  const data = JSON.parse(stdout)
  const ext = extname(filePath).toLowerCase()
  const vs = data.streams.find((s: any) => s.codec_type === 'video')
  const as_ = data.streams.find((s: any) => s.codec_type === 'audio')

  const subs: SubTrack[] = []
  let si = 0
  for (const s of data.streams) {
    if (s.codec_type === 'subtitle') {
      subs.push({
        index: si,
        lang: s.tags?.language || 'und',
        title: s.tags?.title || `字幕 ${si + 1}`,
        codec: s.codec_name
      })
      si++
    }
  }

  const vc = vs?.codec_name || null
  const ac = as_?.codec_name || null
  const compatC = DIRECT_PLAY_CONTAINERS.has(ext)
  const compatV = !vc || CHROMIUM_VIDEO.has(vc)
  const compatA = isAudioCompat(ac)

  const canDirectPlay = compatC && compatV && compatA
  const needsRemux = !canDirectPlay

  return {
    videoCodec: vc, audioCodec: ac,
    duration: parseFloat(data.format.duration) || 0,
    canDirectPlay, needsRemux,
    subtitleTracks: subs
  }
}

export function remuxPath(src: string): string {
  mkdirSync(TEMP_DIR, { recursive: true })
  return join(TEMP_DIR, basename(src, extname(src)) + '_remux.mp4')
}

export function remux(
  input: string, output: string, pr: ProbeResult,
  onProgress?: (pct: number) => void
): { proc: ChildProcess; done: Promise<void> } {
  if (!ffmpegBin) throw new Error('ffmpeg not found')

  const copyV = pr.videoCodec && CHROMIUM_VIDEO.has(pr.videoCodec)
  const copyA = isAudioCompat(pr.audioCodec)

  const args = ['-y', '-i', input, '-map', '0:v:0?', '-map', '0:a:0?']
  args.push('-c:v', copyV ? 'copy' : 'libx264')
  if (!copyV) args.push('-preset', 'fast', '-crf', '22')
  args.push('-c:a', copyA ? 'copy' : 'aac')
  if (!copyA) args.push('-b:a', '256k')
  args.push('-movflags', '+faststart', output)

  const proc = spawn(ffmpegBin, args)
  const done = new Promise<void>((resolve, reject) => {
    let buf = ''
    proc.stderr?.on('data', (c: Buffer) => {
      buf += c.toString()
      if (onProgress && pr.duration > 0) {
        const m = buf.match(/time=(\d+):(\d+):(\d+\.\d+)/g)
        if (m) {
          const l = m[m.length - 1].replace('time=', '').split(':')
          const t = +l[0] * 3600 + +l[1] * 60 + parseFloat(l[2])
          onProgress(Math.min(99, Math.round(t / pr.duration * 100)))
        }
      }
    })
    proc.on('close', (c) => c === 0 ? (onProgress?.(100), resolve()) : reject(new Error(`ffmpeg exit ${c}`)))
    proc.on('error', reject)
  })
  return { proc, done }
}

export function subOutPath(src: string, idx: number): string {
  mkdirSync(TEMP_DIR, { recursive: true })
  return join(TEMP_DIR, `${basename(src, extname(src))}_s${idx}.srt`)
}

export async function extractSub(input: string, trackIdx: number, output: string): Promise<string> {
  if (!ffmpegBin) throw new Error('ffmpeg not found')
  await execFileAsync(ffmpegBin, ['-y', '-i', input, '-map', `0:s:${trackIdx}`, '-f', 'srt', output])
  const srt = readFileSync(output, 'utf-8')
  return 'WEBVTT\n\n' + srt.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
}

export function cleanup(): void {
  try {
    if (!existsSync(TEMP_DIR)) return
    for (const f of readdirSync(TEMP_DIR)) {
      try { unlinkSync(join(TEMP_DIR, f)) } catch {}
    }
  } catch {}
}
