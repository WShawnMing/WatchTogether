import { useEffect } from 'react'
import { usePlayerStore } from '../stores/playerStore'

const typeStyles: Record<string, string> = {
  info: 'bg-blue-500/90',
  success: 'bg-green-500/90',
  warning: 'bg-amber-500/90',
  error: 'bg-red-500/90'
}

export default function Toast() {
  const toasts = usePlayerStore((s) => s.toasts)
  const removeToast = usePlayerStore((s) => s.removeToast)

  useEffect(() => {
    const timers = toasts.map((t) =>
      setTimeout(() => removeToast(t.id), t.duration ?? 3000)
    )
    return () => timers.forEach(clearTimeout)
  }, [toasts])

  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-6 right-6 flex flex-col gap-2 z-50 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`${typeStyles[t.type] ?? typeStyles.info} text-white px-4 py-2.5 rounded-lg shadow-lg text-sm backdrop-blur-sm animate-slide-in pointer-events-auto`}
          onClick={() => removeToast(t.id)}
        >
          {t.text}
        </div>
      ))}
    </div>
  )
}
