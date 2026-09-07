/**
 * Eduki-Themen-Recherche, browser half. Registers a sidebar footer action
 * ("Themen-Recherche") and a modal overlay showing the eduki bulk-topics.
 *
 * Data comes from /preview/edukit-snapshot.json — a JSON file the server-side
 * systemd timer (edukit-snapshot.timer) refreshes every 6 hours. The browser
 * needs no admin JWT: it only reads a static snapshot served by Caddy.
 *
 * The overlay stays mounted but returns null while closed (slot pattern), so
 * opening/closing only flips a module-local flag shared between the button and
 * the overlay via the same useOpen() hook.
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

const SNAPSHOT_URL = 'https://dsh.cyberschooling.eu/preview/edukit-snapshot.json'

// ── Data shapes (mirrors the bulk-topics API contract) ─────────────────────
type BulkTopicRow = {
  opportunityId: number
  marketplace: string
  countryIso: string
  language: string
  subjectName: string
  topicKeyword: string
  topicTitle: string | null
  curriculumTopicId: number | null
  curriculumGrade: string | null
  gradeMin: number | null
  gradeMax: number | null
  opportunityScore: number
  estimatedMonthlyRevenue: number | null
  estimatedMonthlySearches: number | null
  estimatedTeacherCount: number | null
  competitionLevel: string
  ourCurriculumCoverage: string
  existingProducts: number
  whyOnTop: string | null
  alreadyShipped: { hasSpec: boolean; specIds: number[]; statuses: string[] } | null
}

type Snapshot = {
  generated_at: string
  source: string
  rows: BulkTopicRow[]
}

type Filters = {
  countryIso: string
  subjectName: string
  grade: number | null
  minScore: number | null
  onlyUnbuilt: boolean
}

// ── Urgency math (same as the old Cordis plugin) ───────────────────────────
const COVERAGE_WEIGHT: Record<string, number> = { full: 1.0, partial: 0.6, none: 0.3 }
function urgency(row: BulkTopicRow): number {
  const score = Number(row.opportunityScore) || 0
  const cov = row.ourCurriculumCoverage || 'none'
  const existing = Number(row.existingProducts) || 0
  const cw = COVERAGE_WEIGHT[cov] !== undefined ? COVERAGE_WEIGHT[cov] : 0.3
  const gw = 1 / (1 + existing)
  return score * cw * gw
}
function urgencyTier(u: number): 'high' | 'medium' | 'low' {
  if (u >= 60) return 'high'
  if (u >= 30) return 'medium'
  return 'low'
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

// ── Styles ─────────────────────────────────────────────────────────────────
const CSS = [
  '.eduki-recherche-sidebar-btn{all:unset;display:flex;align-items:center;gap:8px;width:100%;padding:8px 12px;cursor:pointer;border-radius:6px;font:inherit;color:inherit;box-sizing:border-box}',
  '.eduki-recherche-sidebar-btn:hover{background:rgba(255,255,255,.07)}',
  '.eduki-recherche-sidebar-btn.is-active{background:rgba(74,127,191,.22)}',
  '.eduki-recherche-sidebar-btn__icon{font-size:18px;line-height:1;width:20px;text-align:center;flex:none}',
  '.eduki-recherche-sidebar-btn__label{font-size:13px;font-weight:500;line-height:1.2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',

  '.eduki-recherche-overlay-root{position:fixed;inset:0;z-index:9100;display:flex;align-items:center;justify-content:center;font-family:inherit}',
  '.eduki-recherche-overlay-backdrop{position:absolute;inset:0;background:rgba(8,12,24,.6);backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px)}',
  '.eduki-recherche-overlay-panel{position:relative;width:min(1100px,96vw);max-height:92vh;display:flex;flex-direction:column;background:#fff;color:#111;border-radius:12px;box-shadow:0 24px 60px rgba(0,0,0,.5);overflow:hidden}',
  '@media (prefers-color-scheme:dark){.eduki-recherche-overlay-panel{background:#1a1f2b;color:#e6e8ee}}',

  '.eduki-recherche-header{display:flex;align-items:flex-start;justify-content:space-between;padding:14px 20px;border-bottom:1px solid rgba(0,0,0,.08);gap:16px}',
  '@media (prefers-color-scheme:dark){.eduki-recherche-header{border-bottom-color:rgba(255,255,255,.08)}}',
  '.eduki-recherche-header__titles h2{margin:0;font-size:16px;font-weight:600}',
  '.eduki-recherche-header__titles p{margin:4px 0 0;font-size:12px;color:#888}',
  '.eduki-recherche-close{all:unset;width:32px;height:32px;border-radius:6px;text-align:center;cursor:pointer;font-size:22px;line-height:1;display:flex;align-items:center;justify-content:center;flex:none}',
  '.eduki-recherche-close:hover{background:rgba(0,0,0,.07)}',
  '@media (prefers-color-scheme:dark){.eduki-recherche-close:hover{background:rgba(255,255,255,.1)}}',

  '.eduki-recherche-filterbar{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;padding:12px 20px;border-bottom:1px solid rgba(0,0,0,.08);background:rgba(0,0,0,.02);align-items:end}',
  '@media (prefers-color-scheme:dark){.eduki-recherche-filterbar{border-bottom-color:rgba(255,255,255,.08);background:rgba(255,255,255,.03)}}',
  '.eduki-recherche-filter{display:flex;flex-direction:column;gap:4px}',
  '.eduki-recherche-filter label{font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.05em}',
  '.eduki-recherche-filter input{font:inherit;color:inherit;padding:5px 8px;border-radius:6px;border:1px solid rgba(0,0,0,.15);background:transparent}',
  '@media (prefers-color-scheme:dark){.eduki-recherche-filter input{border-color:rgba(255,255,255,.15)}}',
  '.eduki-recherche-filter input[type=checkbox]{padding:0;width:auto;height:auto}',

  '.eduki-recherche-body{flex:1;overflow:auto;padding:0 0 0}',
  '.eduki-recherche-status{padding:36px 16px;text-align:center;color:#777;font-size:13px}',
  '.eduki-recherche-status--error{color:#c0392b}',
  '.eduki-recherche-meta{padding:10px 20px;font-size:11px;color:#888;border-bottom:1px solid rgba(0,0,0,.06);display:flex;gap:16px;flex-wrap:wrap}',
  '@media (prefers-color-scheme:dark){.eduki-recherche-meta{border-bottom-color:rgba(255,255,255,.06)}}',

  '.eduki-recherche-table{width:100%;border-collapse:collapse;font-size:12.5px}',
  '.eduki-recherche-table thead th{position:sticky;top:0;background:#fff;text-align:left;padding:8px 10px;font-weight:600;color:#555;border-bottom:1px solid rgba(0,0,0,.1);font-size:11px;text-transform:uppercase;letter-spacing:.04em;z-index:1}',
  '@media (prefers-color-scheme:dark){.eduki-recherche-table thead th{background:#1a1f2b;color:#aaa;border-bottom-color:rgba(255,255,255,.1)}}',
  '.eduki-recherche-table tbody tr{border-bottom:1px solid rgba(0,0,0,.04)}',
  '.eduki-recherche-table tbody tr:hover{background:rgba(74,127,191,.06)}',
  '@media (prefers-color-scheme:dark){.eduki-recherche-table tbody tr{border-bottom-color:rgba(255,255,255,.05)}.eduki-recherche-table tbody tr:hover{background:rgba(74,127,191,.12)}}',
  '.eduki-recherche-table td{padding:8px 10px;vertical-align:top}',

  '.eduki-recherche-urgency{display:inline-flex;align-items:center;gap:4px;font-weight:600;font-size:11px;padding:2px 8px;border-radius:999px;letter-spacing:.03em}',
  '.eduki-recherche-urgency--high{background:rgba(220,80,80,.16);color:#c0392b}',
  '.eduki-recherche-urgency--medium{background:rgba(220,160,40,.18);color:#a87800}',
  '.eduki-recherche-urgency--low{background:rgba(120,140,160,.18);color:#5a6470}',
  '@media (prefers-color-scheme:dark){.eduki-recherche-urgency--high{color:#ff7a75}.eduki-recherche-urgency--medium{color:#f5c661}.eduki-recherche-urgency--low{color:#aab2bd}}',

  '.eduki-recherche-coverage{display:inline-block;font-size:10px;padding:1px 6px;border-radius:4px;text-transform:uppercase;letter-spacing:.04em;font-weight:600}',
  '.eduki-recherche-coverage--full{background:rgba(80,180,120,.16);color:#207a48}',
  '.eduki-recherche-coverage--partial{background:rgba(220,160,40,.16);color:#a87800}',
  '.eduki-recherche-coverage--none{background:rgba(160,160,160,.16);color:#666}',
  '@media (prefers-color-scheme:dark){.eduki-recherche-coverage--full{color:#6dd49a}.eduki-recherche-coverage--partial{color:#f5c661}.eduki-recherche-coverage--none{color:#aab2bd}}',

  '.eduki-recherche-existing{display:inline-block;font-size:10px;padding:1px 6px;border-radius:4px;font-weight:600;background:rgba(0,0,0,.06);color:#333}',
  '.eduki-recherche-existing--zero{background:rgba(220,80,80,.16);color:#c0392b}',
  '@media (prefers-color-scheme:dark){.eduki-recherche-existing{background:rgba(255,255,255,.08);color:#ccc}.eduki-recherche-existing--zero{color:#ff7a75}}',

  '.eduki-recherche-title{font-weight:500;line-height:1.3;display:block}',
  '.eduki-recherche-subtitle{font-size:11px;color:#888;margin-top:2px;display:block}',
  '.eduki-recherche-why{font-size:11px;color:#888;margin-top:4px;display:block;line-height:1.4}',

  '.eduki-recherche-tray{position:sticky;bottom:0;background:#fff;border-top:1px solid rgba(0,0,0,.1);padding:12px 20px;display:flex;align-items:center;gap:12px;z-index:2}',
  '@media (prefers-color-scheme:dark){.eduki-recherche-tray{background:#1a1f2b;border-top-color:rgba(255,255,255,.1)}}',
  '.eduki-recherche-tray__count{font-size:13px;font-weight:600;color:#4a7fbf}',
  '.eduki-recherche-tray__actions{margin-left:auto;display:flex;gap:8px}',
  '.eduki-recherche-btn{all:unset;padding:7px 14px;border-radius:6px;font-size:13px;font-weight:500;cursor:pointer;border:1px solid rgba(0,0,0,.15);background:transparent;color:inherit}',
  '.eduki-recherche-btn:hover{background:rgba(74,127,191,.1)}',
  '.eduki-recherche-btn--primary{background:#4a7fbf;color:#fff;border-color:#4a7fbf}',
  '.eduki-recherche-btn--primary:hover{background:#5e93d4}',
  '.eduki-recherche-btn--primary[disabled]{opacity:.5;cursor:not-allowed}',
  '.eduki-recherche-btn--ghost{border-color:transparent}',
].join('')

// ── Components ─────────────────────────────────────────────────────────────
function filterRows(rows: BulkTopicRow[], f: Filters): BulkTopicRow[] {
  return rows.filter((r) => {
    if (f.countryIso && (r.countryIso || '').toUpperCase() !== f.countryIso.toUpperCase()) return false
    if (f.subjectName && !(r.subjectName || '').toLowerCase().includes(f.subjectName.toLowerCase())) return false
    if (f.grade != null) {
      const g = f.grade
      const grade = r.curriculumGrade ? Number((r.curriculumGrade.match(/\d{1,2}/) || [''])[0]) : NaN
      const inRange = (r.gradeMin != null && r.gradeMax != null) ? (g >= r.gradeMin && g <= r.gradeMax) : false
      if (!inRange && !(grade === g)) return false
    }
    if (f.minScore != null && Number(r.opportunityScore) < f.minScore) return false
    if (f.onlyUnbuilt && Number(r.existingProducts) > 0) return false
    return true
  })
}

function RowCheckbox(props: { checked: boolean; onChange: (v: boolean) => void }) {
  return h('input', {
    type: 'checkbox',
    checked: props.checked,
    onChange: (e: { target: { checked: boolean } }) => props.onChange(!!e.target.checked),
    'aria-label': 'Thema auswählen',
  })
}

function FilterBar(props: { filters: Filters; onChange: (f: Filters) => void }) {
  const f = props.filters
  const patch = (p: Partial<Filters>): void => props.onChange({ ...f, ...p })
  return h(
    'div',
    { className: 'eduki-recherche-filterbar' },
    h('div', { className: 'eduki-recherche-filter' },
      h('label', null, 'Land (ISO)'),
      h('input', {
        type: 'text', maxLength: 2, placeholder: 'DE/FR/IT…',
        value: f.countryIso,
        onChange: (e: { target: { value: string } }) => patch({ countryIso: e.target.value.toUpperCase() }),
      }),
    ),
    h('div', { className: 'eduki-recherche-filter' },
      h('label', null, 'Fach'),
      h('input', {
        type: 'text', placeholder: 'z.B. Mathematik',
        value: f.subjectName,
        onChange: (e: { target: { value: string } }) => patch({ subjectName: e.target.value }),
      }),
    ),
    h('div', { className: 'eduki-recherche-filter' },
      h('label', null, 'Klasse'),
      h('input', {
        type: 'number', min: 1, max: 13,
        value: f.grade == null ? '' : String(f.grade),
        onChange: (e: { target: { value: string } }) => {
          const v = e.target.value.trim()
          patch({ grade: v === '' ? null : Number(v) })
        },
      }),
    ),
    h('div', { className: 'eduki-recherche-filter' },
      h('label', null, 'Min Score'),
      h('input', {
        type: 'number', min: 0, max: 100, step: '0.1',
        value: f.minScore == null ? '' : String(f.minScore),
        onChange: (e: { target: { value: string } }) => {
          const v = e.target.value.trim()
          patch({ minScore: v === '' ? null : Number(v) })
        },
      }),
    ),
    h('div', { className: 'eduki-recherche-filter' },
      h('label', null, 'Nur Lücken'),
      h('input', {
        type: 'checkbox',
        checked: f.onlyUnbuilt,
        onChange: (e: { target: { checked: boolean } }) => patch({ onlyUnbuilt: !!e.target.checked }),
      }),
    ),
  )
}

function TopicsTable(props: {
  rows: BulkTopicRow[]
  selection: Record<string, BulkTopicRow>
  onToggle: (key: string, checked: boolean, row: BulkTopicRow) => void
}) {
  const { rows, selection, onToggle } = props
  if (rows.length === 0) {
    return h('div', { className: 'eduki-recherche-status' }, 'Keine Themen passen zu diesen Filtern.')
  }
  const sorted = rows.slice().sort((a, b) => urgency(b) - urgency(a))
  return h(
    'table',
    { className: 'eduki-recherche-table' },
    h('thead', null,
      h('tr', null,
        h('th', { style: { width: '32px' } }, ''),
        h('th', { style: { width: '90px' } }, 'Dringlichkeit'),
        h('th', { style: { width: '55px' } }, 'Score'),
        h('th', { style: { width: '40px' } }, 'Land'),
        h('th', { style: { width: '110px' } }, 'Fach'),
        h('th', null, 'Thema / Curriculum-Titel'),
        h('th', { style: { width: '70px' } }, 'Klasse'),
        h('th', { style: { width: '85px' } }, 'Coverage'),
        h('th', { style: { width: '70px' } }, 'Existing'),
      ),
    ),
    h('tbody', null,
      sorted.map((row) => {
        const key = String(row.opportunityId) + ':' + (row.curriculumTopicId ?? 'x')
        const checked = !!selection[key]
        const title = row.topicTitle || row.topicKeyword || '(kein Titel)'
        const u = urgency(row)
        const tier = urgencyTier(u)
        const gradeLabel = row.curriculumGrade
          || ((row.gradeMin != null || row.gradeMax != null) ? `${row.gradeMin ?? '?'}–${row.gradeMax ?? '?'}` : '')
        return h('tr', { key },
          h('td', null, h(RowCheckbox, { checked, onChange: v => onToggle(key, v, row) })),
          h('td', null, h('span', { className: `eduki-recherche-urgency edukti-urgency--${tier}` }, u.toFixed(1))),
          h('td', null, Number(row.opportunityScore || 0).toFixed(1)),
          h('td', null, row.countryIso || ''),
          h('td', null, row.subjectName || ''),
          h('td', null,
            h('span', { className: 'eduki-recherche-title' }, title),
            row.whyOnTop ? h('span', { className: 'eduki-recherche-why' }, row.whyOnTop) : null,
          ),
          h('td', null, gradeLabel),
          h('td', null, h('span', { className: `eduki-recherche-coverage edukti-coverage--${row.ourCurriculumCoverage || 'none'}` }, row.ourCurriculumCoverage || 'none')),
          h('td', null, h('span', { className: 'eduki-recherche-existing' + (Number(row.existingProducts) === 0 ? ' eduki-recherche-existing--zero' : '') },
            Number(row.existingProducts) === 0 ? 'Gap' : String(row.existingProducts))),
        )
      }),
    ),
  )
}

function SelectionTray(props: {
  count: number
  onClear: () => void
  onCopy: () => void
  copied: boolean
}) {
  return h(
    'div',
    { className: 'eduki-recherche-tray' },
    h('span', { className: 'eduki-recherche-tray__count' },
      props.count === 0 ? 'Keine Auswahl' : `${props.count} ausgewählt`),
    h('span', { style: { fontSize: '11px', color: '#888' } },
      'Sortiert nach Dringlichkeit (score × coverage × 1/(1+existing))'),
    h('div', { className: 'eduki-recherche-tray__actions' },
      h('button', { type: 'button', className: 'eduki-recherche-btn', onClick: props.onClear, disabled: props.count === 0 },
        'Auswahl leeren'),
      h('button', {
        type: 'button',
        className: 'eduki-recherche-btn eduki-recherche-btn--primary',
        onClick: props.onCopy,
        disabled: props.count === 0,
      }, props.copied ? '✓ Kopiert' : 'Bulk-Generate-JSON kopieren'),
    ),
  )
}

function RechercheOverlay() {
  const [open] = useOpen()
  const statePair = useState<
    { phase: 'loading'; snapshot: null; error: null }
    | { phase: 'ready'; snapshot: Snapshot; error: null }
    | { phase: 'error'; snapshot: null; error: string }
  >({ phase: 'loading', snapshot: null, error: null })
  const state = statePair[0]
  const setState = statePair[1]

  const defaultFilters: Filters = { countryIso: 'DE', subjectName: '', grade: null, minScore: null, onlyUnbuilt: true }
  const filtersPair = useState<Filters>(defaultFilters)
  const filters = filtersPair[0]
  const setFilters = filtersPair[1]

  const selectionPair = useState<Record<string, BulkTopicRow>>({})
  const selection = selectionPair[0]
  const setSelection = selectionPair[1]

  const copiedPair = useState(false)
  const copied = copiedPair[0]
  const setCopied = copiedPair[1]

  useEffect(() => {
    if (!open) return
    let alive = true
    setState({ phase: 'loading', snapshot: null, error: null })
    fetch(SNAPSHOT_URL).then(
      (res) => {
        if (!res.ok) throw new Error('HTTP ' + res.status)
        return res.json()
      },
    ).then(
      (snapshot) => { if (alive) setState({ phase: 'ready', snapshot, error: null }) },
      (err) => { if (alive) setState({ phase: 'error', snapshot: null, error: String((err && err.message) || err) }) },
    )
    return () => { alive = false }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return null

  const onBackdrop = (e: MouseEvent): void => {
    const t = e.target as HTMLElement
    if (t && t.classList && t.classList.contains('eduki-recherche-overlay-backdrop')) setOpen(false)
  }

  const onToggle = (key: string, checked: boolean, row: BulkTopicRow): void => {
    if (checked) {
      setSelection({ ...selection, [key]: row })
      return
    }
    const next: Record<string, BulkTopicRow> = {}
    for (const [k, r] of Object.entries(selection)) {
      if (k !== key) next[k] = r
    }
    setSelection(next)
  }

  const buildPayload = (rows: BulkTopicRow[]): unknown[] =>
    rows.map((row) => {
      const gm = row.curriculumGrade ? (row.curriculumGrade.match(/\d{1,2}/) || [''])[0] : ''
      return {
        curriculumTopicId: row.curriculumTopicId ?? null,
        countryIso: row.countryIso || '',
        language: row.language || '',
        subjectName: row.subjectName || '',
        grade: gm ? Number(gm) : null,
        title: row.topicTitle || row.topicKeyword || '',
        learningObjectives: [],
      }
    }).filter(t => t.curriculumTopicId && t.countryIso && t.language && t.subjectName && t.grade && t.title)

  const onCopy = (): void => {
    const rows = Object.keys(selection).map(k => selection[k]).filter((r): r is BulkTopicRow => r !== undefined)
    const topics = buildPayload(rows)
    const text = JSON.stringify({ topics }, null, 2)
    if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
      void navigator.clipboard.writeText(text).then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 2000)
      })
    }
  }

  let body
  if (state.phase === 'loading') {
    body = h('div', { className: 'eduki-recherche-status' }, 'Lade Themen …')
  } else if (state.phase === 'error') {
    body = h('div', { className: 'eduki-recherche-status eduki-recherche-status--error' },
      'Recherche nicht ladbar: ' + state.error)
  } else {
    const rows = filterRows(state.snapshot.rows || [], filters)
    const meta = h('div', { className: 'eduki-recherche-meta' },
      h('span', null, `${rows.length} Themen nach Filtern`),
      h('span', null, 'Snapshot: ' + new Date(state.snapshot.generated_at).toLocaleString()),
    )
    body = h('div', null,
      meta,
      h(TopicsTable, { rows, selection, onToggle }),
    )
  }

  return h(
    'div',
    { className: 'eduki-recherche-overlay-root', onClick: onBackdrop },
    h('div', { className: 'eduki-recherche-overlay-backdrop', 'aria-hidden': 'true' }),
    h('div', {
      className: 'eduki-recherche-overlay-panel',
      role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Themen',
    },
    h('div', { className: 'eduki-recherche-header' },
      h('div', { className: 'eduki-recherche-header__titles' },
        h('h2', null, 'Themen & Bulk-Generierung'),
        h('p', null, 'Quelle: eduki bulk-topics-Snapshot (aktualisiert alle 6h serverseitig). Generieren läuft über die Admin-UI oder das Cordis-Plugin edukit-1.'),
      ),
      h('button', {
        type: 'button', className: 'eduki-recherche-close',
        onClick: () => setOpen(false), 'aria-label': 'Schließen',
      }, '\u00d7'),
    ),
    h(FilterBar, { filters, onChange: setFilters }),
    h('div', { className: 'eduki-recherche-body' }, body),
    h(SelectionTray, {
      count: Object.keys(selection).length,
      onClear: () => setSelection({}),
      onCopy,
      copied,
    }),
    ),
  )
}

function SidebarButton(props: { wide?: boolean }) {
  const [open, setOpenFn] = useOpen()
  return h(
    'button',
    {
      type: 'button',
      className: 'eduki-recherche-sidebar-btn' + (open ? ' is-active' : ''),
      onClick: () => setOpenFn(!open),
      'aria-pressed': open,
      title: 'Themen öffnen',
    },
    h('span', { className: 'eduki-recherche-sidebar-btn__icon', 'aria-hidden': 'true' }, '\u{1F52C}'),
    props.wide
      ? h('span', { className: 'eduki-recherche-sidebar-btn__label' }, 'Themen')
      : null,
  )
}

// ── Plugin body ────────────────────────────────────────────────────────────
export function apply(ctx: ClientContext): void {
  const styleId = 'eduki-recherche-styles'
  if (typeof document !== 'undefined' && !document.getElementById(styleId)) {
    const tag = document.createElement('style')
    tag.id = styleId
    tag.dataset.plugin = '@deepseek-ai/dsh-client-eduki-recherche'
    tag.textContent = CSS
    document.head.appendChild(tag)
  }

  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      { name: 'sidebar.footer.action', id: 'eduki-recherche-persistent', order: -9, label: 'Themen' },
      (props: { wide?: boolean }) => h(SidebarButton, props),
    ),
  )

  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      { name: 'shell.overlay', id: 'eduki-recherche-persistent', order: 99, label: 'Themen & Bulk-Generierung' },
      () => h(RechercheOverlay),
    ),
  )
}
