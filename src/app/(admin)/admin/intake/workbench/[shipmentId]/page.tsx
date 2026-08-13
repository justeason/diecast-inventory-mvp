import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getWorkbenchContext } from '@/lib/intakeWorkbenchQuery'
import { IntakeWorkbench } from '@/components/admin/IntakeWorkbench'

export const dynamic = 'force-dynamic'

export default async function IntakeWorkbenchPage({ params }: { params: Promise<{ shipmentId: string }> }) {
  const { shipmentId } = await params
  const context = await getWorkbenchContext(shipmentId)
  if (!context) notFound()

  const shipmentLabel = context.shipment.trackingNumber
    ? `Shipment ${context.shipment.trackingNumber}`
    : `Shipment ${context.shipment.id}`

  if (context.shipment.status !== 'received' && context.shipment.status !== 'issue') {
    return (
      <div className="max-w-2xl">
        <h1 className="text-lg font-semibold text-gray-900 mb-2">{shipmentLabel}</h1>
        <p className="text-sm text-gray-600">
          This shipment must be marked received before intake can begin (current status: {context.shipment.status}).
        </p>
      </div>
    )
  }

  if (context.eligibilityBlocked) {
    return (
      <div className="max-w-2xl">
        <h1 className="text-lg font-semibold text-gray-900 mb-2">{shipmentLabel}</h1>
        <p className="text-sm text-red-600">{context.eligibilityBlocked}</p>
        <Link href={`/admin/seller-submissions/${context.submission.id}/agreement`} className="mt-2 inline-block text-sm text-blue-600 hover:underline">
          Review agreement →
        </Link>
      </div>
    )
  }

  return (
    <IntakeWorkbench
      context={{
        shipmentId: context.shipment.id,
        shipmentLabel,
        shipmentStatus: context.shipment.status,
        sellerLabel: context.seller.label,
        portfolioName: context.portfolio?.name ?? null,
        agreementStatus: context.agreement?.status ?? null,
        expected: context.shipment.expectedQuantity,
        received: context.shipment.receivedQuantity,
        processed: context.progress.processed,
        exceptions: context.progress.exceptions,
        remaining: context.progress.remaining,
        defaultCondition: context.defaults.condition,
        defaultCardedOrLoose: context.defaults.cardedOrLoose,
        recentItems: context.recentItems.map((i) => ({ id: i.id, sku: i.sku, catalogLabel: i.catalogLabel, storageLabel: i.storageLabel })),
        reconciliation: context.reconciliation,
      }}
    />
  )
}
