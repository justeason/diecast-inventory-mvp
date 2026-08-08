import type { DateRange } from '@/lib/businessAnalyticsDates'
import { fmtDateUtc } from '@/lib/businessAnalyticsFormat'

const PRESETS: Array<{ value: string; label: string }> = [
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: 'ytd', label: 'Year to date' },
  { value: 'all', label: 'All time' },
  { value: 'custom', label: 'Custom range' },
]

// Plain GET form — no client JS required. Preserves the current path so filters carry
// over when navigating between analytics pages via the sub-nav links.
export function AnalyticsFilterBar({ path, range, error }: { path: string; range: DateRange; error: string | null }) {
  const customStart = range.preset === 'custom' && range.start ? fmtDateUtc(range.start) : ''
  const customEnd = range.preset === 'custom' ? fmtDateUtc(new Date(range.end.getTime() - 86_400_000)) : ''

  return (
    <form method="get" action={path} className="flex flex-wrap items-end gap-3 rounded-md border border-gray-200 bg-gray-50 px-4 py-3">
      <div>
        <label htmlFor="period" className="block text-xs text-gray-500 mb-1">Period</label>
        <select id="period" name="period" defaultValue={range.preset} className="rounded-md border border-gray-300 px-2 py-1.5 text-sm">
          {PRESETS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
      </div>
      <div>
        <label htmlFor="start" className="block text-xs text-gray-500 mb-1">Start (UTC)</label>
        <input id="start" type="date" name="start" defaultValue={customStart} className="rounded-md border border-gray-300 px-2 py-1.5 text-sm" />
      </div>
      <div>
        <label htmlFor="end" className="block text-xs text-gray-500 mb-1">End (UTC, inclusive)</label>
        <input id="end" type="date" name="end" defaultValue={customEnd} className="rounded-md border border-gray-300 px-2 py-1.5 text-sm" />
      </div>
      <button type="submit" className="rounded-md bg-gray-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-gray-700">
        Apply
      </button>
      {error && <p className="text-xs text-red-600 basis-full">{error}</p>}
    </form>
  )
}
