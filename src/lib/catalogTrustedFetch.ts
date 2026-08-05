// Trusted fetch helper for fetching images from this project's Vercel Blob store only.
// Trusted hostname is read from BLOB_TRUSTED_HOSTNAME (server-only env var) at call time.
// Fails closed when the env var is absent or empty — no images are fetched.
// Never exposes the allowlist to client code; not prefixed NEXT_PUBLIC_.

const MAX_BYTES        = 11 * 1024 * 1024  // 11 MB cap (above 10 MB image limit)
const FETCH_TIMEOUT_MS = 15_000

const ACCEPTED_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

// Read lazily on every call so tests can set process.env without module caching issues.
function getTrustedHostname(): string {
  return (process.env.BLOB_TRUSTED_HOSTNAME ?? '').toLowerCase().trim()
}

// Returns true only when:
//   - rawUrl is a valid HTTPS URL
//   - its hostname (lowercased) exactly equals the configured trusted hostname
//   - the configured hostname is non-empty (fail closed when unconfigured)
// No suffix, substring, wildcard, or tenant-level matching.
export function isTrustedBlobUrl(rawUrl: string): boolean {
  const trusted = getTrustedHostname()
  if (!trusted) return false  // fail closed: not configured
  try {
    const url = new URL(rawUrl)
    return url.protocol === 'https:' && url.hostname.toLowerCase() === trusted
  } catch {
    return false
  }
}

export async function fetchTrustedBlobImage(
  url: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  if (!isTrustedBlobUrl(url)) {
    throw new Error('URL is not from a trusted storage origin')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  let response: Response
  try {
    response = await fetch(url, {
      signal:      controller.signal,
      redirect:    'error',     // reject redirects unconditionally
      credentials: 'omit',
    })
  } catch (e) {
    clearTimeout(timer)
    throw new Error(`Fetch failed: ${e instanceof Error ? e.message : 'unknown error'}`)
  }
  clearTimeout(timer)

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching catalog image`)
  }

  const rawCt = response.headers.get('content-type') ?? ''
  const mimeType = rawCt.split(';')[0].trim()
  if (!ACCEPTED_CONTENT_TYPES.has(mimeType)) {
    throw new Error(`Unexpected Content-Type: ${mimeType}`)
  }

  const reader = response.body?.getReader()
  if (!reader) throw new Error('No response body')

  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > MAX_BYTES) {
      await reader.cancel()
      throw new Error('Response exceeds maximum size')
    }
    chunks.push(value)
  }

  return { buffer: Buffer.concat(chunks), mimeType }
}
