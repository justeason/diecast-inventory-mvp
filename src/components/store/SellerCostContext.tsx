import { centsToDisplay } from '@/lib/marketModelPageDisplay'
import type { RecordedCostPreview } from '@/lib/ownershipLedger'

// 27B §43/§49/§50/§61: secondary, understated, PRIVATE cost context — only
// for Collection-linked submissions, visually separate from Market Snapshot.
// Never shown as "tax basis"; never implies a partial-coverage figure is the
// full cost.
export function SellerCostContext({ costPreview }: { costPreview: RecordedCostPreview }) {
  if (costPreview.status === 'insufficient_quantity') {
    return null // shouldn't normally occur (submission quantity is bounded by collection quantity); fail quiet, not loud
  }

  return (
    <div className="rounded-md border border-gray-100 bg-gray-50 px-4 py-3">
      <p className="text-[11px] font-medium text-gray-400 uppercase tracking-wide mb-1">Your Cost</p>
      {costPreview.status === 'known' ? (
        <p className="text-sm text-gray-600">
          Recorded Cost: <span className="font-medium">{centsToDisplay(costPreview.recordedCostCents!)}</span>
        </p>
      ) : costPreview.status === 'partial' ? (
        <p className="text-sm text-gray-500">
          Recorded Cost Coverage: {costPreview.knownCostCopies} of {costPreview.totalAllocatedCopies} copies
        </p>
      ) : (
        <p className="text-sm text-gray-400">Cost not recorded for these copies.</p>
      )}
    </div>
  )
}
