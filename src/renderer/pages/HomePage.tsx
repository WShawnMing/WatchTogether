import { useState } from 'react'
import { useRoomStore } from '../stores/roomStore'
import NicknameInput from '../components/NicknameInput'
import RoomList from '../components/RoomList'
import CreateRoomDialog from '../components/CreateRoomDialog'

export default function HomePage() {
  const nickname = useRoomStore((s) => s.nickname)
  const [showCreate, setShowCreate] = useState(false)
  const [nicknameSet, setNicknameSet] = useState(!!nickname)

  if (!nicknameSet) {
    return <NicknameInput onConfirm={() => setNicknameSet(true)} />
  }

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <div className="w-64 shrink-0 border-r border-black/[0.04] bg-bg-card flex flex-col">
        <div className="px-4 pt-4 pb-3">
          <p className="text-[12px] text-fg-tertiary">
            {nickname}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-3">
          <RoomList />
        </div>

        <div className="p-3 border-t border-black/[0.04]">
          <button
            onClick={() => setShowCreate(true)}
            className="w-full py-2.5 rounded-xl bg-accent text-white text-[13px] font-medium hover:bg-accent-hover transition-all"
          >
            开始共享
          </button>
        </div>
      </div>

      {/* Main area */}
      <div className="flex-1 flex items-center justify-center bg-bg">
        <div className="text-center animate-fade-in">
          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-bg-secondary flex items-center justify-center">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#aeaeb2" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
          </div>
          <p className="text-[15px] font-medium text-fg">创建或加入房间</p>
          <p className="text-[13px] text-fg-tertiary mt-1">在左侧选择一个房间，或创建新房间开始观影</p>
        </div>
      </div>

      {showCreate && <CreateRoomDialog onClose={() => setShowCreate(false)} />}
    </div>
  )
}
