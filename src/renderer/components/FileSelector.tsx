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
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-300">视频文件</h3>
        <button
          onClick={handleSelect}
          disabled={loading}
          className="text-xs px-3 py-1 rounded-lg bg-accent/20 text-accent hover:bg-accent/30 disabled:opacity-50 transition-all"
        >
          {loading ? '加载中...' : fileName ? '切换片源' : '选择文件'}
        </button>
      </div>
      {fileName && (
        <div className="text-xs text-gray-400 truncate bg-surface/50 px-3 py-2 rounded-lg border border-white/5">
          {fileName}
        </div>
      )}
    </div>
  )
}
