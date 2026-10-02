import type { Settings } from '../../shared/types'
import { $, run, toast } from './dom'

const TEXT_FIELDS = [
  'ntfyServer',
  'ntfyTopic',
  'ntfyToken',
  'slackWebhookUrl',
  'discordWebhookUrl',
  'telegramBotToken',
  'telegramChatId',
  'claudeCommand',
  'extraArgs',
  'gitBranchPrefix'
] as const
const CHECKS = ['desktopNotifications', 'ntfyEnabled', 'detectQuestions', 'gitCheckpoints'] as const
const NUMBERS = ['idleTimeoutMin', 'retryMax', 'retryDelaySec', 'commandTimeoutMin'] as const
const SELECTS = ['newSessionMethod', 'hookTransport', 'gitFinishAction'] as const

/** Wire the settings <dialog>. `get` returns the latest settings from main. */
export function setupSettings(get: () => Settings): () => void {
  const dialog = $<HTMLDialogElement>('#settings-dialog')
  const form = $<HTMLFormElement>('#settings-form')
  const warning = $('#bypass-warning')
  const field = <T extends HTMLElement>(name: string) => form.elements.namedItem(name) as unknown as T

  const syncWarning = () => {
    const mode = (form.elements.namedItem('permissionMode') as RadioNodeList).value
    warning.hidden = mode !== 'bypassPermissions'
  }
  form.addEventListener('change', syncWarning)

  $('#btn-random-topic').addEventListener('click', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(12))
    field<HTMLInputElement>('ntfyTopic').value = `chain-prompt-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
    field<HTMLInputElement>('ntfyEnabled').checked = true
  })

  const collect = (): Partial<Settings> => {
    const s = get()
    const num = (name: string, fallback: number) => {
      const n = Number(field<HTMLInputElement>(name).value)
      return Number.isFinite(n) && n >= 0 ? n : fallback
    }
    const patch: Record<string, unknown> = {
      permissionMode: (form.elements.namedItem('permissionMode') as RadioNodeList).value,
      stepDelayMs: Math.round(num('stepDelaySec', s.stepDelayMs / 1000) * 1000)
    }
    for (const k of NUMBERS) patch[k] = num(k, s[k])
    for (const k of CHECKS) patch[k] = field<HTMLInputElement>(k).checked
    for (const k of SELECTS) patch[k] = field<HTMLSelectElement>(k).value
    for (const k of TEXT_FIELDS) patch[k] = field<HTMLInputElement>(k).value.trim()
    patch.ntfyServer ||= 'https://ntfy.sh'
    patch.claudeCommand ||= 'claude'
    patch.gitBranchPrefix ||= 'chain-prompt/'
    return patch as Partial<Settings>
  }

  const open = () => {
    const s = get()
    ;(form.elements.namedItem('permissionMode') as RadioNodeList).value = s.permissionMode
    field<HTMLInputElement>('stepDelaySec').value = String(s.stepDelayMs / 1000)
    for (const k of NUMBERS) field<HTMLInputElement>(k).value = String(s[k])
    for (const k of CHECKS) field<HTMLInputElement>(k).checked = s[k]
    for (const k of SELECTS) field<HTMLSelectElement>(k).value = s[k]
    for (const k of TEXT_FIELDS) field<HTMLInputElement>(k).value = s[k]
    syncWarning()
    dialog.showModal()
  }

  $('#btn-test-notify').addEventListener('click', async () => {
    if (!(await run(window.api.updateSettings(collect())))) return
    if (await run(window.api.testNotification())) toast('Test notification sent to every configured channel.')
  })

  dialog.addEventListener('close', async () => {
    if (dialog.returnValue !== 'save') return
    const patch = collect()
    if (patch.ntfyEnabled && !patch.ntfyTopic) toast('ntfy is on but the topic is empty — nothing will be sent', 'error')
    if (await run(window.api.updateSettings(patch))) toast('Settings saved. They apply to new claude sessions.')
  })

  return open
}
