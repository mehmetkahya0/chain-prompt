/**
 * Heuristic: did claude end its turn by asking the user something?
 * Only the last paragraph counts; a question in the middle of a long answer
 * ("Why did this fail? Because...") is not a hand-off to the user.
 */
const ASKING =
  /\b(should I|shall I|do you want|would you like|would you prefer|do you prefer|can you (confirm|clarify)|could you (confirm|clarify|provide|share)|let me know (if|whether|which|what|how)|please (confirm|clarify|choose|advise|let me know)|which (one|option|approach) (do|would|should))\b/i

export function looksLikeQuestion(message: string): boolean {
  const text = message.replace(/\r\n/g, '\n').trim()
  if (!text) return false
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  const last = paragraphs[paragraphs.length - 1] ?? ''
  // Strip trailing markdown decoration: **bold?**, `code?`, ) etc.
  const bare = last.replace(/[\s*_`)\]"'>]+$/g, '')
  if (bare.endsWith('?')) return true
  // A numbered option list as the last block, introduced by a question.
  const prev = paragraphs[paragraphs.length - 2] ?? ''
  if (/^\s*(\d+[.)]|[-*])\s/m.test(last) && prev.replace(/[\s*_`:]+$/g, '').endsWith('?')) return true
  return ASKING.test(last.slice(-400))
}
