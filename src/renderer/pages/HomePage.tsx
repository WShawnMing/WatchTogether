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
    <div className="flex flex-col h-full p-6 gap-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-gray-400">
            欢迎, <span className="text-white font-medium">{nickname}</span>
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="px-5 py-2 rounded-xl bg-accent hover:bg-accent-hover text-white text-sm font-medium transition-all shadow-lg shadow-accent/20"
        >
          开始共享
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <RoomList />
      </div>

      {showCreate && <CreateRoomDialog onClose={() => setShowCreate(false)} />}
    </div>
  )
}
