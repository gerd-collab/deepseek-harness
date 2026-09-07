/**
 * Eduki-Heft-Katalog, browser half. Registers a sidebar footer action
 * ("Eduki-Hefte") and a modal overlay.
 *
 * UX:
 *   1. Zuerst: durchsuchbare Liste aller erstellten Hefte (Suchfeld oben).
 *   2. Klick auf ein Heft: Detailansicht mit ALLEN Dateien des Heftes
 *      (Label, Typ, Größe). PDFs öffnen im Browser-Tab (Open-Button),
 *      andere Dateien laden per Download herunter — gleiche URL, kein
 *      doppelter Button für PDFs.
 *   3. Header: 📤 Upload-Button → Upload-Modal (mehrere Dateien wählbar,
 *      SHA-256 client-side gehasht, POST an /api/eduki-products/upload-heft
 *      → S3-Key eduki/heft/<sha256>.<ext>). Nach erfolgreichem Upload liegt
 *      die Datei auf S3, wird aber bewusst NICHT im Katalog gelistet — die
 *      Heftsammlung zeigt nur saubere eduki-Hefte.
 *
 * Datenquelle: /preview/edukit-catalog-snapshot.json — serverseitig per
 * edukit-catalog-snapshot.sh (Workspace-Scan + eduki_product_specs-DB)
 * erzeugt, vom systemd-Timer edukit-catalog-snapshot.timer regelmäßig
 * aktualisiert. Der Browser braucht keine Auth.
 */
import { createElement as h, useEffect, useState } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only imports: pull the slot declarations into the global SlotMap so
// ctx.slots.inject('sidebar.footer.action' / 'shell.overlay') typechecks.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'

/** Required service: only the slot registry. */
export const inject = ['slots']

const CATALOG_LABELS = { de: { all: 'Alle Themenhefte', intro: 'Einstiegshefte · 3,99 €', premium: 'Premium-Autorenhefte', label: 'Heftauswahl', badge: '★ Einstiegsheft · 3,99 €', help: 'Erstes Themenheft dieses Fachs · 3,99 €' } } as const
const catalogText = CATALOG_LABELS.de

const SNAPSHOT_URL = 'https://dsh.cyberschooling.eu/preview/edukit-catalog-snapshot.json'
const UPLOAD_ENDPOINT = 'https://ws.cyberschooling.eu/api/eduki-products/upload-heft'

// 2026-08-30: Snapshot-Cache — das Overlay oeffnet sofort aus dem Cache und
// laedt den 4-MB-Snapshot nur noch im Hintergrund still nach (vorher wurde
// bei jedem Oeffnen komplett neu geladen). Nach einem Upload-Batch gilt der
// Cache als veraltet (itemsLen-Pruefung) und es wird frisch geladen.
let snapshotCache: { snapshot: CatalogSnapshot; itemsLen: number } | null = null

// ── Data shapes ────────────────────────────────────────────────────────────
type HeftFile = {
  label: string
  filename: string | null
  url: string | null
  type: string
  pages?: number | null
  size?: number | null
  job_id?: string | null
  updated?: string | null
  release?: string | null
}

/**
 * Eine einzelne Revision eines Heftes. Der Snapshot liefert alle vorhandenen
 * Revisionen sortiert (neueste zuerst). Nur die neueste hat einen voll-
 * staendigen ``files``-Eintrag mit entpackten PDFs; aeltere Revisionen
 * enthalten ausschliesslich das Hauptpaket-ZIP als File.
 */
type HeftRevision = {
  release: string | null         // 'r18', 'r17', ... oder null wenn nicht parsbar
  date: string                   // '2026-08-17'
  ver: number                    // 18
  base: string                   // Raw-Basename mit Datum/Revisions-Marker
  lm: string                     // ISO LastModified
  size: number
  zipUrl: string                 // presigned URL des ZIP
  zipFilename: string            // z.B. 'Deutsch_Wortarten_..._r18.zip'
  isLatest: boolean              // true nur fuer die oberste Revision
  files: HeftFile[]              // entpackte Files (latest) oder [ZIP] (aeltere)
}

type Heft = {
  id: string
  title: string
  shortTitle?: string           // individueller Kurztitel (Kompetenz/Topic)
  titleContext?: string         // Curriculum-Einordnung (Kontext, ohne Klasse)
  subject: string | null
  grade: string | null
  release: string | null          // back-compat: == latestRelease
  latestRelease: string | null    // 'r18'
  revisionCount?: number          // Anzahl vorhandener Revisionen
  status: string
  group: string | null
  source: 'workspace' | 'db' | 's3' | 'direct' | string
  files: HeftFile[]               // == latest revision's files (back-compat)
  revisions?: HeftRevision[]      // sortiert: neueste zuerst; alle vorhandenen Versionen
  dbEntries?: DbEntry[]
  generated?: boolean
  tags?: string[]                 // z.B. ['einstiegsheft'] — Quelle: DB-Tabelle eduki_heft_tags
  einstiegsheft?: boolean         // Convenience-Flag: vom Snapshot-Script aus dem Tag gesetzt
  premium?: boolean
  category?: string
  priceCents?: number
  priceEur?: number
}

type DbEntry = {
  specId?: number | null
  status?: string | null
  edukiStatus?: string | null
  title?: string | null
  subject?: string | null
  grade?: number | null
  curriculumTopicId?: number | null
  generationJobId?: string | null
  s3Key?: string | null
  approvedAt?: string | null
  packagedAt?: string | null
  listedAt?: string | null
  createdAt?: string | null
  updatedAt?: string | null
}

type CatalogSnapshot = {
  generated_at: string
  source: string
  hefte: Heft[]
}

// ── Status-Labels & Farben ─────────────────────────────────────────────────
const STATUS_META: Record<string, { label: string; cls: string }> = {
  review_ready: { label: 'Review bereit', cls: 'eduki-cat-status--blue' },
  approved: { label: 'Freigegeben', cls: 'eduki-cat-status--green' },
  packaged: { label: 'Gepackt', cls: 'eduki-cat-status--green' },
  listed: { label: 'Gelistet', cls: 'eduki-cat-status--green' },
  generating: { label: 'Generiert', cls: 'eduki-cat-status--blue' },
  automated_qc: { label: 'Auto-QC', cls: 'eduki-cat-status--blue' },
  blocked: { label: 'Blockiert', cls: 'eduki-cat-status--red' },
  planned: { label: 'Geplant', cls: 'eduki-cat-status--gray' },
  repair: { label: 'Reparatur', cls: 'eduki-cat-status--red' },
}

// ── Einstiegsheft-Erkennung (Tag aus eduki_heft_tags) ──────────────────────
function isEinstiegsheft(h: Heft): boolean {
  return h.einstiegsheft === true || (h.tags || []).includes('einstiegsheft')
}

function isPremiumHeft(h: Heft): boolean {
  return h.premium === true || h.category === 'premium-autorenheft' || (h.tags || []).includes('premium-autorenheft')
}

// ── Shared open-state (sidebar trigger <-> overlay) ────────────────────────
const store: { open: boolean; listeners: Array<(v: boolean) => void> } = { open: false, listeners: [] }
function setOpen(next: boolean | ((prev: boolean) => boolean)): void {
  const value = typeof next === 'function' ? next(store.open) : next
  if (store.open === value) return
  store.open = value
  for (const l of store.listeners.slice()) l(value)
}
function useOpen(): [boolean, (v: boolean | ((prev: boolean) => boolean)) => void] {
  const [val, setVal] = useState(store.open)
  useEffect(() => {
    setVal(store.open)
    const listener = (v: boolean): void => setVal(v)
    store.listeners.push(listener)
    return () => {
      const i = store.listeners.indexOf(listener)
      if (i >= 0) store.listeners.splice(i, 1)
    }
  }, [])
  return [val, setOpen]
}

// ── Upload sub-state (modal lives inside the catalog overlay) ─────────────
type UploadItem = {
  id: string
  file: File | null   // null = empty slot waiting for picker
  state: 'empty' | 'queued' | 'hashing' | 'uploading' | 'done' | 'error'
  sha256?: string
  s3Key?: string
  size?: number
  presignedUrl?: string | null
  error?: string
  progress?: number  // 0..1
}
const uploadStore: {
  open: boolean
  items: UploadItem[]
  topic: string
  sourceTitle: string
  listeners: Array<() => void>
} = { open: false, items: [], topic: '', sourceTitle: '', listeners: [] }
function setUploadOpen(v: boolean): void {
  if (uploadStore.open === v) return
  uploadStore.open = v
  if (!v) uploadStore.items = []
  for (const l of uploadStore.listeners.slice()) l()
}
function emitUploadChange(): void {
  for (const l of uploadStore.listeners.slice()) l()
}
function openForHeft(title: string): void {
  // Pre-fill the topic with the Heft's title (stored as S3 metadata;
  // the snapshot no longer groups by it — direct uploads stay unlisted).
  uploadStore.topic = title
  uploadStore.sourceTitle = title
  // Pre-populate with one empty slot so the user can immediately pick
  // a file rather than having to click "+ Weitere Datei" first.
  uploadStore.items = [makeEmptySlot()]
  uploadStore.open = true
  emitUploadChange()
}
function uploadSingleForHeft(title: string, file: File): void {
  // Inline path: detail view's "+ Datei hinzufügen" picks one file
  // directly. Set source + topic, queue the upload, no modal needed.
  uploadStore.topic = title
  uploadStore.sourceTitle = title
  const item: UploadItem = {
    id: 'up-' + Date.now() + '-' + Math.floor(Math.random() * 1e6),
    file,
    state: 'queued',
  }
  uploadStore.items = [...uploadStore.items.filter(it => it.file), item]
  emitUploadChange()
  startSlotUpload(item, uploadStore.topic)
}
function useUpload(): {
  open: boolean
  setOpen: (v: boolean) => void
  items: UploadItem[]
  topic: string
  setTopic: (v: string) => void
  sourceTitle: string
  openForHeft: (title: string) => void
  uploadSingleForHeft: (title: string, file: File) => void
} {
  const [, force] = useState(0)
  useEffect(() => {
    const listener = (): void => force((n: number) => n + 1)
    uploadStore.listeners.push(listener)
    return () => {
      const i = uploadStore.listeners.indexOf(listener)
      if (i >= 0) uploadStore.listeners.splice(i, 1)
    }
  }, [])
  return {
    open: uploadStore.open,
    setOpen: setUploadOpen,
    items: uploadStore.items,
    topic: uploadStore.topic,
    setTopic: (v: string) => {
      uploadStore.topic = v
      emitUploadChange()
    },
    sourceTitle: uploadStore.sourceTitle,
    openForHeft,
    uploadSingleForHeft,
  }
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  // Web Crypto is available in every modern browser.
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const arr = Array.from(new Uint8Array(digest))
  return arr.map(b => b.toString(16).padStart(2, '0')).join('')
}

function formatSize(bytes: number | null | undefined): string {
  if (!bytes) return ''
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB'
  return bytes + ' B'
}

function fileIcon(type: string): string {
  if (type === 'pdf') return '📄'
  if (type === 'docx') return '📝'
  if (type === 'zip') return '📦'
  if (type === 'png' || type === 'webp' || type === 'jpg') return '🖼️'
  if (type === 'txt') return '📃'
  return '⬇️'
}

function StatusBadge(props: { status: string }) {
  const meta = STATUS_META[props.status] || { label: props.status, cls: 'eduki-cat-badge--gray' }
  return h('span', { className: 'eduki-cat-badge ' + meta.cls }, meta.label)
}

// ── Views ──────────────────────────────────────────────────────────────────
function HeftList(props: {
  hefte: Heft[]
  query: string
  subjectFilter: string
  catalogFilter: '' | 'einstiegsheft' | 'premium'
  onSelect: (h: Heft) => void
  onUpload: (title: string) => void
}) {
  const q = props.query.trim().toLowerCase()
  const filtered = props.hefte.filter((h) => {
    if (props.subjectFilter && h.subject !== props.subjectFilter) return false
    if (props.catalogFilter === 'einstiegsheft' && !isEinstiegsheft(h)) return false
    if (props.catalogFilter === 'premium' && !isPremiumHeft(h)) return false
    if (!q) return true
    const hay = [
      h.title, h.shortTitle, h.titleContext, h.subject, h.group, h.grade, h.release, h.status,
      ...(h.files || []).map(f => f.label),
    ].filter(Boolean).join(' ').toLowerCase()
    return hay.includes(q)
  })
  if (filtered.length === 0) {
    return h('div', { className: 'eduki-cat-empty' },
      props.catalogFilter === 'einstiegsheft' ? 'Keine Einstiegshefte gefunden — Tag „einstiegsheft“ fehlt im Snapshot.'
        : props.catalogFilter === 'premium' ? 'Keine Premium-Autorenhefte gefunden.'
        : q ? `Keine Hefte passen zu „${props.query}“`
          : (props.subjectFilter ? `Keine Hefte zu „${props.subjectFilter}“ gefunden.` : 'Keine Hefte gefunden.'))
  }
  return h('div', null,
    filtered.map((heft) => {
      const fileCount = (heft.files || []).length
      // Individueller Kurztitel: modernere Snapshot-Versionen liefern
      // ``shortTitle`` (die eigentliche Kompetenz/der Topic) und
      // ``titleContext`` (Curriculum-Einordnung).  Aeltere Snapshot-Versionen
      // ohne diese Felder fallen auf den vollen ``title`` zurueck.
      const shortTitle = heft.shortTitle || heft.title
      const sub = [heft.titleContext, heft.group, heft.subject, heft.grade].filter(Boolean).join(' · ')
      // Revisions-Anzeige: latest-Release-Badge + Count-Badge (nur wenn > 1).
      const latestRel = heft.latestRelease || heft.release
      const revCount = heft.revisionCount ?? (heft.revisions ? heft.revisions.length : 1)
      // Find the "Gesamtes Hauptpaket" ZIP — the catalog exposes this
      // through the snapshot's files list with a label that starts with
      // "Gesamtes Hauptpaket". It's the only way to download the whole
      // release in one click without first opening the detail view.
      const hauptpaket = (heft.files || []).find(
        f => typeof f.label === 'string' && (f.label.startsWith('Gesamtes Hauptpaket') || f.label.startsWith('Gesamtes Premium-Paket')),
      )
      return h('div', {
        key: heft.id,
        className: 'eduki-cat-heft-row' + (heft.generated ? ' eduki-cat-heft-row--gen' : ''),
      },
      h('button', {
        type: 'button',
        className: 'eduki-cat-heft',
        onClick: () => props.onSelect(heft),
        title: 'Details öffnen',
      },
      h('span', { className: 'eduki-cat-heft__icon', 'aria-hidden': 'true' },
        revCount > 1 ? '📚' : '📘'),
      h('span', { className: 'eduki-cat-heft__main' },
        h('span', { className: 'eduki-cat-heft__title', title: shortTitle !== heft.title ? heft.title : undefined }, shortTitle),
        h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', marginTop: '2px', flexWrap: 'wrap' } },
          sub ? h('span', { className: 'eduki-cat-heft__sub' }, sub) : null,
          latestRel
            ? h('span', {
              className: 'eduki-cat-badge eduki-cat-badge--blue',
              title: 'Neueste verfügbare Release',
            }, latestRel)
            : null,
          revCount > 1
            ? h('span', {
              className: 'eduki-cat-badge eduki-cat-badge--gray',
              title: 'Anzahl vorhandener Revisionen — Auswahl in der Detailansicht',
            }, `${revCount} Revisionen`)
            : null,
          isEinstiegsheft(heft)
            ? h('span', {
              className: 'eduki-cat-badge eduki-cat-badge--gold',
              title: catalogText.help,
            }, catalogText.badge)
            : null,
          heft.source === 'direct'
            ? h('span', { className: 'eduki-cat-badge eduki-cat-badge--blue' }, '↑ Direkt-Upload')
            : heft.generated
              ? h('span', { className: 'eduki-cat-badge eduki-cat-badge--green' }, '✓ Generiert')
              : null,
        ),
      ),
      h('span', { className: 'eduki-cat-heft__files' }, fileCount + ' Dateien'),
      h('span', { className: 'eduki-cat-heft__arrow', 'aria-hidden': 'true' }, '→'),
      ),
      h('div', { className: 'eduki-cat-heft-actions' },
        hauptpaket && hauptpaket.url
          ? h('a', {
            className: 'eduki-cat-heft-zip',
            href: hauptpaket.url,
            // Force the browser to download the ZIP — the presigned URL
            // already carries inline-disposition, but ``download`` keeps
            // the right filename instead of opening the JSON-ish body
            // when the user actually clicks "ZIP herunterladen".
            download: '',
            target: '_blank',
            rel: 'noopener noreferrer',
            title: 'Gesamtes Hauptpaket (ZIP, ' + (latestRel || 'neueste') + ') herunterladen',
            'aria-label': 'Gesamtes Hauptpaket „' + heft.title + '“ als ZIP herunterladen',
            onClick: (e: MouseEvent) => e.stopPropagation(),
          }, '⬇ ZIP')
          : null,
        h('button', {
          type: 'button',
          className: 'eduki-cat-heft-upload',
          onClick: (e: MouseEvent) => {
            e.stopPropagation()
            props.onUpload(heft.title)
          },
          title: 'Dateien zu diesem Heft hochladen',
          'aria-label': 'Dateien zu „' + heft.title + '“ hochladen',
        }, '📤'),
      ),
      )
    }),
  )
}

function DbEntryPanel(props: { entries: DbEntry[] }) {
  const entries = props.entries || []
  if (entries.length === 0) return null
  const statePair = useState<number>(0)
  const idx = statePair[0]
  const setIdx = statePair[1]
  const entry = entries[Math.min(idx, entries.length - 1)]
  if (!entry) return null

  const fmt = (v: string | null | undefined): string =>
    v ? new Date(v).toLocaleString() : '–'

  const rows: Array<[string, string]> = [
    ['Status', entry.status || entry.edukiStatus || '–'],
    ['eduki-Status', entry.edukiStatus || '–'],
    ['Spec-ID', entry.specId != null ? String(entry.specId) : '–'],
    ['Fach', entry.subject || '–'],
    ['Klasse', entry.grade != null ? 'Klasse ' + entry.grade : '–'],
    ['Curriculum-Topic-ID', entry.curriculumTopicId != null ? String(entry.curriculumTopicId) : '–'],
    ['Generierungs-Job', entry.generationJobId || '–'],
    ['S3-Key', entry.s3Key || '–'],
    ['Freigegeben', fmt(entry.approvedAt)],
    ['Gepackt', fmt(entry.packagedAt)],
    ['Gelistet', fmt(entry.listedAt)],
    ['Erstellt', fmt(entry.createdAt)],
    ['Aktualisiert', fmt(entry.updatedAt)],
  ]

  return h('div', { className: 'eduki-cat-db' },
    h('div', { className: 'eduki-cat-db__head' },
      h('span', { className: 'eduki-cat-db__title' }, '🗄️ Datenbank-Eintrag'),
      entries.length > 1
        ? h('div', { className: 'eduki-cat-db__selector' },
          h('label', null, 'Eintrag: '),
          h('select', {
            value: idx,
            onChange: (e: { target: { value: string } }) => setIdx(Number(e.target.value)),
          }, entries.map((e, i) => h('option', { key: i, value: i },
            (e.title || e.specId != null ? 'Spec #' + e.specId : e.status || 'Eintrag ' + (i + 1))))),
        )
        : null,
    ),
    h('dl', { className: 'eduki-cat-db__dl' },
      rows.map(([k, v]) =>
        h('div', { key: k, className: 'eduki-cat-db__row' },
          h('dt', null, k),
          h('dd', { className: v === '–' ? 'eduki-cat-db__val--muted' : undefined }, v),
        ),
      ),
    ),
  )
}

function HeftDetail(props: {
  heft: Heft
  onBack: () => void
  onUpload: (title: string) => void
  onUploadFile: (title: string, file: File, suggestedName?: string) => void
  pendingItems: UploadItem[]
}) {
  const { heft, onBack, onUpload, onUploadFile, pendingItems } = props
  // Aktive Revision: Default = neueste.  Snapshot liefert sie in
  // ``heft.revisions`` (sortiert: neueste zuerst). Aelterer Snapshot ohne
  // ``revisions``-Array: Fallback auf die Top-Level-Files (== neueste).
  const revs = (heft.revisions && heft.revisions.length > 0)
    ? heft.revisions
    : (heft.files && heft.files.length > 0
      ? [{ release: heft.latestRelease || heft.release || null,
        date: '', ver: 0, base: heft.id, lm: '', size: 0,
        zipUrl: '', zipFilename: '', isLatest: true, files: heft.files } as HeftRevision]
      : [])
  const revPair = useState<number>(0)
  const revIdx = Math.min(revPair[0], Math.max(revs.length - 1, 0))
  const setRevIdx = revPair[1]
  const currentRev = revs[revIdx] || null
  // Files der gewaehlten Revision. Bei aelteren Revisionen ist das
  // per Definition nur das Hauptpaket-ZIP.
  const files = currentRev ? currentRev.files : (heft.files || [])
  // 2026-08-30: Dateien nach Ordnungsnummer sortieren (1, 2, … 10 numerisch,
  // nicht lexikografisch); Dateien ohne Nummer folgen alphabetisch, ZIPs zuletzt.
  const nummernRang = (name: string): [number, number, string] => {
    const m = /^(\d+)-/.exec(name)
    const num = m?.[1]
    if (num) return [0, parseInt(num, 10), name]
    return [1, 0, name]
  }
  const sortedFiles = [...files].sort((a, b) => {
    const ka = nummernRang(a.filename || a.label || '')
    const kb = nummernRang(b.filename || b.label || '')
    if (ka[0] !== kb[0]) return ka[0] - kb[0]
    if (ka[0] === 0 && ka[1] !== kb[1]) return ka[1] - kb[1]
    return ka[2].localeCompare(kb[2])
  })

  const onInlinePick = (e: { target: HTMLInputElement }): void => {
    const f = e.target.files && e.target.files[0]
    if (!f) return
    onUploadFile(heft.title, f)
    e.target.value = ''
  }

  const onReplacePick = (file: HeftFile) => (e: { target: HTMLInputElement }): void => {
    const f = e.target.files && e.target.files[0]
    if (!f) return
    // Pass the original filename as a suggestion so the user can keep
    // the same label after editing. Server doesn't currently consume
    // this; kept as future extension point for catalog metadata.
    const suggested = file.filename || file.label
    onUploadFile(heft.title, f, suggested)
    e.target.value = ''
  }

  // Show any pending uploads for this Heft (passed in as prop).
  const pendingForHeft = pendingItems

  return h('div', { className: 'eduki-cat-detail' },
    h('div', { className: 'eduki-cat-detail__head' },
      h('button', { type: 'button', className: 'eduki-cat-detail__back', onClick: onBack },
        '← Zurück zur Heftliste'),
    ),
    h('h2', { className: 'eduki-cat-detail__title', title: heft.shortTitle && heft.shortTitle !== heft.title ? heft.title : undefined },
      heft.shortTitle || heft.title),
    h('div', { className: 'eduki-cat-detail__sub' },
      [heft.titleContext, heft.group, heft.subject, heft.grade].filter(Boolean).join(' · '),
      '  ',
      h(StatusBadge, { status: heft.status }),
    ),
    // Revisions-Dropdown: rendert NUR wenn mehr als eine Revision vorliegt.
    // Bei genau einer Revision versteckt sich der Block — die Dateiliste
    // unten zeigt dann einfach die einzige Revision.
    revs.length > 1
      ? h('div', { className: 'eduki-cat-revisions' },
        h('label', { className: 'eduki-cat-revisions__label' },
          h('span', null, 'Revision:'),
          h('select', {
            className: 'eduki-cat-revisions__select',
            value: revIdx,
            onChange: (e: { target: { value: string } }) =>
              setRevIdx(Math.max(0, Math.min(revs.length - 1, Number(e.target.value)))),
            'aria-label': 'Revision auswählen',
          },
          revs.map((r, i) => {
            const labelParts: string[] = []
            if (r.release) labelParts.push(r.release)
            if (r.date) labelParts.push(r.date)
            if (r.isLatest) labelParts.push('(neueste)')
            const isOnlyZip = !r.isLatest && r.files.length <= 1
            if (isOnlyZip) labelParts.push('— nur ZIP')
            return h('option', {
              key: r.base + '-' + i,
              value: i,
            }, labelParts.join(' · ') || (r.base || ('Revision ' + (i + 1))))
          }),
          ),
        ),
        h('span', { className: 'eduki-cat-revisions__count' },
          `${revs.length} Revisionen verfügbar`),
      )
      : null,
    h(DbEntryPanel, { entries: heft.dbEntries || [] }),
    files.length === 0
      ? h('div', { className: 'eduki-cat-empty' }, 'Dieses Heft hat noch keine Dateien.')
      : h('div', null,
        sortedFiles.map((file, i) => {
          const metaParts = [
            file.type.toUpperCase(),
            formatSize(file.size),
            file.updated ? 'Stand ' + file.updated.slice(0, 10) : '',
            file.release ? 'Release ' + file.release : '',
            file.job_id ? 'Job ' + String(file.job_id).slice(0, 8) : '',
          ].filter(Boolean)
          const url = file.url
          const downloadable = !!url
          const fileLabel = file.label || file.filename || 'Datei'
          // 2026-08-30: Einfache Datei-Nummern sichtbar machen — Haupttitel
          // ist der Dateiname (1-LEHRERHANDBUCH.PDF …), das freundliche
          // Label darunter. ZIP-Pakete behalten das Label als Haupttitel.
          const filename = file.filename
          const showNumber = !!filename && file.type !== 'zip' && filename !== fileLabel
          const mainTitle = showNumber ? filename : fileLabel
          return h('div', {
            key: i,
            className: 'eduki-cat-file' + (file.type === 'zip' ? ' eduki-cat-file--zip' : ''),
          },
          downloadable
            ? h('a', {
              className: 'eduki-cat-file__main',
              href: url,
              target: '_blank',
              rel: 'noopener noreferrer',
              title: (file.type === 'pdf' ? 'Im Browser-Tab öffnen' : 'Download') + ' „' + mainTitle + '“',
            },
            h('span', { className: 'eduki-cat-file__icon', 'aria-hidden': 'true' }, fileIcon(file.type)),
            h('span', null,
              h('span', { className: 'eduki-cat-file__label' }, mainTitle),
              showNumber
                ? h('span', { className: 'eduki-cat-file__name' }, fileLabel)
                : null,
              metaParts.length > 0
                ? h('span', { className: 'eduki-cat-file__meta' }, metaParts.join(' · '))
                : null,
            ),
            )
            : h('div', { className: 'eduki-cat-file__main' },
              h('span', { className: 'eduki-cat-file__icon', 'aria-hidden': 'true' }, fileIcon(file.type)),
              h('span', null,
                h('span', { className: 'eduki-cat-file__label' }, mainTitle),
                showNumber
                  ? h('span', { className: 'eduki-cat-file__name' }, fileLabel)
                  : null,
                metaParts.length > 0
                  ? h('span', { className: 'eduki-cat-file__meta' }, metaParts.join(' · '))
                  : null,
              ),
            ),
          h('div', { className: 'eduki-cat-file__actions' },
            downloadable && file.type === 'pdf'
              ? h('a', {
                className: 'eduki-cat-file__open',
                href: url,
                target: '_blank',
                rel: 'noopener noreferrer',
                type: 'application/pdf',
                title: '„' + fileLabel + '“ im Browser-Tab öffnen',
              }, '👁 Open')
              : null,
            // PDFs öffnen über „Open" bereits im Browser-Tab (gleiche URL,
            // gleiche Inline-Disposition) — ein zusätzlicher Download-Button
            // wäre reine Redundanz. Für Nicht-PDFs (ZIP, DOCX, …) bleibt
            // Download erhalten; nicht herunterladbare Dateien zeigen einen
            // inaktiven Platzhalter — PDFs zeigen KEINEN Platzhalter.
            downloadable && file.type !== 'pdf'
              ? h('a', {
                className: 'eduki-cat-file__dl',
                href: url,
                target: '_blank',
                rel: 'noopener noreferrer',
                title: 'Download „' + fileLabel + '“',
              }, 'Download ↗')
              : !downloadable
                ? h('span', { className: 'eduki-cat-file__dl eduki-cat-file__dl--disabled' }, '—')
                : null,
            // Upload-Button nur fuer die neueste Revision anbieten —
            // Upload ersetzt die aktuelle Top-Level-Version des Heftes.
            currentRev && currentRev.isLatest
              ? h('label', {
                className: 'eduki-cat-file__up',
                title: 'Neue Version dieser Datei zu eduki hochladen',
              },
              h('input', {
                type: 'file',
                style: { display: 'none' },
                onChange: onReplacePick(file),
              }),
              '📤 Upload')
              : null,
          ),
          )
        }),
      ),
    pendingForHeft.length > 0
      ? h('div', { className: 'eduki-cat-detail__pending' },
        h('div', { className: 'eduki-cat-detail__pending-title' },
          `${pendingForHeft.length} neue Datei${pendingForHeft.length > 1 ? 'en' : ''} werden gerade hochgeladen — erscheinen nach dem nächsten Snapshot im Katalog`),
        pendingForHeft.map((it) => {
          const file = it.file
          if (!file) return null
          const statusLabel =
            it.state === 'queued' ? 'Wartet…'
              : it.state === 'hashing' ? 'Hasht…'
                : it.state === 'uploading' ? 'Lädt hoch…'
                  : it.state === 'done' ? '✓ Hochgeladen'
                    : '⚠ ' + (it.error || 'Fehler')
          return h('div', { key: it.id, className: 'eduki-cat-detail__pending-row' },
            h('span', null, fileIcon(file.name.split('.').pop() || '')),
            h('span', { className: 'eduki-cat-detail__pending-name' }, file.name),
            h('span', { className: 'eduki-cat-detail__pending-status' }, statusLabel),
          )
        }),
      )
      : null,
    // Inline-Upload-Buttons nur fuer die neueste Revision anzeigen — fuer
    // aeltere Revisionen waeren sie semantisch irrefuehrend (der Upload
    // wuerde eine neue "neueste" Version erzeugen, nicht die gewaehlte
    // alte ueberschreiben).
    currentRev && currentRev.isLatest
      ? h('div', { className: 'eduki-cat-detail__add' },
        h('label', { className: 'eduki-cat-detail__add-btn' },
          h('input', {
            type: 'file',
            style: { display: 'none' },
            onChange: onInlinePick,
          }),
          '📎 + Datei hinzufügen'),
        h('button', {
          type: 'button',
          className: 'eduki-cat-detail__add-more',
          onClick: () => onUpload(heft.title),
          title: 'Mehrere Dateien über Slot-basierte Auswahl hinzufügen',
        }, 'Mehrere Dateien…'),
      )
      : null,
  )
}

// ── Upload Modal ───────────────────────────────────────────────────────────
async function uploadOne(item: UploadItem, topic: string): Promise<void> {
  if (!item.file) return
  try {
    item.state = 'hashing'
    emitUploadChange()
    const buf = await item.file.arrayBuffer()
    const sha = await sha256Hex(buf)
    item.sha256 = sha
    item.size = item.file.size

    item.state = 'uploading'
    emitUploadChange()

    const fd = new FormData()
    fd.append('file', item.file, item.file.name)
    const headers: Record<string, string> = {}
    if (topic.trim()) {
      // Server stores this as S3 Metadata['topic'] (ASCII-safe). The catalog
      // snapshot no longer groups by it — direct uploads are not listed.
      headers['X-Upload-Topic'] = topic.slice(0, 250)
    }
    const res = await fetch(UPLOAD_ENDPOINT, {
      method: 'POST',
      body: fd,
      headers,
    })
    if (!res.ok) {
      let detail = ''
      try { detail = (await res.json()).detail || '' } catch {}
      throw new Error('HTTP ' + res.status + (detail ? ' — ' + detail : ''))
    }
    const payload = await res.json()
    item.s3Key = payload.s3_key
    item.size = payload.size || item.size
    item.presignedUrl = payload.presigned_url || null
    item.state = 'done'
    emitUploadChange()
  } catch (err) {
    item.state = 'error'
    item.error = err instanceof Error && err.message ? err.message : String(err)
    emitUploadChange()
  }
}

function makeEmptySlot(): UploadItem {
  return {
    id: 'up-' + Date.now() + '-' + Math.floor(Math.random() * 1e6),
    file: null,
    state: 'empty',
  }
}

function startSlotUpload(item: UploadItem, topic: string): void {
  void uploadOne(item, topic)
}

function UploadModal() {
  const u = useUpload()

  if (!u.open) return null

  const addEmptySlot = (): void => {
    uploadStore.items = [...uploadStore.items, makeEmptySlot()]
    emitUploadChange()
  }

  const removeSlot = (id: string): void => {
    uploadStore.items = uploadStore.items.filter(it => it.id !== id)
    emitUploadChange()
  }

  const fillSlot = (id: string, file: File): void => {
    const slot = uploadStore.items.find(it => it.id === id)
    if (!slot) return
    slot.file = file
    slot.state = 'queued'
    delete slot.sha256
    delete slot.s3Key
    delete slot.presignedUrl
    delete slot.size
    delete slot.error
    emitUploadChange()
    startSlotUpload(slot, u.topic)
  }

  const queued = u.items.filter(it => it.state === 'queued' || it.state === 'hashing' || it.state === 'uploading').length
  const done = u.items.filter(it => it.state === 'done').length
  const failed = u.items.filter(it => it.state === 'error').length
  const filled = u.items.filter(it => it.file).length

  const closeModal = (): void => u.setOpen(false)

  return h('div',
    {
      className: 'eduki-cat-up-root',
      onClick: (e: MouseEvent) => {
        const t = e.target as HTMLElement
        if (t && t.classList && t.classList.contains('eduki-cat-up-backdrop')) closeModal()
      },
    },
    h('div', { className: 'eduki-cat-up-backdrop', 'aria-hidden': 'true' }),
    h('div', {
      className: 'eduki-cat-up-panel',
      role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Eduki-Heftkatalog (Upload)',
    },
    h('div', { className: 'eduki-cat-up-header' },
      h('div', null,
        h('h3', null, '📤 Dateien hochladen'),
        h('p', null, u.sourceTitle
          ? `Dateien werden zu „${u.sourceTitle}“ hinzugefügt. `
          : 'Wähle ein Heft aus der Liste oder lade direkt hier hoch. '),
        h('p', null, 'Jede Datei wird einzeln ausgewählt. Pro Datei wird clientseitig SHA-256 gehasht '
                    + 'und unter eduki/heft/<sha256>.<ext> hochgeladen. '
                    + 'Die Dateien landen auf S3, werden aber NICHT im Heft-Katalog gelistet — '
                    + 'die Heftsammlung zeigt nur saubere eduki-Hefte.'),
      ),
      h('button', {
        type: 'button', className: 'eduki-cat-close',
        onClick: closeModal, 'aria-label': 'Schließen',
      }, '\u00d7'),
    ),
    h('div', { className: 'eduki-cat-up-body' },
      h('div', { className: 'eduki-cat-up-field' },
        h('label', null,
          u.sourceTitle ? 'Heft / Thema (vorausgefüllt aus der Auswahl)' : 'Heft / Thema (optional, gruppiert später im Katalog)'),
        h('input', {
          type: 'text',
          placeholder: 'z. B. „Deutsch · Wortarten“',
          value: u.topic,
          onChange: (e: { target: { value: string } }) => u.setTopic(e.target.value),
        }),
      ),
      h('div', { className: 'eduki-cat-up-slots' },
        u.items.length === 0
          ? h('div', { className: 'eduki-cat-up-slots__empty' },
            'Noch keine Datei-Slots — klicke unten auf „+ Weitere Datei“ zum Anfangen.')
          : u.items.map(it => h(UploadSlot, {
            key: it.id,
            item: it,
            onPick: (file: File) => fillSlot(it.id, file),
            onRemove: () => removeSlot(it.id),
          })),
      ),
      h('button', {
        type: 'button',
        className: 'eduki-cat-up-add',
        onClick: addEmptySlot,
      }, '+ Weitere Datei'),
    ),
    h('div', { className: 'eduki-cat-up-footer' },
      h('span', null,
        u.items.length === 0
          ? 'Noch keine Slots'
          : `${filled} ausgewählt — ${done} fertig, ${queued} in Arbeit${failed ? ', ' + failed + ' fehlgeschlagen' : ''}`,
      ),
      h('button', {
        type: 'button',
        className: 'eduki-cat-up-close',
        onClick: closeModal,
      }, 'Schließen'),
    ),
    ),
  )
}

function UploadSlot(props: {
  item: UploadItem
  onPick: (file: File) => void
  onRemove: () => void
}) {
  const { item, onPick, onRemove } = props
  const [dragOver, setDragOver] = useState(false)
  const inputRef = { current: null as HTMLInputElement | null }

  if (item.file) {
    const file = item.file
    const meta = [
      formatSize(item.size || file.size),
      item.sha256 ? 'sha ' + item.sha256.slice(0, 10) + '…' : '',
    ].filter(Boolean).join(' · ')
    const statusLabel =
      item.state === 'queued' ? 'Wartet…'
        : item.state === 'hashing' ? 'Hasht…'
          : item.state === 'uploading' ? 'Lädt hoch…'
            : item.state === 'done' ? '✓ Hochgeladen'
              : item.state === 'error' ? '⚠ ' + (item.error || 'Fehler')
                : ''
    const statusCls =
      item.state === 'done' ? 'eduki-cat-up-slot__status--ok'
        : item.state === 'error' ? 'eduki-cat-up-slot__status--err'
          : ''
    const canReplace = item.state === 'done' || item.state === 'error'
    return h('div', { className: 'eduki-cat-up-slot eduki-cat-up-slot--filled' },
      h('span', { className: 'eduki-cat-up-slot__icon' }, fileIcon(file.name.split('.').pop() || '')),
      h('div', { className: 'eduki-cat-up-slot__main' },
        h('div', { className: 'eduki-cat-up-slot__name' }, file.name),
        h('div', { className: 'eduki-cat-up-slot__meta' }, meta),
        item.s3Key
          ? h('div', { className: 'eduki-cat-up-slot__key' }, item.s3Key)
          : null,
      ),
      h('div', { className: 'eduki-cat-up-slot__right' },
        h('span', { className: 'eduki-cat-up-slot__status ' + statusCls }, statusLabel),
        canReplace
          ? h('label', {
            className: 'eduki-cat-up-slot__pick',
            title: 'Andere Datei wählen',
          },
          h('input', {
            type: 'file',
            style: { display: 'none' },
            onChange: (e: { target: HTMLInputElement }) => {
              const f = e.target.files && e.target.files[0]
              if (f) onPick(f)
              e.target.value = ''
            },
          }),
          '🔁',
          )
          : null,
        h('button', {
          type: 'button',
          className: 'eduki-cat-up-slot__remove',
          onClick: onRemove,
          title: 'Slot entfernen',
          'aria-label': 'Slot entfernen',
        }, '\u00d7'),
      ),
    )
  }

  // Empty slot — picker UI
  return h('label', {
    className: 'eduki-cat-up-slot eduki-cat-up-slot--empty' + (dragOver ? ' is-over' : ''),
    onDragOver: (e: DragEvent) => { e.preventDefault(); setDragOver(true) },
    onDragLeave: () => setDragOver(false),
    onDrop: (e: DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]
      if (f) onPick(f)
    },
  },
  h('input', {
    type: 'file',
    style: { display: 'none' },
    ref: (el: HTMLInputElement | null) => { inputRef.current = el },
    onChange: (e: { target: HTMLInputElement }) => {
      const f = e.target.files && e.target.files[0]
      if (f) onPick(f)
      e.target.value = ''
    },
  }),
  h('span', { className: 'eduki-cat-up-slot__icon' }, '📎'),
  h('div', { className: 'eduki-cat-up-slot__main' },
    h('div', { className: 'eduki-cat-up-slot__name' }, '📎 Datei wählen…'),
    h('div', { className: 'eduki-cat-up-slot__meta' }, 'Eine einzelne Datei pro Slot'),
  ),
  h('button', {
    type: 'button',
    className: 'eduki-cat-up-slot__remove',
    onClick: (e: MouseEvent) => { e.preventDefault(); onRemove() },
    title: 'Slot entfernen',
    'aria-label': 'Slot entfernen',
  }, '\u00d7'),
  )
}

function CatalogOverlay() {
  const [open] = useOpen()
  const statePair = useState<
    { phase: 'loading'; snapshot: null; error: null }
    | { phase: 'ready'; snapshot: CatalogSnapshot; error: null }
    | { phase: 'error'; snapshot: null; error: string }
  >({ phase: 'loading', snapshot: null, error: null })
  const state = statePair[0]
  const setState = statePair[1]

  const queryPair = useState('')
  const query = queryPair[0]
  const setQuery = queryPair[1]
  const subjPair = useState('')
  const subjectFilter = subjPair[0]
  const setSubjectFilter = subjPair[1]

  // Katalogauswahl: genau eine Ausgabegruppe anzeigen und Auswahl persistent halten.
  const CATALOG_FILTER_KEY = 'eduki-cat-filter'
  const catalogFilterPair = useState<'' | 'einstiegsheft' | 'premium'>(() => {
    try {
      const saved = window.localStorage.getItem(CATALOG_FILTER_KEY)
      return saved === 'einstiegsheft' || saved === 'premium' ? saved : ''
    } catch { return '' }
  })
  const catalogFilter = catalogFilterPair[0]
  const setCatalogFilter = (v: '' | 'einstiegsheft' | 'premium'): void => {
    catalogFilterPair[1](v)
    try { window.localStorage.setItem(CATALOG_FILTER_KEY, v) } catch { /* ignore */ }
  }

  const selectedPair = useState<Heft | null>(null)
  const selected = selectedPair[0]
  const setSelected = selectedPair[1]

  const upload = useUpload()

  useEffect(() => {
    if (!open) return
    let alive = true
    const cached = snapshotCache && snapshotCache.itemsLen === upload.items.length
      ? snapshotCache.snapshot
      : null
    if (cached) {
      // Sofort aus dem Cache zeigen, dann still auffrischen.
      setState({ phase: 'ready', snapshot: cached, error: null })
      fetch(SNAPSHOT_URL + '?_=' + Date.now()).then(
        (res) => {
          if (!res.ok) throw new Error('HTTP ' + res.status)
          return res.json()
        },
      ).then(
        (snapshot) => {
          snapshotCache = { snapshot, itemsLen: upload.items.length }
          if (alive) setState({ phase: 'ready', snapshot, error: null })
        },
        () => { /* Cache-Stand bleibt gueltig */ },
      )
      return () => { alive = false }
    }
    setState({ phase: 'loading', snapshot: null, error: null })
    fetch(SNAPSHOT_URL + '?_=' + Date.now()).then(
      (res) => {
        if (!res.ok) throw new Error('HTTP ' + res.status)
        return res.json()
      },
    ).then(
      (snapshot) => {
        snapshotCache = { snapshot, itemsLen: upload.items.length }
        if (alive) setState({ phase: 'ready', snapshot, error: null })
      },
      (err) => { if (alive) setState({ phase: 'error', snapshot: null, error: String((err && err.message) || err) }) },
    )
    return () => { alive = false }
  }, [open, upload.items.length])  // refresh after a successful upload batch

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (upload.open) upload.setOpen(false)
        else setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, upload.open])

  if (!open) return null

  const onBackdrop = (e: MouseEvent): void => {
    const t = e.target as HTMLElement
    if (t && t.classList && t.classList.contains('eduki-cat-overlay-backdrop')) setOpen(false)
  }

  // Eindeutige Faecher aus dem Snapshot (alphabetisch sortiert).  Wird
  // einmal pro Render berechnet und sowohl im Filter-Dropdown als auch im
  // Body verwendet.
  const hefte = state.phase === 'ready' ? (state.snapshot.hefte || []) : []
  const subjects = Array.from(new Set(hefte.map(h => h.subject).filter(Boolean))).sort()

  let body
  if (state.phase === 'loading') {
    body = h('div', { className: 'eduki-cat-status' }, 'Lade Heft-Katalog …')
  } else if (state.phase === 'error') {
    body = h('div', { className: 'eduki-cat-status eduki-cat-status--error' },
      'Katalog nicht ladbar: ' + state.error)
  } else if (selected) {
    body = h(HeftDetail, {
      heft: selected,
      onBack: () => setSelected(null),
      onUpload: (title: string) => upload.openForHeft(title),
      onUploadFile: (title: string, file: File) => upload.uploadSingleForHeft(title, file),
      pendingItems: upload.items.filter(it => it.state !== 'empty'),
    })
  } else {
    const einstiegCount = hefte.filter(isEinstiegsheft).length
    const premiumCount = hefte.filter(isPremiumHeft).length
    const meta = h('div', { className: 'eduki-cat-meta' },
      h('span', null, catalogFilter === 'einstiegsheft'
        ? `${einstiegCount} Einstiegshefte (von ${hefte.length} Heften insgesamt)`
        : catalogFilter === 'premium' ? `${premiumCount} Premium-Autorenhefte`
        : `${hefte.length} Hefte insgesamt`),
      h('span', null, 'Snapshot: ' + new Date(state.snapshot.generated_at).toLocaleString()),
    )
    body = h('div', null,
      meta,
      h(HeftList, {
        hefte,
        query,
        subjectFilter,
        catalogFilter,
        onSelect: setSelected,
        onUpload: (title: string) => upload.openForHeft(title),
      }),
    )
  }
  return h(
    'div',
    { className: 'eduki-cat-overlay-root', onClick: onBackdrop },
    h('div', { className: 'eduki-cat-overlay-backdrop', 'aria-hidden': 'true' }),
    h('div', {
      className: 'eduki-cat-overlay-panel',
      role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Eduki-Heftkatalog',
    },
    h('div', { className: 'eduki-cat-header' },
      h('div', { className: 'eduki-cat-header__titles' },
        h('h2', null, 'Eduki-Heftkatalog'),
        h('p', null, selected
          ? (selected.revisions && selected.revisions.length > 1
            ? 'Detailansicht — Auswahl der Revision über das Dropdown unten. '
            : 'Detailansicht — ')
              + 'PDFs öffnen im Browser-Tab, andere Dateien laden herunter.'
          : 'Alle erstellten Hefte, gruppiert nach Topic. Mehrere Revisionen pro Heft sind über das Dropdown in der Detailansicht erreichbar.'),
      ),
      h('button', {
        type: 'button', className: 'eduki-cat-close',
        onClick: () => setOpen(false), 'aria-label': 'Schließen',
      }, '\u00d7'),
    ),
    selected
      ? null
      : h('div', { className: 'eduki-cat-search' },
        h('input', {
          type: 'search',
          placeholder: 'Heft suchen (Titel, Fach, Gruppe, Datei)…',
          value: query,
          onChange: (e: { target: { value: string } }) => setQuery(e.target.value),
          autoFocus: true,
        }),
        // subjects wird weiter oben in der Body-Verzweigung berechnet.
        // Bei geschlossenem Overlay (selected !== null) ist der Filter
        // nicht sichtbar — wir rendern dann nur das Suchfeld.
        h('label', { className: 'eduki-cat-subject-filter' },
          h('span', { className: 'eduki-cat-subject-filter__label' }, 'Fach:'),
          h('select', {
            value: subjectFilter,
            onChange: (e: { target: { value: string } }) => setSubjectFilter(e.target.value),
            'aria-label': 'Fach auswählen',
          },
          h('option', { value: '' }, 'Alle Fächer'),
          Array.from(subjects).map(s =>
            h('option', { key: s, value: s }, s),
          ),
          ),
        ),
        h('label', { className: 'eduki-cat-subject-filter' },
          h('span', { className: 'eduki-cat-subject-filter__label' }, catalogText.label),
          h('select', {
            value: catalogFilter,
            onChange: (e: { target: { value: string } }) => setCatalogFilter(e.target.value as '' | 'einstiegsheft' | 'premium'),
            'aria-label': catalogText.label,
          },
            h('option', { value: '' }, catalogText.all),
            h('option', { value: 'einstiegsheft' }, catalogText.intro),
            h('option', { value: 'premium' }, catalogText.premium),
          ),
        ),
      ),
    h('div', { className: 'eduki-cat-body' }, body),
    h(UploadModal),
    ),
  )
}

// ── Styles ─────────────────────────────────────────────────────────────────
const CSS = [
  '.eduki-cat-sidebar-btn{all:unset;display:flex;align-items:center;gap:8px;width:100%;padding:8px 12px;cursor:pointer;border-radius:6px;font:inherit;color:inherit;box-sizing:border-box}',
  '.eduki-cat-sidebar-btn:hover{background:rgba(255,255,255,.07)}',
  '.eduki-cat-sidebar-btn.is-active{background:rgba(74,127,191,.22)}',
  '.eduki-cat-sidebar-btn__icon{font-size:18px;line-height:1;width:20px;text-align:center;flex:none}',
  '.eduki-cat-sidebar-btn__label{font-size:13px;font-weight:500;line-height:1.2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',

  '.eduki-cat-overlay-root{position:fixed;inset:0;z-index:9000;display:flex;align-items:center;justify-content:center;font-family:inherit}',
  '.eduki-cat-overlay-backdrop{position:absolute;inset:0;background:rgba(8,12,24,.55);backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px)}',
  '.eduki-cat-overlay-panel{position:relative;width:min(880px,94vw);max-height:90vh;display:flex;flex-direction:column;background:#fff;color:#111;border-radius:12px;box-shadow:0 24px 60px rgba(0,0,0,.45);overflow:hidden}',
  '@media (prefers-color-scheme:dark){.eduki-cat-overlay-panel{background:#1a1f2b;color:#e6e8ee}}',

  '.eduki-cat-header{display:flex;align-items:flex-start;justify-content:space-between;padding:14px 20px;border-bottom:1px solid rgba(0,0,0,.08);gap:16px}',
  '@media (prefers-color-scheme:dark){.eduki-cat-header{border-bottom-color:rgba(255,255,255,.08)}}',
  '.eduki-cat-header__titles h2{margin:0;font-size:16px;font-weight:600}',
  '.eduki-cat-header__titles p{margin:4px 0 0;font-size:12px;color:#888}',
  '.eduki-cat-close{all:unset;width:32px;height:32px;border-radius:6px;text-align:center;cursor:pointer;font-size:22px;line-height:1;display:flex;align-items:center;justify-content:center;flex:none}',
  '.eduki-cat-close:hover{background:rgba(0,0,0,.07)}',
  '@media (prefers-color-scheme:dark){.eduki-cat-close:hover{background:rgba(255,255,255,.1)}}',

  '.eduki-cat-search{padding:12px 20px;border-bottom:1px solid rgba(0,0,0,.08);display:flex;align-items:center;gap:14px}',
  '@media (prefers-color-scheme:dark){.eduki-cat-search{border-bottom-color:rgba(255,255,255,.08)}}',
  '.eduki-cat-search input[type=search]{flex:1;width:auto;font:inherit;color:inherit;padding:9px 12px;border-radius:8px;border:1px solid rgba(0,0,0,.15);background:rgba(0,0,0,.03);box-sizing:border-box}',
  '.eduki-cat-subject-filter{display:flex;align-items:center;gap:6px;font-size:12.5px;color:#888;white-space:nowrap;user-select:none;flex-shrink:0}',
  '.eduki-cat-subject-filter__label{font-weight:500}',
  // Light-Mode Default
  '.eduki-cat-subject-filter select{font:inherit;font-size:12.5px;color:#111;padding:5px 8px;border-radius:6px;border:1px solid rgba(0,0,0,.2);background:#fff;cursor:pointer;min-width:140px;color-scheme:light}',
  '.eduki-cat-subject-filter select:focus{outline:2px solid rgba(74,127,191,.45);outline-offset:1px}',
  // Dark-Mode: eigenes color-scheme + helle Schrift auf dunklem BG,
  // damit Browser das Popup auch invertiert rendert (sonst bleibt das
  // ausgeklappte Optionsmenü hell, weil das OS die Default-Theme nutzt).
  '@media (prefers-color-scheme:dark){.eduki-cat-subject-filter{color:#aab1c2}',
  '.eduki-cat-subject-filter select{color:#e6e8ee;border-color:rgba(255,255,255,.25);background:#2a2f3d;color-scheme:dark}}',

  '.eduki-cat-body{flex:1;overflow-y:auto;padding:10px 0;min-height:0}',
  '.eduki-cat-status{padding:36px 16px;text-align:center;color:#777;font-size:13px}',
  '.eduki-cat-status--error{color:#c0392b}',
  '.eduki-cat-meta{padding:8px 20px;font-size:11px;color:#888;border-bottom:1px solid rgba(0,0,0,.05);display:flex;gap:14px;flex-wrap:wrap}',
  '@media (prefers-color-scheme:dark){.eduki-cat-meta{border-bottom-color:rgba(255,255,255,.05)}}',

  // Heft list row: button (click-to-detail) + side upload-button.
  '.eduki-cat-heft-row{display:flex;align-items:stretch;gap:0;border-bottom:1px solid rgba(0,0,0,.04);box-sizing:border-box}',
  '@media (prefers-color-scheme:dark){.eduki-cat-heft-row{border-bottom-color:rgba(255,255,255,.05)}}',
  '.eduki-cat-heft-row--gen{background:linear-gradient(to right, rgba(80,180,120,.04), transparent 30%)}',
  '@media (prefers-color-scheme:dark){.eduki-cat-heft-row--gen{background:linear-gradient(to right, rgba(109,212,154,.06), transparent 30%)}}',
  '.eduki-cat-heft{flex:1;display:flex;align-items:center;gap:12px;padding:12px 12px 12px 20px;border:none;background:none;cursor:pointer;text-align:left;color:inherit;font:inherit;box-sizing:border-box}',
  '.eduki-cat-heft-row:hover .eduki-cat-heft{background:rgba(74,127,191,.07)}',
  '.eduki-cat-heft__icon{font-size:20px;flex:none;width:32px;text-align:center}',
  '.eduki-cat-heft__main{flex:1;min-width:0}',
  '.eduki-cat-heft__title{font-weight:600;font-size:13.5px;line-height:1.3}',
  '.eduki-cat-heft__sub{font-size:11.5px;color:#888;margin-top:2px}',
  '.eduki-cat-heft__files{font-size:11px;color:#888;flex:none}',
  '.eduki-cat-heft__arrow{font-size:14px;color:#4a7fbf;flex:none}',

  // Per-row action group (ZIP download + upload), aligned to the right of
  // the row. Replaces the previously icon-only upload cell with a small
  // flex container so we can render both buttons side by side.
  '.eduki-cat-heft-actions{display:flex;align-items:stretch;gap:0;flex:none}',
  // ZIP download button — primary blue pill with ⬇ icon. Disabled state
  // is greyed-out (no URL available — should not happen in practice).
  '.eduki-cat-heft-zip{all:unset;display:inline-flex;align-items:center;gap:4px;padding:0 12px;font-size:12px;font-weight:600;line-height:1;color:#fff;background:#4a7fbf;cursor:pointer;border-right:1px solid rgba(255,255,255,.18);box-sizing:border-box;text-decoration:none}',
  '.eduki-cat-heft-zip:hover{background:#2a5e9e;color:#fff}',
  '.eduki-cat-heft-zip:focus-visible{outline:2px solid #2a5e9e;outline-offset:-2px}',
  '@media (prefers-color-scheme:dark){.eduki-cat-heft-zip{background:#3d6ea3}.eduki-cat-heft-zip:hover{background:#5e8ec3}}',
  '.eduki-cat-heft-zip--disabled{background:#bbb;color:#fff;cursor:not-allowed}',
  '@media (prefers-color-scheme:dark){.eduki-cat-heft-zip--disabled{background:#555;color:#aaa}}',
  // Per-row upload button (icon-only, sits to the right of the ZIP button).
  '.eduki-cat-heft-upload{all:unset;display:flex;align-items:center;justify-content:center;padding:0 18px;font-size:18px;cursor:pointer;color:#4a7fbf;flex:none}',
  '.eduki-cat-heft-upload:hover{background:rgba(74,127,191,.18);color:#2a5e9e}',
  '@media (prefers-color-scheme:dark){.eduki-cat-heft-upload:hover{color:#7ea7d6}}',

  '.eduki-cat-badge{display:inline-block;font-size:10px;text-transform:uppercase;letter-spacing:.04em;font-weight:700;padding:1px 7px;border-radius:4px}',
  '.eduki-cat-badge--green{background:rgba(80,180,120,.18);color:#207a48}',
  '.eduki-cat-badge--blue{background:rgba(74,127,191,.2);color:#4a7fbf}',
  '.eduki-cat-badge--red{background:rgba(220,80,80,.18);color:#c0392b}',
  '.eduki-cat-badge--gray{background:rgba(120,140,160,.18);color:#5a6470}',
  '.eduki-cat-badge--gold{background:rgba(240,170,30,.2);color:#9a6a00}',
  '@media (prefers-color-scheme:dark){.eduki-cat-badge--green{color:#6dd49a}.eduki-cat-badge--blue{color:#7ea7d6}.eduki-cat-badge--red{color:#ff7a75}.eduki-cat-badge--gray{color:#aab2bd}.eduki-cat-badge--gold{color:#ffc95e}}',
  // ── Einstiegsheft-Switch ────────────────────────────────────────────────
  '.eduki-cat-einstieg-switch{display:flex;align-items:center;gap:7px;font-size:12.5px;color:#888;white-space:nowrap;user-select:none;flex-shrink:0;cursor:pointer;position:relative}',
  '.eduki-cat-einstieg-switch input{position:absolute;opacity:0;width:0;height:0}',
  '.eduki-cat-einstieg-switch__track{position:relative;width:32px;height:18px;border-radius:9px;background:rgba(0,0,0,.22);transition:background .15s ease;flex-shrink:0}',
  '.eduki-cat-einstieg-switch__thumb{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.3);transition:left .15s ease}',
  '.eduki-cat-einstieg-switch input:checked + .eduki-cat-einstieg-switch__track{background:#2e9e5b}',
  '.eduki-cat-einstieg-switch input:checked + .eduki-cat-einstieg-switch__track .eduki-cat-einstieg-switch__thumb{left:16px}',
  '.eduki-cat-einstieg-switch input:focus-visible + .eduki-cat-einstieg-switch__track{outline:2px solid #2e9e5b;outline-offset:2px}',
  '.eduki-cat-einstieg-switch__label{font-weight:500}',
  '@media (prefers-color-scheme:dark){.eduki-cat-einstieg-switch{color:#aab1c2}.eduki-cat-einstieg-switch__track{background:rgba(255,255,255,.22)}.eduki-cat-einstieg-switch input:checked + .eduki-cat-einstieg-switch__track{background:#3aa76d}}',

  '.eduki-cat-detail{padding:16px 20px}',
  '.eduki-cat-detail__head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px}',
  '.eduki-cat-detail__back{all:unset;display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-size:12.5px;color:#4a7fbf;padding:4px 8px;border-radius:6px}',
  '.eduki-cat-detail__back:hover{background:rgba(74,127,191,.1)}',
  '.eduki-cat-detail__upload{all:unset;display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-size:12.5px;color:#fff;background:#4a7fbf;padding:6px 12px;border-radius:6px;font-weight:500}',
  '.eduki-cat-detail__upload:hover{background:rgba(74,127,191,.92)}',
  '.eduki-cat-detail__title{font-size:16px;font-weight:600;margin:8px 0 4px}',
  '.eduki-cat-detail__sub{font-size:12px;color:#888;margin-bottom:14px}',
  // Revisions-Dropdown in der Dateiansicht. Eine Zeile mit Label + Select
  // und einer kleinen Anzahl-Anzeige rechts. Wird nur gerendert, wenn
  // mehr als eine Revision existiert.
  '.eduki-cat-revisions{display:flex;align-items:center;gap:14px;margin:0 0 14px;padding:9px 14px;background:rgba(74,127,191,.08);border:1px solid rgba(74,127,191,.18);border-radius:8px;flex-wrap:wrap}',
  '.eduki-cat-revisions__label{display:inline-flex;align-items:center;gap:8px;font-size:12.5px;color:#4a7fbf;font-weight:500}',
  '.eduki-cat-revisions__select{font:inherit;color:#111;padding:5px 8px;border-radius:6px;border:1px solid rgba(74,127,191,.45);background:#fff;cursor:pointer;min-width:220px;color-scheme:light}',
  '.eduki-cat-revisions__select:focus{outline:2px solid #4a7fbf;outline-offset:1px}',
  '@media (prefers-color-scheme:dark){.eduki-cat-revisions__select{color:#e6e8ee;border-color:rgba(74,127,191,.55);background:#2a2f3d;color-scheme:dark}}',
  '.eduki-cat-revisions__count{font-size:11.5px;color:#777;font-weight:500;margin-left:auto}',
  '.eduki-cat-db{margin-bottom:16px;border:1px solid rgba(0,0,0,.1);border-radius:8px;overflow:hidden}',
  '@media (prefers-color-scheme:dark){.eduki-cat-db{border-color:rgba(255,255,255,.12)}}',
  '.eduki-cat-db__head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 14px;background:rgba(74,127,191,.09);border-bottom:1px solid rgba(0,0,0,.08)}',
  '@media (prefers-color-scheme:dark){.eduki-cat-db__head{border-bottom-color:rgba(255,255,255,.08)}}',
  '.eduki-cat-db__title{font-size:12.5px;font-weight:600;color:#4a7fbf}',
  '.eduki-cat-db__selector{display:flex;align-items:center;gap:6px;font-size:11.5px;color:#555}',
  '.eduki-cat-db__selector select{font:inherit;color:inherit;padding:3px 6px;border-radius:5px;border:1px solid rgba(0,0,0,.15);background:transparent;max-width:220px}',
  '@media (prefers-color-scheme:dark){.eduki-cat-db__selector select{border-color:rgba(255,255,255,.15)}}',
  '.eduki-cat-db__dl{margin:0;padding:8px 14px;display:grid;grid-template-columns:minmax(130px,auto) 1fr;gap:2px 14px}',
  '.eduki-cat-db__row{display:contents}',
  '.eduki-cat-db__row dt{font-size:11px;color:#888;padding:3px 0;text-transform:uppercase;letter-spacing:.04em}',
  '.eduki-cat-db__row dd{margin:0;font-size:12px;padding:3px 0;font-family:ui-monospace,Menlo,Consolas,monospace;word-break:break-all}',
  '.eduki-cat-db__val--muted{color:#999}',
  '.eduki-cat-file{display:flex;align-items:center;gap:12px;padding:11px 14px;border-radius:8px;background:rgba(0,0,0,.04);border:1px solid rgba(0,0,0,.06);margin-bottom:8px;transition:background 120ms}',
  '@media (prefers-color-scheme:dark){.eduki-cat-file{background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.06)}}',
  '.eduki-cat-file:hover{background:rgba(74,127,191,.07)}',
  '@media (prefers-color-scheme:dark){.eduki-cat-file:hover{background:rgba(74,127,191,.15)}}',
  '.eduki-cat-file__icon{font-size:18px;flex:none}',
  '.eduki-cat-file__name{display:block;font-size:11.5px;opacity:.72;margin-top:1px;font-family:ui-monospace,Menlo,Consolas,monospace;word-break:break-all}',
  '.eduki-cat-file--zip{margin-top:16px;border-style:dashed}',
  '.eduki-cat-file__main{flex:1;min-width:0;display:flex;align-items:center;gap:10px;color:inherit;text-decoration:none;cursor:pointer;border-radius:6px;padding:2px 4px;margin:-2px -4px}',
  '.eduki-cat-file__main:hover{background:rgba(74,127,191,.08)}',
  '.eduki-cat-file__main>span:last-child{flex:1;min-width:0}',
  '.eduki-cat-file__label{font-weight:500;font-size:13px;line-height:1.3}',
  '.eduki-cat-file__meta{font-size:11px;color:#888;display:block;margin-top:3px;letter-spacing:.2px}',
  '.eduki-cat-file__actions{display:flex;align-items:center;gap:6px;flex:none}',
  '.eduki-cat-file__dl{flex:none;display:inline-block;font-size:12px;font-weight:600;color:#4a7fbf;border:1px solid rgba(74,127,191,.4);padding:5px 12px;border-radius:6px;white-space:nowrap;text-decoration:none;cursor:pointer}',
  '.eduki-cat-file__dl--disabled{color:#bbb;border-color:rgba(0,0,0,.1);cursor:default}',
  '@media (prefers-color-scheme:dark){.eduki-cat-file__dl--disabled{border-color:rgba(255,255,255,.1)}}',
  '.eduki-cat-file__open{flex:none;display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:600;color:#207a48;background:rgba(80,180,120,.18);padding:5px 10px;border-radius:6px;white-space:nowrap;text-decoration:none;cursor:pointer;transition:background 120ms}',
  '.eduki-cat-file__open:hover{background:rgba(80,180,120,.32)}',
  '@media (prefers-color-scheme:dark){.eduki-cat-file__open{color:#6dd49a;background:rgba(109,212,154,.18)}.eduki-cat-file__open:hover{background:rgba(109,212,154,.32)}}',
  '.eduki-cat-file__up{all:unset;flex:none;display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:500;color:#4a7fbf;background:rgba(74,127,191,.12);padding:5px 10px;border-radius:6px;white-space:nowrap;cursor:pointer;transition:background 120ms}',
  '.eduki-cat-file__up:hover{background:rgba(74,127,191,.24)}',
  '@media (prefers-color-scheme:dark){.eduki-cat-file__up{background:rgba(74,127,191,.18)}.eduki-cat-file__up:hover{background:rgba(74,127,191,.32)}}',
  '.eduki-cat-empty{padding:30px 16px;text-align:center;color:#888;font-size:13px}',

  // Upload modal
  '.eduki-cat-up-root{position:fixed;inset:0;z-index:9100;display:flex;align-items:center;justify-content:center;font-family:inherit}',
  '.eduki-cat-up-backdrop{position:absolute;inset:0;background:rgba(8,12,24,.45);backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px)}',
  '.eduki-cat-up-panel{position:relative;width:min(640px,94vw);max-height:90vh;display:flex;flex-direction:column;background:#fff;color:#111;border-radius:12px;box-shadow:0 24px 60px rgba(0,0,0,.45);overflow:hidden}',
  '@media (prefers-color-scheme:dark){.eduki-cat-up-panel{background:#1a1f2b;color:#e6e8ee}}',
  '.eduki-cat-up-header{display:flex;align-items:flex-start;justify-content:space-between;padding:14px 20px;border-bottom:1px solid rgba(0,0,0,.08);gap:16px}',
  '@media (prefers-color-scheme:dark){.eduki-cat-up-header{border-bottom-color:rgba(255,255,255,.08)}}',
  '.eduki-cat-up-header h3{margin:0;font-size:16px;font-weight:600}',
  '.eduki-cat-up-header p{margin:4px 0 0;font-size:12px;color:#888;max-width:46ch}',
  '.eduki-cat-up-body{padding:16px 20px;overflow-y:auto;flex:1;min-height:0}',
  '.eduki-cat-up-field{display:flex;flex-direction:column;gap:6px;margin-bottom:14px}',
  '.eduki-cat-up-field label{font-size:12px;color:#888}',
  '.eduki-cat-up-field input{font:inherit;color:inherit;padding:9px 12px;border-radius:8px;border:1px solid rgba(0,0,0,.15);background:rgba(0,0,0,.03);box-sizing:border-box}',
  '@media (prefers-color-scheme:dark){.eduki-cat-up-field input{border-color:rgba(255,255,255,.15);background:rgba(255,255,255,.04)}}',

  // Per-file slots (modal + inline).
  '.eduki-cat-up-slots{margin-bottom:12px;display:flex;flex-direction:column;gap:8px}',
  '.eduki-cat-up-slots__empty{padding:18px;text-align:center;color:#888;font-size:12.5px;border:1px dashed rgba(0,0,0,.12);border-radius:8px}',
  '@media (prefers-color-scheme:dark){.eduki-cat-up-slots__empty{border-color:rgba(255,255,255,.15)}}',
  '.eduki-cat-up-slot{display:flex;align-items:center;gap:10px;padding:9px 11px;border-radius:8px;background:rgba(0,0,0,.03);border:1px solid rgba(0,0,0,.06);position:relative}',
  '@media (prefers-color-scheme:dark){.eduki-cat-up-slot{background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.06)}}',
  '.eduki-cat-up-slot--empty{border-style:dashed;background:rgba(74,127,191,.04);cursor:pointer;transition:background 120ms,border-color 120ms}',
  '.eduki-cat-up-slot--empty:hover,.eduki-cat-up-slot--empty.is-over{background:rgba(74,127,191,.12);border-color:rgba(74,127,191,.85)}',
  '.eduki-cat-up-slot--filled{background:rgba(0,0,0,.03)}',
  '.eduki-cat-up-slot__icon{font-size:18px;flex:none;width:24px;text-align:center}',
  '.eduki-cat-up-slot__main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}',
  '.eduki-cat-up-slot__name{font-weight:500;font-size:13px;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.eduki-cat-up-slot__meta{font-size:11px;color:#888;font-family:ui-monospace,Menlo,Consolas,monospace}',
  '.eduki-cat-up-slot__key{font-size:10.5px;color:#4a7fbf;font-family:ui-monospace,Menlo,Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.eduki-cat-up-slot__right{display:flex;align-items:center;gap:6px;flex:none}',
  '.eduki-cat-up-slot__status{font-size:11.5px;font-weight:500;color:#777;min-width:90px;text-align:right}',
  '.eduki-cat-up-slot__status--ok{color:#207a48}',
  '.eduki-cat-up-slot__status--err{color:#c0392b}',
  '.eduki-cat-up-slot__pick{all:unset;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:6px;cursor:pointer;font-size:14px;color:#4a7fbf}',
  '.eduki-cat-up-slot__pick:hover{background:rgba(74,127,191,.18)}',
  '.eduki-cat-up-slot__remove{all:unset;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:6px;cursor:pointer;font-size:16px;color:#888;line-height:1}',
  '.eduki-cat-up-slot__remove:hover{background:rgba(0,0,0,.07);color:#c0392b}',
  '@media (prefers-color-scheme:dark){.eduki-cat-up-slot__remove:hover{background:rgba(255,255,255,.1)}}',

  '.eduki-cat-up-add{all:unset;display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:6px;background:rgba(74,127,191,.1);color:#4a7fbf;cursor:pointer;font-size:13px;font-weight:500;width:fit-content}',
  '.eduki-cat-up-add:hover{background:rgba(74,127,191,.2)}',

  '.eduki-cat-up-footer{display:flex;align-items:center;justify-content:space-between;padding:12px 20px;border-top:1px solid rgba(0,0,0,.06);font-size:12.5px;color:#888;gap:12px}',
  '@media (prefers-color-scheme:dark){.eduki-cat-up-footer{border-top-color:rgba(255,255,255,.06)}}',
  '.eduki-cat-up-close{all:unset;padding:8px 16px;border-radius:6px;background:#4a7fbf;color:#fff;cursor:pointer;font-size:13px;font-weight:500}',
  '.eduki-cat-up-close:hover{background:rgba(74,127,191,.92)}',

  // Detail view: inline "+ Datei hinzufügen" + pending uploads list.
  '.eduki-cat-detail__add{display:flex;align-items:center;gap:10px;margin-top:18px;padding-top:14px;border-top:1px solid rgba(0,0,0,.06);flex-wrap:wrap}',
  '@media (prefers-color-scheme:dark){.eduki-cat-detail__add{border-top-color:rgba(255,255,255,.06)}}',
  '.eduki-cat-detail__add-btn{all:unset;display:inline-flex;align-items:center;gap:6px;padding:9px 14px;border-radius:6px;background:#4a7fbf;color:#fff;cursor:pointer;font-size:13px;font-weight:500}',
  '.eduki-cat-detail__add-btn:hover{background:rgba(74,127,191,.92)}',
  '.eduki-cat-detail__add-more{all:unset;display:inline-flex;align-items:center;gap:6px;padding:9px 14px;border-radius:6px;background:rgba(74,127,191,.1);color:#4a7fbf;cursor:pointer;font-size:13px;font-weight:500}',
  '.eduki-cat-detail__add-more:hover{background:rgba(74,127,191,.2)}',
  '.eduki-cat-detail__pending{margin-top:14px;padding:11px 14px;border:1px dashed rgba(74,127,191,.45);border-radius:8px;background:rgba(74,127,191,.05)}',
  '.eduki-cat-detail__pending-title{font-size:12px;color:#4a7fbf;font-weight:500;margin-bottom:8px}',
  '.eduki-cat-detail__pending-row{display:flex;align-items:center;gap:8px;padding:5px 0;font-size:12.5px;border-top:1px solid rgba(74,127,191,.12)}',
  '.eduki-cat-detail__pending-row:first-of-type{border-top:none}',
  '.eduki-cat-detail__pending-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.eduki-cat-detail__pending-status{flex:none;font-size:11.5px;color:#777}',
].join('')

function SidebarButton(props: { wide?: boolean }) {
  const [open, setOpenFn] = useOpen()
  return h(
    'button',
    {
      type: 'button',
      className: 'eduki-cat-sidebar-btn' + (open ? ' is-active' : ''),
      onClick: () => setOpenFn(!open),
      'aria-pressed': open,
      title: 'Eduki-Heftkatalog öffnen',
    },
    h('span', { className: 'eduki-cat-sidebar-btn__icon', 'aria-hidden': 'true' }, '\u{1F4DA}'),
    props.wide
      ? h('span', { className: 'eduki-cat-sidebar-btn__label' }, 'Eduki-Heftkatalog')
      : null,
  )
}

// ── Plugin body ────────────────────────────────────────────────────────────
export function apply(ctx: ClientContext): void {
  const styleId = 'eduki-cat-styles'
  if (typeof document !== 'undefined' && !document.getElementById(styleId)) {
    const tag = document.createElement('style')
    tag.id = styleId
    tag.dataset.plugin = '@deepseek-ai/dsh-client-eduki-catalog'
    tag.textContent = CSS
    document.head.appendChild(tag)
  }

  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      { name: 'sidebar.footer.action', id: 'eduki-catalog-persistent', order: -10, label: 'Eduki-Heftkatalog' },
      (props: { wide?: boolean }) => h(SidebarButton, props),
    ),
  )

  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      { name: 'shell.overlay', id: 'eduki-catalog-persistent', order: 100, label: 'Eduki-Heftkatalog' },
      () => h(CatalogOverlay),
    ),
  )
}
