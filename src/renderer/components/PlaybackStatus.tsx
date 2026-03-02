import { usePlayerStore } from '../stores/playerStore'

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

export default function PlaybackStatus() {
  const status = usePlayerStore((s) => s.status)

  if (!status.file) {
    return (
      <div className="flex items-center justify-center py-16">
        <p className="text-[14px] text-fg-tertiary">选择视频文件开始观看</p>
      </div>
    )
  }

  const progress = status.duration > 0 ? (status.position / status.duration) * 100 : 0

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (status.duration <= 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    window.api.seek(ratio * status.duration)
  }

  return (
    <div className="flex flex-col gap-4 animate-fade-in">
      {/* Progress bar */}
      <div className="flex flex-col gap-2">
        <div
          className="w-full h-1 bg-black/[0.06] rounded-full cursor-pointer group relative"
          onClick={handleSeek}
        >
          <div
            className="h-full bg-accent rounded-full transition-all duration-150 relative"
            style={{ width: `${progress}%` }}
          >
            <div className="absolute right-0 top-1/2 -translate-y-1/2 w-2.5 h-2.5 bg-accent rounded-full opacity-0 group-hover:opacity-100 transition-opacity shadow-sm" />
          </div>
        </div>
        <div className="flex justify-between text-[11px] text-fg-tertiary">
          <span>{formatTime(status.position)}</span>
          <span>{formatTime(status.duration)}</span>
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center justify-center gap-5">
        <button
          onClick={() => window.api.seek(Math.max(0, status.position - 10))}
          className="w-8 h-8 flex items-center justify-center rounded-full text-fg-secondary hover:text-fg hover:bg-bg-secondary transition-all"
          title="后退 10s"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="11 17 6 12 11 7" />
            <polyline points="18 17 13 12 18 7" />
          </svg>
        </button>

        <button
          onClick={() => window.api.togglePause()}
          className="w-10 h-10 flex items-center justify-center rounded-full bg-fg text-bg-card hover:bg-fg/90 transition-all"
        >
          {status.paused ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="4" width="4" height="16" rx="1" />
              <rect x="14" y="4" width="4" height="16" rx="1" />
            </svg>
          )}
        </button>

        <button
          onClick={() => window.api.seek(Math.min(status.duration, status.position + 10))}
          className="w-8 h-8 flex items-center justify-center rounded-full text-fg-secondary hover:text-fg hover:bg-bg-secondary transition-all"
          title="快进 10s"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="13 17 18 12 13 7" />
            <polyline points="6 17 11 12 6 7" />
          </svg>
        </button>
      </div>

      {/* State pill */}
      <div className="flex justify-center">
        <span className={`text-[11px] px-2.5 py-0.5 rounded-full ${
          status.paused
            ? 'bg-bg-secondary text-fg-secondary'
            : 'bg-ok-light text-ok'
        }`}>
          {status.paused ? '已暂停' : '播放中'}
        </span>
      </div>
    </div>
  )
}
