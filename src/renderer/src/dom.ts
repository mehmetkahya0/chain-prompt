export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T => {
  const el = root.querySelector<T>(sel)
  if (!el) throw new Error(`missing element ${sel}`)
  return el
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | undefined> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue
    if (k === 'html') el.innerHTML = String(v)
    else el.setAttribute(k, v === true ? '' : v)
  }
  for (const c of children) if (c) el.append(c)
  return el
}

let toastHost: HTMLElement | null = null

/** Short transient message in the bottom-right corner. */
export function toast(text: string, kind: 'info' | 'error' = 'info'): void {
  toastHost ??= document.body.appendChild(h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }))
  const t = toastHost.appendChild(h('div', { class: `toast ${kind}` }, text))
  setTimeout(() => t.classList.add('out'), 4200)
  setTimeout(() => t.remove(), 4600)
}

/** Show the error string an API call resolved to, if any. */
export async function run(p: Promise<string | null>): Promise<boolean> {
  const err = await p
  if (err) toast(err, 'error')
  return !err
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${sec}s`
  return `${sec}s`
}

export const fmtTime = (t: number) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
