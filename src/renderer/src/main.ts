import './styles.css'
import type { AppState, BulkAction, ChainCommand, ChainState, WorkspaceState } from '../../shared/types'
import { $, approxCost, confirmInline, h, isMac, run, toast } from './dom'
import { icons } from './icons'
import { chainCost, renderQueue, tickElapsed, type QueueView } from './queue'
import { mountTerminal, type TerminalView } from './terminal'
import { setupSettings } from './settings'
import { setupHistory, setupSchedule, setupShortcutsHelp, setupTemplates, setupVariables, type Shortcut } from './dialogs'
import logoUrl from '../../../docs/logo.svg'

const STATE_LABEL: Record<ChainState, string> = {
  idle: 'Ready',
  starting: 'Starting',
  running: 'Running',
  waiting_user: 'Needs you',
  pausing: 'Pausing',
  paused: 'Paused',
  completed: 'Completed'
}
const BUSY: ChainState[] = ['starting', 'running', 'waiting_user', 'pausing']

let state: AppState
let activeId = localStorageGet('activeTab') ?? ''
let terminal: TerminalView | null = null
const view: QueueView = { filter: '', selecting: false, selected: new Set(), onSelectionChange: () => renderBulkBar() }

const active = (): WorkspaceState | undefined => state?.workspaces.find((w) => w.id === activeId) ?? state?.workspaces[0]
const wsId = () => active()?.id ?? ''

function label(btn: HTMLElement, icon: string, text: string): void {
  btn.innerHTML = `${icon}<span>${text}</span>`
}

const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p

function tabLabel(w: WorkspaceState): string {
  return w.name || (w.session.cwd ? basename(w.session.cwd) : 'New tab')
}

function chain(cmd: ChainCommand): void {
  if (wsId()) void run(window.api.chain(wsId(), cmd))
}

function setActive(id: string): void {
  if (!state.workspaces.some((w) => w.id === id)) return
  activeId = id
  localStorageSet('activeTab', id)
  view.selected.clear()
  render(state)
  void terminal?.attach(id)
}

async function addTab(): Promise<void> {
  const id = await window.api.addWorkspace()
  // The new tab arrives with the next state broadcast.
  activeId = id
  localStorageSet('activeTab', id)
  setTimeout(() => setActive(id), 50)
}

async function closeTab(id: string): Promise<void> {
  const i = state.workspaces.findIndex((w) => w.id === id)
  const ok = await run(window.api.closeWorkspace(id))
  if (ok && id === activeId) {
    const next = state.workspaces[i + 1] ?? state.workspaces[i - 1]
    if (next) setActive(next.id)
  }
}

function cycleTab(dir: 1 | -1): void {
  const list = state.workspaces
  const i = list.findIndex((w) => w.id === wsId())
  const next = list[(i + dir + list.length) % list.length]
  if (next) setActive(next.id)
}

function setupStaticUi(openSettings: () => void): void {
  label($('#btn-start'), icons.play, 'Start')
  label($('#btn-pause'), icons.pause, 'Pause')
  label($('#btn-resume'), icons.resume, 'Resume')
  label($('#btn-stop'), icons.stop, 'Stop')
  label($('#btn-skip'), icons.skip, 'Skip')
  label($('#btn-add'), icons.plus, 'Add')
  label($('#btn-templates'), icons.template, 'Templates')
  label($('#btn-variables'), icons.braces, 'Variables')
  label($('#btn-schedule'), icons.clock, 'Schedule')
  label($('#btn-save'), icons.save, 'Save')
  label($('#btn-load'), icons.open, 'Load')
  label($('#btn-reset-all'), icons.reset, 'Reset')
  label($('#btn-clear'), icons.broom, 'Clear')
  label($('#btn-logs'), icons.logs, 'Logs')
  label($('#btn-select'), icons.select, 'Select')
  label($('#btn-folder'), icons.folder, 'Choose folder')
  label($('#btn-new-session'), icons.terminal, 'New session')
  label($('#btn-continue-session'), icons.refresh, 'Continue session')
  $<HTMLImageElement>('#brand-mark').src = logoUrl
  for (const [id, icon, name] of [
    ['#btn-settings', icons.settings, 'Settings'],
    ['#btn-history', icons.history, 'Run history'],
    ['#btn-shortcuts', icons.keyboard, 'Keyboard shortcuts'],
    ['#btn-add-tab', icons.plus, 'New tab']
  ] as const) {
    $(id).innerHTML = icon
    $(id).setAttribute('aria-label', name)
  }

  const openTemplates = setupTemplates(active, () => setTimeout(openVariables, 120))
  const openVariables = setupVariables(active)
  const openSchedule = setupSchedule(active)
  const openHistory = setupHistory(active)

  $('#btn-start').addEventListener('click', () => chain('start'))
  $('#btn-pause').addEventListener('click', () => chain('pause'))
  $('#btn-resume').addEventListener('click', () => chain('resume'))
  $('#btn-stop').addEventListener('click', () => chain('stop'))
  $('#btn-skip').addEventListener('click', () => chain('skipNext'))
  $('#btn-templates').addEventListener('click', openTemplates)
  $('#btn-variables').addEventListener('click', openVariables)
  $('#variables-bar').addEventListener('click', openVariables)
  $('#btn-schedule').addEventListener('click', openSchedule)
  $('#schedule-badge').addEventListener('click', openSchedule)
  $('#btn-save').addEventListener('click', () => void run(window.api.saveChain(wsId())))
  $('#btn-load').addEventListener('click', async () => {
    const before = active()?.chain.steps
    if (await run(window.api.loadChain(wsId()))) {
      // Ask for variables the loaded chain needs.
      setTimeout(() => {
        const w = active()
        if (w && w.chain.steps !== before && w.variables.some((v) => !v.value)) openVariables()
      }, 120)
    }
  })
  $('#btn-reset-all').addEventListener('click', () => void run(window.api.queueOp(wsId(), { type: 'resetAll' })))
  $('#btn-clear').addEventListener('click', () => {
    if (active()?.chain.steps.length && confirmInline($('#btn-clear'))) void run(window.api.queueOp(wsId(), { type: 'clearAll' }))
  })
  $('#btn-logs').addEventListener('click', () => void run(window.api.openLogs(wsId())))
  $('#btn-history').addEventListener('click', () => void openHistory())
  $('#btn-settings').addEventListener('click', openSettings)
  $('#btn-add-tab').addEventListener('click', () => void addTab())

  // Search + selection
  const search = $<HTMLInputElement>('#queue-search')
  search.addEventListener('input', () => {
    view.filter = search.value.trim().toLowerCase()
    renderQueueNow()
  })
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      search.value = ''
      view.filter = ''
      renderQueueNow()
    }
  })
  $('#btn-select').addEventListener('click', () => toggleSelect())
  for (const b of document.querySelectorAll<HTMLButtonElement>('#bulk-bar [data-bulk]')) {
    b.addEventListener('click', () => {
      const action = b.dataset.bulk!
      const w = active()
      if (!w) return
      if (action === 'all' || action === 'none') {
        view.selected.clear()
        if (action === 'all') {
          for (const s of w.chain.steps) {
            if (!view.filter || s.prompt.toLowerCase().includes(view.filter)) view.selected.add(s.id)
          }
        }
        return renderQueueNow()
      }
      if (!view.selected.size) return toast('Select some steps first')
      if (action === 'remove' && !confirmInline(b, `Delete ${view.selected.size} step(s)? Click again to confirm.`)) return
      void run(window.api.queueOp(w.id, { type: 'bulk', ids: [...view.selected], action: action as BulkAction })).then((ok) => {
        if (ok && action === 'remove') view.selected.clear()
      })
    })
  }

  $('#btn-folder').addEventListener('click', () => void run(window.api.pickFolder(wsId())))
  $<HTMLSelectElement>('#folder-select').addEventListener('change', (e) => {
    const v = (e.target as HTMLSelectElement).value
    if (v && v !== active()?.session.cwd) void run(window.api.setFolder(wsId(), v)).then(() => render(state))
  })
  $('#btn-new-session').addEventListener('click', () => void run(window.api.startSession(wsId(), 'new')))
  $('#btn-continue-session').addEventListener('click', () => void run(window.api.startSession(wsId(), 'continue')))

  // Composer
  const ta = $<HTMLTextAreaElement>('#new-prompt')
  if (isMac) ta.placeholder = ta.placeholder.replace('Ctrl+Enter', '⌘+Enter')
  const add = async () => {
    const prompt = ta.value
    if (!prompt.trim()) return ta.focus()
    const ok = await run(window.api.queueOp(wsId(), { type: 'add', prompt, newSession: $<HTMLInputElement>('#new-session').checked }))
    if (ok) {
      ta.value = ''
      $<HTMLInputElement>('#new-session').checked = false
      ta.focus()
    }
  }
  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault()
    void add()
  })
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      e.preventDefault()
      void add()
    }
  })

  setupShortcuts(openSettings, openHistory)
  setupResizer()
}

function toggleSelect(on = !view.selecting): void {
  view.selecting = on
  if (!on) view.selected.clear()
  $('#btn-select').classList.toggle('on', on)
  renderQueueNow()
}

function renderBulkBar(): void {
  const bar = $('#bulk-bar')
  bar.hidden = !view.selecting
  $('#bulk-count').textContent = `${view.selected.size} selected`
}

function renderQueueNow(): void {
  const w = active()
  if (!w) return
  renderQueue($<HTMLOListElement>('#queue'), w, view)
  renderBulkBar()
}

// ------------------------------------------------------------ shortcuts

function setupShortcuts(openSettings: () => void, openHistory: () => void): void {
  const mod = isMac ? '⌘' : 'Ctrl'
  const list: (Shortcut & { code: string; shift: boolean; ctrlOnly?: boolean; run: () => void })[] = [
    { keys: `${mod} Shift Enter`, label: 'Start / resume the chain', code: 'Enter', shift: true, run: () => chain(active()?.chain.state === 'paused' || active()?.chain.state === 'pausing' || active()?.chain.state === 'waiting_user' ? 'resume' : 'start') },
    { keys: `${mod} Shift P`, label: 'Pause after the current step', code: 'KeyP', shift: true, run: () => chain('pause') },
    { keys: `${mod} Shift X`, label: 'Stop (interrupts claude)', code: 'KeyX', shift: true, run: () => chain('stop') },
    { keys: `${mod} Shift K`, label: 'Skip the next step', code: 'KeyK', shift: true, run: () => chain('skipNext') },
    { keys: `${mod} Shift N`, label: 'Write a new prompt', code: 'KeyN', shift: true, run: () => $('#new-prompt').focus() },
    { keys: `${mod} Shift F`, label: 'Filter the steps', code: 'KeyF', shift: true, run: () => $('#queue-search').focus() },
    { keys: `${mod} Shift A`, label: 'Select steps (bulk actions)', code: 'KeyA', shift: true, run: () => toggleSelect() },
    { keys: `${mod} Shift T`, label: 'New tab', code: 'KeyT', shift: true, run: () => void addTab() },
    { keys: `${mod} Shift W`, label: 'Close tab', code: 'KeyW', shift: true, run: () => void closeTab(wsId()) },
    { keys: 'Ctrl Tab', label: 'Next tab', code: 'Tab', shift: false, ctrlOnly: true, run: () => cycleTab(1) },
    { keys: 'Ctrl Shift Tab', label: 'Previous tab', code: 'Tab', shift: true, ctrlOnly: true, run: () => cycleTab(-1) },
    { keys: `${mod} Shift H`, label: 'Run history', code: 'KeyH', shift: true, run: openHistory },
    { keys: `${mod} ,`, label: 'Settings', code: 'Comma', shift: false, run: openSettings },
    { keys: `${mod} /`, label: 'This list', code: 'Slash', shift: false, run: () => openHelp() }
  ]
  const openHelp = setupShortcutsHelp([
    ...list,
    { keys: `${mod} Enter`, label: 'Add the prompt / save an edited step' },
    { keys: 'Esc', label: 'Cancel editing, clear the filter' }
  ])
  $('#btn-shortcuts').addEventListener('click', openHelp)

  // Capture phase, so shortcuts work while the terminal has focus.
  window.addEventListener(
    'keydown',
    (e) => {
      if (document.querySelector('dialog[open]')) return
      const modDown = isMac ? e.metaKey : e.ctrlKey
      for (const s of list) {
        const ok = s.ctrlOnly ? e.ctrlKey && !e.metaKey : modDown
        if (ok && e.code === s.code && e.shiftKey === s.shift && !e.altKey) {
          e.preventDefault()
          e.stopPropagation()
          s.run()
          return
        }
      }
    },
    true
  )
}

function setupResizer(): void {
  const split = $('#split')
  const resizer = $('#resizer')
  const saved = Number(localStorageGet('leftWidth'))
  if (saved > 0) split.style.setProperty('--left', `${saved}px`)
  resizer.addEventListener('pointerdown', (e) => {
    resizer.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => {
      const w = Math.min(Math.max(ev.clientX, 320), window.innerWidth - 360)
      split.style.setProperty('--left', `${w}px`)
      localStorageSet('leftWidth', String(w))
    }
    const up = () => {
      resizer.removeEventListener('pointermove', move)
      resizer.removeEventListener('pointerup', up)
    }
    resizer.addEventListener('pointermove', move)
    resizer.addEventListener('pointerup', up)
  })
}

function localStorageGet(k: string): string | null {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
function localStorageSet(k: string, v: string): void {
  try {
    localStorage.setItem(k, v)
  } catch {
    /* ignore */
  }
}

// --------------------------------------------------------------- render

function renderTabs(s: AppState): void {
  const list = $('#tab-list')
  list.replaceChildren(
    ...s.workspaces.map((w) => {
      const busy = BUSY.includes(w.chain.state)
      const tab = h(
        'div',
        {
          class: `tab${w.id === wsId() ? ' active' : ''}`,
          role: 'tab',
          'aria-selected': w.id === wsId() ? 'true' : 'false',
          tabindex: '0',
          title: `${w.session.cwd ?? 'No folder'} — ${STATE_LABEL[w.chain.state]}`,
          'data-state': w.chain.state
        },
        h('span', { class: 'tab-dot' }),
        h('span', { class: 'tab-label' }, tabLabel(w)),
        w.schedule ? h('span', { class: 'tab-sched', title: 'Scheduled', html: icons.clock }) : null
      )
      if (s.workspaces.length > 1) {
        const close = h('button', { class: 'tab-close', type: 'button', title: busy ? 'Stop the chain first' : 'Close tab', 'aria-label': 'Close tab', html: icons.close, disabled: busy })
        close.addEventListener('click', (e) => {
          e.stopPropagation()
          void closeTab(w.id)
        })
        tab.append(close)
      }
      tab.addEventListener('click', () => setActive(w.id))
      tab.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && setActive(w.id))
      return tab
    })
  )
  $('#tabs').hidden = false
}

function render(s: AppState): void {
  state = s
  if (!s.workspaces.some((w) => w.id === activeId) && s.workspaces[0]) {
    activeId = s.workspaces[0].id
    void terminal?.attach(activeId)
  }
  const w = active()
  if (!w) return
  const c = w.chain
  renderTabs(s)

  // Header status
  const pill = $('#chain-state')
  pill.dataset.state = c.state
  pill.textContent = STATE_LABEL[c.state]
  $('#chain-message').textContent = c.message
  $('#chain-message').title = c.message
  const badge = $('#schedule-badge')
  badge.hidden = !w.schedule
  if (w.schedule) {
    const d = new Date(w.schedule.at)
    badge.innerHTML = `${icons.clock}<span>${d.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}${w.schedule.daily ? ' · daily' : ''}</span>`
    badge.title = `Starts ${d.toLocaleString()}${w.schedule.daily ? ', then every day' : ''} — click to change`
  }

  // Controls
  const busy = BUSY.includes(c.state)
  const runnable = c.steps.some((x) => ['pending', 'interrupted', 'error'].includes(x.status))
  const set = (id: string, enabled: boolean) => (($(id) as HTMLButtonElement).disabled = !enabled)
  set('#btn-start', !busy && c.state !== 'paused' && runnable)
  set('#btn-pause', ['starting', 'running', 'waiting_user'].includes(c.state))
  set('#btn-resume', c.state === 'paused' || c.state === 'pausing' || c.state === 'waiting_user')
  set('#btn-stop', busy || c.state === 'paused')
  set('#btn-skip', runnable)
  set('#btn-reset-all', !busy && c.steps.length > 0)
  set('#btn-clear', !busy && c.steps.length > 0)
  set('#btn-save', c.steps.length > 0)
  set('#btn-load', !busy)
  set('#btn-templates', !busy)
  set('#btn-logs', !!w.session.cwd)
  $('#btn-schedule').classList.toggle('on', !!w.schedule)

  const done = c.steps.filter((x) => x.status === 'done').length
  const cost = chainCost(c)
  $('#queue-count').textContent = c.steps.length
    ? `${c.steps.length} steps · ${done} done${cost !== null ? ` · ${approxCost(cost)}` : ''}`
    : 'Queue is empty'

  // Variables bar
  const vbar = $('#variables-bar')
  vbar.hidden = !w.variables.length
  vbar.replaceChildren(
    h('span', { class: 'muted small' }, 'Variables:'),
    ...w.variables.map((v) =>
      h('span', { class: `var-chip${v.value.trim() ? '' : ' missing'}`, title: v.value || 'No value yet — click to fill in' }, `{{${v.name}}}`, v.value.trim() ? '' : ' ?')
    )
  )

  renderQueueNow()

  // Terminal bar
  const sel = $<HTMLSelectElement>('#folder-select')
  const folders = w.session.cwd && !s.recentFolders.includes(w.session.cwd) ? [w.session.cwd, ...s.recentFolders] : s.recentFolders
  sel.replaceChildren(
    ...(w.session.cwd ? [] : [h('option', { value: '' }, 'No folder selected')]),
    ...folders.map((f) => h('option', { value: f }, f))
  )
  sel.value = w.session.cwd ?? ''
  sel.title = w.session.cwd ?? 'No folder selected'
  sel.disabled = busy

  const status = $('#session-status')
  const st = !w.session.alive ? 'off' : w.session.claudeReady ? 'ready' : 'starting'
  status.dataset.status = st
  status.textContent = st === 'off' ? 'No session' : st === 'ready' ? 'claude ready' : 'claude starting / needs confirmation'
  set('#btn-new-session', !!w.session.cwd && !busy)
  set('#btn-continue-session', !!w.session.cwd && !busy)
  set('#btn-folder', !busy)
  $('#term-empty').hidden = w.session.alive

  // Window title: the most urgent state across all tabs.
  const urgent = s.workspaces.find((x) => x.chain.state === 'waiting_user') ?? s.workspaces.find((x) => BUSY.includes(x.chain.state))
  document.title = urgent ? `${STATE_LABEL[urgent.chain.state]} — Chain Prompt` : c.state === 'idle' ? 'Chain Prompt' : `${STATE_LABEL[c.state]} — Chain Prompt`
}

async function boot(): Promise<void> {
  const openSettings = setupSettings(() => state.settings)
  setupStaticUi(openSettings)
  const initial = await window.api.getState()
  render(initial)
  terminal = mountTerminal($('#terminal'))
  await terminal.attach(wsId())
  window.api.onState(render)
  setInterval(() => tickElapsed($<HTMLOListElement>('#queue')), 1000)
}

void boot()
