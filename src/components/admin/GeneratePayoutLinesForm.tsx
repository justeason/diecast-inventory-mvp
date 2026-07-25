'use client'

import { useActionState } from 'react'
import { Button } from '@/components/admin/ui/Button'
import { generateMissingPayoutLines, type GeneratePayoutLinesActionState } from '@/lib/actions/sellerPayouts'

export function GeneratePayoutLinesForm({ orderId }: { orderId: string }) {
  const action = generateMissingPayoutLines.bind(null, orderId)
  const [state, formAction, isPending] = useActionState<GeneratePayoutLinesActionState, FormData>(
    action,
    null,
  )

  return (
    <form action={formAction} className="flex items-center gap-3">
      <Button type="submit" disabled={isPending}>
        {isPending ? 'Generating…' : 'Generate missing payout lines'}
      </Button>
      {state && 'success' in state && (
        <p className="text-sm text-green-700">
          {state.created === 0
            ? 'No new lines created (all present or no eligible items).'
            : `Created ${state.created} payout line${state.created !== 1 ? 's' : ''}.`}
        </p>
      )}
      {state && 'errors' in state && (
        <p className="text-sm text-red-600">{Object.values(state.errors).flat()[0]}</p>
      )}
    </form>
  )
}
