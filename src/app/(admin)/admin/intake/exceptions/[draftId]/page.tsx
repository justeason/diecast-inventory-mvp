import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getExceptionDetail } from '@/lib/intakeExceptionQueueQuery'
import { EXCEPTION_LABELS, EXCEPTION_CATEGORY_LABELS, EXCEPTION_CATEGORY, formatExceptionAge, type IntakeExceptionCode } from '@/lib/intakeExceptions'
import { IntakeExceptionResolveForm } from '@/components/admin/IntakeExceptionResolveForm'

export const dynamic = 'force-dynamic'

export default async function IntakeExceptionDetailPage({ params }: { params: Promise<{ draftId: string }> }) {
  const { draftId } = await params
  const detail = await getExceptionDetail(draftId)
  if (!detail) notFound()

  const code = detail.code as IntakeExceptionCode
  const category = EXCEPTION_CATEGORY[code]
  // 15E-review section 7: only distinguish original vs current issue when they
  // actually differ (a fix revealed a new blocker) — otherwise showing both would be
  // pure duplication for the common case of "still the same issue."
  const hasEvolved = detail.initialCode !== null && detail.initialCode !== detail.code
  const initialLabel = detail.initialCode ? (EXCEPTION_LABELS[detail.initialCode as IntakeExceptionCode] ?? detail.initialCode) : null
  const resolved = detail.convertedItemId !== null

  return (
    <div className="max-w-3xl">
      <Link href="/admin/intake/exceptions" className="text-sm text-blue-600 hover:underline">← Back to exception queue</Link>

      <h1 className="mt-2 text-lg font-semibold text-gray-900">
        {EXCEPTION_LABELS[code] ?? detail.code}
        <span className="ml-2 text-xs font-normal text-gray-400">{category ? EXCEPTION_CATEGORY_LABELS[category] : ''}</span>
        {resolved && <span className="ml-2 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">Resolved</span>}
      </h1>
      <p className="text-sm text-gray-500">Age: {formatExceptionAge(detail.createdAt, new Date())}</p>

      {resolved ? (
        // A resolved record must not look actively broken merely because current
        // exception evidence is retained for audit — lead with "Original issue," never
        // with a red/alarming treatment.
        <div className="mt-4 rounded-md border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700">
          <p className="text-xs text-gray-500 mb-1">Original issue</p>
          {initialLabel ?? EXCEPTION_LABELS[code] ?? detail.code}
          {(detail.initialNote ?? detail.note) && <span className="text-gray-500"> — {detail.initialNote ?? detail.note}</span>}
        </div>
      ) : hasEvolved ? (
        <div className="mt-4 space-y-2">
          <div className="rounded-md border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700">
            <p className="text-xs text-gray-500 mb-1">Original issue</p>
            {initialLabel}
            {detail.initialNote && <span className="text-gray-500"> — {detail.initialNote}</span>}
          </div>
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            <p className="text-xs text-red-500 mb-1">Current issue</p>
            {detail.note ?? 'No additional context recorded.'}
          </div>
        </div>
      ) : (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {detail.note ?? 'No additional context recorded.'}
        </div>
      )}

      <div className="mt-4 grid grid-cols-2 gap-4 text-sm">
        <div className="rounded-md border border-gray-200 bg-white p-3">
          <p className="text-xs text-gray-500 mb-1">Seller</p>
          <p className="text-gray-900">{detail.sellerLabel ?? 'Unknown / legacy'}</p>
        </div>
        <div className="rounded-md border border-gray-200 bg-white p-3">
          <p className="text-xs text-gray-500 mb-1">Portfolio</p>
          {detail.portfolio ? (
            <Link href={`/admin/seller-portfolios/${detail.portfolio.id}`} className="text-blue-600 hover:underline">{detail.portfolio.name ?? detail.portfolio.id}</Link>
          ) : <p className="text-gray-500">—</p>}
        </div>
        <div className="rounded-md border border-gray-200 bg-white p-3">
          <p className="text-xs text-gray-500 mb-1">Agreement</p>
          {detail.agreement ? (
            <p className="text-gray-900">{detail.agreement.type} · {detail.agreement.status}</p>
          ) : <p className="text-gray-500">—</p>}
        </div>
        <div className="rounded-md border border-gray-200 bg-white p-3">
          <p className="text-xs text-gray-500 mb-1">Shipment</p>
          {detail.shipment ? (
            <p className="text-gray-900">{detail.shipment.trackingNumber ?? detail.shipment.id} (received {detail.shipment.receivedQuantity ?? '—'})</p>
          ) : <p className="text-gray-500">— (manual/legacy intake)</p>}
        </div>
        <div className="rounded-md border border-gray-200 bg-white p-3">
          <p className="text-xs text-gray-500 mb-1">Submission</p>
          {detail.submission ? (
            <Link href={`/admin/seller-submissions/${detail.submission.id}`} className="text-blue-600 hover:underline">{detail.submission.id}</Link>
          ) : <p className="text-gray-500">—</p>}
        </div>
        {detail.convertedItemId && (
          <div className="rounded-md border border-gray-200 bg-white p-3">
            <p className="text-xs text-gray-500 mb-1">Converted item</p>
            <Link href={`/admin/items/${detail.convertedItemId}`} className="text-blue-600 hover:underline">View Item →</Link>
          </div>
        )}
      </div>

      {(detail.frontPhotoUrl || detail.backPhotoUrl) && (
        <div className="mt-4 flex gap-3">
          {detail.frontPhotoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={detail.frontPhotoUrl} alt="front" className="h-32 w-32 rounded-md border border-gray-200 object-cover" />
          )}
          {detail.backPhotoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={detail.backPhotoUrl} alt="back" className="h-32 w-32 rounded-md border border-gray-200 object-cover" />
          )}
        </div>
      )}

      {detail.pricing && (
        <div className="mt-4 rounded-md border border-gray-200 bg-white p-3 text-sm">
          <p className="text-xs text-gray-500 mb-1">Pricing advisory (14C)</p>
          <p className="text-gray-900">
            Est. {detail.pricing.estimatedValueCents != null ? `$${(detail.pricing.estimatedValueCents / 100).toFixed(2)}` : '—'}
            {detail.pricing.recommendedListing.lowCents != null && detail.pricing.recommendedListing.highCents != null && (
              <> · Recommended ${(detail.pricing.recommendedListing.lowCents / 100).toFixed(0)}–${(detail.pricing.recommendedListing.highCents / 100).toFixed(0)}</>
            )}
            {' · '}Confidence {detail.pricing.confidence.level}
            {detail.pricing.isAskOnly && ' (ask-only)'}
          </p>
        </div>
      )}

      {detail.convertedItemId ? (
        <div className="mt-4 rounded-md border border-green-200 bg-green-50 p-4 text-sm text-green-800">
          Resolved{detail.convertedItemSku ? ` — created SKU ${detail.convertedItemSku}` : ''}.
          <Link href={`/admin/items/${detail.convertedItemId}`} className="ml-2 text-blue-600 hover:underline">View Item →</Link>
        </div>
      ) : (
        <div className="mt-4">
          <IntakeExceptionResolveForm
            draftId={detail.id}
            code={detail.code}
            note={detail.note}
            catalogModelId={detail.catalogModelId}
            catalogLabel={detail.catalogLabel}
            storageLocationId={detail.storageLocationId}
            storageLabel={detail.storageLabel}
            condition={detail.condition}
            cardedOrLoose={detail.cardedOrLoose}
          />
        </div>
      )}
    </div>
  )
}
