import { useRoomStore } from '../stores/roomStore'
import { usePlayerStore } from '../stores/playerStore'
import MemberList from '../components/MemberList'
import FileSelector from '../components/FileSelector'
import FileMatchStatus from '../components/FileMatchStatus'
import SubtitleSettings from '../components/SubtitleSettings'
import VideoPlayer from '../components/VideoPlayer'

export default function RoomPage() {
  const isHost = useRoomStore((s) => s.isHost)
  const mediaUrl = usePlayerStore((s) => s.mediaUrl)

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

        <div className="border-t border-black/[0.04] px-4 py-3 flex flex-col gap-3">
          <FileSelector />
          <FileMatchStatus />
          <SubtitleSettings />
        </div>
      </div>

      {/* Main: Player */}
      <div className="flex-1 flex flex-col bg-bg overflow-hidden">
        {mediaUrl ? (
          <div className="flex-1 flex items-center justify-center p-6">
            <div className="w-full max-w-4xl">
              <VideoPlayer />
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center animate-fade-in">
              <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-bg-secondary flex items-center justify-center">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#aeaeb2" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
              </div>
              <p className="text-[14px] text-fg-secondary">选择视频文件开始观看</p>
              <button
                onClick={() => window.api.selectVideoFile()}
                className="mt-4 px-5 py-2 rounded-xl bg-accent text-white text-[13px] font-medium hover:bg-accent-hover transition-all"
              >
                选择文件
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
