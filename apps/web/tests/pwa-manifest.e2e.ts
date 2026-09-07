import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const DIST_ROOT = fileURLToPath(new URL('../dist', import.meta.url))

it('ships install metadata with the built web application', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<link rel="manifest" href="./manifest.webmanifest" />')

  const manifest: unknown = JSON.parse(await readFile(join(DIST_ROOT, 'manifest.webmanifest'), 'utf8'))
  // No `id`: a browser resolves an explicit `id` against the start URL's origin,
  // so only an absent `id`, which defaults to the resolved `start_url`, gives
  // each mount its own identity. `public-mount.e2e.ts` reads the resolved form.
  expect(manifest).toEqual({
    name: 'Cyber Schooling Eduki',
    short_name: 'Eduki',
    description: 'Eduki-Arbeitshefte Redaktionssystem — DeepSeek Harness',
    start_url: './',
    scope: './',
    display: 'standalone',
    background_color: '#151517',
    theme_color: '#151517',
    icons: [
      { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: 'apple-touch-icon.png', sizes: '180x180', type: 'image/png', purpose: 'any' },
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  })
})

it('ships the branded favicon with its inlined WebP logo mark', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<link rel="icon" type="image/svg+xml" href="./favicon-dark.svg" media="(prefers-color-scheme: dark)" />')
  expect(index).toContain('<link rel="icon" type="image/svg+xml" href="./favicon.svg" media="(prefers-color-scheme: light)" />')
  // The CyberSchooling mark ships as a base64 WebP data URI inside both
  // scheme-selected SVGs, so the media-query favicon pair stays valid.
  for (const name of ['favicon.svg', 'favicon-dark.svg']) {
    const favicon = await readFile(join(DIST_ROOT, name), 'utf8')
    expect(favicon).toMatch(/<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]*>/)
    expect(favicon).toContain('data:image/webp;base64,')
  }
})

it('registers the PWA service worker in the production bundle', async () => {
  const shell = await readFile(join(DIST_ROOT, 'sw.js'), 'utf8')
  expect(shell).toContain("const VERSION = 'dsh-pwa-")
  // A plugin bundle is name-stable across builds: caching it cache-first would
  // pin the pre-update client, so only hashed assets take the cache-first path.
  expect(shell).toContain("url.pathname.startsWith('/assets/')")
  expect(shell).not.toContain("startsWith('/plugins/')")
})
