import { useRoomStore } from '../stores/roomStore'

export default function MemberList() {
  const members = useRoomStore((s) => s.members)

  if (members.length === 0) return null

  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-[12px] font-medium text-fg-tertiary uppercase tracking-wider mb-0.5">
        成员
      </h3>
      {members.map((m) => (
        <div
          key={m.id}
          className="flex items-center gap-2 py-1"
        >
          <div
            className={`w-1.5 h-1.5 rounded-full shrink-0 ${m.fileMatched ? 'bg-ok' : 'bg-fg-tertiary'}`}
          />
          <span className="text-[13px] text-fg truncate">{m.nickname}</span>
          {m.isHost && (
            <span className="text-[10px] text-fg-tertiary ml-auto shrink-0">房主</span>
          )}
        </div>
      ))}
    </div>
  )
}
