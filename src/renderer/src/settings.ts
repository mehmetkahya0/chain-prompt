import type { Settings } from '../../shared/types'
import { $, run, toast } from './dom'

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

  const open = () => {
    const s = get()
    ;(form.elements.namedItem('permissionMode') as RadioNodeList).value = s.permissionMode
    field<HTMLInputElement>('stepDelaySec').value = String(s.stepDelayMs / 1000)
    field<HTMLInputElement>('idleTimeoutMin').value = String(s.idleTimeoutMin)
    field<HTMLSelectElement>('newSessionMethod').value = s.newSessionMethod
    field<HTMLInputElement>('desktopNotifications').checked = s.desktopNotifications
    field<HTMLInputElement>('ntfyEnabled').checked = s.ntfyEnabled
    field<HTMLInputElement>('ntfyServer').value = s.ntfyServer
    field<HTMLInputElement>('ntfyTopic').value = s.ntfyTopic
    field<HTMLInputElement>('claudeCommand').value = s.claudeCommand
    field<HTMLInputElement>('extraArgs').value = s.extraArgs
    field<HTMLSelectElement>('hookTransport').value = s.hookTransport
    syncWarning()
    dialog.showModal()
  }

  dialog.addEventListener('close', async () => {
    if (dialog.returnValue !== 'save') return
    const num = (name: string, fallback: number) => {
      const n = Number(field<HTMLInputElement>(name).value)
      return Number.isFinite(n) && n >= 0 ? n : fallback
    }
    const s = get()
    const patch: Partial<Settings> = {
      permissionMode: (form.elements.namedItem('permissionMode') as RadioNodeList).value as Settings['permissionMode'],
      stepDelayMs: Math.round(num('stepDelaySec', s.stepDelayMs / 1000) * 1000),
      idleTimeoutMin: num('idleTimeoutMin', s.idleTimeoutMin),
      newSessionMethod: field<HTMLSelectElement>('newSessionMethod').value as Settings['newSessionMethod'],
      desktopNotifications: field<HTMLInputElement>('desktopNotifications').checked,
      ntfyEnabled: field<HTMLInputElement>('ntfyEnabled').checked,
      ntfyServer: field<HTMLInputElement>('ntfyServer').value.trim() || 'https://ntfy.sh',
      ntfyTopic: field<HTMLInputElement>('ntfyTopic').value.trim(),
      claudeCommand: field<HTMLInputElement>('claudeCommand').value.trim() || 'claude',
      extraArgs: field<HTMLInputElement>('extraArgs').value.trim(),
      hookTransport: field<HTMLSelectElement>('hookTransport').value as Settings['hookTransport']
    }
    if (patch.ntfyEnabled && !patch.ntfyTopic) toast('ntfy is on but the topic is empty — nothing will be sent', 'error')
    if (await run(window.api.updateSettings(patch))) toast('Settings saved. They apply to new claude sessions.')
  })

  return open
}
