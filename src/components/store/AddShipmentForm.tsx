'use client'

import { useActionState } from 'react'
import { saveSellerInboundShipment, sellerCancelShipment } from '@/lib/actions/sellerInboundShipment'
import {
  type ShipmentActionState,
  SHIPMENT_STATUS_LABELS,
  SELLER_CONDITION_LABELS,
  type ConditionStatus,
} from '@/lib/sellerInboundShipmentConstants'

type ExistingShipment = {
  id: string
  status: string
  carrier: string | null
  trackingNumber: string | null
  expectedQuantity: number
  shippedAt: Date | null
  receivedAt: Date | null
  sellerNotes: string | null
  conditionStatus: string | null
  issueSummary: string | null
}

type Props = {
  submissionId: string
  shipments: ExistingShipment[]
}

const STATUS_COLORS: Record<string, string> = {
  draft:     'bg-gray-100 text-gray-600',
  shipped:   'bg-blue-100 text-blue-700',
  received:  'bg-green-100 text-green-700',
  issue:     'bg-amber-100 text-amber-700',
  cancelled: 'bg-gray-50 text-gray-400',
}

function ShipmentRow({ shipment }: { shipment: ExistingShipment }) {
  const [cancelState, cancelAction, cancelPending] = useActionState<ShipmentActionState, FormData>(
    sellerCancelShipment,
    null,
  )

  const canEdit = shipment.status === 'draft' || shipment.status === 'shipped'
  const canCancel = canEdit
  const isReceived = shipment.status === 'received' || shipment.status === 'issue'

  return (
    <div className="rounded-md border border-gray-200 bg-gray-50 p-4 text-sm space-y-2">
      <div className="flex items-center gap-2">
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[shipment.status] ?? 'bg-gray-100 text-gray-600'}`}
        >
          {SHIPMENT_STATUS_LABELS[shipment.status] ?? shipment.status}
        </span>
        {shipment.carrier && (
          <span className="text-gray-700">{shipment.carrier}</span>
        )}
        {shipment.trackingNumber && (
          <span className="font-mono text-gray-600 text-xs">{shipment.trackingNumber}</span>
        )}
      </div>

      <dl className="space-y-1">
        <div className="flex gap-3">
          <dt className="text-gray-500 w-36 shrink-0">Expected qty</dt>
          <dd className="text-gray-900">{shipment.expectedQuantity}</dd>
        </div>
        {shipment.shippedAt && (
          <div className="flex gap-3">
            <dt className="text-gray-500 w-36 shrink-0">Shipped</dt>
            <dd className="text-gray-900">{new Date(shipment.shippedAt).toLocaleDateString()}</dd>
          </div>
        )}
        {isReceived && shipment.receivedAt && (
          <div className="flex gap-3">
            <dt className="text-gray-500 w-36 shrink-0">Received</dt>
            <dd className="text-gray-900">{new Date(shipment.receivedAt).toLocaleDateString()}</dd>
          </div>
        )}
        {isReceived && shipment.conditionStatus && (
          <div className="flex gap-3">
            <dt className="text-gray-500 w-36 shrink-0">Condition</dt>
            <dd className="text-gray-900">
              {SELLER_CONDITION_LABELS[shipment.conditionStatus as ConditionStatus] ?? shipment.conditionStatus}
            </dd>
          </div>
        )}
        {isReceived && shipment.issueSummary && (
          <div className="flex gap-3">
            <dt className="text-gray-500 w-36 shrink-0">Note</dt>
            <dd className="text-gray-900">{shipment.issueSummary}</dd>
          </div>
        )}
        {shipment.sellerNotes && (
          <div className="flex gap-3">
            <dt className="text-gray-500 w-36 shrink-0">Your notes</dt>
            <dd className="text-gray-900 whitespace-pre-wrap">{shipment.sellerNotes}</dd>
          </div>
        )}
      </dl>

      {canCancel && (
        <form action={cancelAction} className="mt-2">
          <input type="hidden" name="shipmentId" value={shipment.id} />
          {cancelState?.errors?.form && (
            <p className="text-xs text-red-600 mb-1">{cancelState.errors.form[0]}</p>
          )}
          <button
            type="submit"
            disabled={cancelPending}
            className="text-xs text-red-600 hover:underline disabled:opacity-50"
          >
            {cancelPending ? 'Cancelling…' : 'Cancel package'}
          </button>
        </form>
      )}
    </div>
  )
}

function AddForm({ submissionId }: { submissionId: string }) {
  const [state, formAction, isPending] = useActionState<ShipmentActionState, FormData>(
    saveSellerInboundShipment,
    null,
  )

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="submissionId" value={submissionId} />

      {state?.errors?.form && (
        <p className="text-sm text-red-600">{state.errors.form[0]}</p>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Carrier *</label>
          <input
            type="text"
            name="carrier"
            placeholder="e.g. USPS, UPS, FedEx"
            maxLength={100}
            required
            className="w-full rounded-md border border-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {state?.errors?.carrier && (
            <p className="text-xs text-red-600 mt-0.5">{state.errors.carrier[0]}</p>
          )}
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Tracking number *</label>
          <input
            type="text"
            name="trackingNumber"
            maxLength={100}
            required
            className="w-full rounded-md border border-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {state?.errors?.trackingNumber && (
            <p className="text-xs text-red-600 mt-0.5">{state.errors.trackingNumber[0]}</p>
          )}
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Expected quantity *</label>
          <input
            type="number"
            name="expectedQuantity"
            min={1}
            defaultValue={1}
            required
            className="w-full rounded-md border border-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {state?.errors?.expectedQuantity && (
            <p className="text-xs text-red-600 mt-0.5">{state.errors.expectedQuantity[0]}</p>
          )}
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Date shipped (optional)</label>
          <input
            type="date"
            name="shippedAt"
            className="w-full rounded-md border border-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">Notes (optional)</label>
        <textarea
          name="sellerNotes"
          rows={2}
          maxLength={2000}
          placeholder="Any notes about this package…"
          className="w-full rounded-md border border-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <button
        type="submit"
        disabled={isPending}
        className="px-4 py-2 rounded-md bg-gray-800 text-white text-sm font-medium hover:bg-gray-900 disabled:opacity-50"
      >
        {isPending ? 'Saving…' : 'Add package'}
      </button>
    </form>
  )
}

export function AddShipmentForm({ submissionId, shipments }: Props) {
  const activeShipments = shipments.filter((s) => s.status !== 'cancelled')
  const cancelledShipments = shipments.filter((s) => s.status === 'cancelled')

  return (
    <div className="space-y-4">
      {activeShipments.map((s) => (
        <ShipmentRow key={s.id} shipment={s} />
      ))}

      {cancelledShipments.length > 0 && (
        <div className="space-y-2">
          {cancelledShipments.map((s) => (
            <ShipmentRow key={s.id} shipment={s} />
          ))}
        </div>
      )}

      <div>
        <p className="text-xs font-medium text-gray-700 mb-2">Add a package</p>
        <AddForm submissionId={submissionId} />
      </div>
    </div>
  )
}
