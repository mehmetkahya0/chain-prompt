import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

/** xterm.js bound to the main-process pty over the preload API. */
export function mountTerminal(host: HTMLElement, initialScrollback: string): Terminal {
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

  term.onData((d) => window.api.ptyWrite(d))
  window.api.onPtyData((d) => term.write(d))
  window.api.onPtyReset(() => {
    term.reset()
    doFit()
  })
  if (initialScrollback) term.write(initialScrollback)

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
  return term
}
