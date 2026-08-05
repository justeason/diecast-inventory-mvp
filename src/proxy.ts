import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// Format: req_ + 16 lowercase hex chars. Accept from upstream only if format matches.
const REQUEST_ID_RE = /^req_[0-9a-f]{16}$/

function generateRequestId(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return 'req_' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

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

  // Attach request ID on all matched routes (static files excluded by matcher).
  const incoming = request.headers.get('x-request-id') ?? ''
  const requestId = REQUEST_ID_RE.test(incoming) ? incoming : generateRequestId()
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-request-id', requestId)

  // Admin auth — only for /admin routes.
  if (pathname.startsWith('/admin')) {
    const password = process.env.ADMIN_PASSWORD
    const sessionCookie = request.cookies.get('admin_session')
    let isAuthenticated = false

    if (password && sessionCookie?.value) {
      const expected = await deriveSessionToken(password)
      isAuthenticated = sessionCookie.value === expected
    }

    if (pathname === '/admin/login') {
      if (isAuthenticated) {
        return NextResponse.redirect(new URL('/admin', request.url))
      }
    } else if (!isAuthenticated) {
      return NextResponse.redirect(new URL('/admin/login', request.url))
    }
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set('x-request-id', requestId)
  return response
}

export const config = {
  matcher: [
    // Match all routes except Next.js internals, static assets with extensions, and favicon.
    '/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|woff2?|ttf|otf|eot|map)$).*)',
  ],
}
