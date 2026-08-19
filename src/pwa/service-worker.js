/* eslint-disable no-undef */
/**
 * VEX IQ Builder service worker — SOURCE TEMPLATE.
 *
 * The BUILD and PRECACHE placeholders below are substituted by `pwaPlugin()`
 * in `vite.config.ts` at build time; this file is never served as-is and is
 * never processed by Vite's module pipeline (a service worker has no imports
 * and its own global scope). Do not write those two token names anywhere else
 * in this file — the plugin substitutes by literal text.
 *
 * WHY THIS EXISTS. The app is 480 GLB models behind a 426 kB shell, used in
 * classrooms on shared wifi and on iPads that get handed out at the start of a
 * lesson. Two costs follow from that and both are fixed here:
 *
 *   - the shell is re-downloaded by every device, every lesson;
 *   - a robot saved at school cannot be reopened at home without a connection,
 *     because the parts it uses are fetched per model file.
 *
 * TWO CACHES, ON PURPOSE, WITH DIFFERENT LIFETIMES.
 *
 *   `vexiq-shell-<build>` — index.html and the hashed JS/CSS. Keyed by BUILD,
 *   so a deploy creates a new one and `activate` deletes every older shell.
 *   index.html is NOT content-hashed, so anything that keys the shell by URL
 *   alone would serve last week's HTML for ever; this is the bug that turns a
 *   PWA into a site you cannot update.
 *
 *   `vexiq-models-v1` — the GLB part files. Deliberately NOT keyed by build:
 *   surviving deploys is the entire point, otherwise every release wipes the
 *   offline library a class has built up. GLB URLs are stable names rather
 *   than content hashes, so **bump MODEL_CACHE when models are re-converted**
 *   (`npm run convert:glb`) — that is the one manual step this design costs,
 *   and it is written down here rather than inferred.
 *
 * Strategies, and why each:
 *   navigation  network-first, cached shell as fallback — online users always
 *               get the current app; offline users still launch.
 *   models      cache-first — a part that has been seen once must work with no
 *               connection, and the bytes are immutable in practice.
 *   shell       cache-first — the URLs are content-hashed, so a hit is by
 *               definition the right file.
 *   everything  else passes straight through, uncached. A service worker that
 *               intercepts what it does not understand is how sites break.
 *
 * EVERY cache lookup passes `ignoreVary: true`, and that is not a nicety.
 * Measured offline against `vite preview`: the shell was fully cached, a
 * page-side `fetch()` for a chunk returned it, and the page still came up
 * BLANK with ERR_FAILED on all four assets. The server sends `Vary: Origin`;
 * `caches.match` honours Vary, and Vite marks its module scripts `crossorigin`,
 * so the browser's own request carries an `Origin` header while the request the
 * entry was stored under did not. Same URL, no match, straight through to a
 * network that was not there. GitHub Pages sends `Vary` on responses too, so
 * this would have shipped as "offline mode does nothing".
 */

const BUILD = '__BUILD_ID__'
const SHELL_CACHE = `vexiq-shell-${BUILD}`
const MODEL_CACHE = 'vexiq-models-v1'
const PRECACHE = __PRECACHE__

/** Part models: the only large, immutable, on-demand asset class. */
function isModelRequest(url) {
  return url.pathname.endsWith('.glb')
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE)
      // `reload` so an install never re-precaches from the HTTP cache — the
      // whole point of a new build id is to fetch the new files.
      await cache.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' })))
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(
        names
          .filter((n) => n.startsWith('vexiq-shell-') && n !== SHELL_CACHE)
          .map((n) => caches.delete(n)),
      )
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request)
          const cache = await caches.open(SHELL_CACHE)
          cache.put(request, fresh.clone())
          return fresh
        } catch {
          // Offline launch: any precached document will do, and the shell only
          // ever has the one.
          const cached =
            (await caches.match(request, { ignoreVary: true })) ??
            (await caches.match(PRECACHE[0], { ignoreVary: true }))
          if (cached) return cached
          throw new Error('offline and no cached shell')
        }
      })(),
    )
    return
  }

  if (isModelRequest(url)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request, {
          cacheName: MODEL_CACHE,
          ignoreVary: true,
        })
        if (cached) return cached
        const response = await fetch(request)
        // Only store a real hit. A 404 page cached as a model would be served
        // as one for ever.
        if (response.ok) {
          const cache = await caches.open(MODEL_CACHE)
          cache.put(request, response.clone())
        }
        return response
      })(),
    )
    return
  }

  event.respondWith(
    (async () => {
      const cached = await caches.match(request, {
        cacheName: SHELL_CACHE,
        ignoreVary: true,
      })
      if (cached) return cached
      return fetch(request)
    })(),
  )
})

/**
 * Explicit cache warming, driven by the page.
 *
 * `CACHE_URLS` is what the "Save for offline" button calls with the model URLs
 * of the parts in the current scene: a saved robot then opens with no
 * connection, which browsing to each part one by one would also achieve but
 * nobody is going to do. `CACHE_STATUS` reports what is already held so the
 * button can say a number instead of "done".
 */
self.addEventListener('message', (event) => {
  const data = event.data || {}
  const reply = (payload) => {
    const port = event.ports && event.ports[0]
    if (port) port.postMessage(payload)
  }

  if (data.type === 'CACHE_URLS') {
    event.waitUntil(
      (async () => {
        const cache = await caches.open(MODEL_CACHE)
        let added = 0
        let failed = 0
        for (const url of data.urls || []) {
          try {
            if (await cache.match(url, { ignoreVary: true })) continue
            const response = await fetch(url, { cache: 'no-cache' })
            if (!response.ok) throw new Error(String(response.status))
            await cache.put(url, response)
            added += 1
          } catch {
            failed += 1
          }
        }
        reply({ type: 'CACHE_URLS_DONE', added, failed })
      })(),
    )
    return
  }

  if (data.type === 'CACHE_STATUS') {
    event.waitUntil(
      (async () => {
        const cache = await caches.open(MODEL_CACHE)
        const keys = await cache.keys()
        // Sum the stored bodies rather than trusting Content-Length: a
        // cross-origin or opaque response reports 0, and these are same-origin
        // so the real number is available.
        let bytes = 0
        for (const key of keys) {
          const response = await cache.match(key, { ignoreVary: true })
          if (!response) continue
          const blob = await response.clone().blob()
          bytes += blob.size
        }
        reply({ type: 'CACHE_STATUS_RESULT', files: keys.length, bytes, build: BUILD })
      })(),
    )
  }
})
