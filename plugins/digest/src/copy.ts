import type { DigestContent, DigestMemberContent } from './content'

export const SECTIONS = [
  { key: 'done', label: 'Done' },
  { key: 'inProgress', label: 'In progress' },
  { key: 'next', label: 'Next' },
] as const

export interface LinePart {
  text: string
  href?: string
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/** A line of the digest, with every ticket identifier it mentions turned into a link to that ticket. */
export function lineParts(line: string, links: Record<string, string>): LinePart[] {
  const identifiers = Object.keys(links).sort((a, b) => b.length - a.length)
  if (identifiers.length === 0) return [{ text: line }]
  const pattern = new RegExp(`(?<![\\w-])(${identifiers.map(escapeRegExp).join('|')})(?![\\w-])`, 'g')
  const parts: LinePart[] = []
  let last = 0
  for (const match of line.matchAll(pattern)) {
    if (match.index > last) parts.push({ text: line.slice(last, match.index) })
    parts.push({ text: match[0], href: links[match[0]] })
    last = match.index + match[0].length
  }
  if (last < line.length) parts.push({ text: line.slice(last) })
  return parts
}

/** A line as HTML: its text escaped, and its ticket identifiers as links, which on the page open outside Factorix's frame. */
export function lineHtml(line: string, links: Record<string, string>, attributes = ' target="_blank" rel="noreferrer"'): string {
  return lineParts(line, links)
    .map((part) => (part.href ? `<a href="${escapeHtml(part.href)}"${attributes}>${escapeHtml(part.text)}</a>` : escapeHtml(part.text)))
    .join('')
}

function memberCopy(member: DigestMemberContent, links: Record<string, string>): { html: string; text: string } {
  const html = [`<p><b>${escapeHtml(member.name)}</b></p>`]
  const text = [member.name]
  for (const section of SECTIONS) {
    const lines = member[section.key]
    if (lines.length === 0) continue
    html.push(`<p>${section.label}</p>`)
    html.push(`<ul>${lines.map((line) => `<li>${lineHtml(line, links, '')}</li>`).join('')}</ul>`)
    text.push(`${section.label}:`, ...lines.map((line) => `• ${line}`))
  }
  return { html: html.join(''), text: text.join('\n') }
}

/**
 * A digest, or one member of it, in the two forms a chat app pastes: rich text that keeps the lists and ticket links,
 * and plain text for anywhere else.
 */
export function digestCopy(
  content: DigestContent,
  links: Record<string, string>,
  title: string,
  only?: DigestMemberContent,
): { html: string; text: string } {
  const members = (only ? [only] : content.members).map((member) => memberCopy(member, links))
  const summary = only ? null : content.summary || null
  return {
    html: [`<p><b>${escapeHtml(title)}</b></p>`, summary ? `<p>${escapeHtml(summary)}</p>` : '', ...members.map((member) => member.html)].join(''),
    text: [title, ...(summary ? [summary] : []), ...members.map((member) => member.text)].join('\n\n'),
  }
}
