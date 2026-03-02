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

  useEffect(() => {
    const { setMpvState, setFile, setTracks, addToast } = usePlayerStore.getState()
    const unsubs = [
      window.api.onRoomList((rooms) => setRooms(rooms)),
      window.api.onRoomUpdate((data) => handleRoomUpdate(data)),
      window.api.onMpvState((s) => setMpvState(s)),
      window.api.onFileLoaded(({ filePath, fileName }) => setFile(filePath, fileName)),
      window.api.onMpvTracks(({ subs, audio }) => setTracks(subs, audio)),
      window.api.onToast((data) => addToast(data))
    ]
    window.api.refreshRooms()
    return () => unsubs.forEach((fn) => fn())
  }, [])

  return (
    <div className="h-screen flex flex-col bg-bg">
      <div
        className="flex items-center h-11 px-5 bg-bg-card border-b border-black/[0.04] shrink-0"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="w-[70px] shrink-0" />
        <div className="flex-1 text-center">
          <span className="text-[13px] font-semibold text-fg tracking-tight">WatchTogether</span>
        </div>
        <div className="w-[70px] shrink-0 flex justify-end">
          {currentRoom && (
            <span className="text-2xs text-fg-tertiary truncate">{currentRoom.name}</span>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-hidden">
        {currentRoom ? <RoomPage /> : <HomePage />}
      </div>

      <Toast />
    </div>
  )
}
