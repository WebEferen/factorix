import { createHash } from 'node:crypto'

const TRACKER_PREFIX = /^\*\*\[Factorix · [^\]]+\]\*\*/
const SCM_MARKER = /<!-- factorix:run=[^\s]+ agent=[^\s]+ -->/

export function normalizeBody(body: string): string {
  return body.replace(/\r\n/g, '\n').trim()
}

export function formatTrackerComment(agentHandle: string, body: string, runId?: string): string {
  const footer = runId ? `\n\n<sub>factorix run ${runId.slice(0, 8)}</sub>` : ''
  return `**[Factorix · ${agentHandle}]** ${body}${footer}`
}

export function isFactoryTrackerComment(body: string): boolean {
  return TRACKER_PREFIX.test(body.trimStart())
}

export function scmMarker(runId: string, agentHandle: string): string {
  return `<!-- factorix:run=${runId} agent=${agentHandle} -->`
}

export function formatScmBody(body: string, runId: string, agentHandle: string): string {
  return `${body}\n\n${scmMarker(runId, agentHandle)}`
}

export function isFactoryScmBody(body: string): boolean {
  return SCM_MARKER.test(body)
}

export function fingerprint(field: string, value: unknown): string {
  const normalized = typeof value === 'string' ? normalizeBody(value) : JSON.stringify(value)
  return createHash('sha256').update(`${field}=${normalized}`).digest('hex')
}

export function branchNameFor(identifier: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  const id = identifier.toLowerCase().replace(/[^a-z0-9-]+/g, '-')
  return slug ? `factorix/${id}-${slug}` : `factorix/${id}`
}
