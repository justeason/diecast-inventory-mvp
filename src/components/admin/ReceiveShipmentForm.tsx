'use client'

import { useActionState } from 'react'
import { receiveSellerInboundShipment, adminCancelShipment } from '@/lib/actions/sellerInboundShipment'
import {
  type ShipmentActionState,
  CONDITION_STATUSES,
  CONDITION_LABELS,
  SHIPMENT_STATUS_LABELS,
} from '@/lib/sellerInboundShipmentConstants'

type IntakeDraftOption = {
  id: string
  status: string
  createdAt: Date
}

type Props = {
  shipmentId: string
  shipmentStatus: string
  expectedQuantity: number
  carrier: string | null
  trackingNumber: string | null
  availableDrafts: IntakeDraftOption[]
}

function ReceiveForm({ shipmentId, expectedQuantity, availableDrafts }: Omit<Props, 'shipmentStatus' | 'carrier' | 'trackingNumber'>) {
  const [state, formAction, isPending] = useActionState<ShipmentActionState, FormData>(
    receiveSellerInboundShipment,
    null,
  )

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="shipmentId" value={shipmentId} />

      {state?.errors?.form && (
        <p className="text-sm text-red-600">{state.errors.form[0]}</p>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Received quantity *</label>
          <input
            type="number"
            name="receivedQuantity"
            min={1}
            defaultValue={expectedQuantity}
            required
            className="w-full rounded-md border border-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {state?.errors?.receivedQuantity && (
            <p className="text-xs text-red-600 mt-0.5">{state.errors.receivedQuantity[0]}</p>
          )}
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Received date *</label>
          <input
            type="date"
            name="receivedAt"
            defaultValue={new Date().toISOString().split('T')[0]}
            required
            className="w-full rounded-md border border-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {state?.errors?.receivedAt && (
            <p className="text-xs text-red-600 mt-0.5">{state.errors.receivedAt[0]}</p>
          )}
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Condition *</label>
          <select
            name="conditionStatus"
            required
            className="w-full rounded-md border border-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">Select…</option>
            {CONDITION_STATUSES.map((s) => (
              <option key={s} value={s}>{CONDITION_LABELS[s]}</option>
            ))}
          </select>
          {state?.errors?.conditionStatus && (
            <p className="text-xs text-red-600 mt-0.5">{state.errors.conditionStatus[0]}</p>
          )}
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Received by</label>
          <input
            type="text"
            name="receivedBy"
            className="w-full rounded-md border border-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">Issue summary (required for non-good condition)</label>
        <textarea
          name="issueSummary"
          rows={2}
          maxLength={1000}
          className="w-full rounded-md border border-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        {state?.errors?.issueSummary && (
          <p className="text-xs text-red-600 mt-0.5">{state.errors.issueSummary[0]}</p>
        )}
      </div>

      {availableDrafts.length > 0 && (
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">Link to intake draft (optional)</label>
          <select
            name="intakeDraftId"
            className="w-full rounded-md border border-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">None — link later</option>
            {availableDrafts.map((d) => (
              <option key={d.id} value={d.id}>
                {d.status} — {d.createdAt.toLocaleDateString()}
              </option>
            ))}
          </select>
          {state?.errors?.intakeDraftId && (
            <p className="text-xs text-red-600 mt-0.5">{state.errors.intakeDraftId[0]}</p>
          )}
        </div>
      )}

      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1">Admin notes (internal)</label>
        <textarea
          name="adminNotes"
          rows={2}
          maxLength={2000}
          className="w-full rounded-md border border-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <label className="flex items-center gap-2 text-sm cursor-pointer">
        <input type="checkbox" name="confirm" required />
        <span>I confirm receipt of this package</span>
      </label>
      {state?.errors?.form?.[0]?.includes('confirm') && (
        <p className="text-xs text-red-600">{state.errors.form[0]}</p>
      )}

      <button
        type="submit"
        disabled={isPending}
        className="px-4 py-2 rounded-md bg-green-700 text-white text-sm font-medium hover:bg-green-800 disabled:opacity-50"
      >
        {isPending ? 'Confirming…' : 'Confirm receipt'}
      </button>
    </form>
  )
}

function CancelForm({ shipmentId }: { shipmentId: string }) {
  const [state, formAction, isPending] = useActionState<ShipmentActionState, FormData>(
    adminCancelShipment,
    null,
  )
  return (
    <form action={formAction} className="flex gap-2 items-end">
      <input type="hidden" name="shipmentId" value={shipmentId} />
      <div className="flex-1">
        <label className="block text-xs font-medium text-gray-700 mb-1">Cancel reason</label>
        <input
          type="text"
          name="cancelReason"
          maxLength={500}
          required
          className="w-full rounded-md border border-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>
      <button
        type="submit"
        disabled={isPending}
        className="px-3 py-1.5 rounded-md border border-red-200 text-red-700 text-sm hover:bg-red-50 disabled:opacity-50"
      >
        {isPending ? '…' : 'Cancel shipment'}
      </button>
      {state?.errors?.cancelReason && (
        <p className="text-xs text-red-600">{state.errors.cancelReason[0]}</p>
      )}
    </form>
  )
}

export function ReceiveShipmentForm({ shipmentId, shipmentStatus, expectedQuantity, carrier, trackingNumber, availableDrafts }: Props) {
  const isReceived = shipmentStatus === 'received' || shipmentStatus === 'issue'
  const canReceive = shipmentStatus === 'shipped'
  const canCancel = shipmentStatus === 'draft' || shipmentStatus === 'shipped'

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-gray-500">Status:</span>
        <span className="font-medium text-gray-900">
          {SHIPMENT_STATUS_LABELS[shipmentStatus] ?? shipmentStatus}
        </span>
        {carrier && <span className="text-gray-500">· {carrier}</span>}
        {trackingNumber && <span className="font-mono text-xs text-gray-600">{trackingNumber}</span>}
      </div>

      {canReceive && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">Confirm receipt</p>
          <ReceiveForm shipmentId={shipmentId} expectedQuantity={expectedQuantity} availableDrafts={availableDrafts} />
        </div>
      )}

      {isReceived && (
        <p className="text-sm text-green-700">This package has been received.</p>
      )}

      {canCancel && (
        <div className="pt-2 border-t border-gray-100">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">Cancel shipment</p>
          <CancelForm shipmentId={shipmentId} />
        </div>
      )}
    </div>
  )
}
