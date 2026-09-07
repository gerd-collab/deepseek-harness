/*
 * DSH PWA Service Worker (Cyber Schooling Eduki)
 *
 * Caching-Strategie:
 *  - /assets/* (gehashte, unveränderliche Bundles): cache-first
 *  - /plugins/* dsh-Client-Bundles (namenstabil, ändern sich mit jedem
 *    DSH-Build): stale-while-revalidate — cache-first würde nach einem
 *    Update dauerhaft den alten Client ausliefern
 *  - Navigationen (index.html, token-gated): network-first, Fallback auf die
 *    zuletzt gecachte Shell
 *  - Manifest/Icons/Favicon: stale-while-revalidate
 *  - /api/* und WebSocket werden NIE gecacht
 *
 * VERSION rotieren, wenn sich Auslieferungspfade oder Cache-Semantik ändern:
 * die Aktivierung löscht dann alle Caches der Vorversion.
 */
const VERSION = 'dsh-pwa-v2'
const PRECACHE = [
  './favicon.svg',
  './favicon-dark.svg',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION)
    await Promise.all(PRECACHE.map(async (url) => {
      try {
        const response = await fetch(url)
        if (response.ok) await cache.put(url, response)
      } catch { /* einzelne Fehler blockieren die Installation nicht */ }
    }))
  })())
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // RPC/API und Live-Daten nie cachen
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return

  // Gehashte App-Shell-Assets (immutable): cache-first
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith((async () => {
      const cached = await caches.match(request)
      if (cached) return cached
      const response = await fetch(request)
      if (response.ok) {
        const copy = response.clone()
        const cache = await caches.open(VERSION)
        await cache.put(request, copy)
      }
      return response
    })())
    return
  }

  // Navigation: network-first, offline-Fallback auf gecachte Shell
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request)
        if (response.ok) {
          const copy = response.clone()
          const cache = await caches.open(VERSION)
          await cache.put('./index.html', copy)
        }
        return response
      } catch {
        const shell = await caches.match('./index.html')
        if (shell) return shell
        return new Response('Offline — bitte neu verbinden', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        })
      }
    })())
    return
  }

  // Manifest, Icons, Plugin-Bundles, übrige GETs: stale-while-revalidate
  event.respondWith((async () => {
    const cached = await caches.match(request)
    const refresh = fetch(request).then(async (response) => {
      if (response.ok) {
        const copy = response.clone()
        const cache = await caches.open(VERSION)
        await cache.put(request, copy)
      }
      return response
    }).catch(() => cached)
    return cached || refresh
  })())
})
