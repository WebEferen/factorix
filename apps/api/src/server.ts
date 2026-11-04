import { createDb, migrate } from '@factorix/db'
import { Redis } from 'ioredis'
import { buildApp } from './app'
import { realConnectors } from './deps'
import { loadEnv } from './env'
import { createSecretBox } from './lib/crypto'
import { createQueues } from './queues'

async function main(): Promise<void> {
  const env = loadEnv()
  const db = createDb(env.DATABASE_URL, { max: 20 })
  await migrate(db)
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null })
  const queues = createQueues(redis)
  const app = buildApp({ db, redis, env, secrets: createSecretBox(env.FACTORIX_SECRET_KEY), connectors: realConnectors, queues }, { logger: true })
  const shutdown = async () => {
    await app.close()
    await queues.close()
    await db.destroy()
    redis.disconnect()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown())
  process.on('SIGINT', () => void shutdown())
  await app.listen({ port: env.PORT, host: env.HOST })
}

void main()
