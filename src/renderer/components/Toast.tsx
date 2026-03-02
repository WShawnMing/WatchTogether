import { useEffect } from 'react'
import { usePlayerStore } from '../stores/playerStore'

const typeStyles: Record<string, string> = {
  info: 'bg-bg-card text-fg border border-black/[0.06]',
  success: 'bg-ok-light text-ok border border-ok/20',
  warning: 'bg-warn-light text-warn border border-warn/20',
  error: 'bg-err-light text-err border border-err/20'
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
    <div className="fixed bottom-5 right-5 flex flex-col gap-2 z-50 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`${typeStyles[t.type] ?? typeStyles.info} px-4 py-2.5 rounded-xl shadow-card text-[13px] animate-slide-in pointer-events-auto cursor-default`}
          onClick={() => removeToast(t.id)}
        >
          {t.text}
        </div>
      ))}
    </div>
  )
}
