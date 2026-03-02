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
  const addToast = usePlayerStore((s) => s.addToast)

  useEffect(() => {
    const unsubs = [
      window.api.onRoomList((rooms) => setRooms(rooms)),
      window.api.onRoomUpdate((data) => handleRoomUpdate(data)),
      window.api.onPlayerState((data) => setPlayerStatus(data)),
      window.api.onToast((data) => addToast(data))
    ]
    window.api.refreshRooms()
    return () => unsubs.forEach((fn) => fn())
  }, [])

  return (
    <div className="h-screen flex flex-col bg-surface text-gray-100">
      <div className="flex items-center h-10 draggable-region px-4 bg-surface-light/50 border-b border-white/5"
           style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
        <span className="text-sm font-semibold tracking-wide text-accent">WatchTogether</span>
      </div>
      <div className="flex-1 overflow-hidden">
        {currentRoom ? <RoomPage /> : <HomePage />}
      </div>
      <Toast />
    </div>
  )
}
