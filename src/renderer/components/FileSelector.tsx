import { useState } from 'react'
import { usePlayerStore } from '../stores/playerStore'

export default function FileSelector() {
  const status = usePlayerStore((s) => s.status)
  const [loading, setLoading] = useState(false)

  const handleSelect = async () => {
    setLoading(true)
    try {
      await window.api.selectVideoFile()
    } finally {
      setLoading(false)
    }
  }

  const fileName = status.file ? status.file.split('/').pop()?.split('\\').pop() : null

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0 flex-1">
        {fileName ? (
          <p className="text-[13px] text-fg truncate">{fileName}</p>
        ) : (
          <p className="text-[13px] text-fg-tertiary">未选择视频</p>
        )}
      </div>
      <button
        onClick={handleSelect}
        disabled={loading}
        className="text-[12px] text-accent hover:text-accent-hover disabled:opacity-50 transition-colors shrink-0"
      >
        {loading ? '加载中...' : fileName ? '切换' : '选择文件'}
      </button>
    </div>
  )
}
