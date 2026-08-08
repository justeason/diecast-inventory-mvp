// 14B: Shared server-side setup for every analytics page — one asOf, one parsed range.

import { parseDateRangeParams, dateRangeQueryParams, previousPeriod, type DateRange } from '@/lib/businessAnalyticsDates'

export type AnalyticsPageContext = {
  asOf: Date
  range: DateRange
  previous: { start: Date; end: Date } | null
  error: string | null
  queryString: string
}

export function buildAnalyticsContext(searchParams: { period?: string; start?: string; end?: string }): AnalyticsPageContext {
  const asOf = new Date()
  const { range, error } = parseDateRangeParams(searchParams, asOf)
  const previous = previousPeriod(range)
  const queryString = new URLSearchParams(dateRangeQueryParams(range)).toString()
  return { asOf, range, previous, error, queryString }
}
