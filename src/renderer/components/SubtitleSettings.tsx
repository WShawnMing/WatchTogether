import { useState } from 'react'
import { usePlayerStore } from '../stores/playerStore'

export default function SubtitleSettings() {
  const [expanded, setExpanded] = useState(false)
  const subtitleSize = usePlayerStore((s) => s.subtitleSize)
  const subtitlePosition = usePlayerStore((s) => s.subtitlePosition)
  const setSubtitleSize = usePlayerStore((s) => s.setSubtitleSize)
  const setSubtitlePosition = usePlayerStore((s) => s.setSubtitlePosition)
  const status = usePlayerStore((s) => s.status)

  const handleSelectSubtitle = async () => {
    await window.api.selectSubtitleFile()
  }

  const handleRemoveSubtitle = async () => {
    await window.api.removeSubtitle()
  }

  const handleSizeChange = (size: number) => {
    setSubtitleSize(size)
    window.api.setSubtitleSize(size)
  }

  const handlePositionChange = (pos: number) => {
    setSubtitlePosition(pos)
    window.api.setSubtitlePosition(pos)
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between text-sm font-medium text-gray-300 hover:text-white transition-colors"
      >
        <span>字幕设置</span>
        <span className="text-xs text-gray-500">{expanded ? '▼' : '▶'}</span>
      </button>

      {expanded && (
        <div className="flex flex-col gap-3 pl-1">
          <div className="flex items-center gap-2">
            <button
              onClick={handleSelectSubtitle}
              className="text-xs px-3 py-1 rounded-lg bg-accent/20 text-accent hover:bg-accent/30 transition-all"
            >
              选择字幕
            </button>
            {status.subtitleFile && (
              <button
                onClick={handleRemoveSubtitle}
                className="text-xs px-2 py-1 rounded-lg bg-white/5 text-gray-400 hover:bg-white/10 transition-all"
              >
                移除
              </button>
            )}
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">字号 ({subtitleSize})</span>
            <input
              type="range"
              min={24}
              max={72}
              value={subtitleSize}
              onChange={(e) => handleSizeChange(Number(e.target.value))}
              className="w-full accent-accent"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">位置 ({subtitlePosition})</span>
            <input
              type="range"
              min={50}
              max={100}
              value={subtitlePosition}
              onChange={(e) => handlePositionChange(Number(e.target.value))}
              className="w-full accent-accent"
            />
          </label>
        </div>
      )}
    </div>
  )
}
