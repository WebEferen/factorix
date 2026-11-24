import { randomUUID } from 'node:crypto'
import {
  CHATGPT_OAUTH,
  chatgptAuthorizeUrl,
  chatgptRedirectUri,
  exchangeChatgptCode,
  grantedScopes,
  OAuthError,
  oauthNonce,
  parseChatgptCallback,
  pkcePair,
  refreshChatgptTokens,
  revokeChatgptToken,
  verifyChatgptIdToken,
} from '@factorix/connectors'
import { TERMINAL_RUN_STATES } from '@factorix/core'
import { type AccountRow, type Db, json, type ModelLoginRow, type RunRow } from '@factorix/db'
import { MODEL_PLAN_IDS, MODEL_PLANS, type ModelDialect, type ModelPlanId } from '@factorix/runtime'
import type { SandboxProvider } from '@factorix/sandbox'
import type { ModelPlanAttemptDto } from '@factorix/schemas'
import type { AppDeps } from '../deps'
import { writeAudit } from '../lib/audit'
import { badRequest, conflict, notFound } from '../lib/errors'

type Deps = Pick<AppDeps, 'db' | 'redis' | 'secrets'>

interface ChatgptSecret {
  accessToken: string
  refreshToken: string
  idToken: string | null
}

interface Attempt {
  accountId: string
  orgId: string
  verifier: string
  nonce: string
  redirectUri: string
  /** The client an earlier sign-in registered, or null when this one registers it. */
  clientId: string | null
}

const ATTEMPT_SECONDS = 600
const HOST_ID_SETTING = 'modelPlans.hostId'
/** A run is about to start on the token, and a refresh near expiry is cheaper than a failed call. */
const START_MIN_SECONDS = 15 * 60
const LIVE_MIN_SECONDS = 25 * 60
/** A refresh token lasts 30 days, and each refresh starts a new 30, so an idle login is kept alive well before then. */
const KEEP_ALIVE_DAYS = 20

const attemptKey = (state: string) => `model-login:attempt:${state}`
export const planAccessKey = (loginId: string) => `model-login:access:${loginId}`
/** Holds one person's Claude sign-in, as the Claude CLI keeps it, and nothing else. */
export const claudeLoginVolume = (accountId: string) => `fx-login-claude-${accountId}`

export async function plansAllowed(db: Db, orgId: string): Promise<boolean> {
  const org = await db('organizations').where({ id: orgId }).first('personalModelLogins')
  return Boolean(org?.personalModelLogins)
}

/** OpenAI asks for one stable id per host. Factorix is one host, whichever machine runs the API. */
async function hostId(db: Db): Promise<string> {
  await db('platform_settings')
    .insert({ key: HOST_ID_SETTING, value: json(randomUUID()) })
    .onConflict('key')
    .ignore()
  const row = await db('platform_settings').where({ key: HOST_ID_SETTING }).first('value')
  return String(row?.value)
}

function readSecret(deps: Pick<AppDeps, 'secrets'>, row: ModelLoginRow): ChatgptSecret | null {
  if (!row.secretCiphertext || !row.secretNonce) return null
  return JSON.parse(deps.secrets.decrypt({ ciphertext: row.secretCiphertext, nonce: row.secretNonce, keyVersion: row.keyVersion })) as ChatgptSecret
}

function writeSecret(deps: Pick<AppDeps, 'secrets'>, secret: ChatgptSecret): Partial<ModelLoginRow> {
  const { ciphertext, nonce, keyVersion } = deps.secrets.encrypt(JSON.stringify(secret))
  return { secretCiphertext: ciphertext, secretNonce: nonce, keyVersion }
}

async function cacheAccess(deps: Pick<AppDeps, 'redis'>, loginId: string, token: string, expiresAt: Date): Promise<void> {
  const seconds = Math.floor((expiresAt.getTime() - Date.now()) / 1000) - 60
  if (seconds > 0) await deps.redis.set(planAccessKey(loginId), token, 'EX', seconds)
}

export async function startChatgptLogin(
  deps: Deps,
  account: Pick<AccountRow, 'id' | 'orgId'>,
  input: { redirectPort?: number },
): Promise<{ url: string; redirectUri: string }> {
  if (!(await plansAllowed(deps.db, account.orgId))) throw conflict('An admin has to allow personal plans in this organization first.')
  const existing = await deps.db<ModelLoginRow>('model_logins').where({ accountId: account.id, provider: 'chatgpt' }).first()
  const previous = existing ? readSecret(deps, existing) : null
  const { verifier, challenge } = pkcePair()
  const state = oauthNonce()
  const nonce = oauthNonce()
  const redirectUri = chatgptRedirectUri(input.redirectPort)
  const attempt: Attempt = { accountId: account.id, orgId: account.orgId, verifier, nonce, redirectUri, clientId: existing?.clientId ?? null }
  await deps.redis.set(attemptKey(state), JSON.stringify(attempt), 'EX', ATTEMPT_SECONDS)
  const url = chatgptAuthorizeUrl({
    clientId: attempt.clientId,
    appName: 'Factorix',
    hostId: await hostId(deps.db),
    redirectUri,
    state,
    nonce,
    challenge,
    idTokenHint: previous?.idToken,
    loginHint: existing?.email,
  })
  return { url, redirectUri }
}

function signInFailed(error: unknown): Error {
  if (!(error instanceof OAuthError)) return error as Error
  if (error.code === 'invalid_grant') return badRequest('That sign-in was already used or has expired. Start it again.')
  return badRequest(`ChatGPT refused the sign-in: ${error.message}`)
}

export async function completeChatgptLogin(deps: Deps, account: Pick<AccountRow, 'id' | 'orgId'>, callbackUrl: string): Promise<ModelLoginRow> {
  const { db, redis } = deps
  let callback: ReturnType<typeof parseChatgptCallback>
  try {
    callback = parseChatgptCallback(callbackUrl)
  } catch (error) {
    throw signInFailed(error)
  }
  const raw = await redis.getdel(attemptKey(callback.state))
  const attempt = raw ? (JSON.parse(raw) as Attempt) : null
  if (!attempt || attempt.accountId !== account.id) throw badRequest('This sign-in has expired or was already used. Start it again.')
  let clientId = attempt.clientId
  if (!clientId) {
    if (!callback.clientId) throw badRequest('ChatGPT did not finish registering Factorix. Start the sign-in again.')
    clientId = callback.clientId
  } else if (callback.clientId && callback.clientId !== clientId) {
    throw badRequest('ChatGPT answered for another registration. Start the sign-in again.')
  }

  let tokens: Awaited<ReturnType<typeof exchangeChatgptCode>>
  let identity: Awaited<ReturnType<typeof verifyChatgptIdToken>>
  try {
    tokens = await exchangeChatgptCode({ clientId, code: callback.code, verifier: attempt.verifier, redirectUri: attempt.redirectUri })
    if (!tokens.id_token || !tokens.refresh_token) throw badRequest('ChatGPT sent no lasting sign-in. Start it again.')
    identity = await verifyChatgptIdToken(tokens.id_token, { clientId, nonce: attempt.nonce })
  } catch (error) {
    throw signInFailed(error)
  }
  if (!grantedScopes(tokens, callback).includes(CHATGPT_OAUTH.planScope))
    throw badRequest('ChatGPT did not allow Factorix to use your plan. Sign in again and approve plan usage.')

  const existing = await db<ModelLoginRow>('model_logins').where({ accountId: account.id, provider: 'chatgpt' }).first()
  if (existing?.subject && existing.clientId === clientId && existing.subject !== identity.subject)
    throw conflict('You signed in to a different ChatGPT account. Disconnect the current one first.')
  const accessExpiresAt = new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000)
  const values = {
    status: 'active' as const,
    email: identity.email,
    subject: identity.subject,
    plan: identity.plan,
    clientId,
    ...writeSecret(deps, { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, idToken: tokens.id_token }),
    accessExpiresAt,
    refreshedAt: new Date(),
    lastError: null,
    updatedAt: new Date(),
  }
  const [row] = await db<ModelLoginRow>('model_logins')
    .insert({ orgId: account.orgId, accountId: account.id, provider: 'chatgpt', ...values })
    .onConflict(['account_id', 'provider'])
    .merge(values)
    .returning('*')
  if (!row) throw new Error('Saving the login returned nothing')
  await writeAudit(db, {
    orgId: account.orgId,
    actorAccountId: account.id,
    actorKind: 'human',
    action: 'model_plan.connected',
    targetType: 'model_login',
    targetId: row.id,
    metadata: { provider: 'chatgpt', email: identity.email, plan: identity.plan },
  })
  await cacheAccess(deps, row.id, tokens.access_token, accessExpiresAt)
  return row
}

/**
 * A ChatGPT access token good for at least `minSeconds`, refreshed if it is not. The row lock serializes refreshes of one
 * login across workers, since each refresh spends the refresh token before it. Null once the login needs signing in again.
 */
export async function chatgptAccess(deps: Deps, loginId: string, options: { minSeconds: number; force?: boolean }): Promise<string | null> {
  const fresh = await deps.db.transaction(async (trx) => {
    const row = await trx<ModelLoginRow>('model_logins').where({ id: loginId }).forUpdate().first()
    if (row?.status !== 'active' || !row.clientId) return null
    const secret = readSecret(deps, row)
    if (!secret) return null
    const left = row.accessExpiresAt ? new Date(row.accessExpiresAt).getTime() - Date.now() : 0
    if (!options.force && left > options.minSeconds * 1000) return { token: secret.accessToken, expiresAt: new Date(row.accessExpiresAt as Date) }
    try {
      const tokens = await refreshChatgptTokens({ clientId: row.clientId, refreshToken: secret.refreshToken })
      const expiresAt = new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000)
      const next = {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? secret.refreshToken,
        idToken: tokens.id_token ?? secret.idToken,
      }
      await trx('model_logins')
        .where({ id: row.id })
        .update({ ...writeSecret(deps, next), accessExpiresAt: expiresAt, refreshedAt: trx.fn.now(), lastError: null, updatedAt: trx.fn.now() })
      return { token: next.accessToken, expiresAt }
    } catch (error) {
      if (!(error instanceof OAuthError) || !['invalid_grant', 'invalid_client', 'unauthorized_client'].includes(error.code)) throw error
      await trx('model_logins')
        .where({ id: row.id })
        .update({ status: 'needs_login', lastError: `ChatGPT ended this sign-in: ${error.message}`, updatedAt: trx.fn.now() })
      return null
    }
  })
  if (!fresh) {
    await deps.redis.del(planAccessKey(loginId))
    return null
  }
  await cacheAccess(deps, loginId, fresh.token, fresh.expiresAt)
  return fresh.token
}

export interface RunPlan {
  plan: ModelPlanId
  login: ModelLoginRow
}

/**
 * The author's own plan for a run in this dialect. A plan only ever serves runs its owner started, and only where the
 * organization allows personal plans. Undefined means the run uses the organization's key, with the reason when it matters.
 */
export async function planForRun(
  deps: Deps,
  run: Pick<RunRow, 'orgId' | 'createdBy'>,
  dialect: ModelDialect,
  where: { networkPolicy?: string | null; onRunner?: boolean } = {},
): Promise<{ use: RunPlan } | { skip: string } | undefined> {
  if (!run.createdBy) return undefined
  const plan = MODEL_PLAN_IDS.find((id) => MODEL_PLANS[id].dialect === dialect)
  if (!plan) return undefined
  const login = (await deps
    .db('model_logins')
    .join('accounts', 'model_logins.account_id', 'accounts.id')
    .where({ 'model_logins.account_id': run.createdBy, 'model_logins.provider': plan, 'model_logins.org_id': run.orgId, 'accounts.status': 'active' })
    .select('model_logins.*')
    .first()) as ModelLoginRow | undefined
  if (!login) return undefined
  if (!(await plansAllowed(deps.db, run.orgId))) return undefined
  const label = MODEL_PLANS[plan].label
  if (login.status !== 'active')
    return { skip: `The ${label} plan of this run's author needs signing in again, so the run uses the organization's key.` }
  if (MODEL_PLANS[plan].via === 'cli') {
    if (where.onRunner)
      return {
        skip: `The ${label} plan of this run's author is signed in on the main machine and this run is on a runner, so it uses the organization's key.`,
      }
    if (where.networkPolicy === 'none')
      return { skip: `This project gives agents no network, which a ${label} plan needs, so the run uses the organization's key.` }
  } else {
    const token = await chatgptAccess(deps, login.id, { minSeconds: START_MIN_SECONDS }).catch(() => null)
    if (!token) return { skip: `The ${label} plan of this run's author could not be renewed, so the run uses the organization's key.` }
  }
  await deps.db('model_logins').where({ id: login.id }).update({ lastUsedAt: deps.db.fn.now() })
  return { use: { plan, login } }
}

/** Keeps tokens fresh for live runs, and idle logins from lapsing. The proxy reads the cached token on every call. */
export async function refreshPlanLogins(deps: Deps, log: (message: string) => void = () => undefined): Promise<void> {
  const live = (await deps
    .db('runs')
    .whereNotNull('modelLoginId')
    .whereNotIn('state', TERMINAL_RUN_STATES as string[])
    .distinct('modelLoginId')) as { modelLoginId: string }[]
  for (const { modelLoginId } of live) {
    await chatgptAccess(deps, modelLoginId, { minSeconds: LIVE_MIN_SECONDS }).catch((error: Error) =>
      log(`renewing a ChatGPT plan failed: ${error.message}`),
    )
  }
  const idle = (await deps
    .db('model_logins')
    .where({ provider: 'chatgpt', status: 'active' })
    .where('refreshed_at', '<', deps.db.raw(`now() - interval '${KEEP_ALIVE_DAYS} days'`))
    .select('id')) as { id: string }[]
  for (const { id } of idle) {
    await chatgptAccess(deps, id, { minSeconds: 0, force: true }).catch((error: Error) => log(`renewing a ChatGPT plan failed: ${error.message}`))
  }
}

/** Fills a proxy grant's plan routes with the plan's current token, which only the cache holds. */
export async function withPlanKeys<T extends { models?: Record<string, { key: string; login?: string }> }>(
  redis: AppDeps['redis'],
  grant: T,
): Promise<T> {
  for (const model of Object.values(grant.models ?? {})) {
    if (model.login) model.key = (await redis.get(planAccessKey(model.login))) ?? ''
  }
  return grant
}

export async function disconnectModelLogin(
  deps: Deps & Pick<AppDeps, 'queues'>,
  account: Pick<AccountRow, 'id' | 'orgId'>,
  id: string,
): Promise<void> {
  const row = await deps.db<ModelLoginRow>('model_logins').where({ id, accountId: account.id }).first()
  if (!row) throw notFound('Model plan')
  const secret = row.provider === 'chatgpt' ? readSecret(deps, row) : null
  if (secret && row.clientId) await revokeChatgptToken({ clientId: row.clientId, refreshToken: secret.refreshToken }).catch(() => undefined)
  await deps.db('model_logins').where({ id: row.id }).delete()
  // A run that has the volume mounted keeps it until it ends, so removing it is retried for a good while.
  if (row.provider === 'claude')
    await deps.queues.environments.add(
      'plan.claude-forget',
      { volume: claudeLoginVolume(account.id) },
      { attempts: 12, backoff: { type: 'exponential', delay: 60_000 }, removeOnComplete: true },
    )
  await deps.redis.del(planAccessKey(row.id))
  await writeAudit(deps.db, {
    orgId: account.orgId,
    actorAccountId: account.id,
    actorKind: 'human',
    action: 'model_plan.disconnected',
    targetType: 'model_login',
    targetId: row.id,
    metadata: { provider: row.provider },
  })
}

type ClaudeAttemptStatus = ModelPlanAttemptDto['status']

interface ClaudeAttempt {
  accountId: string
  orgId: string
  status: ClaudeAttemptStatus
  url?: string
  containerId?: string
  error?: string
}

const CLAUDE_ATTEMPT_SECONDS = 15 * 60
const CLAUDE_URL_WAIT_MS = 60_000
const CLAUDE_CODE_WAIT_MS = 90_000
const claudeAttemptKey = (id: string) => `model-login:claude:${id}`
/** Matched once terminal escapes are gone, since the CLI wraps the address in a terminal link. */
const CLAUDE_SIGN_IN = /https:\/\/[a-z.]+\/\S*oauth\/authorize\?\S+/
// biome-ignore lint/suspicious/noControlCharactersInRegex: strips the terminal escapes the CLI prints around links and colors
const TERMINAL_ESCAPES = /\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)|\u001b\[[0-9;?]*[A-Za-z]/g

async function readClaudeAttempt(redis: AppDeps['redis'], id: string): Promise<ClaudeAttempt | null> {
  const raw = await redis.get(claudeAttemptKey(id))
  return raw ? (JSON.parse(raw) as ClaudeAttempt) : null
}

async function saveClaudeAttempt(redis: AppDeps['redis'], id: string, attempt: ClaudeAttempt): Promise<void> {
  await redis.set(claudeAttemptKey(id), JSON.stringify(attempt), 'EX', CLAUDE_ATTEMPT_SECONDS)
}

async function ownAttempt(deps: Deps, account: Pick<AccountRow, 'id'>, id: string): Promise<ClaudeAttempt> {
  const attempt = await readClaudeAttempt(deps.redis, id)
  if (!attempt || attempt.accountId !== account.id) throw notFound('Sign-in')
  return attempt
}

/**
 * Starts a Claude sign-in. Anthropic lets only its own CLI hold a Claude sign-in, so the worker runs `claude auth login` in a
 * container of its own and the person signs in on Anthropic's page. Factorix passes the CLI the code that page shows, once.
 */
export async function startClaudeLogin(
  deps: Deps & Pick<AppDeps, 'queues'>,
  account: Pick<AccountRow, 'id' | 'orgId'>,
): Promise<{ attemptId: string }> {
  if (!(await plansAllowed(deps.db, account.orgId))) throw conflict('An admin has to allow personal plans in this organization first.')
  const attemptId = randomUUID()
  await saveClaudeAttempt(deps.redis, attemptId, { accountId: account.id, orgId: account.orgId, status: 'starting' })
  await deps.queues.environments.add('plan.claude-login', { attemptId }, { attempts: 1, removeOnComplete: true, removeOnFail: true })
  return { attemptId }
}

export async function claudeLoginAttempt(deps: Deps, account: Pick<AccountRow, 'id'>, id: string): Promise<ModelPlanAttemptDto> {
  const attempt = await ownAttempt(deps, account, id)
  return { status: attempt.status, url: attempt.url ?? null, error: attempt.error ?? null }
}

export async function sendClaudeLoginCode(
  deps: Deps & Pick<AppDeps, 'queues'>,
  account: Pick<AccountRow, 'id'>,
  id: string,
  code: string,
): Promise<void> {
  const attempt = await ownAttempt(deps, account, id)
  if (attempt.status !== 'waiting') throw conflict('This sign-in is not waiting for a code. Start it again.')
  await saveClaudeAttempt(deps.redis, id, { ...attempt, status: 'checking' })
  // The code is good once, and only with the secret the CLI in that container holds. The job is dropped as soon as it ran.
  await deps.queues.environments.add(
    'plan.claude-code',
    { attemptId: id, code: code.trim() },
    { attempts: 1, removeOnComplete: true, removeOnFail: true },
  )
}

function lastWords(lines: string[]): string | undefined {
  const said = lines
    .map((line) => line.replace(TERMINAL_ESCAPES, '').trim())
    .filter((line) => line && !CLAUDE_SIGN_IN.test(line) && !line.startsWith('Paste code'))
  return said.at(-1)?.slice(0, 300)
}

export interface ClaudeStatus {
  loggedIn: boolean
  authMethod?: string
  email?: string | null
  orgName?: string | null
  subscriptionType?: string | null
}

export function parseClaudeStatus(output: string): ClaudeStatus | null {
  const start = output.indexOf('{')
  const end = output.lastIndexOf('}')
  if (start < 0 || end < start) return null
  try {
    return JSON.parse(output.slice(start, end + 1)) as ClaudeStatus
  } catch {
    return null
  }
}

function within<T>(work: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

/** One step of a Claude sign-in, on the worker: start the CLI and wait for its address, or give it the code and record who signed in. */
export async function runClaudeLoginStep(deps: Deps & { sandbox: SandboxProvider }, data: { attemptId: string; code?: string }): Promise<void> {
  const attempt = await readClaudeAttempt(deps.redis, data.attemptId)
  if (!attempt) return
  const volume = claudeLoginVolume(attempt.accountId)
  const fail = async (error: string) => {
    if (attempt.containerId) await deps.sandbox.remove(attempt.containerId).catch(() => undefined)
    await saveClaudeAttempt(deps.redis, data.attemptId, { ...attempt, status: 'failed', error })
  }

  if (data.code === undefined) {
    const handle = await deps.sandbox.startClaudeLogin(volume)
    attempt.containerId = handle.containerId
    const seen: string[] = []
    const found = await within(
      (async () => {
        for await (const line of handle.lines) {
          seen.push(line)
          const url = line.replace(TERMINAL_ESCAPES, ' ').match(CLAUDE_SIGN_IN)?.[0]
          if (url) return url
        }
        return null
      })(),
      CLAUDE_URL_WAIT_MS,
    )
    handle.detach()
    if (!found || found === 'timeout') return fail(lastWords(seen) ?? 'The Claude CLI did not offer an address to sign in at. Try again.')
    await saveClaudeAttempt(deps.redis, data.attemptId, { ...attempt, status: 'waiting', url: found })
    return
  }

  const handle = attempt.containerId ? await deps.sandbox.reattach(attempt.containerId) : null
  if (!handle) return fail('This sign-in waited too long. Start it again.')
  const said: string[] = []
  handle.onStderr((line) => said.push(line))
  const reading = (async () => {
    for await (const line of handle.lines) said.push(line)
  })()
  handle.send(data.code)
  const exit = await within(handle.wait(), CLAUDE_CODE_WAIT_MS)
  handle.detach()
  await reading.catch(() => undefined)
  if (exit === 'timeout' || exit.exitCode !== 0) return fail(lastWords(said) ?? 'Claude did not accept that code. Start the sign-in again.')
  await deps.sandbox.remove(handle.containerId).catch(() => undefined)
  attempt.containerId = undefined

  const status = parseClaudeStatus((await deps.sandbox.claudeLoginStatus(volume)).output)
  if (!status?.loggedIn) return fail('The Claude CLI did not finish signing in. Start it again.')
  if (status.authMethod && status.authMethod !== 'claude.ai') return fail('That sign-in is not a Claude plan. Sign in with your Claude account.')
  const values = {
    status: 'active' as const,
    email: status.email ?? null,
    plan: status.subscriptionType ?? null,
    refreshedAt: new Date(),
    lastError: null,
    updatedAt: new Date(),
  }
  const [row] = await deps
    .db<ModelLoginRow>('model_logins')
    .insert({ orgId: attempt.orgId, accountId: attempt.accountId, provider: 'claude', ...values })
    .onConflict(['account_id', 'provider'])
    .merge(values)
    .returning('*')
  if (!row) throw new Error('Saving the login returned nothing')
  await writeAudit(deps.db, {
    orgId: attempt.orgId,
    actorAccountId: attempt.accountId,
    actorKind: 'human',
    action: 'model_plan.connected',
    targetType: 'model_login',
    targetId: row.id,
    metadata: { provider: 'claude', email: values.email, plan: values.plan },
  })
  await saveClaudeAttempt(deps.redis, data.attemptId, { ...attempt, status: 'done' })
}

/** A run that failed on its Claude plan's sign-in marks the plan, so the person sees it and later runs stop trying it. */
export async function noteClaudePlanFailure(db: Db, loginId: string, message: string): Promise<void> {
  await db('model_logins')
    .where({ id: loginId, provider: 'claude' })
    .update({ status: 'needs_login', lastError: `Claude refused this sign-in in a run: ${message.slice(0, 300)}`, updatedAt: db.fn.now() })
}
