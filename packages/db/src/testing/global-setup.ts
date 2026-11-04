import type { TestProject } from 'vitest/node'

export default async function setup(project: TestProject) {
  let databaseUrl = process.env.TEST_DATABASE_URL
  let redisUrl = process.env.TEST_REDIS_URL
  const stops: (() => Promise<unknown>)[] = []
  if (!databaseUrl || !redisUrl) {
    process.env.TESTCONTAINERS_RYUK_DISABLED ??= 'true'
    const { GenericContainer, Wait } = await import('testcontainers')
    if (!databaseUrl) {
      const container = await new GenericContainer('postgres:17')
        .withEnvironment({ POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'postgres' })
        .withExposedPorts(5432)
        .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
        .start()
      databaseUrl = `postgres://postgres:test@${container.getHost()}:${container.getMappedPort(5432)}/postgres`
      stops.push(() => container.stop())
    }
    if (!redisUrl) {
      const container = await new GenericContainer('redis:7')
        .withExposedPorts(6379)
        .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
        .start()
      redisUrl = `redis://${container.getHost()}:${container.getMappedPort(6379)}`
      stops.push(() => container.stop())
    }
  }
  project.provide('databaseUrl', databaseUrl)
  project.provide('redisUrl', redisUrl)
  return async () => {
    await Promise.all(stops.map((stop) => stop()))
  }
}

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string
    redisUrl: string
  }
}
