import { useRoomStore } from '../stores/roomStore'
import MemberList from '../components/MemberList'
import FileSelector from '../components/FileSelector'
import FileMatchStatus from '../components/FileMatchStatus'
import PlaybackStatus from '../components/PlaybackStatus'
import SubtitleSettings from '../components/SubtitleSettings'

export default function RoomPage() {
  const isHost = useRoomStore((s) => s.isHost)

  const handleLeave = async () => {
    await window.api.leaveRoom()
  }

  return (
    <div className="flex flex-col h-full p-6 gap-5 overflow-y-auto">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
          <span className="text-sm text-gray-300">
            {isHost ? '你是房主' : '已加入房间'}
          </span>
        </div>
        <button
          onClick={handleLeave}
          className="text-xs px-3 py-1.5 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-all"
        >
          离开房间
        </button>
      </div>

      <MemberList />

      <div className="border-t border-white/5" />

      <FileSelector />
      <FileMatchStatus />

      <div className="border-t border-white/5" />

      <PlaybackStatus />

      <div className="border-t border-white/5" />

      <SubtitleSettings />
    </div>
  )
}
