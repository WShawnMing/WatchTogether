import { useRef, useState, useEffect, useCallback } from 'react'
import { usePlayerStore } from '../stores/playerStore'

function fmt(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

export default function VideoPlayer() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const hideRef = useRef(0)

  const mediaUrl = usePlayerStore((s) => s.mediaUrl)
  const subtitleUrl = usePlayerStore((s) => s.subtitleUrl)

  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [dur, setDur] = useState(0)
  const [buf, setBuf] = useState(0)
  const [controls, setControls] = useState(true)
  const [fs, setFs] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [dragT, setDragT] = useState(0)
  const [hoverBar, setHoverBar] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Load media
  useEffect(() => {
    const v = videoRef.current
    if (!v || !mediaUrl) return
    v.src = mediaUrl
    v.load()
    setErr(null)
    setTime(0)
    setDur(0)
    setPlaying(false)
  }, [mediaUrl])

  // Video events
  useEffect(() => {
    const v = videoRef.current
    if (!v) return

    const onMeta = () => {
      setDur(v.duration)
      window.api.reportDuration(v.duration)
    }
    const onTime = () => { if (!dragging) setTime(v.currentTime) }
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    const onEnded = () => setPlaying(false)
    const onErr = () => setErr('无法播放此视频，格式可能不兼容')
    const onBuf = () => {
      if (v.buffered.length > 0) setBuf(v.buffered.end(v.buffered.length - 1))
    }

    v.addEventListener('loadedmetadata', onMeta)
    v.addEventListener('timeupdate', onTime)
    v.addEventListener('play', onPlay)
    v.addEventListener('pause', onPause)
    v.addEventListener('ended', onEnded)
    v.addEventListener('error', onErr)
    v.addEventListener('progress', onBuf)

    return () => {
      v.removeEventListener('loadedmetadata', onMeta)
      v.removeEventListener('timeupdate', onTime)
      v.removeEventListener('play', onPlay)
      v.removeEventListener('pause', onPause)
      v.removeEventListener('ended', onEnded)
      v.removeEventListener('error', onErr)
      v.removeEventListener('progress', onBuf)
    }
  }, [dragging])

  // Sync commands from main
  useEffect(() => {
    return window.api.onPlayerCommand((cmd: Record<string, unknown>) => {
      const v = videoRef.current
      if (!v) return
      const action = cmd.action as string
      if (action === 'play') v.play().catch(() => {})
      else if (action === 'pause') v.pause()
      else if (action === 'seek') v.currentTime = cmd.position as number
      else if (action === 'sync') {
        const st = cmd.state as { position: number; paused: boolean }
        if (Math.abs(v.currentTime - st.position) > 1.5) v.currentTime = st.position
        if (st.paused && !v.paused) v.pause()
        if (!st.paused && v.paused) v.play().catch(() => {})
      }
    })
  }, [])

  // Report state to main for sync
  useEffect(() => {
    const id = setInterval(() => {
      const v = videoRef.current
      if (!v || !mediaUrl) return
      window.api.reportPlayerState({
        position: v.currentTime,
        duration: v.duration || 0,
        paused: v.paused,
        playing: !v.paused
      })
    }, 500)
    return () => clearInterval(id)
  }, [mediaUrl])

  // Controls auto-hide
  const flash = useCallback(() => {
    setControls(true)
    clearTimeout(hideRef.current)
    if (playing) {
      hideRef.current = window.setTimeout(() => setControls(false), 3000)
    }
  }, [playing])

  useEffect(() => {
    if (!playing) setControls(true)
  }, [playing])

  // Fullscreen
  useEffect(() => {
    const h = () => setFs(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', h)
    return () => document.removeEventListener('fullscreenchange', h)
  }, [])

  const togglePlay = () => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) {
      v.play().catch(() => {})
      window.api.reportAction({ action: 'play', position: v.currentTime, paused: false })
    } else {
      v.pause()
      window.api.reportAction({ action: 'pause', position: v.currentTime, paused: true })
    }
  }

  const seek = (pos: number) => {
    const v = videoRef.current
    if (!v) return
    v.currentTime = pos
    window.api.reportAction({ action: 'seek', position: pos, paused: v.paused })
  }

  const toggleFs = () => {
    const c = containerRef.current
    if (!c) return
    document.fullscreenElement ? document.exitFullscreen() : c.requestFullscreen()
  }

  // Progress bar interaction
  const barPos = (e: React.MouseEvent | MouseEvent) => {
    const b = barRef.current
    if (!b || dur <= 0) return 0
    const r = b.getBoundingClientRect()
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * dur
  }

  const onBarDown = (e: React.MouseEvent) => {
    e.preventDefault()
    setDragging(true)
    setDragT(barPos(e))

    const move = (ev: MouseEvent) => setDragT(barPos(ev))
    const up = (ev: MouseEvent) => {
      seek(barPos(ev))
      setDragging(false)
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  }

  const pct = dur > 0 ? ((dragging ? dragT : time) / dur) * 100 : 0
  const bufPct = dur > 0 ? (buf / dur) * 100 : 0
  const shown = dragging ? dragT : time

  if (!mediaUrl) return null

  return (
    <div
      ref={containerRef}
      className={`relative w-full bg-black select-none ${fs ? '' : 'rounded-2xl'} overflow-hidden`}
      style={{ aspectRatio: '16 / 9' }}
      onMouseMove={flash}
      onMouseLeave={() => playing && !dragging && setControls(false)}
    >
      <video
        ref={videoRef}
        className="absolute inset-0 w-full h-full"
        onClick={togglePlay}
        onDoubleClick={toggleFs}
        playsInline
      >
        {subtitleUrl && <track kind="subtitles" src={subtitleUrl} default />}
      </video>

      {/* Error */}
      {err && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-10">
          <p className="text-white/60 text-[13px] text-center px-8">{err}</p>
        </div>
      )}

      {/* Center play icon (paused + controls visible) */}
      {!playing && !err && controls && (
        <button
          className="absolute inset-0 flex items-center justify-center z-10"
          onClick={togglePlay}
        >
          <div className="w-16 h-16 rounded-full bg-black/40 backdrop-blur-md flex items-center justify-center transition-transform hover:scale-105">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="white">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        </button>
      )}

      {/* Bottom bar */}
      <div
        className={`absolute bottom-0 left-0 right-0 z-20 transition-opacity duration-300 ${
          controls || dragging ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/30 to-transparent pointer-events-none" />

        <div className="relative px-4 pb-3 pt-12">
          {/* Progress track */}
          <div
            ref={barRef}
            className="relative w-full h-1 rounded-full cursor-pointer group mb-3"
            onMouseDown={onBarDown}
            onMouseEnter={() => setHoverBar(true)}
            onMouseLeave={() => setHoverBar(false)}
          >
            <div className="absolute inset-0 bg-white/20 rounded-full" />
            <div
              className="absolute h-full bg-white/30 rounded-full"
              style={{ width: `${bufPct}%` }}
            />
            <div
              className="absolute h-full bg-white rounded-full transition-[width] duration-75"
              style={{ width: `${pct}%` }}
            />
            {/* Thumb */}
            <div
              className={`absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full shadow transition-opacity ${
                hoverBar || dragging ? 'opacity-100' : 'opacity-0'
              }`}
              style={{ left: `calc(${pct}% - 6px)` }}
            />
            {/* Expand hit area */}
            <div className="absolute -inset-y-2 inset-x-0" />
          </div>

          {/* Controls row */}
          <div className="flex items-center gap-2.5">
            {/* Play / Pause */}
            <button onClick={togglePlay} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-white/10 transition-colors">
              {playing ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="white"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg>
              )}
            </button>

            {/* Time */}
            <span className="text-[12px] text-white/80 tabular-nums min-w-[90px]">
              {fmt(shown)}<span className="text-white/40 mx-1">/</span>{fmt(dur)}
            </span>

            <div className="flex-1" />

            {/* Fullscreen */}
            <button onClick={toggleFs} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-white/10 transition-colors">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                {fs ? (
                  <><path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/></>
                ) : (
                  <><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></>
                )}
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
