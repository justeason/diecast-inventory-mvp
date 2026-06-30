import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// Derives the expected session token using Web Crypto (available in Edge Runtime).
// Must produce the same result as the Node.js crypto HMAC in auth.ts.
async function deriveSessionToken(password: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode('diecast-admin-session'))
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  const password = process.env.ADMIN_PASSWORD

  const sessionCookie = request.cookies.get('admin_session')
  let isAuthenticated = false

  if (password && sessionCookie?.value) {
    const expected = await deriveSessionToken(password)
    isAuthenticated = sessionCookie.value === expected
  }

  // /admin/login: let unauthenticated users through; redirect authenticated users away
  if (pathname === '/admin/login') {
    if (isAuthenticated) {
      return NextResponse.redirect(new URL('/admin', request.url))
    }
    return NextResponse.next()
  }

  // All other /admin routes: require authentication
  if (!isAuthenticated) {
    return NextResponse.redirect(new URL('/admin/login', request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/admin', '/admin/:path*'],
}
