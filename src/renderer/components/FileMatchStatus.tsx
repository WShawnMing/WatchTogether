import { useRoomStore } from '../stores/roomStore'
import { usePlayerStore } from '../stores/playerStore'

export default function FileMatchStatus() {
  const isHost = useRoomStore((s) => s.isHost)
  const fileMatched = useRoomStore((s) => s.fileMatched)
  const hostFingerprint = useRoomStore((s) => s.hostFingerprint)
  const status = usePlayerStore((s) => s.status)

  if (!status.file) return null

  if (isHost) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-green-500/10 border border-green-500/20">
        <div className="w-2 h-2 rounded-full bg-green-400" />
        <span className="text-xs text-green-300">房主 · 等待其他成员选择片源</span>
      </div>
    )
  }

  if (!hostFingerprint) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
        <div className="w-2 h-2 rounded-full bg-yellow-400" />
        <span className="text-xs text-yellow-300">等待房主选择片源</span>
      </div>
    )
  }

  if (fileMatched) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-green-500/10 border border-green-500/20">
        <div className="w-2 h-2 rounded-full bg-green-400" />
        <span className="text-xs text-green-300">片源已匹配 · 可以开始观看</span>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20">
      <div className="w-2 h-2 rounded-full bg-red-400" />
      <span className="text-xs text-red-300">片源不一致 · 请重新选择相同的视频文件</span>
    </div>
  )
}
