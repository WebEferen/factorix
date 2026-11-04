import type { ZodType } from 'zod'

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
  }
}

export const notFound = (what: string) => new HttpError(404, 'not_found', `${what} was not found`)
export const forbidden = (message = 'You do not have access to this') => new HttpError(403, 'forbidden', message)
export const conflict = (message: string) => new HttpError(409, 'conflict', message)
export const badRequest = (message: string, details?: unknown) => new HttpError(400, 'bad_request', message, details)

export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {})
  if (!result.success) {
    const details = result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
    throw new HttpError(422, 'validation_failed', details[0] ? `${details[0].path || 'body'}: ${details[0].message}` : 'Invalid input', details)
  }
  return result.data
}

export function isForeignKeyViolation(error: unknown): boolean {
  return (error as { code?: string }).code === '23503'
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const pg = error as { code?: string; constraint?: string }
  return pg.code === '23505' && (constraint === undefined || pg.constraint === constraint)
}
