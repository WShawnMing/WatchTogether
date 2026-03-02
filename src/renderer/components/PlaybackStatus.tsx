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
      <div className="text-center py-6 text-gray-500 text-sm">
        请选择视频文件开始观看
      </div>
    )
  }

  const progress = status.duration > 0 ? (status.position / status.duration) * 100 : 0

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between text-xs text-gray-400">
        <span>{formatTime(status.position)}</span>
        <span className={`px-2 py-0.5 rounded ${status.paused ? 'bg-yellow-500/20 text-yellow-300' : 'bg-green-500/20 text-green-300'}`}>
          {status.paused ? '已暂停' : '播放中'}
        </span>
        <span>{formatTime(status.duration)}</span>
      </div>

      <div className="w-full h-1.5 bg-white/10 rounded-full overflow-hidden">
        <div
          className="h-full bg-accent rounded-full transition-all duration-300"
          style={{ width: `${progress}%` }}
        />
      </div>

      <div className="flex items-center justify-center gap-3">
        <button
          onClick={() => window.api.seek(Math.max(0, status.position - 10))}
          className="p-2 rounded-lg hover:bg-white/5 text-gray-400 hover:text-white transition-all text-sm"
          title="后退 10 秒"
        >
          ⏪
        </button>
        <button
          onClick={() => window.api.togglePause()}
          className="p-3 rounded-xl bg-accent/20 hover:bg-accent/30 text-accent text-lg transition-all"
        >
          {status.paused ? '▶' : '⏸'}
        </button>
        <button
          onClick={() => window.api.seek(Math.min(status.duration, status.position + 10))}
          className="p-2 rounded-lg hover:bg-white/5 text-gray-400 hover:text-white transition-all text-sm"
          title="快进 10 秒"
        >
          ⏩
        </button>
      </div>

      {status.subtitleFile && (
        <div className="text-[11px] text-gray-500 text-center truncate">
          字幕: {status.subtitleFile.split('/').pop()?.split('\\').pop()}
        </div>
      )}
    </div>
  )
}
