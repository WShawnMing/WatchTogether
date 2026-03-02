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
    <div className="flex flex-col items-center justify-center h-full animate-fade-in">
      <div className="flex flex-col items-center gap-8 w-72">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-fg tracking-tight">WatchTogether</h1>
          <p className="text-fg-secondary text-[13px] mt-1.5">和朋友一起看，进度实时同步</p>
        </div>

        <div className="flex flex-col gap-3 w-full">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
            placeholder="你的昵称"
            maxLength={20}
            className="px-4 py-2.5 rounded-xl bg-bg border border-black/[0.08] text-fg text-[14px] placeholder-fg-tertiary focus:border-accent/40 focus:ring-2 focus:ring-accent/10 transition-all text-center"
            autoFocus
          />
          <button
            onClick={handleSubmit}
            disabled={!input.trim()}
            className="px-6 py-2.5 rounded-xl bg-accent text-white text-[14px] font-medium hover:bg-accent-hover disabled:opacity-30 disabled:cursor-not-allowed transition-all"
          >
            开始
          </button>
        </div>
      </div>
    </div>
  )
}
