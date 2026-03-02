import { useRoomStore } from '../stores/roomStore'

export default function MemberList() {
  const members = useRoomStore((s) => s.members)

  if (members.length === 0) return null

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium text-gray-300">
        房间成员 <span className="text-gray-500">({members.length})</span>
      </h3>
      <div className="flex flex-wrap gap-2">
        {members.map((m) => (
          <div
            key={m.id}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-light/60 border border-white/5 text-xs"
          >
            <div
              className={`w-1.5 h-1.5 rounded-full ${m.fileMatched ? 'bg-green-400' : 'bg-gray-500'}`}
            />
            <span className="text-gray-300">{m.nickname}</span>
            {m.isHost && (
              <span className="text-[10px] text-accent bg-accent/10 px-1 rounded">房主</span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
