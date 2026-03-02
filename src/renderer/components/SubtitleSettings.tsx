import { useState } from 'react'
import { usePlayerStore } from '../stores/playerStore'

export default function SubtitleSettings() {
  const [expanded, setExpanded] = useState(false)
  const subtitleSize = usePlayerStore((s) => s.subtitleSize)
  const subtitlePosition = usePlayerStore((s) => s.subtitlePosition)
  const setSubtitleSize = usePlayerStore((s) => s.setSubtitleSize)
  const setSubtitlePosition = usePlayerStore((s) => s.setSubtitlePosition)
  const status = usePlayerStore((s) => s.status)

  const handleSelectSubtitle = () => window.api.selectSubtitleFile()
  const handleRemoveSubtitle = () => window.api.removeSubtitle()

  const handleSizeChange = (size: number) => {
    setSubtitleSize(size)
    window.api.setSubtitleSize(size)
  }

  const handlePositionChange = (pos: number) => {
    setSubtitlePosition(pos)
    window.api.setSubtitlePosition(pos)
  }

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-[12px] text-fg-secondary hover:text-fg transition-colors"
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="currentColor"
          className={`transition-transform ${expanded ? 'rotate-90' : ''}`}
        >
          <path d="M3 1.5 L7 5 L3 8.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        字幕
        {status.subtitleFile && (
          <span className="text-[11px] text-fg-tertiary ml-1 truncate max-w-[120px]">
            · {status.subtitleFile.split('/').pop()?.split('\\').pop()}
          </span>
        )}
      </button>

      {expanded && (
        <div className="mt-3 flex flex-col gap-3 pl-4 animate-fade-in">
          <div className="flex items-center gap-2">
            <button
              onClick={handleSelectSubtitle}
              className="text-[12px] text-accent hover:text-accent-hover transition-colors"
            >
              选择字幕文件
            </button>
            {status.subtitleFile && (
              <button
                onClick={handleRemoveSubtitle}
                className="text-[12px] text-fg-tertiary hover:text-fg-secondary transition-colors"
              >
                移除
              </button>
            )}
          </div>

          <label className="flex items-center gap-3">
            <span className="text-[12px] text-fg-tertiary w-8 shrink-0">字号</span>
            <input
              type="range"
              min={24}
              max={72}
              value={subtitleSize}
              onChange={(e) => handleSizeChange(Number(e.target.value))}
              className="flex-1 h-1 accent-accent"
            />
            <span className="text-[11px] text-fg-tertiary w-6 text-right">{subtitleSize}</span>
          </label>

          <label className="flex items-center gap-3">
            <span className="text-[12px] text-fg-tertiary w-8 shrink-0">位置</span>
            <input
              type="range"
              min={50}
              max={100}
              value={subtitlePosition}
              onChange={(e) => handlePositionChange(Number(e.target.value))}
              className="flex-1 h-1 accent-accent"
            />
            <span className="text-[11px] text-fg-tertiary w-6 text-right">{subtitlePosition}</span>
          </label>
        </div>
      )}
    </div>
  )
}
