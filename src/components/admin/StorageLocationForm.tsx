'use client'

import { useActionState } from 'react'
import Link from 'next/link'
import { StorageLocation } from '@prisma/client'
import { createStorageLocation, updateStorageLocation, LocationActionState } from '@/lib/actions/locations'
import { Button } from '@/components/admin/ui/Button'
import { Input } from '@/components/admin/ui/Input'

type Props = { location?: StorageLocation }

export function StorageLocationForm({ location }: Props) {
  const action = location ? updateStorageLocation.bind(null, location.id) : createStorageLocation
  const [state, formAction, isPending] = useActionState<LocationActionState, FormData>(action, null)

  return (
    <form action={formAction} className="space-y-4 max-w-lg">
      <Input label="Label" name="label" required defaultValue={location?.label ?? ''} error={state?.errors?.label?.[0]} />
      <Input label="Notes" name="notes" defaultValue={location?.notes ?? ''} error={state?.errors?.notes?.[0]} />

      <div className="flex gap-3 pt-2">
        <Button type="submit" disabled={isPending}>
          {isPending ? 'Saving…' : location ? 'Update Location' : 'Create Location'}
        </Button>
        <Link href="/admin/locations">
          <Button type="button" variant="secondary">Cancel</Button>
        </Link>
      </div>
    </form>
  )
}
