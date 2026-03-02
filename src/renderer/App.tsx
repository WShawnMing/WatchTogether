import { useEffect } from 'react'
import { useRoomStore } from './stores/roomStore'
import { usePlayerStore } from './stores/playerStore'
import HomePage from './pages/HomePage'
import RoomPage from './pages/RoomPage'
import Toast from './components/Toast'

export default function App() {
  const currentRoom = useRoomStore((s) => s.currentRoom)
  const setRooms = useRoomStore((s) => s.setRooms)
  const handleRoomUpdate = useRoomStore((s) => s.handleRoomUpdate)
  const setPlayerStatus = usePlayerStore((s) => s.setStatus)
  const setMedia = usePlayerStore((s) => s.setMedia)
  const setSubtitle = usePlayerStore((s) => s.setSubtitle)
  const addToast = usePlayerStore((s) => s.addToast)

  useEffect(() => {
    const unsubs = [
      window.api.onRoomList((rooms) => setRooms(rooms)),
      window.api.onRoomUpdate((data) => handleRoomUpdate(data)),
      window.api.onPlayerState((data) => setPlayerStatus(data)),
      window.api.onLoadMedia(({ url, filePath }) => setMedia(url, filePath)),
      window.api.onLoadSubtitle(({ url }) => setSubtitle(url)),
      window.api.onToast((data) => addToast(data))
    ]
    window.api.refreshRooms()
    return () => unsubs.forEach((fn) => fn())
  }, [])

  return (
    <div className="h-screen flex flex-col bg-bg">
      {/* Title bar */}
      <div
        className="flex items-center justify-between h-11 px-5 bg-bg-card border-b border-black/[0.04] shrink-0"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <span className="text-[13px] font-semibold text-fg tracking-tight">WatchTogether</span>
        {currentRoom && (
          <span className="text-2xs text-fg-tertiary">{currentRoom.name}</span>
        )}
      </div>

      <div className="flex-1 overflow-hidden">
        {currentRoom ? <RoomPage /> : <HomePage />}
      </div>

      <Toast />
    </div>
  )
}
