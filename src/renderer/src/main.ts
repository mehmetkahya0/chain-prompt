import './styles.css'
import type { AppState, ChainState } from '../../shared/types'
import { $, h, run, toast } from './dom'
import { icons } from './icons'
import { renderQueue, tickElapsed } from './queue'
import { mountTerminal } from './terminal'
import { setupSettings } from './settings'
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

let state: AppState

function label(btn: HTMLElement, icon: string, text: string): void {
  btn.innerHTML = `${icon}<span>${text}</span>`
}

function setupStaticUi(openSettings: () => void): void {
  label($('#btn-start'), icons.play, 'Start')
  label($('#btn-pause'), icons.pause, 'Pause')
  label($('#btn-resume'), icons.resume, 'Resume')
  label($('#btn-stop'), icons.stop, 'Stop')
  label($('#btn-skip'), icons.skip, 'Skip')
  label($('#btn-add'), icons.plus, 'Add')
  label($('#btn-save'), icons.save, 'Save')
  label($('#btn-load'), icons.open, 'Load')
  label($('#btn-reset-all'), icons.reset, 'Reset')
  label($('#btn-clear'), icons.broom, 'Clear')
  label($('#btn-logs'), icons.logs, 'Logs')
  label($('#btn-folder'), icons.folder, 'Choose folder')
  label($('#btn-new-session'), icons.terminal, 'New session')
  label($('#btn-continue-session'), icons.refresh, 'Continue session')
  $<HTMLImageElement>('#brand-mark').src = logoUrl
  $('#btn-settings').innerHTML = icons.settings
  $('#btn-settings').setAttribute('aria-label', 'Settings')

  $('#btn-start').addEventListener('click', () => void run(window.api.chain('start')))
  $('#btn-pause').addEventListener('click', () => void run(window.api.chain('pause')))
  $('#btn-resume').addEventListener('click', () => void run(window.api.chain('resume')))
  $('#btn-stop').addEventListener('click', () => void run(window.api.chain('stop')))
  $('#btn-skip').addEventListener('click', () => void run(window.api.chain('skipNext')))
  $('#btn-save').addEventListener('click', () => void run(window.api.saveChain()))
  $('#btn-load').addEventListener('click', () => void run(window.api.loadChain()))
  $('#btn-reset-all').addEventListener('click', () => void run(window.api.queueOp({ type: 'resetAll' })))
  $('#btn-clear').addEventListener('click', () => {
    if (state.chain.steps.length && confirmInline($('#btn-clear'))) void run(window.api.queueOp({ type: 'clearAll' }))
  })
  $('#btn-logs').addEventListener('click', () => void run(window.api.openLogs()))
  $('#btn-settings').addEventListener('click', openSettings)

  $('#btn-folder').addEventListener('click', () => void run(window.api.pickFolder()))
  $<HTMLSelectElement>('#folder-select').addEventListener('change', (e) => {
    const v = (e.target as HTMLSelectElement).value
    if (v && v !== state.session.cwd) void run(window.api.setFolder(v)).then(() => render(state))
  })
  $('#btn-new-session').addEventListener('click', () => void run(window.api.startSession('new')))
  $('#btn-continue-session').addEventListener('click', () => void run(window.api.startSession('continue')))

  // Composer
  const ta = $<HTMLTextAreaElement>('#new-prompt')
  if (/Mac/.test(navigator.userAgent)) ta.placeholder = ta.placeholder.replace('Ctrl+Enter', '⌘+Enter')
  const add = async () => {
    const prompt = ta.value
    if (!prompt.trim()) return ta.focus()
    const ok = await run(window.api.queueOp({ type: 'add', prompt, newSession: $<HTMLInputElement>('#new-session').checked }))
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
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      void add()
    }
  })

  setupResizer()
}

/** Two-click confirmation without a modal: first click arms the button for 3s. */
function confirmInline(btn: HTMLElement): boolean {
  if (btn.dataset.armed) {
    delete btn.dataset.armed
    btn.classList.remove('armed')
    return true
  }
  btn.dataset.armed = '1'
  btn.classList.add('armed')
  toast('Are you sure? Click again to confirm.')
  setTimeout(() => {
    delete btn.dataset.armed
    btn.classList.remove('armed')
  }, 3000)
  return false
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

function render(s: AppState): void {
  state = s
  const c = s.chain

  // Header status
  const pill = $('#chain-state')
  pill.dataset.state = c.state
  pill.textContent = STATE_LABEL[c.state]
  $('#chain-message').textContent = c.message
  $('#chain-message').title = c.message

  // Controls
  const busy = ['starting', 'running', 'waiting_user', 'pausing'].includes(c.state)
  const runnable = c.steps.some((x) => ['pending', 'interrupted', 'error'].includes(x.status))
  const set = (id: string, enabled: boolean) => (($(id) as HTMLButtonElement).disabled = !enabled)
  set('#btn-start', !busy && c.state !== 'paused' && runnable)
  set('#btn-pause', ['starting', 'running', 'waiting_user'].includes(c.state))
  set('#btn-resume', c.state === 'paused' || c.state === 'pausing')
  set('#btn-stop', busy || c.state === 'paused')
  set('#btn-skip', runnable)
  set('#btn-reset-all', !busy && c.steps.length > 0)
  set('#btn-clear', !busy && c.steps.length > 0)
  set('#btn-save', c.steps.length > 0)
  set('#btn-load', !busy)
  set('#btn-logs', !!s.session.cwd)

  const done = c.steps.filter((x) => x.status === 'done').length
  $('#queue-count').textContent = c.steps.length ? `${c.steps.length} steps · ${done} done` : 'Queue is empty'

  renderQueue($<HTMLOListElement>('#queue'), c)

  // Terminal bar
  const sel = $<HTMLSelectElement>('#folder-select')
  const folders = s.session.cwd && !s.recentFolders.includes(s.session.cwd) ? [s.session.cwd, ...s.recentFolders] : s.recentFolders
  sel.replaceChildren(
    ...(s.session.cwd ? [] : [h('option', { value: '' }, 'No folder selected')]),
    ...folders.map((f) => h('option', { value: f }, f))
  )
  sel.value = s.session.cwd ?? ''
  sel.title = s.session.cwd ?? 'No folder selected'
  sel.disabled = busy

  const status = $('#session-status')
  const st = !s.session.alive ? 'off' : s.session.claudeReady ? 'ready' : 'starting'
  status.dataset.status = st
  status.textContent = st === 'off' ? 'No session' : st === 'ready' ? 'claude ready' : 'claude starting / needs confirmation'
  set('#btn-new-session', !!s.session.cwd && !busy)
  set('#btn-continue-session', !!s.session.cwd && !busy)
  set('#btn-folder', !busy)
  $('#term-empty').hidden = s.session.alive
  document.title = c.state === 'idle' ? 'Chain Prompt' : `${STATE_LABEL[c.state]} — Chain Prompt`
}

async function boot(): Promise<void> {
  const openSettings = setupSettings(() => state.settings)
  setupStaticUi(openSettings)
  const initial = await window.api.getState()
  render(initial)
  mountTerminal($('#terminal'), initial.scrollback)
  window.api.onState(render)
  setInterval(() => tickElapsed($<HTMLOListElement>('#queue')), 1000)
}

void boot()
