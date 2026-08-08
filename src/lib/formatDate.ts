// Pure helper with no server dependencies — safe to import from client components.
//
// Timestamps that cross a serialization boundary (unstable_cache, JSON, etc.) arrive
// as ISO strings, not Date objects, even when their TypeScript type still says
// `Date` at the call site that produced them. This formatter accepts either shape so
// a stale/incorrect type annotation upstream can't crash rendering — and a malformed
// value renders as an empty string instead of throwing.

export function formatDate(
  value: string | Date | null | undefined,
  options?: Intl.DateTimeFormatOptions,
): string {
  if (!value) return ''

  const date = value instanceof Date ? value : new Date(value)

  if (Number.isNaN(date.getTime())) return ''

  return date.toLocaleDateString('en-US', options)
}
