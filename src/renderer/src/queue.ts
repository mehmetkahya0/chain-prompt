import type { ChainSnapshot, Step, StepStatus, WorkspaceState } from '../../shared/types'
import { icons } from './icons'
import { approxCost, fmtDuration, fmtTokens, fmtTime, h, run, toast } from './dom'

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

export interface QueueView {
  /** Lower-cased search text; empty = show all. */
  filter: string
  selecting: boolean
  selected: Set<string>
  onSelectionChange: () => void
}

/** Cards being edited keep their DOM node so typing isn't clobbered by re-renders. */
const editing = new Map<string, HTMLLIElement>()
const expanded = new Set<string>()
const showOutput = new Set<string>()
let dragId: string | null = null
let last: { ws: WorkspaceState; view: QueueView } | null = null

export function renderQueue(list: HTMLOListElement, ws: WorkspaceState, view: QueueView): void {
  last = { ws, view }
  const chain = ws.chain
  const matches = (s: Step) =>
    !view.filter || [s.prompt, s.note, s.output, s.verify, s.model].some((t) => t?.toLowerCase().includes(view.filter))
  const nodes: HTMLLIElement[] = []
  chain.steps.forEach((step, i) => {
    if (!matches(step) && !editing.has(step.id)) return
    nodes.push(editing.get(step.id) ?? card(step, i, ws, view))
  })
  for (const id of editing.keys()) if (!chain.steps.some((s) => s.id === id)) editing.delete(id)
  for (const id of view.selected) if (!chain.steps.some((s) => s.id === id)) view.selected.delete(id)
  list.replaceChildren(...nodes)
  list.classList.toggle('filtered', !!view.filter)
  if (!chain.steps.length) {
    list.append(h('li', { class: 'queue-empty' }, 'The queue is empty. Add a prompt above, load a chain or pick a template.'))
  } else if (!nodes.length) {
    list.append(h('li', { class: 'queue-empty' }, 'No step matches the filter.'))
  }
  // Keep the running / halted step in view.
  const focus = list.querySelector<HTMLElement>('.card.current')
  if (focus && chain.state !== 'idle' && !view.filter) focus.scrollIntoView({ block: 'nearest' })
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
  if (step.usage) {
    const u = step.usage
    parts.push(
      h(
        'span',
        {
          class: 'usage',
          title:
            `Input ${u.inputTokens.toLocaleString()} · output ${u.outputTokens.toLocaleString()} · ` +
            `cache write ${u.cacheWriteTokens.toLocaleString()} · cache read ${u.cacheReadTokens.toLocaleString()}` +
            (u.models.length ? `\nModel: ${u.models.join(', ')}` : '') +
            '\nCost is an estimate from public API prices.'
        },
        ` · ${fmtTokens(u.outputTokens)} out${u.costUsd !== null ? ` · ${approxCost(u.costUsd)}` : ''}`
      )
    )
  }
  return h('div', { class: 'timing' }, ...parts)
}

/** Small tags for every option configured on the step. */
function tags(step: Step): HTMLElement[] {
  const t: HTMLElement[] = []
  const tag = (text: string, title: string, cls = '') => t.push(h('span', { class: `tag ${cls}`.trim(), title }, text))
  if (step.model) tag(step.model, 'Model for this step', 'opt')
  if (step.permissionMode) tag(step.permissionMode, 'Permission mode for this step', 'opt')
  if (step.when) tag('if', `Runs only if this exits with 0:\n${step.when}`, 'opt')
  if (step.verify) tag(step.maxLoops ? `verify ×${step.maxLoops}` : 'verify', `Verified with:\n${step.verify}${step.maxLoops ? `\nUp to ${step.maxLoops} fix attempts` : ''}`, 'opt')
  if (step.onError && step.onError !== 'pause') tag(`on error: ${step.onError}`, 'What happens when this step fails', 'opt')
  if (step.idleTimeoutMin !== undefined) tag(`stall ${step.idleTimeoutMin}m`, 'Stall warning for this step', 'opt')
  return t
}

function card(step: Step, index: number, ws: WorkspaceState, view: QueueView): HTMLLIElement {
  const chain = ws.chain
  const active = ACTIVE.includes(step.status)
  const isCurrent = chain.currentStepId === step.id
  const li = h('li', {
    class: `card status-${step.status}${isCurrent ? ' current' : ''}${view.selected.has(step.id) ? ' selected' : ''}`,
    'data-id': step.id
  })

  const handle = h('span', { class: 'grip', title: view.filter ? 'Clear the filter to reorder' : 'Drag to reorder', html: icons.grip })
  // The card only becomes draggable while the grip is held, so the prompt
  // text stays selectable.
  handle.addEventListener('pointerdown', () => (li.draggable = !view.filter))
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
    const from = last.ws.chain.steps.findIndex((s) => s.id === id)
    let to = index + (e.offsetY > li.offsetHeight / 2 ? 1 : 0)
    if (from < to) to--
    void run(window.api.queueOp(ws.id, { type: 'move', id, toIndex: to }))
  })

  const status = h(
    'span',
    { class: 'status', title: STATUS_LABEL[step.status] },
    h('span', { class: 'status-icon', html: icons[step.status] }),
    STATUS_LABEL[step.status]
  )

  let select: HTMLInputElement | null = null
  if (view.selecting) {
    select = h('input', { type: 'checkbox', class: 'select-box', 'aria-label': `Select step ${index + 1}` }) as HTMLInputElement
    select.checked = view.selected.has(step.id)
    select.addEventListener('change', () => {
      if (select!.checked) view.selected.add(step.id)
      else view.selected.delete(step.id)
      li.classList.toggle('selected', select!.checked)
      view.onSelectionChange()
    })
  }

  const head = h(
    'div',
    { class: 'card-head' },
    select ?? handle,
    h('span', { class: 'num' }, String(index + 1)),
    status,
    // "new session" stays in the head (the e2e test reads the first tag there).
    step.newSession ? h('span', { class: 'tag', title: 'The context is reset before this step' }, 'new session') : null,
    h('span', { class: 'spacer' }),
    actions(step, active, li, ws)
  )

  const isLong = step.prompt.length > 220 || step.prompt.split('\n').length > 4
  const text = h('pre', { class: `prompt${expanded.has(step.id) ? ' expanded' : ''}` }, step.prompt)
  const more = isLong ? h('button', { class: 'link', type: 'button' }, expanded.has(step.id) ? 'Show less' : 'Show all') : null
  more?.addEventListener('click', () => {
    if (expanded.has(step.id)) expanded.delete(step.id)
    else expanded.add(step.id)
    text.classList.toggle('expanded')
    more.textContent = expanded.has(step.id) ? 'Show less' : 'Show all'
  })

  const optTags = tags(step)
  li.append(head)
  if (optTags.length) li.append(h('div', { class: 'card-tags' }, ...optTags))
  li.append(text)
  if (more) li.append(more)
  const t = timing(step)
  if (t) li.append(t)
  if (step.diffStat) li.append(h('div', { class: 'diffstat', title: 'Changes made by this step (git)' }, step.diffStat))
  if (step.note) li.append(h('div', { class: 'note' }, step.note))
  if (step.output) {
    const open = showOutput.has(step.id)
    const toggle = h('button', { class: 'link output-toggle', type: 'button', html: `${icons.message}<span>${open ? "Hide claude's reply" : "Show claude's reply"}</span>` })
    const body = h('pre', { class: 'output' }, step.output)
    body.hidden = !open
    toggle.addEventListener('click', () => {
      const now = !showOutput.has(step.id)
      if (now) showOutput.add(step.id)
      else showOutput.delete(step.id)
      body.hidden = !now
      toggle.querySelector('span')!.textContent = now ? "Hide claude's reply" : "Show claude's reply"
    })
    li.append(toggle, body)
  }
  return li
}

function iconBtn(icon: string, title: string, onClick: () => void, disabled = false): HTMLButtonElement {
  const b = h('button', { class: 'icon-btn', type: 'button', title, 'aria-label': title, html: icon, disabled })
  b.addEventListener('click', onClick)
  return b
}

function actions(step: Step, active: boolean, li: HTMLLIElement, ws: WorkspaceState): HTMLElement {
  const box = h('div', { class: 'card-actions' })
  const busy = ['starting', 'running', 'waiting_user', 'pausing'].includes(ws.chain.state)
  if (step.checkpoint && !active) {
    const b = iconBtn(icons.undo, busy ? 'Pause or stop the chain to roll back' : 'Roll back the folder to before this step', () => {
      if (b.dataset.armed) {
        void run(window.api.rollback(ws.id, step.id))
        return
      }
      b.dataset.armed = '1'
      b.classList.add('armed')
      toast('Roll back the files to before this step? Click again to confirm.')
      setTimeout(() => {
        delete b.dataset.armed
        b.classList.remove('armed')
      }, 3000)
    }, busy)
    box.append(b)
  }
  if (step.status !== 'pending' && !active) {
    box.append(iconBtn(icons.reset, 'Reset so it runs again', () => void run(window.api.queueOp(ws.id, { type: 'reset', id: step.id }))))
  }
  box.append(
    iconBtn(icons.edit, active ? 'A running step cannot be edited' : 'Edit', () => startEdit(step, li, ws), active),
    iconBtn(icons.copy, 'Duplicate', () => void run(window.api.queueOp(ws.id, { type: 'duplicate', id: step.id }))),
    iconBtn(icons.trash, active ? 'A running step cannot be deleted' : 'Delete', () => void run(window.api.queueOp(ws.id, { type: 'remove', id: step.id })), active)
  )
  return box
}

const MODEL_SUGGESTIONS = ['opus', 'sonnet', 'haiku', 'fable', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'claude-fable-5-1']

function field(labelText: string, input: HTMLElement, hint?: string): HTMLElement {
  return h('label', { class: 'opt-field' }, h('span', {}, labelText), input, hint ? h('small', { class: 'muted' }, hint) : null)
}

function startEdit(step: Step, li: HTMLLIElement, ws: WorkspaceState): void {
  li.classList.add('editing')
  li.draggable = false
  const ta = h('textarea', { class: 'edit-area', rows: '6' }) as HTMLTextAreaElement
  ta.value = step.prompt
  const chk = h('input', { type: 'checkbox' }) as HTMLInputElement
  chk.checked = step.newSession

  // Advanced options
  const listId = `models-${step.id}`
  const model = h('input', { type: 'text', list: listId, placeholder: 'default', value: step.model ?? '' }) as HTMLInputElement
  const models = h('datalist', { id: listId }, ...MODEL_SUGGESTIONS.map((m) => h('option', { value: m })))
  const perm = h(
    'select',
    {},
    h('option', { value: '' }, 'as in Settings'),
    h('option', { value: 'default' }, 'default'),
    h('option', { value: 'acceptEdits' }, 'acceptEdits'),
    h('option', { value: 'bypassPermissions' }, 'bypassPermissions')
  ) as HTMLSelectElement
  perm.value = step.permissionMode ?? ''
  const onError = h(
    'select',
    {},
    h('option', { value: '' }, 'pause the chain'),
    h('option', { value: 'retry' }, 'retry (see Settings)'),
    h('option', { value: 'skip' }, 'skip and continue')
  ) as HTMLSelectElement
  onError.value = step.onError && step.onError !== 'pause' ? step.onError : ''
  const idle = h('input', { type: 'number', min: '0', max: '1440', step: '1', placeholder: 'as in Settings' }) as HTMLInputElement
  idle.value = step.idleTimeoutMin !== undefined ? String(step.idleTimeoutMin) : ''
  const when = h('input', { type: 'text', placeholder: 'e.g. test -f PLAN.md', value: step.when ?? '' }) as HTMLInputElement
  const verify = h('input', { type: 'text', placeholder: 'e.g. npm test', value: step.verify ?? '' }) as HTMLInputElement
  const loops = h('input', { type: 'number', min: '0', max: '50', step: '1', placeholder: '0' }) as HTMLInputElement
  loops.value = step.maxLoops ? String(step.maxLoops) : ''
  const fix = h('textarea', { rows: '3', placeholder: 'Default: the step prompt again. {{verify.output}} = command output' }) as HTMLTextAreaElement
  fix.value = step.fixPrompt ?? ''

  const hasAdvanced = !!(step.model || step.permissionMode || step.onError || step.idleTimeoutMin !== undefined || step.when || step.verify)
  const advanced = h(
    'details',
    { class: 'advanced', open: hasAdvanced },
    h('summary', {}, 'Step options'),
    h(
      'div',
      { class: 'opt-grid' },
      field('Model', model, 'claude is restarted with --continue when it changes'),
      models,
      field('Permission mode', perm),
      field('On error', onError),
      field('Stall warning (min)', idle),
      field('Run only if', when, 'Shell command; a non-zero exit skips the step'),
      field('Verify with', verify, 'Shell command after the step; non-zero = failed'),
      field('Fix attempts', loops, 'Send the fix prompt and verify again up to N times'),
      field('Fix prompt', fix)
    )
  )

  const save = h('button', { class: 'btn primary small', type: 'button' }, 'Save')
  const cancel = h('button', { class: 'btn ghost small', type: 'button' }, 'Cancel')
  const done = () => {
    editing.delete(step.id)
    if (last) renderQueue(li.parentElement as HTMLOListElement, last.ws, last.view)
  }
  save.addEventListener('click', async () => {
    const idleN = idle.value.trim() === '' ? '' : Number(idle.value)
    const loopsN = loops.value.trim() === '' ? '' : Number(loops.value)
    const ok = await run(
      window.api.queueOp(ws.id, {
        type: 'update',
        id: step.id,
        prompt: ta.value,
        newSession: chk.checked,
        // '' clears a field (main drops empty values).
        model: model.value.trim(),
        permissionMode: (perm.value || '') as Step['permissionMode'],
        onError: (onError.value || '') as Step['onError'],
        idleTimeoutMin: idleN as number,
        when: when.value.trim(),
        verify: verify.value.trim(),
        maxLoops: loopsN as number,
        fixPrompt: fix.value.trim()
      })
    )
    if (ok) done()
  })
  cancel.addEventListener('click', done)
  li.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save.click()
    if (e.key === 'Escape') cancel.click()
  })
  li.replaceChildren(
    h('div', { class: 'card-head' }, h('strong', {}, 'Edit step')),
    ta,
    advanced,
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

/** Total estimated cost of the chain's steps (null when no usage is known). */
export function chainCost(chain: ChainSnapshot): number | null {
  const withUsage = chain.steps.filter((s) => s.usage)
  if (!withUsage.length) return null
  if (withUsage.some((s) => s.usage!.costUsd === null)) return null
  return withUsage.reduce((a, s) => a + (s.usage!.costUsd ?? 0), 0)
}
