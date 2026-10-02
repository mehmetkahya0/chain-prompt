import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

export interface TerminalView {
  /** Show the pty of another tab (replays its scrollback). */
  attach(ws: string): Promise<void>
  focus(): void
}

/**
 * One xterm.js view bound to the pty of the active tab. Output of the other
 * tabs is kept in main (scrollback) and replayed on switch.
 */
export function mountTerminal(host: HTMLElement): TerminalView {
  const term = new Terminal({
    fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, Menlo, "DejaVu Sans Mono", monospace',
    fontSize: 13,
    lineHeight: 1.15,
    cursorBlink: true,
    scrollback: 10000,
    allowProposedApi: false,
    theme: {
      background: '#0b0d11',
      foreground: '#d7dae0',
      cursor: '#e6b450',
      selectionBackground: '#33415580',
      black: '#1c1f26',
      brightBlack: '#5c6370'
    }
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.open(host)
  let active = ''
  /** Bumped on every attach so a slow scrollback fetch can't overwrite a newer tab. */
  let attachGen = 0
  /** Output that arrived while the scrollback of the new tab was loading. */
  let pending: string[] | null = null

  // Clipboard: Ctrl+C copies when there is a selection (otherwise it is SIGINT),
  // Ctrl+V / Ctrl+Shift+V paste (bracketed, via term.paste).
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true
    const mod = e.ctrlKey || e.metaKey
    const key = e.key.toLowerCase()
    if (mod && key === 'c' && term.hasSelection()) {
      void navigator.clipboard.writeText(term.getSelection())
      term.clearSelection()
      return false
    }
    if (mod && key === 'v') {
      e.preventDefault()
      void navigator.clipboard.readText().then((t) => t && term.paste(t))
      return false
    }
    return true
  })

  term.onData((d) => active && window.api.ptyWrite(active, d))
  window.api.onPtyData((ws, d) => {
    if (ws !== active) return
    if (pending) pending.push(d)
    else term.write(d)
  })
  window.api.onPtyReset((ws) => {
    if (ws !== active) return
    term.reset()
    doFit()
  })

  let lastSize = ''
  const doFit = () => {
    if (!host.offsetWidth || !host.offsetHeight) return
    try {
      fit.fit()
    } catch {
      return
    }
    const size = `${term.cols}x${term.rows}`
    if (size !== lastSize) {
      lastSize = size
      window.api.ptyResize(term.cols, term.rows)
    }
  }
  let raf = 0
  new ResizeObserver(() => {
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(doFit)
  }).observe(host)
  doFit()

  return {
    async attach(ws: string) {
      if (ws === active) return
      active = ws
      const g = ++attachGen
      pending = []
      term.reset()
      const scrollback = await window.api.getScrollback(ws)
      if (g !== attachGen) return
      term.write(scrollback)
      for (const d of pending) term.write(d)
      pending = null
      doFit()
    },
    focus: () => term.focus()
  }
}
