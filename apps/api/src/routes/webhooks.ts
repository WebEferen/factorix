import { gitlabWebhookCodec, linearWebhookCodec } from '@factorix/connectors'
import { type ConnectionRow, json } from '@factorix/db'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AppDeps } from '../deps'
import { HttpError, isUniqueViolation } from '../lib/errors'

export function webhookRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db, queues } = deps

  const authenticate = async (
    request: FastifyRequest,
    source: 'linear' | 'gitlab',
  ): Promise<{ connection: ConnectionRow; rawBody: Buffer; payload: unknown }> => {
    const { connectionId } = request.params as { connectionId: string }
    const connection = /^[0-9a-f-]{36}$/.test(connectionId)
      ? await db<ConnectionRow>('connections').where({ id: connectionId, kind: source }).first()
      : undefined
    if (!connection) throw new HttpError(404, 'not_found', 'Unknown webhook')
    const rawBody = request.body as Buffer
    const codec = source === 'linear' ? linearWebhookCodec : gitlabWebhookCodec
    if (!codec.verify(rawBody, request.headers, String(connection.config.webhookSecret ?? '')))
      throw new HttpError(401, 'bad_signature', 'Webhook signature check failed')
    return { connection, rawBody, payload: JSON.parse(rawBody.toString('utf8')) }
  }

  const record = async (
    connectionId: string,
    source: 'linear' | 'gitlab',
    deliveryId: string,
    eventType: string | undefined,
    payload: unknown,
  ): Promise<string | null> => {
    try {
      const [row] = await db('webhook_deliveries')
        .insert({ connectionId, source, deliveryId, eventType, payload: json(payload) })
        .returning('id')
      return row.id as string
    } catch (error) {
      if (isUniqueViolation(error)) return null
      throw error
    }
  }

  app.register(async (scope) => {
    scope.removeAllContentTypeParsers()
    scope.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body))

    scope.post('/webhooks/linear/:connectionId', async (request) => {
      const { connection, rawBody, payload } = await authenticate(request, 'linear')
      const deliveryId = linearWebhookCodec.deliveryId(request.headers, rawBody)
      const rowId = await record(connection.id, 'linear', deliveryId, (payload as { type?: string }).type, payload)
      if (rowId)
        await queues.trackerInbound.add('delivery', { connectionId: connection.id, deliveryId: rowId, payload }, { jobId: `linear-${rowId}` })
      return { ok: true, duplicate: !rowId }
    })

    scope.post('/webhooks/gitlab/:connectionId', async (request) => {
      const { connection, rawBody, payload } = await authenticate(request, 'gitlab')
      const deliveryId = gitlabWebhookCodec.deliveryId(request.headers, rawBody)
      const event = request.headers['x-gitlab-event'] as string | undefined
      const rowId = await record(connection.id, 'gitlab', deliveryId, event, payload)
      if (rowId)
        await queues.scmInbound.add(
          'delivery',
          { connectionId: connection.id, deliveryId: rowId, payload, headers: { 'x-gitlab-event': event } },
          { jobId: `gitlab-${rowId}` },
        )
      return { ok: true, duplicate: !rowId }
    })
  })
}
