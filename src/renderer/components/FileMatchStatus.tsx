import { useRoomStore } from '../stores/roomStore'
import { usePlayerStore } from '../stores/playerStore'

export default function FileMatchStatus() {
  const isHost = useRoomStore((s) => s.isHost)
  const fileMatched = useRoomStore((s) => s.fileMatched)
  const hostFingerprint = useRoomStore((s) => s.hostFingerprint)
  const status = usePlayerStore((s) => s.status)

  if (!status.file) return null

  let dotColor = 'bg-fg-tertiary'
  let text = ''
  let textColor = 'text-fg-tertiary'

  if (isHost) {
    dotColor = 'bg-ok'
    text = '等待其他人选择相同片源'
    textColor = 'text-fg-secondary'
  } else if (!hostFingerprint) {
    text = '等待房主选择片源'
    textColor = 'text-fg-secondary'
  } else if (fileMatched) {
    dotColor = 'bg-ok'
    text = '片源已匹配'
    textColor = 'text-ok'
  } else {
    dotColor = 'bg-err'
    text = '文件不一致，请重新选择'
    textColor = 'text-err'
  }

  return (
    <div className="flex items-center gap-2">
      <div className={`w-1.5 h-1.5 rounded-full ${dotColor} shrink-0`} />
      <span className={`text-[12px] ${textColor}`}>{text}</span>
    </div>
  )
}
