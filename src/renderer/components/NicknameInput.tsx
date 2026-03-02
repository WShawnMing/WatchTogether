import { useState } from 'react'
import { useRoomStore } from '../stores/roomStore'

interface Props {
  onConfirm: () => void
}

export default function NicknameInput({ onConfirm }: Props) {
  const nickname = useRoomStore((s) => s.nickname)
  const setNickname = useRoomStore((s) => s.setNickname)
  const [input, setInput] = useState(nickname)

  const handleSubmit = () => {
    const trimmed = input.trim()
    if (!trimmed) return
    setNickname(trimmed)
    window.api.setNickname(trimmed)
    onConfirm()
  }

  return (
    <div className="flex flex-col items-center justify-center h-full gap-8">
      <div className="text-center">
        <h1 className="text-3xl font-bold text-white mb-2">WatchTogether</h1>
        <p className="text-gray-400 text-sm">和朋友一起看片，进度实时同步</p>
      </div>
      <div className="flex flex-col gap-4 w-72">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          placeholder="输入你的昵称"
          maxLength={20}
          className="px-4 py-3 rounded-xl bg-surface-light border border-white/10 text-white placeholder-gray-500 focus:outline-none focus:border-accent transition-colors text-center"
          autoFocus
        />
        <button
          onClick={handleSubmit}
          disabled={!input.trim()}
          className="px-6 py-3 rounded-xl bg-accent hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium transition-all"
        >
          进入大厅
        </button>
      </div>
    </div>
  )
}
