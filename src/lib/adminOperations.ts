// 15H: pure logic for the admin command center — attention-item priority banding.
// No DB access (see adminOperationsQuery.ts for that boundary). Mirrors the
// sellerPortfolio.ts / itemLifecycle.ts pure/DB-boundary split.
//
// Deliberately NOT a numeric health/risk score (Part B section 8) — every band is a
// fixed, explicit mapping from a named signal to one of three priority tiers (Part K
// section 35), never a computed weighting.

export type AttentionBand = 'critical' | 'operational' | 'data_quality'

// 15H focused-review section 5: no separate 'payouts_ready' code — an approved
// payout ready to send is Work Queue material, not a distinct Needs Attention
// category (it would otherwise show the exact same number as Work Queue's Payout
// Ready card, under a different label, as if it were two different issues).
export type AttentionItemCode =
  | 'pending_approvals'
  | 'intake_exceptions'
  | 'shipment_discrepancies'
  | 'portfolio_issues'
  | 'inventory_contradictions'

const ATTENTION_BANDS: Record<AttentionItemCode, AttentionBand> = {
  // Critical commercial/financial (section 35): approval required.
  pending_approvals: 'critical',
  // Operational blocker: intake exception, shipment variance, portfolio prerequisite.
  intake_exceptions: 'operational',
  shipment_discrepancies: 'operational',
  portfolio_issues: 'operational',
  // Data-quality attention: inventory contradiction.
  inventory_contradictions: 'data_quality',
}

export function attentionBand(code: AttentionItemCode): AttentionBand {
  return ATTENTION_BANDS[code]
}

export type AttentionItem = {
  code: AttentionItemCode
  label: string
  // null = no efficient global count exists (Part C section 7) — render as a link,
  // never as a fabricated or expensively-computed exact number.
  count: number | null
  detail?: string
  href: string
}

// Stable priority order (section 35) — critical first, data-quality last. Ties keep
// their relative input order (Array.sort is stable), so callers control ordering
// within a band by array position.
export function sortByAttentionBand(items: AttentionItem[]): AttentionItem[] {
  const order: Record<AttentionBand, number> = { critical: 0, operational: 1, data_quality: 2 }
  return [...items].sort((a, b) => order[attentionBand(a.code)] - order[attentionBand(b.code)])
}

// Only items with a nonzero (or unavailable/link-only) signal are actionable —
// an authoritative zero is not shown in the Needs Attention list at all.
export function activeAttentionItems(items: AttentionItem[]): AttentionItem[] {
  return items.filter((i) => i.count === null || i.count > 0)
}

// Section 9: explicitly NOT a sum of "affected items" (one physical item can
// contribute to multiple categories) — only a count of how many attention
// categories currently have a provable nonzero signal, labeled accordingly by the
// caller as "Open attention signals", never "Affected items".
export function openAttentionSignalCount(items: AttentionItem[]): number {
  return activeAttentionItems(items).length
}
