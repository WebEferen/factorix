import { createServer, type Server } from 'node:http'
import { createHandler, type HandlerOptions, type Plugin } from './plugin.js'

/** Starts a plain Node server for a plugin. Put HTTPS in front of it: Factorix sends connection secrets to this address. */
export function serve(plugin: Plugin, options: HandlerOptions & { port?: number; hostname?: string }): Promise<Server> {
  const handler = createHandler(plugin, options)
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const headers = new Headers()
      for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(name, [value].flat().join(', '))
      const method = req.method ?? 'GET'
      const response = await handler(
        new Request(`http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`, {
          method,
          headers,
          body: method === 'GET' || method === 'HEAD' ? undefined : Buffer.concat(chunks),
        }),
      )
      res.writeHead(response.status, Object.fromEntries(response.headers))
      res.end(Buffer.from(await response.arrayBuffer()))
    } catch {
      res.writeHead(500).end()
    }
  })
  return new Promise((resolve) => server.listen(options.port ?? 8787, options.hostname ?? '0.0.0.0', () => resolve(server)))
}
