import { Notification } from 'electron'
import type { Settings } from '../shared/types'
import type { NoticeKind } from './core/chainRunner'
import { sendRemoteNotice } from './notifier'

/** Desktop notification + every configured remote channel. Returns remote errors, never throws. */
export async function sendNotice(settings: Settings, kind: NoticeKind, title: string, body: string): Promise<string[]> {
  if (settings.desktopNotifications && Notification.isSupported()) {
    new Notification({ title, body, urgency: kind === 'done' ? 'normal' : 'critical' }).show()
  }
  return sendRemoteNotice(settings, kind, title, body)
}
