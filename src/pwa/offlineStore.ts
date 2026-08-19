import { create } from 'zustand'
import { getPartDefinition } from '../data/parts'
import { useAssemblyStore } from '../store/assemblyStore'
import { assetUrl } from '../utils/assetUrl'

/**
 * Offline / install state, kept OUT of `assemblyStore`.
 *
 * Nothing here is about the assembly — it is about the document the assembly
 * is edited in — and `assemblyStore` is already 3,400 lines that every part of
 * the app subscribes to. A separate store means a cache-status poll cannot
 * re-render the viewport, and it reads the parts list through `getState()` at
 * the moment the button is pressed, which is the only time it needs it.
 */

export type OfflineState = {
  /** Service workers exist AND the page is a production build served over TLS. */
  supported: boolean
  /** The worker controlling this page is ours and has activated. */
  ready: boolean
  /** A newer build has installed; the page is still running the old one. */
  updateReady: boolean
  /** Files and bytes currently held in the part-model cache. */
  cachedFiles: number
  cachedBytes: number
  busy: boolean
  message: string | null
}

type OfflineStore = OfflineState & {
  register: () => void
  refreshStatus: () => Promise<void>
  saveSceneForOffline: () => Promise<void>
  clearModelCache: () => Promise<void>
}

/** Ask the active worker a question and wait for its reply, or give up. */
function ask<T>(message: unknown, timeoutMs = 20000): Promise<T | null> {
  const worker = navigator.serviceWorker?.controller
  if (!worker) return Promise.resolve(null)
  return new Promise<T | null>((resolve) => {
    const channel = new MessageChannel()
    const timer = window.setTimeout(() => resolve(null), timeoutMs)
    channel.port1.onmessage = (event) => {
      window.clearTimeout(timer)
      resolve(event.data as T)
    }
    worker.postMessage(message, [channel.port2])
  })
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Every distinct part-model URL used by the parts currently in the scene. */
export function sceneModelUrls(): string[] {
  const urls = new Set<string>()
  for (const part of useAssemblyStore.getState().parts) {
    const def = getPartDefinition(part.partId)
    if (def?.modelPath) urls.add(assetUrl(def.modelPath))
  }
  return [...urls]
}

export const useOfflineStore = create<OfflineStore>((set, get) => ({
  supported: false,
  ready: false,
  updateReady: false,
  cachedFiles: 0,
  cachedBytes: 0,
  busy: false,
  message: null,

  register: () => {
    // DEV is excluded deliberately: a worker caching Vite's rewritten module
    // urls would serve yesterday's modules through today's edits, and the only
    // cure is a manual unregister in devtools.
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
    set({ supported: true })

    const url = assetUrl('/sw.js')
    const scope = import.meta.env.BASE_URL || '/'
    navigator.serviceWorker
      .register(url, { scope })
      .then((registration) => {
        // A worker that installs while one is already controlling the page is
        // by definition a NEW build. The page keeps running the code it loaded
        // — swapping JS under a live React tree is how a PWA breaks — so this
        // only offers a reload.
        registration.addEventListener('updatefound', () => {
          const installing = registration.installing
          if (!installing) return
          installing.addEventListener('statechange', () => {
            if (
              installing.state === 'installed' &&
              navigator.serviceWorker.controller
            ) {
              set({ updateReady: true })
            }
          })
        })
      })
      .catch(() => {
        set({ supported: false })
      })

    const markReady = () => {
      set({ ready: true })
      void get().refreshStatus()
    }
    if (navigator.serviceWorker.controller) markReady()
    // First visit: the worker activates and claims the page a moment later.
    navigator.serviceWorker.addEventListener('controllerchange', markReady)
  },

  refreshStatus: async () => {
    const result = await ask<{ files: number; bytes: number }>({
      type: 'CACHE_STATUS',
    })
    if (!result) return
    set({ cachedFiles: result.files, cachedBytes: result.bytes })
  },

  saveSceneForOffline: async () => {
    const urls = sceneModelUrls()
    if (urls.length === 0) {
      set({ message: 'Nothing to save yet — add some parts first.' })
      return
    }
    set({ busy: true, message: null })
    const result = await ask<{ added: number; failed: number }>({
      type: 'CACHE_URLS',
      urls,
    })
    await get().refreshStatus()
    const { cachedFiles, cachedBytes } = get()
    set({
      busy: false,
      message: !result
        ? 'Offline save timed out — try again with a connection.'
        : result.failed > 0
          ? `Saved ${result.added} of ${urls.length} part models (${result.failed} could not be fetched).`
          : `This build works offline — ${urls.length} part model${
              urls.length === 1 ? '' : 's'
            } ready, ${cachedFiles} cached in total (${formatBytes(cachedBytes)}).`,
    })
  },

  clearModelCache: async () => {
    if (!('caches' in window)) return
    await caches.delete('vexiq-models-v1')
    set({
      cachedFiles: 0,
      cachedBytes: 0,
      message: 'Offline part models cleared. The app itself still opens offline.',
    })
  },
}))

export { formatBytes }
