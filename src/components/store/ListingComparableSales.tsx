import Link from 'next/link'
import { centsToDisplay } from '@/lib/marketModelPageDisplay'
import {
  computeAskPosition,
  formatAskPositionSentence,
  formatComparableSalesEvidenceLine,
  type EligibleComparableSales,
} from '@/lib/listingComparableSales'

// 38B: secondary, factual context on /browse/[id] — "how does this physical
// copy's asking price compare with completed sales of comparable copies,"
// never "is this a good deal." Only rendered when the caller has already
// confirmed strict model_variant_condition eligibility (see
// evaluateComparableSalesEligibility) — this component does no gating itself.
export function ListingComparableSales({
  askCents,
  evidence,
  marketPageHref,
}: {
  askCents: number
  evidence: EligibleComparableSales
  marketPageHref: string
}) {
  const position = computeAskPosition(askCents, evidence.rangeLowCents, evidence.rangeHighCents)

  return (
    <section className="mt-6 border-t border-gray-200 pt-6">
      <h2 className="font-semibold text-gray-900 mb-3">Asking price &amp; recorded sales</h2>

      <dl className="text-sm space-y-1">
        <div className="flex justify-between gap-4">
          <dt className="text-gray-500">Current asking price</dt>
          <dd className="text-gray-900 font-medium">{centsToDisplay(askCents)}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-gray-500">Middle 50% of comparable completed sales</dt>
          <dd className="text-gray-900 font-medium">
            {centsToDisplay(evidence.rangeLowCents)}–{centsToDisplay(evidence.rangeHighCents)}
          </dd>
        </div>
      </dl>

      <p className="mt-3 text-sm text-gray-700">{formatAskPositionSentence(position)}</p>
      <p className="mt-2 text-xs text-gray-500">{formatComparableSalesEvidenceLine(evidence)}</p>

      <Link href={marketPageHref} className="mt-2 inline-block text-xs text-gray-500 hover:text-gray-900 underline underline-offset-2">
        View full market history →
      </Link>
    </section>
  )
}
