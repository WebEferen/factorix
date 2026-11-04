const PLACEHOLDER = /\{\{\s*([\w.-]+)\s*\}\}/g

function lookup(values: unknown, path: string): unknown {
  let current = values
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return ''
  return Array.isArray(value) ? value.join(', ') : String(value)
}

/** One pass only, so a ticket title that contains {{...}} stays text. Ticket text is untrusted, so callers escape values for where they end up. */
export function renderTemplate(template: string, values: unknown, escapeValue: (text: string) => string = (text) => text): string {
  return template.replace(PLACEHOLDER, (_, path: string) => escapeValue(asText(lookup(values, path))))
}

/** Lets a ticket title sit inside Markdown as plain text, unable to become a link or a mention. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_[\]()<>~#|!@]/g, '\\$&')
}
