// {{variable}} substitution for prompts. Shared so the renderer can preview names.

const VAR_RE = /\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g

/** Replace {{name}} with vars[name]; unknown names are left untouched so mistakes stay visible. */
export function renderPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(VAR_RE, (all, name: string) => (Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : all))
}

/** Every distinct {{name}} used in the given texts, in order of first use. */
export function variableNames(...texts: (string | undefined)[]): string[] {
  const seen = new Set<string>()
  for (const t of texts) {
    if (!t) continue
    for (const m of t.matchAll(VAR_RE)) seen.add(m[1])
  }
  return [...seen]
}

/** Variables the app fills in by itself; they never need a user value. */
export const BUILTIN_VARIABLES: { name: string; description: string }[] = [
  { name: 'folder', description: 'Full path of the working folder' },
  { name: 'folderName', description: 'Name of the working folder' },
  { name: 'date', description: 'Today, YYYY-MM-DD' },
  { name: 'time', description: 'Now, HH:MM' },
  { name: 'step', description: 'Number of the current step' },
  { name: 'prev.output', description: "claude's last message from the previous finished step" },
  { name: 'verify.output', description: 'Output of the failed verify command (fix prompts only)' }
]

export const isBuiltinVariable = (name: string) => BUILTIN_VARIABLES.some((v) => v.name === name)
