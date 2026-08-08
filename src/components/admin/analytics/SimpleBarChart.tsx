// Accessible SVG bar chart — no chart library dependency exists in this project.
export function SimpleBarChart({
  bars,
  height = 120,
  formatValue = (v: number) => String(v),
}: {
  bars: Array<{ label: string; value: number }>
  height?: number
  formatValue?: (v: number) => string
}) {
  const max = Math.max(1, ...bars.map(b => b.value))
  const barWidth = 100 / Math.max(bars.length, 1)

  return (
    <div role="img" aria-label={bars.map(b => `${b.label}: ${formatValue(b.value)}`).join(', ')}>
      <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" className="w-full" style={{ height }}>
        {bars.map((b, i) => {
          const barHeight = (b.value / max) * (height - 20)
          return (
            <g key={b.label}>
              <rect
                x={i * barWidth + barWidth * 0.15}
                y={height - 20 - barHeight}
                width={barWidth * 0.7}
                height={barHeight}
                className="fill-gray-700"
              />
            </g>
          )
        })}
      </svg>
      <div className="flex text-[10px] text-gray-400 mt-1">
        {bars.map(b => (
          <div key={b.label} style={{ width: `${barWidth}%` }} className="text-center truncate px-0.5">
            {b.label}
          </div>
        ))}
      </div>
    </div>
  )
}
