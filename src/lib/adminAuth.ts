import crypto from 'crypto'
import { cookies } from 'next/headers'

// Same HMAC-SHA256 derivation used by src/proxy.ts (Web Crypto) and src/lib/actions/auth.ts (Node crypto).
// All three must stay in sync: same key (ADMIN_PASSWORD), same message ('diecast-admin-session').
function deriveSessionToken(password: string): string {
  return crypto
    .createHmac('sha256', password)
    .update('diecast-admin-session')
    .digest('hex')
}

/**
 * Returns true when the current request carries a valid admin_session cookie.
 * Use this inside Route Handlers that cannot rely solely on middleware.
 */
export async function isAdminAuthenticated(): Promise<boolean> {
  const password = process.env.ADMIN_PASSWORD
  if (!password) return false

  const cookieStore = await cookies()
  const session = cookieStore.get('admin_session')
  if (!session?.value) return false

  const expected = Buffer.from(deriveSessionToken(password), 'utf8')
  const actual   = Buffer.from(session.value, 'utf8')

  // Lengths must match before calling timingSafeEqual (it throws on unequal lengths).
  // Returning false on a length mismatch does not leak information — the expected
  // length is always 64 hex chars (SHA-256), so any other length is structurally wrong.
  if (actual.length !== expected.length) return false

  return crypto.timingSafeEqual(actual, expected)
}
