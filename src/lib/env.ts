/**
 * Server-only environment validation.
 * - Never sends secrets to client bundles (no NEXT_PUBLIC_ on server vars).
 * - Required-in-production vars fail loudly only when accessed and missing.
 * - Optional vars return undefined cleanly.
 * - Never logs or returns secret values.
 */

export type EnvStatus = {
  name:       string
  required:   boolean
  configured: boolean
}

// Variables required for core operation in all environments.
const REQUIRED_PRODUCTION = [
  'DATABASE_URL',
  'ADMIN_PASSWORD',
  'APP_URL',
] as const

// Variables that become required when NODE_ENV === 'production'.
// Without them the app fails closed in a defined way (e.g. rate limiting), so startup
// is not blocked in development but readiness is false in production when absent.
const REQUIRED_IN_PRODUCTION = [
  'RATE_LIMIT_SECRET',
] as const

// Variables needed for specific optional features; absence is always acceptable.
const OPTIONAL = [
  'BLOB_READ_WRITE_TOKEN',
  'BLOB_TRUSTED_HOSTNAME',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'RESEND_API_KEY',
  'ORDER_DIGEST_FROM_EMAIL',
  'ORDER_DIGEST_TO_EMAIL',
  'BUYER_ALERTS_FROM_EMAIL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'CRON_SECRET',
] as const

/**
 * Reads a required env var. Throws a clean error if absent; never logs the value.
 * Use at call time, not module load, to avoid blocking startup for optional paths.
 */
export function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Required environment variable ${name} is not configured.`)
  }
  return value
}

/** Reads an optional env var. Returns undefined if absent. Never throws. */
export function optionalEnv(name: string): string | undefined {
  return process.env[name] || undefined
}

/**
 * Returns the presence (not the value) of every known env var.
 * Safe to include in health/diagnostic responses — values are never exposed.
 */
export function getEnvStatus(): EnvStatus[] {
  const isProd = process.env.NODE_ENV === 'production'
  return [
    ...REQUIRED_PRODUCTION.map(name => ({
      name,
      required:   true,
      configured: Boolean(process.env[name]),
    })),
    ...REQUIRED_IN_PRODUCTION.map(name => ({
      name,
      required:   isProd,
      configured: Boolean(process.env[name]),
    })),
    ...OPTIONAL.map(name => ({
      name,
      required:   false,
      configured: Boolean(process.env[name]),
    })),
  ]
}

/**
 * Returns true when all vars required for production are present.
 * In development REQUIRED_IN_PRODUCTION vars are not checked.
 * Does not throw; intended for the readiness check.
 */
export function isCriticalEnvReady(): boolean {
  const isProd = process.env.NODE_ENV === 'production'
  const alwaysRequired = REQUIRED_PRODUCTION.every(name => Boolean(process.env[name]))
  if (!isProd) return alwaysRequired
  const prodRequired = REQUIRED_IN_PRODUCTION.every(name => Boolean(process.env[name]))
  return alwaysRequired && prodRequired
}
