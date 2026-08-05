/**
 * Centralized error normalization.
 * - Maps Prisma codes to application error categories.
 * - Produces safe user-facing messages; never leaks SQL, stack traces, or file paths.
 * - Logs internal details once via serverLogger.
 */
import { Prisma } from '@prisma/client'
import { logger } from './serverLogger'

export type ErrorCategory =
  | 'validation'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'stale'
  | 'rate_limited'
  | 'dependency_unavailable'
  | 'internal'

export class AppError extends Error {
  readonly category: ErrorCategory
  readonly userMessage: string

  constructor(category: ErrorCategory, userMessage: string, cause?: unknown) {
    super(userMessage)
    this.name = 'AppError'
    this.category = category
    this.userMessage = userMessage
    if (cause instanceof Error) this.cause = cause
  }
}

const PRISMA_CODE_MAP: Record<string, ErrorCategory> = {
  P2002: 'conflict',   // unique constraint violation
  P2025: 'not_found',  // record not found
  P2003: 'conflict',   // foreign key constraint failed
  P2016: 'not_found',  // query interpretation error (missing required value)
}

const PRODUCTION_SAFE_MESSAGES: Record<ErrorCategory, string> = {
  validation:             'The request data is invalid.',
  unauthorized:           'Authentication required.',
  forbidden:              'You do not have permission to perform this action.',
  not_found:              'The requested resource was not found.',
  conflict:               'This operation conflicts with existing data.',
  stale:                  'This record has been updated elsewhere. Please refresh and try again.',
  rate_limited:           'Too many requests. Please wait and try again.',
  dependency_unavailable: 'A required service is temporarily unavailable.',
  internal:               'An unexpected error occurred. Please try again.',
}

export function normalizeError(
  err: unknown,
  context: { event: string; requestId?: string; route?: string },
): AppError {
  // Already normalized
  if (err instanceof AppError) return err

  // Prisma known errors
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const category = PRISMA_CODE_MAP[err.code] ?? 'internal'
    logger.error(context.event, err, {
      requestId: context.requestId,
      route:     context.route,
      status:    prismaStatusCode(category),
    })
    return new AppError(category, PRODUCTION_SAFE_MESSAGES[category], err)
  }

  // Prisma validation / init errors — never expose connection strings
  if (err instanceof Prisma.PrismaClientValidationError ||
      err instanceof Prisma.PrismaClientInitializationError) {
    logger.error(context.event, new Error('[Prisma config/validation error hidden]'), {
      requestId: context.requestId,
      route:     context.route,
    })
    return new AppError('internal', PRODUCTION_SAFE_MESSAGES['internal'])
  }

  // Generic errors
  const cause = err instanceof Error ? err : new Error(String(err))
  logger.error(context.event, cause, {
    requestId: context.requestId,
    route:     context.route,
  })
  return new AppError('internal', PRODUCTION_SAFE_MESSAGES['internal'], cause)
}

export function prismaStatusCode(category: ErrorCategory): number {
  switch (category) {
    case 'validation':             return 400
    case 'unauthorized':           return 401
    case 'forbidden':              return 403
    case 'not_found':              return 404
    case 'conflict':               return 409
    case 'stale':                  return 409
    case 'rate_limited':           return 429
    case 'dependency_unavailable': return 503
    default:                       return 500
  }
}

/** Safe user message for an error category. */
export function safeMessage(category: ErrorCategory): string {
  return PRODUCTION_SAFE_MESSAGES[category]
}
