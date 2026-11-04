import { mapProse } from '../source'

// Private-use characters hold what must survive formatting. Input is stripped of them first, so ticket text cannot forge one.
const CODE = ''
const LITERAL = ''
const BOLD = ''
const PLACEHOLDERS = /[-]/g

const escapeControl = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function inline(line: string): string {
  const spans: string[] = []
  return line
    .replace(/`[^`\n]+`/g, (match) => {
      spans.push(match)
      return `${CODE}${spans.length - 1}${CODE}`
    })
    .replace(/!?\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '<$2|$1>')
    .replace(/\*\*([^*\n]+)\*\*/g, `${BOLD}$1${BOLD}`)
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?])/g, '$1_$2_')
    .replace(/~~([^~\n]+)~~/g, '~$1~')
    .replaceAll(BOLD, '*')
    .replace(new RegExp(`${CODE}(\\d+)${CODE}`, 'g'), (_, index: string) => spans[Number(index)] ?? '')
}

/**
 * Slack reads `<...>` as links and mentions, so `<`, `>`, and `&` are escaped before anything else. That keeps ticket
 * text from pinging a channel, and only a Markdown link in the template itself can become a link.
 */
export function markdownToSlack(markdown: string): string {
  const marked = markdown
    .replace(PLACEHOLDERS, '')
    .replace(/\\([\\`*_[\]()<>~#|!@])/g, (_, character: string) => `${LITERAL}${character.charCodeAt(0)}${LITERAL}`)
  const formatted = mapProse(escapeControl(marked), (lines) =>
    lines.map((line) => {
      const heading = /^\s{0,3}#{1,6}\s+(.+)$/.exec(line)
      if (heading) return `*${inline(heading[1] as string).replace(/\*/g, '')}*`
      return inline(line.replace(/^(\s*)[-*+]\s+/, '$1• '))
    }),
  )
  return formatted.replace(new RegExp(`${LITERAL}(\\d+)${LITERAL}`, 'g'), (_, code: string) => escapeControl(String.fromCharCode(Number(code))))
}
