import { Notification } from 'electron'
import type { Settings } from '../shared/types'
import type { NoticeKind } from './core/chainRunner'

const NTFY_PRIORITY: Record<NoticeKind, string> = { done: 'default', attention: 'high', error: 'high' }
const NTFY_TAGS: Record<NoticeKind, string> = { done: 'white_check_mark', attention: 'bell', error: 'warning' }

/** Desktop notification + optional ntfy.sh push. Failures are logged, never thrown. */
export async function sendNotice(settings: Settings, kind: NoticeKind, title: string, body: string): Promise<void> {
  if (settings.desktopNotifications && Notification.isSupported()) {
    new Notification({ title, body, urgency: kind === 'done' ? 'normal' : 'critical' }).show()
  }
  const topic = settings.ntfyTopic.trim()
  if (!settings.ntfyEnabled || !topic) return
  const server = (settings.ntfyServer.trim() || 'https://ntfy.sh').replace(/\/+$/, '')
  try {
    const res = await fetch(`${server}/${encodeURIComponent(topic)}`, {
      method: 'POST',
      body,
      headers: {
        // Header values must be ASCII-safe; ntfy decodes RFC 2047 encoded titles.
        Title: `=?UTF-8?B?${Buffer.from(title).toString('base64')}?=`,
        Priority: NTFY_PRIORITY[kind],
        Tags: NTFY_TAGS[kind]
      },
      signal: AbortSignal.timeout(10_000)
    })
    if (!res.ok) console.error(`ntfy: HTTP ${res.status}`)
  } catch (e) {
    console.error('ntfy failed', e)
  }
}
