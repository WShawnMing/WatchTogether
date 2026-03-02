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
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">附近房间</h2>
        <button
          onClick={handleRefresh}
          className="text-xs text-accent hover:text-accent-hover transition-colors px-3 py-1 rounded-lg hover:bg-white/5"
        >
          刷新
        </button>
      </div>

      {rooms.length === 0 ? (
        <div className="text-center py-12 text-gray-500 text-sm">
          <p>暂无发现房间</p>
          <p className="mt-1 text-xs text-gray-600">请确保双方在同一局域网内</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {rooms.map((room) => (
            <div
              key={room.id}
              className="flex items-center justify-between px-4 py-3 rounded-xl bg-surface-light/60 border border-white/5 hover:border-accent/30 transition-all"
            >
              <div>
                <div className="text-sm font-medium text-white flex items-center gap-2">
                  {room.name}
                  {room.hasPassword && (
                    <span className="text-[10px] text-gray-400 bg-white/5 px-1.5 py-0.5 rounded">🔒</span>
                  )}
                </div>
                <div className="text-xs text-gray-500 mt-0.5">
                  {room.hostNickname} · {room.memberCount} 人
                </div>
              </div>

              {passwordRoomId === room.id ? (
                <div className="flex items-center gap-2">
                  <input
                    type="password"
                    value={passwordInput}
                    onChange={(e) => setPasswordInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && doJoin(room.id, passwordInput)}
                    placeholder="密码"
                    className="w-24 px-2 py-1 rounded-lg bg-surface border border-white/10 text-white text-xs focus:outline-none focus:border-accent"
                    autoFocus
                  />
                  <button
                    onClick={() => doJoin(room.id, passwordInput)}
                    className="text-xs text-accent hover:text-accent-hover px-2 py-1"
                  >
                    确定
                  </button>
                  <button
                    onClick={() => setPasswordRoomId(null)}
                    className="text-xs text-gray-500 hover:text-gray-300 px-1 py-1"
                  >
                    取消
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => handleJoin(room)}
                  disabled={joiningId === room.id}
                  className="text-xs px-4 py-1.5 rounded-lg bg-accent/20 text-accent hover:bg-accent/30 disabled:opacity-50 transition-all"
                >
                  {joiningId === room.id ? '加入中...' : '加入'}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
