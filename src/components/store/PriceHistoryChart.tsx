import { computeChartPoints } from '@/lib/marketModelPageDisplay'
import { formatDate } from '@/lib/formatDate'
import type { MarketSaleObservation } from '@/lib/marketSaleQuery'

const WIDTH = 300
const HEIGHT = 100
const PAD = 10

type Point = { soldAt: Date; priceCents: number; sourceType: MarketSaleObservation['sourceType'] }

// 24B: dependency-free server-rendered SVG, following SimpleBarChart.tsx's own
// no-chart-library convention. Discrete scatter only — no daily closes, no
// forward-fill, no OHLC, no interpolation. Never the sole representation of
// the history (see RecentSalesList) — role="img" carries a concise summary,
// not a per-point transcript.
export function PriceHistoryChart({ points }: { points: Point[] }) {
  if (points.length === 0) return null

  const coords = computeChartPoints(points, WIDTH, HEIGHT, PAD)
  const prices = points.map((p) => p.priceCents)
  const minPrice = Math.min(...prices)
  const maxPrice = Math.max(...prices)
  const times = points.map((p) => p.soldAt.getTime())
  const minDate = new Date(Math.min(...times))
  const maxDate = new Date(Math.max(...times))
  const saleWord = points.length === 1 ? 'sale' : 'sales'

  const summary =
    `Price history chart: ${points.length} comparable ${saleWord} from ${formatDate(minDate)} to ${formatDate(maxDate)}, ` +
    `prices from $${(minPrice / 100).toFixed(2)} to $${(maxPrice / 100).toFixed(2)}. See the recent sales list below for details.`

  return (
    <div role="img" aria-label={summary}>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" className="w-full" style={{ height: 140 }}>
        {coords.map((c, i) => (
          <circle key={i} cx={c.x} cy={c.y} r={3} className={c.sourceType === 'internal' ? 'fill-gray-700' : 'fill-gray-400'} />
        ))}
      </svg>
    </div>
  )
}
