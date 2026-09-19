import { centsToDisplay } from '@/lib/marketModelPageDisplay'
import type { AskDepthLevel } from '@/lib/marketAskQuery'

// 28B: aggregate, informational supply overview only — rows are never
// executable (no "Buy at $X" button); actual purchase stays in Available
// Listings below. No seller identity anywhere — only price/count (§20).
export function AskDepth({ levels }: { levels: AskDepthLevel[] }) {
  return (
    <section className="mb-8">
      <h2 className="text-sm font-semibold text-gray-900 mb-1">Current Ask Depth</h2>
      <p className="text-xs text-gray-500 mb-2">Current asking prices for active, available CollectNTrades copies.</p>

      {levels.length === 0 ? (
        <p className="text-sm text-gray-400">No copies currently available.</p>
      ) : (
        <table className="w-full text-sm border border-gray-200 rounded-md overflow-hidden">
          <thead className="bg-gray-50 text-left text-xs font-medium text-gray-500 uppercase tracking-wide">
            <tr>
              <th scope="col" className="px-3 py-2">Asking Price</th>
              <th scope="col" className="px-3 py-2">Available</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {levels.map((level) => (
              <tr key={level.priceCents}>
                <td className="px-3 py-2 text-gray-900">{centsToDisplay(level.priceCents)}</td>
                <td className="px-3 py-2 text-gray-700">
                  {level.availableCopies} {level.availableCopies === 1 ? 'copy' : 'copies'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
