import type { ChainSnapshot, Step, StepStatus } from '../../shared/types'
import { icons } from './icons'
import { fmtDuration, fmtTime, h, run } from './dom'

const STATUS_LABEL: Record<StepStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  waiting: 'Needs you',
  done: 'Done',
  error: 'Error',
  skipped: 'Skipped',
  interrupted: 'Interrupted'
}
const ACTIVE: StepStatus[] = ['running', 'waiting']

/** Cards being edited keep their DOM node so typing isn't clobbered by re-renders. */
const editing = new Map<string, HTMLLIElement>()
const expanded = new Set<string>()
let dragId: string | null = null
let last: ChainSnapshot | null = null

export function renderQueue(list: HTMLOListElement, chain: ChainSnapshot): void {
  last = chain
  const nodes = chain.steps.map((step, i) => editing.get(step.id) ?? card(step, i, chain))
  for (const id of editing.keys()) if (!chain.steps.some((s) => s.id === id)) editing.delete(id)
  list.replaceChildren(...nodes)
  if (!chain.steps.length) {
    list.append(h('li', { class: 'queue-empty' }, 'The queue is empty. Add a prompt above or load a chain.'))
  }
  // Keep the running / halted step in view.
  const focus = list.querySelector<HTMLElement>('.card.current')
  if (focus && chain.state !== 'idle') focus.scrollIntoView({ block: 'nearest' })
}

/** Live elapsed counters for running steps; called once a second. */
export function tickElapsed(list: HTMLOListElement): void {
  for (const el of list.querySelectorAll<HTMLElement>('[data-started]')) {
    el.textContent = fmtDuration(Date.now() - Number(el.dataset.started))
  }
}

function timing(step: Step): HTMLElement | null {
  if (!step.startedAt) return null
  const parts: (string | HTMLElement)[] = [`Started ${fmtTime(step.startedAt)}`]
  if (step.endedAt) {
    parts.push(` · Ended ${fmtTime(step.endedAt)} · `, h('strong', {}, fmtDuration(step.endedAt - step.startedAt)))
  } else if (ACTIVE.includes(step.status)) {
    parts.push(' · ', h('strong', { 'data-started': String(step.startedAt) }, fmtDuration(Date.now() - step.startedAt)))
  }
  return h('div', { class: 'timing' }, ...parts)
}

function card(step: Step, index: number, chain: ChainSnapshot): HTMLLIElement {
  const active = ACTIVE.includes(step.status)
  const isCurrent = chain.currentStepId === step.id
  const li = h('li', {
    class: `card status-${step.status}${isCurrent ? ' current' : ''}`,
    'data-id': step.id
  })

  const handle = h('span', { class: 'grip', title: 'Drag to reorder', html: icons.grip })
  // The card only becomes draggable while the grip is held, so the prompt
  // text stays selectable.
  handle.addEventListener('pointerdown', () => (li.draggable = true))
  li.addEventListener('pointerup', () => (li.draggable = false))
  li.addEventListener('dragstart', (e) => {
    dragId = step.id
    li.classList.add('dragging')
    e.dataTransfer?.setData('text/plain', step.id)
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
  })
  li.addEventListener('dragend', () => {
    li.draggable = false
    dragId = null
    li.classList.remove('dragging')
    document.querySelectorAll('.drop-before, .drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'))
  })
  li.addEventListener('dragover', (e) => {
    if (!dragId || dragId === step.id) return
    e.preventDefault()
    const after = e.offsetY > li.offsetHeight / 2
    li.classList.toggle('drop-after', after)
    li.classList.toggle('drop-before', !after)
  })
  li.addEventListener('dragleave', () => li.classList.remove('drop-before', 'drop-after'))
  li.addEventListener('drop', (e) => {
    e.preventDefault()
    const id = dragId
    li.classList.remove('drop-before', 'drop-after')
    if (!id || id === step.id || !last) return
    const from = last.steps.findIndex((s) => s.id === id)
    let to = index + (e.offsetY > li.offsetHeight / 2 ? 1 : 0)
    if (from < to) to--
    void run(window.api.queueOp({ type: 'move', id, toIndex: to }))
  })

  const status = h(
    'span',
    { class: 'status', title: STATUS_LABEL[step.status] },
    h('span', { class: 'status-icon', html: icons[step.status] }),
    STATUS_LABEL[step.status]
  )

  const head = h(
    'div',
    { class: 'card-head' },
    handle,
    h('span', { class: 'num' }, String(index + 1)),
    status,
    step.newSession ? h('span', { class: 'tag', title: 'The context is reset before this step' }, 'new session') : null,
    h('span', { class: 'spacer' }),
    actions(step, active, li)
  )

  const isLong = step.prompt.length > 220 || step.prompt.split('\n').length > 4
  const text = h('pre', { class: `prompt${expanded.has(step.id) ? ' expanded' : ''}` }, step.prompt)
  const more = isLong
    ? h('button', { class: 'link', type: 'button' }, expanded.has(step.id) ? 'Show less' : 'Show all')
    : null
  more?.addEventListener('click', () => {
    if (expanded.has(step.id)) expanded.delete(step.id)
    else expanded.add(step.id)
    text.classList.toggle('expanded')
    more.textContent = expanded.has(step.id) ? 'Show less' : 'Show all'
  })

  li.append(head, text)
  if (more) li.append(more)
  const t = timing(step)
  if (t) li.append(t)
  if (step.note) li.append(h('div', { class: 'note' }, step.note))
  return li
}

function iconBtn(icon: string, title: string, onClick: () => void, disabled = false): HTMLButtonElement {
  const b = h('button', { class: 'icon-btn', type: 'button', title, 'aria-label': title, html: icon, disabled })
  b.addEventListener('click', onClick)
  return b
}

function actions(step: Step, active: boolean, li: HTMLLIElement): HTMLElement {
  const box = h('div', { class: 'card-actions' })
  if (step.status !== 'pending' && !active) {
    box.append(iconBtn(icons.reset, 'Reset so it runs again', () => void run(window.api.queueOp({ type: 'reset', id: step.id }))))
  }
  box.append(
    iconBtn(icons.edit, active ? 'A running step cannot be edited' : 'Edit', () => startEdit(step, li), active),
    iconBtn(icons.copy, 'Duplicate', () => void run(window.api.queueOp({ type: 'duplicate', id: step.id }))),
    iconBtn(icons.trash, active ? 'A running step cannot be deleted' : 'Delete', () => void run(window.api.queueOp({ type: 'remove', id: step.id })), active)
  )
  return box
}

function startEdit(step: Step, li: HTMLLIElement): void {
  li.classList.add('editing')
  li.draggable = false
  const ta = h('textarea', { class: 'edit-area', rows: '6' }) as HTMLTextAreaElement
  ta.value = step.prompt
  const chk = h('input', { type: 'checkbox' }) as HTMLInputElement
  chk.checked = step.newSession
  const save = h('button', { class: 'btn primary small', type: 'button' }, 'Save')
  const cancel = h('button', { class: 'btn ghost small', type: 'button' }, 'Cancel')
  const done = () => {
    editing.delete(step.id)
    if (last) renderQueue(li.parentElement as HTMLOListElement, last)
  }
  save.addEventListener('click', async () => {
    const ok = await run(window.api.queueOp({ type: 'update', id: step.id, prompt: ta.value, newSession: chk.checked }))
    if (ok) done()
  })
  cancel.addEventListener('click', done)
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save.click()
    if (e.key === 'Escape') cancel.click()
  })
  li.replaceChildren(
    h('div', { class: 'card-head' }, h('strong', {}, 'Edit step')),
    ta,
    h(
      'div',
      { class: 'composer-row' },
      h('label', { class: 'check' }, chk, ' Run in a new session'),
      h('span', { class: 'spacer' }),
      cancel,
      save
    )
  )
  editing.set(step.id, li)
  ta.focus()
}
