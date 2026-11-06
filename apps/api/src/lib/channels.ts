export const runChannel = (runId: string) => `run:${runId}`
export const runCommandChannel = (runId: string) => `run:${runId}:commands`
export const orgChannel = (orgId: string) => `org:${orgId}`
export const runProxyChannel = (runId: string) => `run:${runId}:proxy`
export const proxyTokenKey = (token: string) => `proxy:token:${token}`

/** Shared with apps/preview-gateway, which reads routes, consumes tickets, and records visits under the same names. */
export const previewKeys = {
  route: (slug: string) => `preview:route:${slug}`,
  ticket: (token: string) => `preview:ticket:${token}`,
  seen: (slug: string) => `preview:seen:${slug}`,
  logs: (slug: string) => `preview:logs:${slug}`,
  logSeq: (slug: string) => `preview:log-seq:${slug}`,
  logChannel: (slug: string) => `preview:${slug}:logs`,
  proxyChannel: (slug: string) => `preview:${slug}:proxy`,
  grant: (slug: string) => `preview:grant:${slug}`,
  lock: (id: string) => `preview:lock:${id}`,
  pump: (containerId: string) => `preview:pump:${containerId}`,
}
