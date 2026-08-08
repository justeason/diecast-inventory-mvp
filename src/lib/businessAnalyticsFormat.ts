// 14B: Display-only formatting. No calculation happens here.

import type { Prisma } from '@prisma/client'
import type { PeriodChange } from '@/lib/businessAnalyticsMath'
import type { BucketGranularity } from '@/lib/businessAnalyticsDates'

export function fmtUsdCents(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function fmtUsdDecimal(d: Prisma.Decimal): string {
  return `$${d.toNumber().toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function fmtInt(n: number): string {
  return n.toLocaleString('en-US')
}

export function fmtPct(value: number | null, digits = 1): string {
  return value === null ? 'N/A' : `${value.toFixed(digits)}%`
}

export function fmtDays(value: number | null): string {
  return value === null ? 'N/A' : `${value.toFixed(1)}d`
}

export function fmtPeriodChange(change: PeriodChange): string {
  if (change.kind === 'unavailable') return '—'
  if (change.kind === 'new') return 'New'
  const sign = change.pct >= 0 ? '+' : ''
  return `${sign}${change.pct.toFixed(1)}%`
}

export function fmtDateUtc(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export function fmtDateTimeUtc(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

export function fmtBucketLabel(d: Date, granularity: BucketGranularity): string {
  if (granularity === 'month') return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' })
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}
