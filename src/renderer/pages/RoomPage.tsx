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
    <div className="flex h-full">
      {/* Sidebar */}
      <div className="w-56 shrink-0 border-r border-black/[0.04] bg-bg-card flex flex-col">
        <div className="px-4 pt-4 pb-3 flex items-center justify-between">
          <span className="text-[12px] text-fg-secondary flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-ok inline-block" />
            {isHost ? '你的房间' : '已加入'}
          </span>
          <button
            onClick={handleLeave}
            className="text-[11px] text-fg-tertiary hover:text-err transition-colors"
          >
            离开
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4">
          <MemberList />
        </div>

        {/* Sidebar bottom: file & subtitle */}
        <div className="border-t border-black/[0.04] px-4 py-3 flex flex-col gap-3">
          <FileSelector />
          <FileMatchStatus />
          <SubtitleSettings />
        </div>
      </div>

      {/* Main: Player area */}
      <div className="flex-1 flex flex-col bg-bg">
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="w-full max-w-xl">
            <PlaybackStatus />
          </div>
        </div>
      </div>
    </div>
  )
}
