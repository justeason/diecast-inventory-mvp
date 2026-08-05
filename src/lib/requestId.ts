/**
 * Server-only helper for reading the current request ID from Next.js headers.
 * Returns undefined when called outside a request context (e.g. during build).
 * Never throws — callers treat undefined as "no request ID available".
 */
import 'server-only'
import { headers } from 'next/headers'

export async function getRequestId(): Promise<string | undefined> {
  try {
    const h = await headers()
    return h.get('x-request-id') ?? undefined
  } catch {
    return undefined
  }
}
