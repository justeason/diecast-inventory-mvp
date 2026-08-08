import type { MetricDefinition } from '@/lib/businessAnalyticsRegistry'

export function KpiCard({
  value,
  change,
  definition,
  note,
}: {
  value: string
  change?: string
  definition: MetricDefinition
  note?: string
}) {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-4" title={definition.description}>
      <p className="text-2xl font-bold tabular-nums text-gray-900 leading-none">{value}</p>
      <p className="text-sm text-gray-600 mt-1.5">{definition.name}</p>
      <div className="flex items-center gap-2 mt-1">
        {change && <span className="text-xs text-gray-400">{change} vs prior period</span>}
      </div>
      {note && <p className="text-xs text-amber-600 mt-1">{note}</p>}
      <p className="text-[11px] text-gray-300 mt-2 uppercase tracking-wide">{definition.metricType}</p>
    </div>
  )
}
