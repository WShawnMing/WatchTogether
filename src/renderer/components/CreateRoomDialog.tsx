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
    <div className="fixed inset-0 bg-black/20 flex items-center justify-center z-40 backdrop-blur-sm animate-fade-in">
      <div className="bg-bg-card rounded-2xl p-6 w-80 shadow-card-hover border border-black/[0.04]">
        <h3 className="text-[16px] font-semibold text-fg mb-5">创建房间</h3>

        <div className="flex flex-col gap-3">
          <input
            type="text"
            value={roomName}
            onChange={(e) => setRoomName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            placeholder="房间名称"
            maxLength={30}
            className="px-3.5 py-2.5 rounded-xl bg-bg border border-black/[0.08] text-fg text-[14px] placeholder-fg-tertiary focus:border-accent/40 focus:ring-2 focus:ring-accent/10 transition-all"
            autoFocus
          />

          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            placeholder="密码（可选）"
            maxLength={30}
            className="px-3.5 py-2.5 rounded-xl bg-bg border border-black/[0.08] text-fg text-[14px] placeholder-fg-tertiary focus:border-accent/40 focus:ring-2 focus:ring-accent/10 transition-all"
          />

          {error && <p className="text-[12px] text-err">{error}</p>}

          <div className="flex gap-2 mt-1">
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2.5 rounded-xl text-fg-secondary text-[14px] hover:bg-bg-secondary transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleCreate}
              disabled={!roomName.trim() || creating}
              className="flex-1 px-4 py-2.5 rounded-xl bg-accent text-white text-[14px] font-medium hover:bg-accent-hover disabled:opacity-30 disabled:cursor-not-allowed transition-all"
            >
              {creating ? '创建中...' : '开始共享'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
