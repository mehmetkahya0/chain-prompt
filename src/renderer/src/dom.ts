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

export const fmtCost = (usd: number) => (usd < 0.01 && usd > 0 ? '<$0.01' : `$${usd.toFixed(2)}`)

/** Estimated cost with a "~" (the "<$0.01" form already says it is approximate). */
export const approxCost = (usd: number) => (usd < 0.01 && usd > 0 ? '<$0.01' : `~$${usd.toFixed(2)}`)

export function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M tok`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k tok`
  return `${n} tok`
}

/** Two-click confirmation without a modal: first click arms the button for 3s. */
export function confirmInline(btn: HTMLElement, question = 'Are you sure? Click again to confirm.'): boolean {
  if (btn.dataset.armed) {
    delete btn.dataset.armed
    btn.classList.remove('armed')
    return true
  }
  btn.dataset.armed = '1'
  btn.classList.add('armed')
  toast(question)
  setTimeout(() => {
    delete btn.dataset.armed
    btn.classList.remove('armed')
  }, 3000)
  return false
}

export const isMac = /Mac/.test(navigator.userAgent)
