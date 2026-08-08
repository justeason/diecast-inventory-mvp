// 14A: Deterministic, server-generated alert primitives — no floats, no PII.
//
// Event keys never include email, name, session ID, or seller identity — only
// listingId/catalogModelId/price-in-cents/Listing.version.

export const DEFAULT_PRICE_CHANGE_THRESHOLD_PCT = 5

// Converts an authoritative Listing.price (dollars, Float) to integer cents.
// Single rounding step directly off a value that's already at 2-decimal precision —
// avoids building keys/comparisons from raw float string representations.
export function toCents(dollars: number): number {
  return Math.round(dollars * 100)
}

// True when the cents delta is large enough to be worth notifying about.
// thresholdPct is an integer percent (e.g. 5 = 5%); null/undefined falls back to the default.
export function isMeaningfulPriceChange(
  oldCents: number,
  newCents: number,
  thresholdPct: number | null | undefined,
): boolean {
  if (oldCents === newCents) return false
  if (oldCents <= 0) return true // defensive — Listing.price is always > 0 in practice
  const pct = (Math.abs(newCents - oldCents) / oldCents) * 100
  return pct >= (thresholdPct ?? DEFAULT_PRICE_CHANGE_THRESHOLD_PCT)
}

// Listing.version is a durable, monotonically-incrementing counter bumped on every
// alert-relevant mutation (see listings.ts / intake.ts). It — not updatedAt — is the
// version salt: updatedAt has only millisecond precision and is not a safe uniqueness
// anchor under rapid writes, and a raw timestamp is not a meaningful "transition id."
// Reactivation (archived -> active) always bumps version, so it gets its own event key
// rather than masquerading as part of the prior availability window.
export function buildAvailableEventKey(listingId: string, listingVersion: number): string {
  return `wanted_available:${listingId}:${listingVersion}`
}

export function buildPriceChangeEventKey(
  listingId: string,
  oldCents: number,
  newCents: number,
  listingVersion: number,
): string {
  return `wanted_price:${listingId}:${oldCents}:${newCents}:${listingVersion}`
}
