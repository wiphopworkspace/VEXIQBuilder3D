import { useEffect, useRef, useState } from 'react'
import { getPartThumbnail } from '../utils/thumbnailRenderer'

/**
 * Lazily render a part's GLB thumbnail when its card scrolls into view, caching
 * the result. Returns a `ref` to attach to the card and the PNG `src` (null
 * until ready — callers show the glyph fallback meanwhile).
 */
export function usePartThumbnail(
  modelPath: string | undefined,
  enabled: boolean,
  tint?: string,
) {
  const ref = useRef<HTMLDivElement>(null)
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    setSrc(null)
    if (!modelPath || !enabled) return
    const el = ref.current
    if (!el) return

    let cancelled = false
    let started = false
    const start = () => {
      if (started) return
      started = true
      getPartThumbnail(modelPath, tint)
        .then((url) => {
          if (!cancelled) setSrc(url)
        })
        .catch(() => {
          /* leave src null → glyph fallback */
        })
    }

    if (typeof IntersectionObserver === 'undefined') {
      start()
      return () => {
        cancelled = true
      }
    }

    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          start()
          obs.disconnect()
        }
      },
      { rootMargin: '120px' },
    )
    obs.observe(el)
    return () => {
      cancelled = true
      obs.disconnect()
    }
  }, [modelPath, enabled, tint])

  return { ref, src }
}
