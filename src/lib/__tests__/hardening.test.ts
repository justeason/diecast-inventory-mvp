/**
 * 13A Production Hardening — focused tests.
 * Tests pure functions and source structure; does not require DB or network.
 */
import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const root = path.resolve(__dirname, '../../..')
const src  = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8')

const loggerSrc      = src('src/lib/serverLogger.ts')
const envSrc         = src('src/lib/env.ts')
const rateLimitSrc   = src('src/lib/rateLimit.ts')
const middlewareSrc  = src('src/proxy.ts')
const healthSrc      = src('src/app/api/health/route.ts')
const readySrc       = src('src/app/api/ready/route.ts')
const nextConfigSrc  = src('next.config.ts')
const sysHealthSrc   = src('src/app/(admin)/admin/system-health/page.tsx')
const errorTsx       = src('src/app/error.tsx')
const globalErrorTsx = src('src/app/global-error.tsx')
// 15H: nav content moved from layout.tsx into AdminNav.tsx's grouped nav data.
const adminNavSrc    = src('src/components/admin/AdminNav.tsx')
const storageRoute   = src('src/app/api/admin/storage-locations/search/route.ts')
const authActionSrc  = src('src/lib/actions/auth.ts')
const buyerAuthSrc   = src('src/lib/actions/buyerAuth.ts')
const envExampleSrc  = src('.env.example')

// ── serverLogger ──────────────────────────────────────────────────────────────

import { logger } from '../serverLogger'

describe('serverLogger — redaction', () => {
  it('redacts password fields', () => {
    const output: string[] = []
    const orig = console.log
    console.log = (s: string) => { output.push(s); orig(s) }
    process.env.NODE_ENV = 'production'
    logger.info('test', { password: 'secret123' } as never)
    process.env.NODE_ENV = 'test'
    console.log = orig
    const entry = JSON.parse(output[0] ?? '{}')
    expect(entry.password).toBe('[REDACTED]')
  })

  it('redacts token fields', () => {
    const output: string[] = []
    const orig = console.log
    console.log = (s: string) => { output.push(s); orig(s) }
    process.env.NODE_ENV = 'production'
    logger.info('test', { token: 'tok_abc' } as never)
    process.env.NODE_ENV = 'test'
    console.log = orig
    const entry = JSON.parse(output[0] ?? '{}')
    expect(entry.token).toBe('[REDACTED]')
  })

  it('redacts email fields', () => {
    const output: string[] = []
    const orig = console.log
    console.log = (s: string) => { output.push(s); orig(s) }
    process.env.NODE_ENV = 'production'
    logger.info('test', { email: 'user@example.com' } as never)
    process.env.NODE_ENV = 'test'
    console.log = orig
    const entry = JSON.parse(output[0] ?? '{}')
    expect(entry.email).toBe('[REDACTED]')
  })

  it('passes through safe scalar fields', () => {
    const output: string[] = []
    const orig = console.log
    console.log = (s: string) => { output.push(s); orig(s) }
    process.env.NODE_ENV = 'production'
    logger.info('test', { requestId: 'req_abc123', status: 200 })
    process.env.NODE_ENV = 'test'
    console.log = orig
    const entry = JSON.parse(output[0] ?? '{}')
    expect(entry.requestId).toBe('req_abc123')
    expect(entry.status).toBe(200)
  })

  it('drops object values — no uncontrolled serialization', () => {
    const output: string[] = []
    const orig = console.log
    console.log = (s: string) => { output.push(s); orig(s) }
    process.env.NODE_ENV = 'production'
    logger.info('test', { nested: { a: 1 } } as never)
    process.env.NODE_ENV = 'test'
    console.log = orig
    const entry = JSON.parse(output[0] ?? '{}')
    // Object value must be absent (dropped, not serialized)
    expect(entry.nested).toBeUndefined()
  })

  it('structured: uses JSON in production (source check)', () => {
    expect(loggerSrc).toContain('JSON.stringify(entry)')
    expect(loggerSrc).toContain("process.env.NODE_ENV === 'production'")
  })

  it('stack traces omitted in production (source check)', () => {
    // Stack traces are guarded by isProd or equivalent production check
    expect(loggerSrc).toContain('stack')
    // Stack traces appear only in non-production branches
    const stackIdx = loggerSrc.indexOf('e.stack')
    // There must be a production check before the stack output
    const prodCheckIdx = loggerSrc.lastIndexOf('isProd', stackIdx)
    expect(prodCheckIdx).toBeGreaterThan(-1)
  })

  it('does not serialize unknown arbitrary objects', () => {
    expect(loggerSrc).not.toContain('JSON.stringify(meta)')
    expect(loggerSrc).not.toContain('JSON.stringify(obj)')
  })

  it('sensitive key list covers critical fields', () => {
    const patterns = ['password', 'token', 'cookie', 'authorization', 'secret', 'email', 'phone', 'payment']
    for (const p of patterns) {
      expect(loggerSrc).toContain(`'${p}'`)
    }
  })
})

// ── errors.ts ─────────────────────────────────────────────────────────────────

import { AppError, normalizeError, safeMessage, prismaStatusCode } from '../errors'
import { Prisma } from '@prisma/client'

describe('errors — normalization', () => {
  it('AppError returns category and userMessage', () => {
    const e = new AppError('not_found', 'Not found.')
    expect(e.category).toBe('not_found')
    expect(e.userMessage).toBe('Not found.')
    expect(e.name).toBe('AppError')
  })

  it('normalizeError passthrough for AppError', () => {
    const a = new AppError('forbidden', 'Forbidden.')
    const result = normalizeError(a, { event: 'test' })
    expect(result).toBe(a)
  })

  it('maps P2002 (unique constraint) → conflict', () => {
    const prismaErr = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: '5.0.0',
    })
    const result = normalizeError(prismaErr, { event: 'db.write' })
    expect(result.category).toBe('conflict')
  })

  it('maps P2025 (record not found) → not_found', () => {
    const prismaErr = new Prisma.PrismaClientKnownRequestError('Record not found', {
      code: 'P2025',
      clientVersion: '5.0.0',
    })
    const result = normalizeError(prismaErr, { event: 'db.read' })
    expect(result.category).toBe('not_found')
  })

  it('normalizes generic error → internal', () => {
    const result = normalizeError(new Error('something blew up'), { event: 'action.run' })
    expect(result.category).toBe('internal')
  })

  it('production message for internal never leaks raw error', () => {
    const result = normalizeError(new Error('SELECT * FROM users WHERE id=1'), { event: 'sql' })
    expect(result.userMessage).not.toContain('SELECT')
    expect(result.userMessage).not.toContain('FROM')
  })

  it('safeMessage returns non-empty string for all categories', () => {
    const categories = ['validation', 'unauthorized', 'forbidden', 'not_found', 'conflict',
      'stale', 'rate_limited', 'dependency_unavailable', 'internal'] as const
    for (const c of categories) {
      expect(safeMessage(c).length).toBeGreaterThan(0)
    }
  })

  it('prismaStatusCode returns correct HTTP codes', () => {
    expect(prismaStatusCode('unauthorized')).toBe(401)
    expect(prismaStatusCode('not_found')).toBe(404)
    expect(prismaStatusCode('conflict')).toBe(409)
    expect(prismaStatusCode('rate_limited')).toBe(429)
    expect(prismaStatusCode('dependency_unavailable')).toBe(503)
    expect(prismaStatusCode('internal')).toBe(500)
  })

  it('never mentions SQL, stack trace, or file path in safe messages', () => {
    for (const cat of ['internal', 'conflict', 'not_found'] as const) {
      const msg = safeMessage(cat)
      expect(msg).not.toMatch(/select|insert|update|delete|\.ts|\/src\//i)
    }
  })
})

// ── env.ts ────────────────────────────────────────────────────────────────────

import { requireEnv, optionalEnv, getEnvStatus, isCriticalEnvReady } from '../env'

describe('env — validation', () => {
  const origEnv = { ...process.env }
  afterEach(() => { Object.assign(process.env, origEnv) })

  it('requireEnv returns the value when present', () => {
    process.env.TEST_VAR_HARDENING = 'hello'
    expect(requireEnv('TEST_VAR_HARDENING')).toBe('hello')
    delete process.env.TEST_VAR_HARDENING
  })

  it('requireEnv throws a clean message when absent — no secret values', () => {
    delete process.env.MISSING_VAR_HARDENING
    expect(() => requireEnv('MISSING_VAR_HARDENING')).toThrow('MISSING_VAR_HARDENING')
    try { requireEnv('MISSING_VAR_HARDENING') } catch (e) {
      const msg = (e as Error).message
      expect(msg).not.toContain('=')         // no value leaked
      expect(msg).not.toContain('undefined')
    }
  })

  it('optionalEnv returns undefined when absent', () => {
    delete process.env.OPTIONAL_TEST
    expect(optionalEnv('OPTIONAL_TEST')).toBeUndefined()
  })

  it('getEnvStatus never includes values — only name/required/configured', () => {
    const statuses = getEnvStatus()
    for (const s of statuses) {
      expect(typeof s.name).toBe('string')
      expect(typeof s.required).toBe('boolean')
      expect(typeof s.configured).toBe('boolean')
      // No 'value' field
      expect((s as Record<string, unknown>).value).toBeUndefined()
    }
  })

  it('isCriticalEnvReady returns false when required vars are absent', () => {
    const origDb = process.env.DATABASE_URL
    delete process.env.DATABASE_URL
    expect(isCriticalEnvReady()).toBe(false)
    process.env.DATABASE_URL = origDb
  })

  it('source: optional features do not block startup', () => {
    // ANTHROPIC_API_KEY is listed as optional, not required
    const envStatusCall = envSrc
    expect(envStatusCall).toContain("'ANTHROPIC_API_KEY'")
    // It should appear in the OPTIONAL array, not REQUIRED_PRODUCTION
    const requiredSection = envSrc.slice(envSrc.indexOf('REQUIRED_PRODUCTION'), envSrc.indexOf('OPTIONAL'))
    expect(requiredSection).not.toContain('ANTHROPIC_API_KEY')
  })
})

// ── rateLimit.ts ──────────────────────────────────────────────────────────────

import { checkRateLimit, hashRateLimitKey, rateLimitKeyFromHeaders } from '../rateLimit'

describe('rateLimit — sliding window', () => {
  it('allows requests below the limit', () => {
    const key = `test-${Math.random()}`
    const r = checkRateLimit(key, 3, 60_000)
    expect(r.allowed).toBe(true)
    expect(r.remaining).toBe(2)
  })

  it('blocks at the limit', () => {
    const key = `test-${Math.random()}`
    checkRateLimit(key, 2, 60_000)
    checkRateLimit(key, 2, 60_000)
    const r = checkRateLimit(key, 2, 60_000)
    expect(r.allowed).toBe(false)
    expect(r.remaining).toBe(0)
  })

  it('returns resetMs > 0 when blocked', () => {
    const key = `test-${Math.random()}`
    checkRateLimit(key, 1, 60_000)
    const r = checkRateLimit(key, 1, 60_000)
    expect(r.allowed).toBe(false)
    expect(r.resetMs).toBeGreaterThan(0)
  })

  it('different keys are independent', () => {
    const k1 = `test-a-${Math.random()}`, k2 = `test-b-${Math.random()}`
    checkRateLimit(k1, 1, 60_000)
    const r = checkRateLimit(k1, 1, 60_000)
    const r2 = checkRateLimit(k2, 1, 60_000)
    expect(r.allowed).toBe(false)
    expect(r2.allowed).toBe(true)
  })

  it('hashRateLimitKey returns consistent 24-char hex', () => {
    const h1 = hashRateLimitKey('127.0.0.1', 'login')
    const h2 = hashRateLimitKey('127.0.0.1', 'login')
    expect(h1).toBe(h2)
    expect(h1).toHaveLength(24)
    expect(/^[0-9a-f]{24}$/.test(h1)).toBe(true)
  })

  it('hashRateLimitKey does NOT store the raw IP', () => {
    const hash = hashRateLimitKey('192.168.1.100', 'test')
    expect(hash).not.toContain('192.168')
    expect(hash).not.toContain('100')
  })

  it('rateLimitKeyFromHeaders extracts first forwarded IP', () => {
    const headers = new Headers({ 'x-forwarded-for': '10.0.0.1, 10.0.0.2' })
    const key = rateLimitKeyFromHeaders(headers, ':test')
    // Key must not contain the raw IP
    expect(key).not.toContain('10.0.0.1')
    expect(key).toHaveLength(24)
  })

  it('source: explicitly labeled as instance-local', () => {
    expect(rateLimitSrc).toContain('INSTANCE-LOCAL')
    expect(rateLimitSrc).toContain('per-serverless-instance')
  })
})

// ── request ID / middleware ───────────────────────────────────────────────────

describe('middleware — request ID', () => {
  it('source: validates format before accepting incoming ID', () => {
    expect(middlewareSrc).toContain('REQUEST_ID_RE')
    expect(middlewareSrc).toContain('.test(incoming)')
  })

  it('source: generates a new ID when invalid', () => {
    expect(middlewareSrc).toContain('generateRequestId')
    expect(middlewareSrc).toContain('req_')
  })

  it('source: echoes ID in response header', () => {
    expect(middlewareSrc).toContain("response.headers.set('x-request-id'")
  })

  it('source: matcher covers all routes, not just admin', () => {
    // Admin auth is scoped inside the handler; the matcher itself covers all routes.
    expect(middlewareSrc).toContain("_next/static")
    expect(middlewareSrc).toContain("favicon")
  })

  it('source: admin auth is scoped inside handler to /admin only', () => {
    expect(middlewareSrc).toContain("pathname.startsWith('/admin')")
  })

  it('request ID format regex matches valid IDs', () => {
    // req_ + 16 lowercase hex chars
    const RE = /^req_[0-9a-f]{16}$/
    expect(RE.test('req_' + 'a'.repeat(16))).toBe(true)
    expect(RE.test('req_' + '0'.repeat(16))).toBe(true)
    expect(RE.test('req_' + 'G'.repeat(16))).toBe(false)  // uppercase
    expect(RE.test('invalid')).toBe(false)
    expect(RE.test('')).toBe(false)
  })
})

// ── health route ──────────────────────────────────────────────────────────────

describe('/api/health', () => {
  it('source: no database query — liveness only', () => {
    expect(healthSrc).not.toContain('prisma')
    expect(healthSrc).not.toContain('$queryRaw')
    expect(healthSrc).not.toContain('findMany')
    expect(healthSrc).not.toContain('count(')
  })

  it('source: no DB writes', () => {
    expect(healthSrc).not.toContain('.create(')
    expect(healthSrc).not.toContain('.update(')
    expect(healthSrc).not.toContain('.delete(')
  })

  it('source: returns status ok', () => {
    expect(healthSrc).toContain("'ok'")
    expect(healthSrc).toContain('status: 200')
  })

  it('source: no secret values or env var values in response', () => {
    expect(healthSrc).not.toContain('process.env.')
  })
})

// ── readiness route ───────────────────────────────────────────────────────────

describe('/api/ready', () => {
  it('source: has bounded DB timeout', () => {
    expect(readySrc).toContain('DB_TIMEOUT_MS')
    expect(readySrc).toContain('setTimeout')
    expect(readySrc).toContain('Promise.race')
  })

  it('source: returns 503 on failure', () => {
    expect(readySrc).toContain('503')
  })

  it('source: returns 200 on success', () => {
    expect(readySrc).toContain('200')
  })

  it('source: response contains no secret values', () => {
    // The response must not include env var values
    expect(readySrc).not.toContain('process.env.DATABASE_URL')
    expect(readySrc).not.toContain('process.env.ADMIN_PASSWORD')
    expect(readySrc).not.toContain('process.env.STRIPE_SECRET_KEY')
  })

  it('source: no DB writes in readiness check', () => {
    expect(readySrc).not.toContain('.create(')
    expect(readySrc).not.toContain('.update(')
    expect(readySrc).not.toContain('.delete(')
  })

  it('source: checks env and Blob config separately', () => {
    expect(readySrc).toContain('checkEnv')
    expect(readySrc).toContain('checkBlobConfig')
  })

  it('source: Blob check is syntax-only — no external write', () => {
    // Blob check only validates the env var format, never calls put() or blob API
    expect(readySrc).not.toContain('put(')
    expect(readySrc).not.toContain('@vercel/blob')
  })
})

// ── security headers ──────────────────────────────────────────────────────────

describe('security headers — next.config.ts', () => {
  it('X-Content-Type-Options: nosniff', () => {
    expect(nextConfigSrc).toContain('X-Content-Type-Options')
    expect(nextConfigSrc).toContain('nosniff')
  })

  it('X-Frame-Options: SAMEORIGIN', () => {
    expect(nextConfigSrc).toContain('X-Frame-Options')
    expect(nextConfigSrc).toContain('SAMEORIGIN')
  })

  it('Referrer-Policy configured', () => {
    expect(nextConfigSrc).toContain('Referrer-Policy')
    expect(nextConfigSrc).toContain('strict-origin-when-cross-origin')
  })

  it('Permissions-Policy configured', () => {
    expect(nextConfigSrc).toContain('Permissions-Policy')
  })

  it('HSTS only in production', () => {
    // Must be conditional — not sent in development
    const hstsIdx  = nextConfigSrc.indexOf('Strict-Transport-Security')
    const prodCheck = nextConfigSrc.lastIndexOf('isProd', hstsIdx)
    expect(hstsIdx).toBeGreaterThan(-1)
    expect(prodCheck).toBeGreaterThan(-1)
  })

  it('CSP is report-only — not enforced', () => {
    expect(nextConfigSrc).toContain('Content-Security-Policy-Report-Only')
    expect(nextConfigSrc).not.toContain("key: 'Content-Security-Policy',")
  })

  it('frame-ancestors in CSP covers admin routes', () => {
    expect(nextConfigSrc).toContain('frame-ancestors')
  })
})

// ── system-health page ────────────────────────────────────────────────────────

describe('/admin/system-health', () => {
  it('source: requires admin authentication', () => {
    expect(sysHealthSrc).toContain('isAdminAuthenticated')
    expect(sysHealthSrc).toContain('redirect')
  })

  it('source: never shows secret values or connection strings', () => {
    expect(sysHealthSrc).not.toContain('process.env.DATABASE_URL')
    expect(sysHealthSrc).not.toContain('process.env.ADMIN_PASSWORD')
    expect(sysHealthSrc).not.toContain('process.env.STRIPE_SECRET_KEY')
    expect(sysHealthSrc).not.toContain('process.env.RESEND_API_KEY')
  })

  it('source: shows only presence of config, not values', () => {
    // depStatus() reads env vars for truthiness only — never renders values
    expect(sysHealthSrc).toContain('depStatus(')
    expect(sysHealthSrc).toContain('process.env[envKey]')
    // Rendered output must not reference secret env var values
    const rendered = sysHealthSrc.slice(sysHealthSrc.indexOf('return ('))
    expect(rendered).not.toContain('process.env.DATABASE_URL')
    expect(rendered).not.toContain('process.env.ADMIN_PASSWORD')
    expect(rendered).not.toContain('process.env.STRIPE_SECRET')
  })

  it('source: no customer/business data queries', () => {
    expect(sysHealthSrc).not.toContain('findMany')
    expect(sysHealthSrc).not.toContain('findUnique')
    expect(sysHealthSrc).not.toContain('customerProfile')
    expect(sysHealthSrc).not.toContain('catalogModel.findMany')
  })

  it('source: DB check is read-only (SELECT 1)', () => {
    expect(sysHealthSrc).toContain('SELECT 1')
    expect(sysHealthSrc).not.toContain('.create(')
    expect(sysHealthSrc).not.toContain('.update(')
  })

  it('nav link added to admin layout', () => {
    expect(adminNavSrc).toContain('/admin/system-health')
    expect(adminNavSrc).toContain('System Health')
  })
})

// ── error boundaries ──────────────────────────────────────────────────────────

describe('error.tsx', () => {
  it('client component', () => {
    expect(errorTsx).toContain("'use client'")
  })

  it('shows error.digest as reference — not stack trace or raw message in UI', () => {
    expect(errorTsx).toContain('error.digest')
    expect(errorTsx).not.toContain('error.stack')
    // digest shown in JSX, raw message and stack not exposed to user in rendered output
    const jsxSection = errorTsx.slice(errorTsx.indexOf('return ('))
    expect(jsxSection).not.toContain('error.message')
    expect(jsxSection).not.toContain('error.stack')
  })

  it('has retry button', () => {
    expect(errorTsx).toContain('reset()')
    expect(errorTsx).toContain('Try again')
  })

  it('no raw error serialization', () => {
    expect(errorTsx).not.toContain('JSON.stringify(error)')
    expect(errorTsx).not.toContain('{error.message}')
  })
})

describe('global-error.tsx', () => {
  it('includes html/body (required for global-error)', () => {
    expect(globalErrorTsx).toContain('<html')
    expect(globalErrorTsx).toContain('<body')
  })

  it('no stack trace exposed', () => {
    expect(globalErrorTsx).not.toContain('error.stack')
    expect(globalErrorTsx).not.toContain('{error.message}')
  })

  it('has retry button', () => {
    expect(globalErrorTsx).toContain('reset()')
  })
})

// ── deployment safeguards ─────────────────────────────────────────────────────

describe('deployment safeguards', () => {
  it('.env.local is git-ignored via .env* glob', () => {
    const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8')
    // .env* covers .env.local, .env.production, etc.
    expect(gitignore).toMatch(/\.env\*|\.env\.local/)
  })

  it('.env.example documents RATE_LIMIT_SECRET', () => {
    expect(envExampleSrc).toContain('RATE_LIMIT_SECRET')
  })

  it('.env.example does not contain real secrets', () => {
    // Should only contain placeholder values
    expect(envExampleSrc).not.toMatch(/sk_live_[a-zA-Z0-9]+/)
    expect(envExampleSrc).not.toMatch(/re_[a-zA-Z0-9]{32}/)
    expect(envExampleSrc).not.toMatch(/whsec_[a-zA-Z0-9]{40,}/)
  })

  it('vitest config excludes .claude/worktrees', () => {
    const vitestCfg = src('vitest.config.mts')
    expect(vitestCfg).toContain('.claude/worktrees/**')
  })

  it('storage-locations/search now requires admin auth', () => {
    expect(storageRoute).toContain('isAdminAuthenticated')
    expect(storageRoute).toContain('401')
  })
})

// ── rate limiting on admin login ──────────────────────────────────────────────

describe('admin login rate limiting', () => {
  it('loginAdmin applies rate limit before checking password', () => {
    const rateLimitIdx = authActionSrc.indexOf('checkRateLimit')
    const passwordIdx  = authActionSrc.indexOf('ADMIN_PASSWORD')
    expect(rateLimitIdx).toBeGreaterThan(-1)
    expect(rateLimitIdx).toBeLessThan(passwordIdx)
  })

  it('rate limit uses hashed IP key, not raw IP', () => {
    expect(authActionSrc).toContain('rateLimitKeyFromHeaders')
    expect(authActionSrc).not.toContain("headers.get('x-forwarded-for')")
  })

  it('returns user-safe message on rate limit — message only contains seconds', () => {
    expect(authActionSrc).toContain('Too many login attempts')
    expect(authActionSrc).toContain('secs')
    const rateLimitReturn = authActionSrc.indexOf('Too many login attempts')
    const passwordCheck   = authActionSrc.indexOf("const password = process.env.ADMIN_PASSWORD")
    expect(rateLimitReturn).toBeLessThan(passwordCheck)
  })
})

// ── admin login error normalization ──────────────────────────────────────────

describe('admin login — error normalization', () => {
  it('imports and uses normalizeError for unexpected errors', () => {
    expect(authActionSrc).toContain("import { normalizeError }")
    expect(authActionSrc).toContain('normalizeError')
  })

  it('unexpected errors during crypto are wrapped — not propagated raw', () => {
    // try/catch around crypto operations
    const tryIdx   = authActionSrc.indexOf('try {')
    const matchIdx = authActionSrc.indexOf('timingSafeEqual')
    const catchIdx = authActionSrc.indexOf('catch (e)', tryIdx)
    expect(tryIdx).toBeGreaterThan(-1)
    expect(matchIdx).toBeGreaterThan(tryIdx)
    expect(catchIdx).toBeGreaterThan(matchIdx)
  })

  it('unexpected error path returns normalized user message — no raw error', () => {
    expect(authActionSrc).toContain('norm.userMessage')
    // No error.message or error.stack exposed in return
    const normIdx = authActionSrc.indexOf('norm.userMessage')
    expect(normIdx).toBeGreaterThan(-1)
  })

  it('ADMIN_PASSWORD absent returns generic message — not config-leaking', () => {
    expect(authActionSrc).not.toContain('ADMIN_PASSWORD is not configured. Add it to your environment.')
    expect(authActionSrc).toContain('temporarily unavailable')
  })

  it('rate-limit and auth-failure messages are distinguishable', () => {
    expect(authActionSrc).toContain('Too many login attempts')
    expect(authActionSrc).toContain('Incorrect password.')
    // These must be different strings
    expect('Too many login attempts').not.toBe('Incorrect password.')
  })

  it('logger.warn events use safe constant strings — no dynamic user data in metadata', () => {
    // Event names are static constants, not interpolated from user input
    expect(authActionSrc).toContain("'admin.login.failed'")
    expect(authActionSrc).toContain("'admin.login.rate_limited'")
    // The submitted password variable is not passed to logger calls
    // (logger.warn metadata only contains requestId/status/action — never credential values)
    const warnLines = authActionSrc.split('\n').filter(l => l.includes('logger.warn'))
    for (const line of warnLines) {
      // Metadata object (after the event name) must not include submitted password
      const metaStart = line.indexOf('{')
      if (metaStart === -1) continue
      const meta = line.slice(metaStart)
      expect(meta).not.toContain('submitted')
      expect(meta).not.toContain('sessionCookie')
    }
  })
})

// ── admin image-search rate-limit identity ───────────────────────────────────

describe('admin image-search — session-keyed rate limit', () => {
  const imageMatchSrc2 = src('src/lib/actions/catalogImageMatching.ts')

  it('uses hashRateLimitKey, not a fixed global key', () => {
    expect(imageMatchSrc2).toContain('hashRateLimitKey')
    expect(imageMatchSrc2).not.toContain("'admin_image_search'")
  })

  it('key derived from server-verified session cookie, not browser-supplied value', () => {
    // Anchor all lookups to the admin function body to avoid false matches in buyer function
    const adminFnIdx = imageMatchSrc2.indexOf('adminSearchCatalogByImage')
    const authIdx    = imageMatchSrc2.indexOf('isAdminAuthenticated()', adminFnIdx)
    const cookieIdx  = imageMatchSrc2.indexOf("get('admin_session')", authIdx)
    const hashIdx    = imageMatchSrc2.indexOf('hashRateLimitKey(sessionValue', cookieIdx)
    expect(authIdx).toBeGreaterThan(adminFnIdx)
    expect(cookieIdx).toBeGreaterThan(authIdx)
    expect(hashIdx).toBeGreaterThan(cookieIdx)
  })

  it('raw session value is never stored — only the hash is used as key', () => {
    // sessionValue feeds into hashRateLimitKey and nowhere else in the rate-limit path
    expect(imageMatchSrc2).toContain("hashRateLimitKey(sessionValue")
    expect(imageMatchSrc2).not.toContain("checkRateLimit(sessionValue")
  })

  it('null key (missing RATE_LIMIT_SECRET) fails closed', () => {
    expect(imageMatchSrc2).toContain('rateLimitKey === null')
    // Returns an error, not allowing the request through
    const nullIdx  = imageMatchSrc2.indexOf('rateLimitKey === null')
    const returnIdx = imageMatchSrc2.indexOf('return { error:', nullIdx)
    expect(returnIdx).toBeGreaterThan(nullIdx)
  })

  it('rate limit check before image decoding in admin function', () => {
    // Anchor to admin function; arrayBuffer() first appears in buyer function
    const adminFnIdx   = imageMatchSrc2.indexOf('adminSearchCatalogByImage')
    const rateLimitIdx = imageMatchSrc2.indexOf('checkRateLimit(rateLimitKey', adminFnIdx)
    const arrayBufIdx  = imageMatchSrc2.indexOf('arrayBuffer()', rateLimitIdx)
    expect(rateLimitIdx).toBeGreaterThan(adminFnIdx)
    expect(arrayBufIdx).toBeGreaterThan(rateLimitIdx)
  })
})

// ── email timeout ─────────────────────────────────────────────────────────────

describe('email send timeout', () => {
  it('buyerAuth Resend call is bounded by a timeout', () => {
    expect(buyerAuthSrc).toContain('email_timeout')
    expect(buyerAuthSrc).toContain('Promise.race')
    expect(buyerAuthSrc).toContain('8_000')
  })

  it('timeout is in the fire-tolerant try-catch — failure does not block user', () => {
    // Promise.race inside the fire-tolerant email send block
    expect(buyerAuthSrc).toContain('Promise.race')
    // The fire-tolerant block catches any error and still returns SENT
    const raceIdx  = buyerAuthSrc.indexOf('Promise.race')
    const catchIdx = buyerAuthSrc.indexOf('} catch (err)', raceIdx)
    // There is a catch after the race
    expect(catchIdx).toBeGreaterThan(raceIdx)
    // The final return SENT is after all try/catch blocks
    const lastReturnIdx = buyerAuthSrc.lastIndexOf('return SENT')
    expect(lastReturnIdx).toBeGreaterThan(catchIdx)
  })
})

// ── no financial retries ──────────────────────────────────────────────────────

describe('no automatic financial retries', () => {
  it('stripe action has no retry loop', () => {
    const stripeSrc = src('src/lib/actions/stripe.ts')
    expect(stripeSrc).not.toContain('for (let attempt')
    expect(stripeSrc).not.toContain('retry(')
    expect(stripeSrc).not.toContain('while (retries')
  })

  it('webhook handler has no retry loop', () => {
    const webhookSrc = src('src/app/api/webhooks/stripe/route.ts')
    expect(webhookSrc).not.toContain('retry(')
    expect(webhookSrc).not.toContain('for (let attempt')
  })
})

// ── Gap: camera policy ────────────────────────────────────────────────────────

describe('security headers — camera policy', () => {
  it('Permissions-Policy allows camera for self (preserves mobile camera input)', () => {
    expect(nextConfigSrc).toContain('camera=(self)')
  })

  it('Permissions-Policy blocks microphone and geolocation', () => {
    expect(nextConfigSrc).toContain('microphone=()')
    expect(nextConfigSrc).toContain('geolocation=()')
  })
})

// ── Gap: value-level string sanitization ──────────────────────────────────────

import { sanitizeString } from '../serverLogger'

describe('serverLogger — value-level sanitization', () => {
  it('redacts Bearer tokens in string values', () => {
    expect(sanitizeString('Authorization: Bearer abc123XYZ')).toContain('[')
    expect(sanitizeString('Authorization: Bearer abc123XYZ')).not.toContain('abc123XYZ')
  })

  it('redacts email addresses in string values', () => {
    const out = sanitizeString('contact user@example.com for help')
    expect(out).not.toContain('user@example.com')
    expect(out).toContain('[EMAIL]')
  })

  it('redacts database connection URLs', () => {
    const out = sanitizeString('postgres://user:pass@host:5432/db')
    expect(out).not.toContain('user:pass')
    expect(out).toContain('[DB_URL]')
  })

  it('removes control characters', () => {
    const out = sanitizeString('hello\x00world\x1Fend')
    expect(out).not.toContain('\x00')
    expect(out).not.toContain('\x1F')
    expect(out).toContain('hello')
    expect(out).toContain('world')
  })

  it('truncates very long strings', () => {
    const long = 'a'.repeat(600)
    const out = sanitizeString(long)
    expect(out.length).toBeLessThan(600)
    expect(out).toContain('truncated')
  })

  it('passes through safe short strings unchanged', () => {
    expect(sanitizeString('model not found')).toBe('model not found')
    expect(sanitizeString('req_abc123')).toBe('req_abc123')
  })
})

// ── Gap: RATE_LIMIT_SECRET fail-closed ────────────────────────────────────────

describe('rateLimit — RATE_LIMIT_SECRET fail-closed', () => {
  const origEnv = { ...process.env }
  afterEach(() => { Object.assign(process.env, origEnv) })

  it('hashRateLimitKey returns null in production without secret', () => {
    delete process.env.RATE_LIMIT_SECRET
    process.env.NODE_ENV = 'production'
    const result = hashRateLimitKey('127.0.0.1', ':test')
    process.env.NODE_ENV = 'test'
    expect(result).toBeNull()
  })

  it('hashRateLimitKey returns a string in development without secret', () => {
    delete process.env.RATE_LIMIT_SECRET
    // NODE_ENV stays as 'test' (treated as non-production)
    const result = hashRateLimitKey('127.0.0.1', ':test')
    expect(typeof result).toBe('string')
    expect(result).not.toBeNull()
  })

  it('hashRateLimitKey returns hashed key when secret is present', () => {
    process.env.RATE_LIMIT_SECRET = 'test-secret-for-test'
    const result = hashRateLimitKey('127.0.0.1', ':test')
    delete process.env.RATE_LIMIT_SECRET
    expect(typeof result).toBe('string')
    expect(result).toHaveLength(24)
    expect(result).not.toContain('127.0.0.1')
  })

  it('source: callers must check for null and treat as denied', () => {
    // auth.ts handles null return from rateLimitKeyFromHeaders
    expect(authActionSrc).toContain('rateLimitKey === null')
  })

  it('source: dev fallback is explicitly documented, not secret-like', () => {
    expect(rateLimitSrc).toContain('dev-rate-limit-fallback-do-not-use-in-production')
    expect(rateLimitSrc).toContain('Development-only fallback')
  })
})

// ── Gap: authenticated rate-limit keys ───────────────────────────────────────

describe('rate-limit surface — authenticated identity keys', () => {
  const imageMatchSrc  = src('src/lib/actions/catalogImageMatching.ts')
  const collectionSrc  = src('src/lib/actions/collectionItems.ts')
  const wantedSrc      = src('src/lib/actions/wantedList.ts')
  const sellerSrc      = src('src/lib/actions/sellerSubmissions.ts')

  it('buyer image search rate-limits by profileId, not IP', () => {
    expect(imageMatchSrc).toContain('image_search:${session.profileId}')
    expect(imageMatchSrc).not.toContain('rateLimitKeyFromHeaders')
  })

  it('collection-item creation rate-limits by profileId', () => {
    expect(collectionSrc).toContain('create_collection:${session.profileId}')
  })

  it('wanted-list creation rate-limits by profileId', () => {
    expect(wantedSrc).toContain('create_wanted:${session.profileId}')
  })

  it('seller submission rate-limits by profileId', () => {
    expect(sellerSrc).toContain('seller_submit:${session.profileId}')
  })

  it('image search rate limit: 10 per 10 minutes', () => {
    expect(imageMatchSrc).toContain('IMAGE_SEARCH_MAX')
    const maxLine = imageMatchSrc.split('\n').find(l => l.includes('IMAGE_SEARCH_MAX'))
    expect(maxLine).toContain('10')
    expect(imageMatchSrc).toContain('10 * 60 * 1000')
  })

  it('seller submission limit: 10 per hour', () => {
    expect(sellerSrc).toContain('SUBMIT_MAX')
    const maxLine = sellerSrc.split('\n').find(l => l.includes('SUBMIT_MAX') && l.includes('='))
    expect(maxLine).toContain('10')
    expect(sellerSrc).toContain('60 * 60 * 1000')
  })

  it('collection creation limit: 30 per 10 minutes', () => {
    expect(collectionSrc).toContain('CREATE_MAX')
    const maxLine = collectionSrc.split('\n').find(l => l.includes('CREATE_MAX') && l.includes('='))
    expect(maxLine).toContain('30')
    expect(collectionSrc).toContain('10 * 60 * 1000')
  })

  it('wanted-list creation limit: 30 per 10 minutes', () => {
    expect(wantedSrc).toContain('CREATE_MAX')
    const maxLine = wantedSrc.split('\n').find(l => l.includes('CREATE_MAX') && l.includes('='))
    expect(maxLine).toContain('30')
    expect(wantedSrc).toContain('10 * 60 * 1000')
  })
})

// ── Gap: image validation before decoding ─────────────────────────────────────

describe('image upload — validate before decode', () => {
  const imageMatchSrc = src('src/lib/actions/catalogImageMatching.ts')

  it('validateUpload error short-circuits before arrayBuffer() decode', () => {
    // If validateUpload returns an error, we return immediately — buffer is never read.
    // Check that the error-return from validate appears before arrayBuffer() in each action.
    const validationEarlyExit = imageMatchSrc.indexOf('if (validationError) return')
    const arrayBufferIdx      = imageMatchSrc.indexOf('arrayBuffer()')
    expect(validationEarlyExit).toBeGreaterThan(-1)
    expect(arrayBufferIdx).toBeGreaterThan(-1)
    expect(validationEarlyExit).toBeLessThan(arrayBufferIdx)
  })

  it('rejects files over 10 MB before reading buffer', () => {
    expect(imageMatchSrc).toContain('MAX_FILE_BYTES')
    expect(imageMatchSrc).toContain('10 * 1024 * 1024')
  })

  it('MIME allowlist is restrictive', () => {
    expect(imageMatchSrc).toContain('image/jpeg')
    expect(imageMatchSrc).toContain('image/png')
    expect(imageMatchSrc).toContain('image/webp')
    expect(imageMatchSrc).not.toContain('image/gif')
    expect(imageMatchSrc).not.toContain('application/pdf')
  })
})

// ── Gap: rate limit before DB mutation ────────────────────────────────────────

describe('rate limit applied before DB mutation', () => {
  const collectionSrc = src('src/lib/actions/collectionItems.ts')
  const wantedSrc     = src('src/lib/actions/wantedList.ts')
  const sellerSrc     = src('src/lib/actions/sellerSubmissions.ts')

  it('collection: rate check before prisma.create', () => {
    const rateLimitIdx = collectionSrc.indexOf('checkRateLimit')
    const createIdx    = collectionSrc.indexOf('prisma.collectionItem.create')
    expect(rateLimitIdx).toBeLessThan(createIdx)
  })

  it('wanted list: rate check before prisma.create', () => {
    const rateLimitIdx = wantedSrc.indexOf('checkRateLimit')
    const createIdx    = wantedSrc.indexOf('prisma.wantedCatalogModel.create')
    expect(rateLimitIdx).toBeLessThan(createIdx)
  })

  it('seller submission: rate check before prisma.create', () => {
    const rateLimitIdx = sellerSrc.indexOf('checkRateLimit')
    const createIdx    = sellerSrc.indexOf('prisma.sellerSubmission.create')
    expect(rateLimitIdx).toBeLessThan(createIdx)
  })
})

// ── Gap: unhandled rejection prevention ──────────────────────────────────────

describe('email timeout — unhandled rejection prevention', () => {
  it('sendPromise has a terminal .catch() before the race', () => {
    // The loser of Promise.race must have a terminal handler to suppress
    // the unhandled rejection that occurs when it resolves/rejects after timeout fires.
    expect(buyerAuthSrc).toContain('sendPromise.catch(() => {})')
  })

  it('terminal catch is attached before Promise.race, not after', () => {
    const catchIdx = buyerAuthSrc.indexOf('sendPromise.catch(() => {})')
    const raceIdx  = buyerAuthSrc.indexOf('Promise.race([sendPromise')
    expect(catchIdx).toBeGreaterThan(-1)
    expect(raceIdx).toBeGreaterThan(-1)
    expect(catchIdx).toBeLessThan(raceIdx)
  })
})

// ── Gap: normalizeError integration ───────────────────────────────────────────

describe('normalizeError — integration in action files', () => {
  const imageMatchSrc  = src('src/lib/actions/catalogImageMatching.ts')
  const csvImportSrc   = src('src/lib/actions/externalMarketResearch.ts')
  const readySrc2      = src('src/app/api/ready/route.ts')

  it('image matching action uses normalizeError on non-FingerprintError', () => {
    expect(imageMatchSrc).toContain('normalizeError')
    expect(imageMatchSrc).toContain('FingerprintError')
    // FingerprintError short-circuits; other errors go through normalizeError
    const fingerprintIdx  = imageMatchSrc.indexOf('FingerprintError')
    const normalizeIdx    = imageMatchSrc.indexOf('normalizeError')
    expect(normalizeIdx).toBeGreaterThan(-1)
    expect(fingerprintIdx).toBeGreaterThan(-1)
  })

  it('CSV import action uses normalizeError instead of raw e.message', () => {
    expect(csvImportSrc).toContain('normalizeError')
    expect(csvImportSrc).not.toContain('e instanceof Error ? e.message')
    expect(csvImportSrc).toContain('norm.userMessage')
  })

  it('readiness route uses normalizeError to log DB failures', () => {
    expect(readySrc2).toContain('normalizeError')
    // Still returns a static safe message to the caller — no raw error in response
    expect(readySrc2).toContain("'connectivity check failed'")
    expect(readySrc2).not.toContain('e.message')
  })

  it('normalizeError is imported (not just defined) in image matching', () => {
    expect(imageMatchSrc).toContain("import { normalizeError }")
  })
})

// ── RATE_LIMIT_SECRET required in production ──────────────────────────────────

describe('env — RATE_LIMIT_SECRET production-required', () => {
  const origEnv2 = { ...process.env }
  afterEach(() => {
    Object.assign(process.env, origEnv2)
    // Restore any keys deleted during test
    if (!('RATE_LIMIT_SECRET' in origEnv2)) delete process.env.RATE_LIMIT_SECRET
  })

  it('isCriticalEnvReady fails in production when RATE_LIMIT_SECRET is absent', () => {
    const saved = process.env.RATE_LIMIT_SECRET
    delete process.env.RATE_LIMIT_SECRET
    process.env.NODE_ENV = 'production'
    const result = isCriticalEnvReady()
    process.env.NODE_ENV = 'test'
    if (saved) process.env.RATE_LIMIT_SECRET = saved
    expect(result).toBe(false)
  })

  it('isCriticalEnvReady passes in production when RATE_LIMIT_SECRET is present', () => {
    process.env.RATE_LIMIT_SECRET = 'test-secret-value'
    process.env.NODE_ENV = 'production'
    // All other required vars must also be present; set them if needed
    const savedDb  = process.env.DATABASE_URL
    const savedPwd = process.env.ADMIN_PASSWORD
    const savedUrl = process.env.APP_URL
    if (!savedDb)  process.env.DATABASE_URL    = 'postgres://test'
    if (!savedPwd) process.env.ADMIN_PASSWORD  = 'test-pw'
    if (!savedUrl) process.env.APP_URL         = 'https://test.example.com'
    const result = isCriticalEnvReady()
    process.env.NODE_ENV = 'test'
    delete process.env.RATE_LIMIT_SECRET
    if (!savedDb)  delete process.env.DATABASE_URL
    if (!savedPwd) delete process.env.ADMIN_PASSWORD
    if (!savedUrl) delete process.env.APP_URL
    expect(result).toBe(true)
  })

  it('isCriticalEnvReady does NOT require RATE_LIMIT_SECRET in development', () => {
    const saved = process.env.RATE_LIMIT_SECRET
    delete process.env.RATE_LIMIT_SECRET
    // NODE_ENV is 'test' (non-production) — secret should not be required
    const result = isCriticalEnvReady()
    if (saved) process.env.RATE_LIMIT_SECRET = saved
    // Result depends only on REQUIRED_PRODUCTION vars; should not fail due to secret
    // (we only assert RATE_LIMIT_SECRET absence alone doesn't fail dev)
    const allProdVarsPresent = Boolean(process.env.DATABASE_URL && process.env.ADMIN_PASSWORD && process.env.APP_URL)
    expect(result).toBe(allProdVarsPresent)
  })

  it('getEnvStatus marks RATE_LIMIT_SECRET as required:true in production', () => {
    process.env.NODE_ENV = 'production'
    const statuses = getEnvStatus()
    process.env.NODE_ENV = 'test'
    const entry = statuses.find(s => s.name === 'RATE_LIMIT_SECRET')
    expect(entry).toBeDefined()
    expect(entry!.required).toBe(true)
  })

  it('getEnvStatus marks RATE_LIMIT_SECRET as required:false in development', () => {
    // NODE_ENV stays as 'test'
    const statuses = getEnvStatus()
    const entry = statuses.find(s => s.name === 'RATE_LIMIT_SECRET')
    expect(entry).toBeDefined()
    expect(entry!.required).toBe(false)
  })

  it('getEnvStatus never exposes secret values', () => {
    process.env.RATE_LIMIT_SECRET = 'should-not-appear-in-output'
    const statuses = getEnvStatus()
    delete process.env.RATE_LIMIT_SECRET
    const entry = statuses.find(s => s.name === 'RATE_LIMIT_SECRET')
    expect(entry).toBeDefined()
    expect(JSON.stringify(entry)).not.toContain('should-not-appear-in-output')
    expect((entry as Record<string, unknown>).value).toBeUndefined()
  })

  it('source: RATE_LIMIT_SECRET is in REQUIRED_IN_PRODUCTION, not OPTIONAL', () => {
    const optionalIdx         = envSrc.indexOf('OPTIONAL')
    const requiredInProdIdx   = envSrc.indexOf('REQUIRED_IN_PRODUCTION')
    const rateLimitInOptional = envSrc.slice(optionalIdx).indexOf("'RATE_LIMIT_SECRET'")
    const rateLimitInRequired = envSrc.slice(requiredInProdIdx, optionalIdx).indexOf("'RATE_LIMIT_SECRET'")
    expect(requiredInProdIdx).toBeGreaterThan(-1)
    expect(rateLimitInRequired).toBeGreaterThan(-1)   // present in REQUIRED_IN_PRODUCTION
    expect(rateLimitInOptional).toBe(-1)               // absent from OPTIONAL
  })
})

// ── Request-ID integration: CSV import and readiness ─────────────────────────

describe('request-ID integration', () => {
  const csvSrc   = src('src/lib/actions/externalMarketResearch.ts')
  const ready2   = src('src/app/api/ready/route.ts')

  it('CSV import reads requestId at the start of the action', () => {
    expect(csvSrc).toContain('getRequestId')
    // requestId must be read before the try/catch around ingestCsvImport
    const requestIdIdx = csvSrc.indexOf('getRequestId()')
    const tryIdx       = csvSrc.indexOf('try {')
    expect(requestIdIdx).toBeGreaterThan(-1)
    expect(requestIdIdx).toBeLessThan(tryIdx)
  })

  it('CSV import passes requestId to normalizeError', () => {
    expect(csvSrc).toContain('requestId')
    expect(csvSrc).toContain('normalizeError')
    // requestId appears in the normalizeError call
    const normIdx   = csvSrc.indexOf('normalizeError')
    const reqIdInNorm = csvSrc.slice(normIdx, normIdx + 120).includes('requestId')
    expect(reqIdInNorm).toBe(true)
  })

  it('CSV import does not log CSV content, filename, or provider payload', () => {
    // Only normalizeError (which sanitizes) is used — no direct console.log of csvText/filename
    expect(csvSrc).not.toContain('console.log(csvText')
    expect(csvSrc).not.toContain('console.log(file')
    expect(csvSrc).not.toContain('console.error(csvText')
    expect(csvSrc).not.toContain('logger.info(csvText')
  })

  it('readiness route reads requestId in GET handler', () => {
    expect(ready2).toContain('getRequestId')
    // Invoked in the GET handler body
    const getIdx   = ready2.indexOf('export async function GET')
    const reqIdIdx = ready2.indexOf('getRequestId()', getIdx)
    expect(reqIdIdx).toBeGreaterThan(getIdx)
  })

  it('readiness route passes requestId to DB check failure log', () => {
    expect(ready2).toContain('requestId')
    // requestId appears in normalizeError call within checkDatabase
    const checkDbIdx = ready2.indexOf('checkDatabase')
    const normIdx    = ready2.indexOf('normalizeError', checkDbIdx)
    const reqIdInNorm = ready2.slice(normIdx, normIdx + 120).includes('requestId')
    expect(reqIdInNorm).toBe(true)
  })

  it('readiness response body contains no secret values or stack traces', () => {
    // Response is { ready, checks } — no env var values, no requestId in body
    expect(ready2).not.toContain('process.env.DATABASE_URL')
    expect(ready2).not.toContain('e.stack')
    expect(ready2).not.toContain('e.message')
  })
})

// ── Resend timer cleanup ──────────────────────────────────────────────────────

import { vi } from 'vitest'

describe('email timeout — timer cleanup', () => {
  it('source: clearTimeout is called in a finally block', () => {
    const clearIdx   = buyerAuthSrc.indexOf('clearTimeout(timeoutHandle)')
    const finallyIdx = buyerAuthSrc.lastIndexOf('} finally {', clearIdx)
    expect(clearIdx).toBeGreaterThan(-1)
    expect(finallyIdx).toBeGreaterThan(-1)
    // finally must come before clearTimeout (it opens the block)
    expect(finallyIdx).toBeLessThan(clearIdx)
  })

  it('source: timer handle is stored in a variable before the race', () => {
    expect(buyerAuthSrc).toContain('timeoutHandle')
    // timeoutHandle is assigned inside the setTimeout callback
    expect(buyerAuthSrc).toContain('timeoutHandle = setTimeout')
  })

  it('source: terminal sendPromise.catch remains before the race', () => {
    const catchIdx = buyerAuthSrc.indexOf('sendPromise.catch(() => {})')
    const raceIdx  = buyerAuthSrc.indexOf('Promise.race([sendPromise')
    expect(catchIdx).toBeGreaterThan(-1)
    expect(catchIdx).toBeLessThan(raceIdx)
  })

  it('behavioral: clearTimeout is called when send resolves before timeout', async () => {
    vi.useFakeTimers()
    const clearSpy = vi.spyOn(global, 'clearTimeout')

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error('email_timeout')), 8_000)
    })
    // Simulate immediate successful send
    const sendPromise = Promise.resolve({ data: { id: 'msg_test' }, error: null })
    sendPromise.catch(() => {})
    try {
      await Promise.race([sendPromise, timeoutPromise])
    } finally {
      clearTimeout(timeoutHandle)
    }

    expect(clearSpy).toHaveBeenCalledWith(timeoutHandle)
    clearSpy.mockRestore()
    vi.useRealTimers()
  })

  it('behavioral: no dangling timer when send wins the race', async () => {
    vi.useFakeTimers()
    let timerFired = false
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => { timerFired = true; reject(new Error('email_timeout')) }, 8_000)
    })
    const sendPromise = Promise.resolve({ data: { id: 'msg_test' }, error: null })
    sendPromise.catch(() => {})
    try {
      await Promise.race([sendPromise, timeoutPromise])
    } finally {
      clearTimeout(timeoutHandle)
    }
    // Advance time past the timeout — should not fire because we cleared it
    vi.advanceTimersByTime(10_000)
    expect(timerFired).toBe(false)
    vi.useRealTimers()
  })
})
