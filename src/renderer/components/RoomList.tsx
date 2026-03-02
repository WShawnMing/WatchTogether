import { useState } from 'react'
import { useRoomStore } from '../stores/roomStore'
import type { RoomInfo } from '../../shared/types'

export default function RoomList() {
  const rooms = useRoomStore((s) => s.rooms)
  const nickname = useRoomStore((s) => s.nickname)
  const [joiningId, setJoiningId] = useState<string | null>(null)
  const [passwordInput, setPasswordInput] = useState('')
  const [passwordRoomId, setPasswordRoomId] = useState<string | null>(null)

  const handleRefresh = () => {
    window.api.refreshRooms()
  }

  const handleJoin = async (room: RoomInfo) => {
    if (room.hasPassword) {
      setPasswordRoomId(room.id)
      setPasswordInput('')
      return
    }
    await doJoin(room.id)
  }

  const doJoin = async (roomId: string, password?: string) => {
    setJoiningId(roomId)
    setPasswordRoomId(null)
    const result = await window.api.joinRoom(roomId, nickname, password)
    if (!result.success) {
      setJoiningId(null)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-[13px] font-medium text-fg-secondary">附近房间</h3>
        <button
          onClick={handleRefresh}
          className="text-[12px] text-accent hover:text-accent-hover transition-colors"
        >
          刷新
        </button>
      </div>

      {rooms.length === 0 ? (
        <div className="py-8 text-center">
          <p className="text-[13px] text-fg-tertiary">暂无房间</p>
          <p className="text-[11px] text-fg-tertiary mt-1">确保双方在同一网络内</p>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {rooms.map((room) => (
            <div
              key={room.id}
              className="group flex items-center justify-between px-3 py-2.5 rounded-xl hover:bg-bg-secondary/80 transition-colors"
            >
              <div className="min-w-0">
                <div className="text-[13px] font-medium text-fg truncate flex items-center gap-1.5">
                  {room.name}
                  {room.hasPassword && (
                    <span className="text-[10px] text-fg-tertiary">🔒</span>
                  )}
                </div>
                <div className="text-[11px] text-fg-tertiary mt-0.5">
                  {room.hostNickname} · {room.memberCount}人
                </div>
              </div>

              {passwordRoomId === room.id ? (
                <div className="flex items-center gap-1.5 ml-2 shrink-0">
                  <input
                    type="password"
                    value={passwordInput}
                    onChange={(e) => setPasswordInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && doJoin(room.id, passwordInput)}
                    placeholder="密码"
                    className="w-20 px-2 py-1 rounded-lg bg-bg border border-black/[0.06] text-[12px] text-fg focus:border-accent/40 transition-colors"
                    autoFocus
                  />
                  <button
                    onClick={() => doJoin(room.id, passwordInput)}
                    className="text-[12px] text-accent"
                  >
                    加入
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => handleJoin(room)}
                  disabled={joiningId === room.id}
                  className="text-[12px] text-accent opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-50 ml-2 shrink-0"
                >
                  {joiningId === room.id ? '加入中' : '加入'}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
