// 14B: Server-side date-range parsing. UTC/database timestamps only — never
// browser-local classification. One `asOf` per dashboard request, shared by every
// metric computed for that request.

export type PeriodPreset = '7d' | '30d' | '90d' | 'ytd' | 'all' | 'custom'

export type DateRange = {
  preset: PeriodPreset
  start: Date | null // null = all time (no lower bound)
  end: Date // exclusive upper bound
  label: string
}

const PRESET_DAYS: Record<Exclude<PeriodPreset, 'ytd' | 'all' | 'custom'>, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
}

const PRESET_LABELS: Record<PeriodPreset, string> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  ytd: 'Year to date',
  all: 'All time',
  custom: 'Custom range',
}

function isValidDateString(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00.000Z'))
}

export type ParsedDateRange = { range: DateRange; error: string | null }

// searchParams values: `period` = preset key; `start`/`end` = YYYY-MM-DD (UTC), only
// used when period=custom. Malformed/inconsistent input falls back to the default
// (30d) with an error message the page can surface — it never throws or 500s.
export function parseDateRangeParams(
  params: { period?: string; start?: string; end?: string },
  now: Date = new Date(),
): ParsedDateRange {
  const asOfEnd = now // end is always exclusive-now for non-custom presets
  const preset = (params.period ?? '30d') as PeriodPreset

  if (preset === 'all') {
    return { range: { preset, start: null, end: asOfEnd, label: PRESET_LABELS.all }, error: null }
  }

  if (preset === 'ytd') {
    const start = new Date(Date.UTC(now.getUTCFullYear(), 0, 1, 0, 0, 0, 0))
    return { range: { preset, start, end: asOfEnd, label: PRESET_LABELS.ytd }, error: null }
  }

  if (preset === 'custom') {
    if (!params.start || !params.end || !isValidDateString(params.start) || !isValidDateString(params.end)) {
      return { range: defaultRange(now), error: 'Invalid custom date range — showing last 30 days instead.' }
    }
    const start = new Date(params.start + 'T00:00:00.000Z')
    // end is user-inclusive (a calendar day) — convert to an exclusive boundary the
    // instant after that day ends, so `start <= timestamp < end` includes it fully.
    const end = new Date(params.end + 'T00:00:00.000Z')
    end.setUTCDate(end.getUTCDate() + 1)
    if (start.getTime() > end.getTime()) {
      return { range: defaultRange(now), error: 'Start date must not be after end date — showing last 30 days instead.' }
    }
    return { range: { preset, start, end, label: `${params.start} – ${params.end}` }, error: null }
  }

  if (preset === '7d' || preset === '30d' || preset === '90d') {
    const days = PRESET_DAYS[preset]
    const start = new Date(asOfEnd.getTime() - days * 86_400_000)
    return { range: { preset, start, end: asOfEnd, label: PRESET_LABELS[preset] }, error: null }
  }

  return { range: defaultRange(now), error: 'Unrecognized period filter — showing last 30 days instead.' }
}

function defaultRange(now: Date): DateRange {
  const days = PRESET_DAYS['30d']
  return { preset: '30d', start: new Date(now.getTime() - days * 86_400_000), end: now, label: PRESET_LABELS['30d'] }
}

// 15H: UTC-calendar-day "today" range for command-center business pulse — same UTC
// convention as every other range in this module, never browser-local.
export function todayRange(now: Date = new Date()): DateRange {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0))
  return { preset: 'custom', start, end: now, label: 'Today' }
}

// The immediately preceding period of equal length, for flow/cohort comparisons.
// Snapshot metrics and 'all'/'ytd' ranges have no meaningful equal-length predecessor.
export function previousPeriod(range: DateRange): { start: Date; end: Date } | null {
  if (range.start === null) return null // 'all time' has no predecessor
  const lengthMs = range.end.getTime() - range.start.getTime()
  return { start: new Date(range.start.getTime() - lengthMs), end: range.start }
}

// Query params to preserve when linking between analytics pages.
export function dateRangeQueryParams(range: DateRange): Record<string, string> {
  if (range.preset === 'custom' && range.start) {
    return { period: 'custom', start: range.start.toISOString().slice(0, 10), end: new Date(range.end.getTime() - 86_400_000).toISOString().slice(0, 10) }
  }
  return { period: range.preset }
}

// Deterministic UTC bucket boundaries for time-series. 'day' for short ranges,
// 'week' (UTC Monday start) or 'month' for longer ones.
export type BucketGranularity = 'day' | 'week' | 'month'

// <=90 days: daily. 91-365 days: weekly. >365 days (including 'all time'): monthly.
export function chooseBucketGranularity(range: DateRange): BucketGranularity {
  if (range.start === null) return 'month'
  const days = (range.end.getTime() - range.start.getTime()) / 86_400_000
  if (days <= 90) return 'day'
  if (days <= 365) return 'week'
  return 'month'
}

export function advanceBucket(date: Date, granularity: BucketGranularity): Date {
  const d = new Date(date)
  if (granularity === 'day') d.setUTCDate(d.getUTCDate() + 1)
  else if (granularity === 'week') d.setUTCDate(d.getUTCDate() + 7)
  else d.setUTCMonth(d.getUTCMonth() + 1)
  return d
}

export function bucketStart(date: Date, granularity: BucketGranularity): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  if (granularity === 'day') return d
  if (granularity === 'month') return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
  // week: UTC Monday start (ISO-ish)
  const dow = d.getUTCDay() // 0=Sun..6=Sat
  const diffToMonday = dow === 0 ? 6 : dow - 1
  d.setUTCDate(d.getUTCDate() - diffToMonday)
  return d
}
