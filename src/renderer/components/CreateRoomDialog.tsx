import { useState } from 'react'

interface Props {
  onClose: () => void
}

export default function CreateRoomDialog({ onClose }: Props) {
  const [roomName, setRoomName] = useState('')
  const [password, setPassword] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')

  const handleCreate = async () => {
    const name = roomName.trim()
    if (!name) return

    setCreating(true)
    setError('')

    const result = await window.api.createRoom(name, password || undefined)
    if (!result.success) {
      setError(result.error || '创建失败')
      setCreating(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-40 backdrop-blur-sm">
      <div className="bg-surface-light rounded-2xl p-6 w-80 shadow-2xl border border-white/10">
        <h3 className="text-lg font-semibold text-white mb-4">创建房间</h3>

        <div className="flex flex-col gap-3">
          <input
            type="text"
            value={roomName}
            onChange={(e) => setRoomName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            placeholder="房间名称"
            maxLength={30}
            className="px-3 py-2.5 rounded-xl bg-surface border border-white/10 text-white placeholder-gray-500 focus:outline-none focus:border-accent transition-colors text-sm"
            autoFocus
          />

          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            placeholder="房间密码（可选）"
            maxLength={30}
            className="px-3 py-2.5 rounded-xl bg-surface border border-white/10 text-white placeholder-gray-500 focus:outline-none focus:border-accent transition-colors text-sm"
          />

          {error && <p className="text-xs text-red-400">{error}</p>}

          <div className="flex gap-2 mt-2">
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2.5 rounded-xl bg-white/5 text-gray-400 hover:bg-white/10 transition-colors text-sm"
            >
              取消
            </button>
            <button
              onClick={handleCreate}
              disabled={!roomName.trim() || creating}
              className="flex-1 px-4 py-2.5 rounded-xl bg-accent hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium transition-all text-sm"
            >
              {creating ? '创建中...' : '开始共享'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
