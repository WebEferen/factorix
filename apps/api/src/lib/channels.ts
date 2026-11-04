export const runChannel = (runId: string) => `run:${runId}`
export const runCommandChannel = (runId: string) => `run:${runId}:commands`
export const orgChannel = (orgId: string) => `org:${orgId}`
export const runProxyChannel = (runId: string) => `run:${runId}:proxy`
export const proxyTokenKey = (token: string) => `proxy:token:${token}`
