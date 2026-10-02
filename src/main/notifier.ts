import type { Settings } from '../shared/types'
import type { NoticeKind } from './core/chainRunner'

// Remote notification channels. No Electron imports here: the headless CLI
// uses this module too; desktop notifications live in desktopNotifier.ts.

const NTFY_PRIORITY: Record<NoticeKind, string> = { done: 'default', attention: 'high', error: 'high' }
const NTFY_TAGS: Record<NoticeKind, string> = { done: 'white_check_mark', attention: 'bell', error: 'warning' }
const EMOJI: Record<NoticeKind, string> = { done: '✅', attention: '🔔', error: '⚠️' }

async function post(name: string, url: string, init: RequestInit): Promise<string | null> {
  try {
    const res = await fetch(url, { method: 'POST', ...init, signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return `${name}: HTTP ${res.status}`
    return null
  } catch (e) {
    return `${name}: ${(e as Error).message}`
  }
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

/** Send to every configured remote channel. Returns the errors (empty = all fine). */
export async function sendRemoteNotice(settings: Settings, kind: NoticeKind, title: string, body: string): Promise<string[]> {
  const jobs: Promise<string | null>[] = []
  const topic = settings.ntfyTopic.trim()
  if (settings.ntfyEnabled && topic) {
    const server = (settings.ntfyServer.trim() || 'https://ntfy.sh').replace(/\/+$/, '')
    const headers: Record<string, string> = {
      // Header values must be ASCII-safe; ntfy decodes RFC 2047 encoded titles.
      Title: `=?UTF-8?B?${Buffer.from(title).toString('base64')}?=`,
      Priority: NTFY_PRIORITY[kind],
      Tags: NTFY_TAGS[kind]
    }
    if (settings.ntfyToken.trim()) headers.Authorization = `Bearer ${settings.ntfyToken.trim()}`
    jobs.push(post('ntfy', `${server}/${encodeURIComponent(topic)}`, { body, headers }))
  }
  const text = `${EMOJI[kind]} ${title}\n${body}`
  if (settings.slackWebhookUrl.trim()) jobs.push(post('Slack', settings.slackWebhookUrl.trim(), json({ text })))
  if (settings.discordWebhookUrl.trim()) {
    jobs.push(post('Discord', settings.discordWebhookUrl.trim(), json({ content: text.slice(0, 2000) })))
  }
  if (settings.telegramBotToken.trim() && settings.telegramChatId.trim()) {
    const url = `https://api.telegram.org/bot${encodeURIComponent(settings.telegramBotToken.trim())}/sendMessage`
    jobs.push(post('Telegram', url, json({ chat_id: settings.telegramChatId.trim(), text: text.slice(0, 4000) })))
  }
  const errors = (await Promise.all(jobs)).filter((e): e is string => !!e)
  for (const e of errors) console.error(`notification failed — ${e}`)
  return errors
}
