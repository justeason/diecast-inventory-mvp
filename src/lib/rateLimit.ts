/**
 * Instance-local sliding-window rate limiter.
 *
 * IMPORTANT: Enforcement is per-serverless-instance, NOT globally distributed.
 * Each Vercel function instance maintains its own window independently.
 * Distributed enforcement requires a shared store (Redis/Upstash), not configured.
 *
 * IP-based keys require RATE_LIMIT_SECRET to be set in production.
 * Missing secret fails closed (all IP-based requests denied) to prevent
 * unkeyed hashes from being used as a production identity baseline.
 *
 * Identity-based keys (profileId, admin session) always work without the secret.
 *
 * Raw client addresses are never stored or logged.
 */

import crypto from 'crypto'

// INSTANCE-LOCAL: Each serverless instance tracks its own window independently.
const store = new Map<string, number[]>()

export interface RateLimitResult {
  allowed:    boolean
  remaining:  number
  resetMs:    number   // ms until the oldest hit expires
  failedClosed?: true  // set when denied due to missing RATE_LIMIT_SECRET
}

/**
 * Checks and records a rate-limit hit.
 * Returns allowed=false when `max` hits have occurred within `windowMs`.
 */
export function checkRateLimit(
  key:      string,
  max:      number,
  windowMs: number,
): RateLimitResult {
  const now = Date.now()
  const cutoff = now - windowMs
  const hits = (store.get(key) ?? []).filter(t => t > cutoff)

  if (hits.length >= max) {
    const oldest = Math.min(...hits)
    return { allowed: false, remaining: 0, resetMs: oldest + windowMs - now }
  }

  hits.push(now)
  store.set(key, hits)
  return { allowed: true, remaining: max - hits.length, resetMs: windowMs }
}

/**
 * Hashes a value with HMAC-SHA256 (RATE_LIMIT_SECRET required in production).
 * Returns null when the secret is absent in production — callers must fail closed.
 * In development, falls back to plain SHA-256 with an explicit dev constant.
 */
export function hashRateLimitKey(value: string, suffix = ''): string | null {
  const secret = process.env.RATE_LIMIT_SECRET

  if (secret) {
    return crypto.createHmac('sha256', secret).update(value + suffix).digest('hex').slice(0, 24)
  }

  if (process.env.NODE_ENV === 'production') {
    // Fail closed: without a secret, IP-derived keys would be unkeyed
    // and provide no deployment isolation. Deny rather than hash without a key.
    return null
  }

  // Development-only fallback — explicitly documented, never used in production.
  const DEV_FALLBACK = 'dev-rate-limit-fallback-do-not-use-in-production'
  return crypto.createHmac('sha256', DEV_FALLBACK).update(value + suffix).digest('hex').slice(0, 24)
}

/**
 * Canonicalizes the client address from x-forwarded-for.
 * Vercel sets XFF with the real client IP as the first entry.
 * Returns null when no valid address can be extracted.
 * The raw address is never stored or logged.
 */
export function canonicalClientAddress(headers: Headers): string | null {
  const xff = headers.get('x-forwarded-for') ?? ''
  // Take only the first (leftmost) address — the original client on Vercel.
  const candidate = xff.split(',')[0].trim()
  if (!candidate) return null
  // Basic structural validation — not a full IP parser, but filters garbage.
  // Accepts IPv4 (e.g. 1.2.3.4), IPv6, or localhost.
  if (!/^[0-9a-fA-F:.[\]]+$/.test(candidate)) return null
  return candidate
}

/**
 * Produces a hashed, privacy-safe rate-limit key from request headers.
 * Returns null when RATE_LIMIT_SECRET is required but absent (fail closed).
 * Callers MUST treat null as denied.
 */
export function rateLimitKeyFromHeaders(headers: Headers, suffix = ''): string | null {
  const addr = canonicalClientAddress(headers) ?? 'unknown'
  return hashRateLimitKey(addr, suffix)
}
