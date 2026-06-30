'use server'

import crypto from 'crypto'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

export type LoginState = string | null

// Derives a session token from the admin password using HMAC-SHA256.
// The same derivation runs in middleware (via Web Crypto) so the two stay in sync.
function deriveSessionToken(password: string): string {
  return crypto
    .createHmac('sha256', password)
    .update('diecast-admin-session')
    .digest('hex')
}

export async function loginAdmin(
  _prev: LoginState,
  formData: FormData
): Promise<LoginState> {
  const password = process.env.ADMIN_PASSWORD
  if (!password) {
    return 'ADMIN_PASSWORD is not configured. Add it to your environment.'
  }

  const submitted = (formData.get('password') as string) ?? ''

  // Hash both before comparing so timingSafeEqual works on equal-length buffers
  // and no information about the password length is revealed via timing.
  const submittedHash = crypto.createHash('sha256').update(submitted).digest()
  const expectedHash  = crypto.createHash('sha256').update(password).digest()
  const match = crypto.timingSafeEqual(submittedHash, expectedHash)

  if (!match) {
    return 'Incorrect password.'
  }

  const cookieStore = await cookies()
  cookieStore.set('admin_session', deriveSessionToken(password), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60 * 24 * 30, // 30 days
    path: '/',
  })

  redirect('/admin')
}

export async function logoutAdmin(_formData: FormData): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.set('admin_session', '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 0,
    path: '/',
  })
  redirect('/admin/login')
}
