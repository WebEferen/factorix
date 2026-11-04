import { z } from 'zod'

const booleanish = z
  .string()
  .optional()
  .transform((value) => value === 'true' || value === '1')

const enabledUnlessOff = z
  .string()
  .optional()
  .transform((value) => value === undefined || value === '' || value === 'true' || value === '1')

const count = (fallback: number, min = 0) =>
  z.preprocess((value) => (value === '' ? undefined : value), z.coerce.number().int().min(min).default(fallback))

const schema = z.object({
  DATABASE_URL: z.string().default('postgres://factorix:factorix@localhost:55432/factorix'),
  REDIS_URL: z.string().default('redis://localhost:56379'),
  FACTORIX_SECRET_KEY: z.string().min(1, 'Set FACTORIX_SECRET_KEY to 32 random bytes in base64: openssl rand -base64 32'),
  PORT: z.coerce.number().default(4100),
  HOST: z.string().default('0.0.0.0'),
  FACTORIX_PUBLIC_URL: z.string().default('http://localhost:4101'),
  COOKIE_SECURE: booleanish,
  FACTORIX_SANDBOX_IMAGE: z.string().default('factorix/sandbox-base:dev'),
  FACTORIX_STEP_NETWORK: z.string().optional(),
  FACTORIX_AGENT_NETWORK: z.string().optional(),
  FACTORIX_PROXY_URL: z.string().optional(),
  FACTORIX_ALLOW_SCRIPTED_RUNTIME: booleanish,
  FACTORIX_SYNC_INTERVAL_SECONDS: count(300, 1),
  FACTORIX_RUN_CONCURRENCY: count(3, 1),
  FACTORIX_CLOSED_ISSUE_DAYS: count(90),
  FACTORIX_NOTE_DEBOUNCE_MINUTES: count(3),
  FACTORIX_CI_WAIT_MINUTES: count(30, 1),
  FACTORIX_CLEAR_RUN_CACHE: enabledUnlessOff,
  FACTORIX_FINISHED_WORKSPACE_HOURS: count(0),
  FACTORIX_FAILED_WORKSPACE_DAYS: count(7),
  FACTORIX_OPEN_WORKSPACE_DAYS: count(30, 1),
  FACTORIX_FAILED_CONTAINER_HOURS: count(1),
  FACTORIX_SESSION_DAYS: count(30, 1),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
})

export type Env = z.infer<typeof schema>

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = schema.safeParse(source)
  if (!result.success)
    throw new Error(`Invalid environment: ${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`)
  return result.data
}
