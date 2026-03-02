import { usePlayerStore } from '../stores/playerStore'

function fmtTime(s: number): string {
  if (!isFinite(s) || s < 0) return '0:00'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`
}

export default function NowPlaying() {
  const mpv = usePlayerStore((s) => s.mpv)
  const filePath = usePlayerStore((s) => s.filePath)
  const fileName = usePlayerStore((s) => s.fileName)
  const subTracks = usePlayerStore((s) => s.subTracks)
  const audioTracks = usePlayerStore((s) => s.audioTracks)

  if (!filePath) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center animate-fade-in">
          <div className="w-20 h-20 mx-auto mb-5 rounded-3xl bg-bg-secondary flex items-center justify-center">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#c7c7cc" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
          </div>
          <p className="text-[15px] text-fg-secondary mb-1">选择视频开始观看</p>
          <p className="text-[12px] text-fg-tertiary mb-5">视频将在独立的播放器窗口中打开</p>
          <button
            onClick={() => window.api.selectVideoFile()}
            className="px-6 py-2.5 rounded-xl bg-accent text-white text-[13px] font-medium hover:bg-accent-hover transition-all shadow-sm"
          >
            选择文件
          </button>
        </div>
      </div>
    )
  }

  const pos = mpv?.position ?? 0
  const dur = mpv?.duration ?? 0
  const paused = mpv?.paused ?? true
  const pct = dur > 0 ? (pos / dur) * 100 : 0

  return (
    <div className="flex-1 flex flex-col p-6 animate-fade-in">
      {/* Now Playing Card */}
      <div className="bg-bg-card rounded-2xl p-5 shadow-sm border border-black/[0.04]">
        <div className="flex items-start gap-4">
          {/* Playback indicator */}
          <div className="w-14 h-14 rounded-2xl bg-black/[0.04] flex items-center justify-center shrink-0">
            {paused ? (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#8e8e93" strokeWidth="2">
                <rect x="6" y="4" width="4" height="16" rx="1" />
                <rect x="14" y="4" width="4" height="16" rx="1" />
              </svg>
            ) : (
              <div className="flex items-center gap-[3px]">
                <div className="w-[3px] h-4 bg-accent rounded-full animate-pulse" style={{ animationDelay: '0ms' }} />
                <div className="w-[3px] h-5 bg-accent rounded-full animate-pulse" style={{ animationDelay: '150ms' }} />
                <div className="w-[3px] h-3 bg-accent rounded-full animate-pulse" style={{ animationDelay: '300ms' }} />
                <div className="w-[3px] h-5 bg-accent rounded-full animate-pulse" style={{ animationDelay: '450ms' }} />
              </div>
            )}
          </div>

          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-medium text-fg truncate">{fileName || '未知文件'}</p>
            <div className="flex items-center gap-2 mt-1">
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${paused ? 'bg-fg-tertiary' : 'bg-ok'}`} />
              <span className="text-[12px] text-fg-tertiary">
                {paused ? '已暂停' : '正在播放'}
              </span>
            </div>

            {/* Progress */}
            <div className="mt-3">
              <div className="w-full h-1 bg-black/[0.06] rounded-full overflow-hidden">
                <div className="h-full bg-accent rounded-full transition-all duration-300" style={{ width: `${pct}%` }} />
              </div>
              <div className="flex justify-between mt-1">
                <span className="text-[11px] text-fg-tertiary tabular-nums">{fmtTime(pos)}</span>
                <span className="text-[11px] text-fg-tertiary tabular-nums">{fmtTime(dur)}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Tracks Info */}
      {(subTracks.length > 0 || audioTracks.length > 0) && (
        <div className="mt-4 bg-bg-card rounded-2xl p-4 shadow-sm border border-black/[0.04]">
          <p className="text-[12px] text-fg-tertiary mb-3 font-medium">媒体信息</p>
          <div className="flex flex-col gap-2">
            {audioTracks.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-fg-tertiary w-10 shrink-0">音轨</span>
                <span className="text-[12px] text-fg-secondary">
                  {audioTracks.length} 条
                  {audioTracks.find((t) => t.selected) &&
                    ` · 当前: ${audioTracks.find((t) => t.selected)?.title || '默认'}`}
                </span>
              </div>
            )}
            {subTracks.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-fg-tertiary w-10 shrink-0">字幕</span>
                <span className="text-[12px] text-fg-secondary">
                  {subTracks.length} 条
                  {subTracks.find((t) => t.selected) &&
                    ` · 当前: ${subTracks.find((t) => t.selected)?.title || '默认'}`}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="mt-4 flex gap-2">
        <button
          onClick={() => window.api.selectVideoFile()}
          className="px-4 py-2 rounded-xl bg-bg-card text-[12px] text-fg-secondary font-medium hover:bg-bg-secondary transition-colors border border-black/[0.04]"
        >
          切换文件
        </button>
        <button
          onClick={() => window.api.selectSubtitleFile()}
          className="px-4 py-2 rounded-xl bg-bg-card text-[12px] text-fg-secondary font-medium hover:bg-bg-secondary transition-colors border border-black/[0.04]"
        >
          加载字幕
        </button>
      </div>

      {/* Tip */}
      <div className="mt-auto pt-6">
        <p className="text-[11px] text-fg-tertiary text-center">
          播放控制（暂停、进度、音量、字幕等）请在 mpv 播放器窗口中操作
        </p>
      </div>
    </div>
  )
}
