/**
 * Structured server logger.
 * - JSON output in production, human-readable in development.
 * - Key-name redaction AND value-level string sanitization.
 * - Only scalar metadata admitted — arbitrary objects/records silently dropped.
 * - Stack traces and extra detail only in development.
 */

type LogLevel = 'info' | 'warn' | 'error'

export interface LogMeta {
  requestId?:  string
  route?:      string
  action?:     string
  durationMs?: number
  status?:     number
  [key: string]: string | number | boolean | null | undefined
}

interface LogEntry {
  timestamp:  string
  level:      LogLevel
  event:      string
  error?:     { name: string; message: string; code?: string; stack?: string }
  [key: string]: unknown
}

// ── Key-name redaction ────────────────────────────────────────────────────────

const SENSITIVE_KEY_PATTERNS = [
  'password', 'token', 'cookie', 'authorization', 'auth',
  'session', 'secret', 'apikey', 'api_key', 'key',
  'email', 'phone', 'address', 'ssn', 'payment',
  'card', 'cvv', 'hash', 'credential',
]

function isSensitiveKey(key: string): boolean {
  const norm = key.toLowerCase().replace(/[_\-]/g, '')
  return SENSITIVE_KEY_PATTERNS.some(p => norm.includes(p))
}

// ── Value-level string sanitization ──────────────────────────────────────────

const MAX_STRING_LENGTH = 500

// Patterns that indicate a string value contains credentials or PII.
const VALUE_PATTERNS: [RegExp, string][] = [
  [/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,                '[BEARER_TOKEN]'],
  [/\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g, '[EMAIL]'],
  // session/token/cookie assignments: key=value, key: value
  [/(?:session|token|auth|cookie|secret|key|api[_-]?key)\s*[:=]\s*\S+/gi, '[CREDENTIAL]'],
  // Database connection strings
  [/(?:postgres|mysql|mongodb|redis):\/\/[^\s"']+/gi,  '[DB_URL]'],
  // Authorization header values
  [/(?:Authorization|Bearer|Basic|Digest):\s*\S+/gi,   '[AUTH_HEADER]'],
  // Simple phone numbers (E.164-ish)
  [/\+?1?\s*\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4}\b/g, '[PHONE]'],
]

export function sanitizeString(value: string): string {
  // Remove control characters first
  let s = value.replace(/[\x00-\x1F\x7F]/g, '')

  for (const [pattern, replacement] of VALUE_PATTERNS) {
    s = s.replace(pattern, replacement)
  }

  if (s.length > MAX_STRING_LENGTH) {
    s = s.slice(0, MAX_STRING_LENGTH) + '…[truncated]'
  }

  return s
}

// ── Metadata admission and sanitization ──────────────────────────────────────

function sanitizeMeta(meta: LogMeta): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(meta)) {
    if (isSensitiveKey(k)) {
      out[k] = '[REDACTED]'
      continue
    }
    if (v === null || v === undefined) {
      out[k] = v
    } else if (typeof v === 'string') {
      out[k] = sanitizeString(v)
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v
    }
    // Objects/arrays/buffers are silently dropped — no arbitrary serialization
  }
  return out
}

// ── Error formatting ──────────────────────────────────────────────────────────

function formatError(e: unknown): LogEntry['error'] {
  if (e instanceof Error) {
    const isProd = process.env.NODE_ENV === 'production'
    return {
      name:    e.name,
      message: isProd ? sanitizeString(e.message) : e.message,
      ...(('code' in e && typeof (e as { code: unknown }).code === 'string')
        ? { code: (e as { code: string }).code }
        : {}),
      ...(!isProd && e.stack ? { stack: e.stack } : {}),
    }
  }
  return { name: 'UnknownError', message: sanitizeString(String(e)) }
}

// ── Emit ──────────────────────────────────────────────────────────────────────

function emit(level: LogLevel, event: string, meta: LogMeta, err?: unknown): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...sanitizeMeta(meta),
    ...(err !== undefined ? { error: formatError(err) } : {}),
  }

  if (process.env.NODE_ENV === 'production') {
    const line = JSON.stringify(entry)
    if (level === 'error') console.error(line)
    else if (level === 'warn')  console.warn(line)
    else                        console.log(line)
  } else {
    const { timestamp, level: lv, event: ev, error: errField, ...rest } = entry
    const prefix = `[${timestamp}] ${lv.toUpperCase()} ${ev}`
    const extras = Object.keys(rest).length > 0 ? rest : undefined
    if (errField) {
      console[lv](prefix, extras ?? '', errField)
    } else if (extras) {
      console[lv](prefix, extras)
    } else {
      console[lv](prefix)
    }
  }
}

export const logger = {
  info(event: string, meta: LogMeta = {}):                 void { emit('info',  event, meta) },
  warn(event: string, meta: LogMeta = {}):                 void { emit('warn',  event, meta) },
  error(event: string, err?: unknown, meta: LogMeta = {}): void { emit('error', event, meta, err) },
}
