import { useEffect, useState } from 'react'
import { formatBytes, useOfflineStore } from '../pwa/offlineStore'
import { useAssemblyStore } from '../store/assemblyStore'

/**
 * The offline control, in the top bar next to Save/Load.
 *
 * It sits there because that is where "what happens to my build" already
 * lives: Save JSON keeps the build, and this keeps the PARTS the build is made
 * of. Those are the two halves of taking a robot home from a lesson, and
 * separating them by panel would hide the second one.
 *
 * Three states, no menu:
 *   nothing        development, or a browser with no service worker.
 *   Update ready   a newer build is installed; one press reloads into it.
 *   Offline ⤓      press to fetch the current scene's models into the cache.
 *
 * It renders nothing at all rather than a disabled control when the feature is
 * unavailable: a greyed-out button in the top bar of a classroom tool is a
 * question thirty students will ask.
 */
export default function OfflineButton() {
  const supported = useOfflineStore((s) => s.supported)
  const ready = useOfflineStore((s) => s.ready)
  const updateReady = useOfflineStore((s) => s.updateReady)
  const cachedFiles = useOfflineStore((s) => s.cachedFiles)
  const cachedBytes = useOfflineStore((s) => s.cachedBytes)
  const busy = useOfflineStore((s) => s.busy)
  const message = useOfflineStore((s) => s.message)
  const save = useOfflineStore((s) => s.saveSceneForOffline)
  const setStatus = useAssemblyStore((s) => s.setStatus)
  const [online, setOnline] = useState(() => navigator.onLine)

  // The label has to be able to say "you are offline and this still works",
  // which is the whole promise being made.
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])

  // Route the store's own reporting through the one status bar the app has,
  // instead of inventing a second place for messages to appear.
  useEffect(() => {
    if (message) setStatus(message)
  }, [message, setStatus])

  if (!supported) return null

  if (updateReady) {
    return (
      <button
        className="offline-btn update"
        onClick={() => window.location.reload()}
        title="A newer version of the builder has been downloaded. Reload to use it — your build is autosaved."
      >
        ⟳ Update ready
      </button>
    )
  }

  const cachedLabel =
    cachedFiles > 0 ? ` · ${cachedFiles} parts, ${formatBytes(cachedBytes)}` : ''

  return (
    <button
      className={`offline-btn${ready ? ' ready' : ''}${online ? '' : ' offline'}`}
      disabled={busy}
      onClick={() => void save()}
      title={
        ready
          ? `The builder itself already opens without a connection. Press to also store the part models this build uses, so it opens complete offline.${cachedLabel}`
          : 'Preparing offline support…'
      }
    >
      {busy ? '⤓ Saving…' : online ? '⤓ Offline' : '⤓ Offline ✓'}
    </button>
  )
}
