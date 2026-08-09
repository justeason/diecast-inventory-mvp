export type MatchLevel = 'exact' | 'model_family' | 'series_year' | 'brand_series' | 'insufficient'
export type Confidence = 'high' | 'medium' | 'low' | 'insufficient'

export type TargetModel = {
  id: string
  brand: string
  name: string
  series: string | null
  year: number | null
}

export type ComparableSale = {
  orderItemId: string
  orderId: string
  catalogModelId: string
  catalogBrand: string
  catalogName: string
  catalogSeries: string | null
  catalogYear: number | null
  soldPriceCents: number
  listingCreatedAt: Date
  orderCompletedAt: Date
  sku: string
}

export type ComparableRecord = {
  orderItemId: string
  orderId: string
  sku: string
  catalogModelId: string
  matchLevel: MatchLevel
  soldPriceCents: number
  listingCreatedAt: Date
  orderCompletedAt: Date
  daysToSell: number | null
}

export type EstimateResult = {
  estimatedPrice: number | null
  lowPrice: number | null
  highPrice: number | null
  estimatedDaysToSell: number | null
  comparableCount: number
  confidence: Confidence
  matchLevel: MatchLevel
  comparables: ComparableRecord[]
  warnings: string[]
  newestComparableDate: Date | null
  oldestComparableDate: Date | null
  extendedHistoryUsed: boolean
}

// Minimum comps in the 24-month window before expanding to all-time history.
export const MIN_WINDOW_COMPS = 3
// ~24 months in ms
const TWO_YEARS_MS = 2 * 365.25 * 24 * 60 * 60 * 1000

export const CONFIDENCE_ORDER: Confidence[] = ['insufficient', 'low', 'medium', 'high']
const MATCH_LEVEL_PRIORITY: MatchLevel[] = ['exact', 'model_family', 'series_year', 'brand_series']

export function downgradeConfidence(c: Confidence, levels: number): Confidence {
  const idx = CONFIDENCE_ORDER.indexOf(c)
  return CONFIDENCE_ORDER[Math.max(0, idx - levels)]
}

export function deriveConfidence(
  count: number,
  matchLevel: MatchLevel,
  extendedHistoryUsed: boolean,
): Confidence {
  if (count === 0) return 'insufficient'
  let base: Confidence = count >= 10 ? 'high' : count >= 5 ? 'medium' : 'low'
  if (matchLevel === 'model_family') base = downgradeConfidence(base, 1)
  else if (matchLevel === 'series_year') base = downgradeConfidence(base, 1)
  else if (matchLevel === 'brand_series') base = downgradeConfidence(base, 2)
  if (extendedHistoryUsed) base = downgradeConfidence(base, 1)
  return base
}

export function median(sorted: number[]): number {
  const n = sorted.length
  if (n === 0) throw new Error('median: empty array')
  if (n % 2 === 1) return sorted[Math.floor(n / 2)]
  return Math.round((sorted[Math.floor(n / 2) - 1] + sorted[Math.floor(n / 2)]) / 2)
}

export function percentile(sorted: number[], p: number): number {
  const n = sorted.length
  if (n === 0) throw new Error('percentile: empty array')
  const idx = Math.floor(p * (n - 1))
  return sorted[idx]
}

function computeDaysToSell(listingCreatedAt: Date, orderCompletedAt: Date): number | null {
  const ms = orderCompletedAt.getTime() - listingCreatedAt.getTime()
  if (ms < 0) return null
  return Math.round(ms / (1000 * 60 * 60 * 24))
}

function resolveMatchLevel(target: TargetModel, sale: ComparableSale): MatchLevel | null {
  if (sale.catalogModelId === target.id) return 'exact'
  const sameBrand = sale.catalogBrand.toLowerCase() === target.brand.toLowerCase()
  const sameName = sale.catalogName.toLowerCase() === target.name.toLowerCase()
  if (sameBrand && sameName) return 'model_family'
  if (
    sameBrand &&
    target.series &&
    sale.catalogSeries &&
    sale.catalogSeries.toLowerCase() === target.series.toLowerCase() &&
    target.year != null &&
    sale.catalogYear === target.year
  ) {
    return 'series_year'
  }
  if (
    sameBrand &&
    target.series &&
    sale.catalogSeries &&
    sale.catalogSeries.toLowerCase() === target.series.toLowerCase()
  ) {
    return 'brand_series'
  }
  return null
}

export function computeEstimate(
  target: TargetModel,
  allComparables: ComparableSale[],
  nowMs: number = Date.now(),
): EstimateResult {
  const cutoff = new Date(nowMs - TWO_YEARS_MS)

  // Deduplicate by orderItemId
  const seen = new Set<string>()
  const deduped = allComparables.filter((s) => {
    if (seen.has(s.orderItemId)) return false
    seen.add(s.orderItemId)
    return true
  })

  // Classify by match level
  type Classified = { sale: ComparableSale; matchLevel: MatchLevel }
  const classified: Classified[] = []
  for (const sale of deduped) {
    const level = resolveMatchLevel(target, sale)
    if (level) classified.push({ sale, matchLevel: level })
  }

  let chosen: Classified[] = []
  let chosenLevel: MatchLevel = 'insufficient'
  let extendedHistoryUsed = false

  for (const level of MATCH_LEVEL_PRIORITY) {
    const atLevel = classified.filter((c) => c.matchLevel === level)
    if (atLevel.length === 0) continue
    const recent = atLevel.filter((c) => c.sale.orderCompletedAt >= cutoff)
    if (recent.length >= MIN_WINDOW_COMPS) {
      chosen = recent
      chosenLevel = level
      extendedHistoryUsed = false
    } else {
      chosen = atLevel
      chosenLevel = level
      extendedHistoryUsed = recent.length < atLevel.length
    }
    break
  }

  if (chosen.length === 0) {
    return {
      estimatedPrice: null,
      lowPrice: null,
      highPrice: null,
      estimatedDaysToSell: null,
      comparableCount: 0,
      confidence: 'insufficient',
      matchLevel: 'insufficient',
      comparables: [],
      warnings: ['No comparable completed sales found.'],
      newestComparableDate: null,
      oldestComparableDate: null,
      extendedHistoryUsed: false,
    }
  }

  const records: ComparableRecord[] = chosen.map(({ sale, matchLevel }) => ({
    orderItemId: sale.orderItemId,
    orderId: sale.orderId,
    sku: sale.sku,
    catalogModelId: sale.catalogModelId,
    matchLevel,
    soldPriceCents: sale.soldPriceCents,
    listingCreatedAt: sale.listingCreatedAt,
    orderCompletedAt: sale.orderCompletedAt,
    daysToSell: computeDaysToSell(sale.listingCreatedAt, sale.orderCompletedAt),
  }))

  const sortedPrices = records.map((r) => r.soldPriceCents).sort((a, b) => a - b)
  const validDays = records
    .map((r) => r.daysToSell)
    .filter((d): d is number => d !== null)
    .sort((a, b) => a - b)

  const completedTimes = records.map((r) => r.orderCompletedAt.getTime())
  const newestComparableDate = new Date(Math.max(...completedTimes))
  const oldestComparableDate = new Date(Math.min(...completedTimes))

  const warnings: string[] = []
  if (extendedHistoryUsed) {
    warnings.push(
      `Fewer than ${MIN_WINDOW_COMPS} comparable sales found within 24 months. Extended to all available history.`,
    )
  }
  if (chosen.length === 1) {
    warnings.push('Only 1 comparable sale found. Estimate is based on a single observation.')
  }
  if (chosenLevel !== 'exact') {
    warnings.push(`No exact model match found. Using ${chosenLevel} comparables.`)
  }

  const confidence = deriveConfidence(records.length, chosenLevel, extendedHistoryUsed)

  return {
    estimatedPrice: median(sortedPrices),
    lowPrice: percentile(sortedPrices, 0.25),
    highPrice: percentile(sortedPrices, 0.75),
    estimatedDaysToSell: validDays.length > 0 ? median(validDays) : null,
    comparableCount: records.length,
    confidence,
    matchLevel: chosenLevel,
    comparables: records,
    warnings,
    newestComparableDate,
    oldestComparableDate,
    extendedHistoryUsed,
  }
}
