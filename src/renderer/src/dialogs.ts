import type { RunDetail, RunStepRecord, RunSummary, WorkspaceState } from '../../shared/types'
import { BUILTIN_TEMPLATES } from '../../shared/templates'
import { BUILTIN_VARIABLES } from '../../shared/variables'
import { $, fmtCost, fmtDuration, h, run } from './dom'

type GetWs = () => WorkspaceState | undefined

const pad = (n: number) => String(n).padStart(2, '0')
const toLocalInput = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const fmtDate = (iso: string) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '–')

// ------------------------------------------------------------- templates

export function setupTemplates(getWs: GetWs, afterLoad: () => void): () => void {
  const dialog = $<HTMLDialogElement>('#templates-dialog')
  const list = $('#template-list')
  list.replaceChildren(
    ...BUILTIN_TEMPLATES.map((t, i) => {
      const use = h('button', { class: 'btn primary small', type: 'button' }, 'Use')
      use.addEventListener('click', async () => {
        const ws = getWs()
        if (!ws) return
        if (await run(window.api.applyTemplate(ws.id, i))) {
          dialog.close()
          if (t.variables?.length) afterLoad()
        }
      })
      const steps = t.steps.map((s, n) => `${n + 1}. ${s.prompt.split('\n')[0]}`).join('\n')
      return h(
        'li',
        { class: 'template' },
        h('div', {}, h('strong', {}, t.name), h('span', { class: 'muted small' }, ` · ${t.steps.length} steps`), h('p', { class: 'muted small' }, t.description)),
        h('span', { class: 'spacer' }),
        h('span', { class: 'template-steps', title: steps }, 'ⓘ'),
        use
      )
    })
  )
  return () => {
    const ws = getWs()
    if (ws && ['starting', 'running', 'waiting_user', 'pausing'].includes(ws.chain.state)) {
      void run(Promise.resolve('Cannot load a template while the chain is running'))
      return
    }
    dialog.showModal()
  }
}

// ------------------------------------------------------------- variables

export function setupVariables(getWs: GetWs): () => void {
  const dialog = $<HTMLDialogElement>('#variables-dialog')
  const fields = $('#variables-fields')
  $('#builtin-vars').replaceChildren(...BUILTIN_VARIABLES.map((v) => h('li', {}, h('code', {}, `{{${v.name}}}`), ` — ${v.description}`)))
  let wsId = ''

  dialog.addEventListener('close', async () => {
    if (dialog.returnValue !== 'save' || !wsId) return
    const values: Record<string, string> = {}
    for (const el of fields.querySelectorAll<HTMLTextAreaElement>('textarea[data-name]')) values[el.dataset.name!] = el.value
    await run(window.api.setVariables(wsId, values))
  })

  return () => {
    const ws = getWs()
    if (!ws) return
    wsId = ws.id
    dialog.returnValue = ''
    fields.replaceChildren(
      ...(ws.variables.length
        ? ws.variables.map((v) => {
            const ta = h('textarea', { rows: '2', 'data-name': v.name, placeholder: v.description ?? '' }) as HTMLTextAreaElement
            ta.value = v.value
            return h('label', { class: 'var-field' }, h('span', {}, h('code', {}, `{{${v.name}}}`), v.description ? h('small', { class: 'muted' }, ` ${v.description}`) : null), ta)
          })
        : [h('p', { class: 'muted' }, 'No variables yet. Write {{name}} in a prompt to add one.')])
    )
    dialog.showModal()
    fields.querySelector<HTMLTextAreaElement>('textarea')?.focus()
  }
}

// -------------------------------------------------------------- schedule

export function setupSchedule(getWs: GetWs): () => void {
  const dialog = $<HTMLDialogElement>('#schedule-dialog')
  const form = $<HTMLFormElement>('#schedule-form')
  const at = form.elements.namedItem('at') as HTMLInputElement
  const daily = form.elements.namedItem('daily') as HTMLInputElement
  let wsId = ''

  dialog.addEventListener('close', async () => {
    if (!wsId) return
    if (dialog.returnValue === 'clear') await run(window.api.setSchedule(wsId, null))
    if (dialog.returnValue !== 'save') return
    const t = new Date(at.value).getTime()
    if (!Number.isFinite(t)) return void run(Promise.resolve('Invalid date'))
    await run(window.api.setSchedule(wsId, { at: t, daily: daily.checked }))
  })

  return () => {
    const ws = getWs()
    if (!ws) return
    wsId = ws.id
    dialog.returnValue = ''
    const next = new Date()
    next.setHours(next.getHours() + 1, 0, 0, 0)
    at.value = toLocalInput(ws.schedule?.at ?? next.getTime())
    at.min = toLocalInput(Date.now())
    daily.checked = ws.schedule?.daily ?? false
    dialog.showModal()
  }
}

// --------------------------------------------------------------- history

const STATUS_MARK: Record<string, string> = { done: '✓', error: '✕', skipped: '⏵', interrupted: '⏸', pending: '◷', running: '◌', waiting: '🔔' }

function stepRow(s: RunStepRecord): HTMLElement[] {
  const out = s.output
    ? (() => {
        const d = h('details', {}, h('summary', {}, 'reply'), h('pre', { class: 'output' }, s.output))
        return d
      })()
    : null
  return [
    h('tr', { class: `st-${s.status}` },
      h('td', {}, String(s.index)),
      h('td', { title: s.status }, `${STATUS_MARK[s.status] ?? ''} ${s.status}`),
      h('td', { class: 'prompt-cell', title: s.prompt }, s.prompt.split('\n')[0]),
      h('td', {}, s.durationMs !== null ? fmtDuration(s.durationMs) : '–'),
      h('td', {}, s.costUsd !== null ? fmtCost(s.costUsd) : '–'),
      h('td', { class: 'small muted' }, s.diffStat ?? '')
    ),
    ...(s.note || out ? [h('tr', { class: 'sub' }, h('td', {}), h('td', { colspan: '5' }, s.note ? h('div', { class: 'note' }, s.note) : null, out))] : [])
  ]
}

function detailView(r: RunDetail): HTMLElement {
  return h(
    'div',
    {},
    h('h3', {}, r.name || 'Run', h('span', { class: 'muted small' }, ` · ${fmtDate(r.startedAt)}`)),
    h('p', { class: 'muted small' }, `${r.done}/${r.stepCount} done · ${r.failed} failed · ${fmtDuration(r.durationMs)}${r.costUsd !== null ? ` · ${fmtCost(r.costUsd)}` : ''}`),
    h('table', { class: 'runs' },
      h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Status'), h('th', {}, 'Prompt'), h('th', {}, 'Time'), h('th', {}, 'Cost'), h('th', {}, 'Changes'))),
      h('tbody', {}, ...r.steps.flatMap(stepRow))
    )
  )
}

function compareView(a: RunDetail, b: RunDetail): HTMLElement {
  const n = Math.max(a.steps.length, b.steps.length)
  const cell = (s?: RunStepRecord) =>
    s ? `${STATUS_MARK[s.status] ?? ''} ${s.durationMs !== null ? fmtDuration(s.durationMs) : '–'}${s.costUsd !== null ? ` · ${fmtCost(s.costUsd)}` : ''}` : '–'
  const delta = (x: number | null, y: number | null, f: (v: number) => string) => {
    if (x === null || y === null) return ''
    const d = y - x
    return Math.abs(d) < 1000 ? '±0' : `${d > 0 ? '+' : '−'}${f(Math.abs(d))}`
  }
  const rows = []
  for (let i = 0; i < n; i++) {
    const sa = a.steps[i]
    const sb = b.steps[i]
    rows.push(
      h('tr', {},
        h('td', {}, String(i + 1)),
        h('td', { class: 'prompt-cell', title: (sb ?? sa)?.prompt ?? '' }, ((sb ?? sa)?.prompt ?? '').split('\n')[0]),
        h('td', {}, cell(sa)),
        h('td', {}, cell(sb)),
        h('td', { class: 'muted' }, delta(sa?.durationMs ?? null, sb?.durationMs ?? null, fmtDuration))
      )
    )
  }
  return h(
    'div',
    {},
    h('h3', {}, 'Comparison'),
    h('table', { class: 'runs' },
      h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Prompt'), h('th', {}, `A · ${fmtDate(a.startedAt)}`), h('th', {}, `B · ${fmtDate(b.startedAt)}`), h('th', {}, 'Δ time'))),
      h('tbody', {}, ...rows),
      h('tfoot', {}, h('tr', {},
        h('td', {}), h('td', {}, 'Total'),
        h('td', {}, `${a.done}/${a.stepCount} · ${fmtDuration(a.durationMs)}${a.costUsd !== null ? ` · ${fmtCost(a.costUsd)}` : ''}`),
        h('td', {}, `${b.done}/${b.stepCount} · ${fmtDuration(b.durationMs)}${b.costUsd !== null ? ` · ${fmtCost(b.costUsd)}` : ''}`),
        h('td', { class: 'muted' }, delta(a.durationMs, b.durationMs, fmtDuration))
      ))
    )
  )
}

export function setupHistory(getWs: GetWs): () => void {
  const dialog = $<HTMLDialogElement>('#history-dialog')
  const list = $('#history-list')
  const detail = $('#history-detail')
  let wsId = ''
  const picked: string[] = []
  const cache = new Map<string, RunDetail>()

  const load = async (file: string) => {
    if (!cache.has(file)) {
      const r = await window.api.getRun(wsId, file)
      if (r) cache.set(file, r)
    }
    return cache.get(file) ?? null
  }

  const showCompare = async () => {
    const [a, b] = await Promise.all(picked.map(load))
    if (a && b) detail.replaceChildren(compareView(a, b))
  }

  return async () => {
    const ws = getWs()
    if (!ws) return
    if (!ws.session.cwd) return void run(Promise.resolve('Pick a folder first'))
    wsId = ws.id
    picked.length = 0
    cache.clear()
    $('#history-folder').textContent = ws.session.cwd
    const runs: RunSummary[] = await window.api.listRuns(ws.id)
    detail.replaceChildren(h('p', { class: 'muted' }, runs.length ? 'Pick a run.' : 'No runs in this folder yet.'))
    list.replaceChildren(
      ...runs.map((r) => {
        const box = h('input', { type: 'checkbox', 'aria-label': 'Compare' }) as HTMLInputElement
        box.addEventListener('click', (e) => e.stopPropagation())
        box.addEventListener('change', () => {
          if (box.checked) {
            picked.push(r.file)
            if (picked.length > 2) {
              const drop = picked.shift()!
              const other = list.querySelector<HTMLInputElement>(`li[data-file="${CSS.escape(drop)}"] input`)
              if (other) other.checked = false
            }
          } else picked.splice(picked.indexOf(r.file), 1)
          if (picked.length === 2) void showCompare()
        })
        const li = h(
          'li',
          { 'data-file': r.file, tabindex: '0' },
          box,
          h('div', {},
            h('div', {}, h('strong', {}, r.name || 'Run'), h('span', { class: 'muted small' }, ` ${fmtDate(r.startedAt)}`)),
            h('div', { class: 'muted small' }, `${r.done}/${r.stepCount} done${r.failed ? ` · ${r.failed} failed` : ''} · ${fmtDuration(r.durationMs)}${r.costUsd !== null ? ` · ${fmtCost(r.costUsd)}` : ''}`)
          )
        )
        const open = async () => {
          list.querySelectorAll('li.active').forEach((n) => n.classList.remove('active'))
          li.classList.add('active')
          const d = await load(r.file)
          detail.replaceChildren(d ? detailView(d) : h('p', { class: 'muted' }, 'Could not read this run.'))
        }
        li.addEventListener('click', () => void open())
        li.addEventListener('keydown', (e) => e.key === 'Enter' && void open())
        return li
      })
    )
    dialog.showModal()
  }
}

// ------------------------------------------------------------- shortcuts

export interface Shortcut {
  keys: string
  label: string
}

export function setupShortcutsHelp(list: Shortcut[]): () => void {
  const dialog = $<HTMLDialogElement>('#shortcuts-dialog')
  $('#shortcuts-table').replaceChildren(
    ...list.map((s) => h('tr', {}, h('td', {}, ...s.keys.split(' ').map((k) => h('kbd', {}, k))), h('td', {}, s.label)))
  )
  return () => dialog.showModal()
}
