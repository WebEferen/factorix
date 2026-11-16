import { SCM_WEBHOOK_CODECS, TRACKER_WEBHOOK_CODECS, type TrackerWebhookCodec } from '@factorix/connectors'
import { type ConnectionRow, json, type WebhookDeliveryRow } from '@factorix/db'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AppDeps } from '../deps'
import { HttpError, isUniqueViolation } from '../lib/errors'
import { endpointOf, getPlugin } from '../services/plugins'
import { readSettings } from '../services/settings'

export function webhookRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db, queues } = deps

  const authenticate = async (
    request: FastifyRequest,
    source: WebhookDeliveryRow['source'],
  ): Promise<{ connection: ConnectionRow; rawBody: Buffer; payload: unknown }> => {
    const { connectionId } = request.params as { connectionId: string }
    const connection = /^[0-9a-f-]{36}$/.test(connectionId)
      ? await db<ConnectionRow>('connections').where({ id: connectionId, kind: source }).first()
      : undefined
    if (!connection) throw new HttpError(404, 'not_found', 'Unknown webhook')
    const rawBody = request.body as Buffer
    // A plugin signs with the secret it shares with Factorix, the same one its calls arrive signed with.
    const secret =
      source === 'plugin'
        ? endpointOf(deps, await getPlugin(db, String(connection.config.pluginId ?? ''))).secret
        : String(connection.config.webhookSecret ?? '')
    const tracker = TRACKER_WEBHOOK_CODECS[source as keyof typeof TRACKER_WEBHOOK_CODECS]
    const callbackUrl = `${(await readSettings(deps)).publicUrl.replace(/\/$/, '')}/webhooks/${source}/${connection.id}`
    const verified = tracker
      ? tracker.verify(rawBody, request.headers, secret, callbackUrl)
      : SCM_WEBHOOK_CODECS[source as keyof typeof SCM_WEBHOOK_CODECS].verify(rawBody, request.headers, secret)
    if (!verified) throw new HttpError(401, 'bad_signature', 'Webhook signature check failed')
    return { connection, rawBody, payload: JSON.parse(rawBody.toString('utf8')) }
  }

  const record = async (
    connectionId: string,
    source: WebhookDeliveryRow['source'],
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

    // Trello calls the address once before it accepts a webhook, and only checks that something answers.
    scope.head('/webhooks/trello/:connectionId', async () => ({ ok: true }))

    for (const source of ['linear', 'jira', 'trello', 'plugin'] as const) {
      scope.post(`/webhooks/${source}/:connectionId`, async (request) => {
        const { connection, rawBody, payload } = await authenticate(request, source)
        const deliveryId = (TRACKER_WEBHOOK_CODECS[source] as TrackerWebhookCodec).deliveryId(request.headers, rawBody)
        const { type, webhookEvent, event } = payload as { type?: string; webhookEvent?: string; event?: { kind?: unknown } }
        const eventType = type ?? webhookEvent ?? (typeof event?.kind === 'string' ? event.kind.slice(0, 80) : undefined)
        const rowId = await record(connection.id, source, deliveryId, eventType, payload)
        if (rowId)
          await queues.trackerInbound.add(
            'delivery',
            { connectionId: connection.id, deliveryId: rowId, payload, source },
            { jobId: `${source}-${rowId}` },
          )
        return { ok: true, duplicate: !rowId }
      })
    }

    for (const source of ['gitlab', 'github'] as const) {
      const eventHeader = `x-${source}-event`
      scope.post(`/webhooks/${source}/:connectionId`, async (request) => {
        const { connection, rawBody, payload } = await authenticate(request, source)
        const deliveryId = SCM_WEBHOOK_CODECS[source].deliveryId(request.headers, rawBody)
        const event = request.headers[eventHeader] as string | undefined
        const rowId = await record(connection.id, source, deliveryId, event, payload)
        if (rowId)
          await queues.scmInbound.add(
            'delivery',
            { connectionId: connection.id, deliveryId: rowId, payload, source, headers: { [eventHeader]: event } },
            { jobId: `${source}-${rowId}` },
          )
        return { ok: true, duplicate: !rowId }
      })
    }
  })
}
