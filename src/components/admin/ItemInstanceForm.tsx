'use client'

import { useActionState } from 'react'
import Link from 'next/link'
import { CatalogModel, ItemInstance, StorageLocation } from '@prisma/client'
import { createItemInstance, updateItemInstance, ItemActionState } from '@/lib/actions/items'
import { Button } from '@/components/admin/ui/Button'
import { Input } from '@/components/admin/ui/Input'
import { Select } from '@/components/admin/ui/Select'

type Props = {
  item?: ItemInstance
  catalogModels: CatalogModel[]
  locations: StorageLocation[]
}

const CONDITION_OPTIONS = [
  { value: 'mint', label: 'Mint' },
  { value: 'near_mint', label: 'Near Mint' },
  { value: 'good', label: 'Good' },
  { value: 'fair', label: 'Fair' },
  { value: 'poor', label: 'Poor' },
  { value: 'damaged', label: 'Damaged' },
]

const STATUS_OPTIONS = [
  { value: 'draft', label: 'Draft' },
  { value: 'available', label: 'Available' },
  { value: 'reserved', label: 'Reserved' },
  { value: 'sold', label: 'Sold' },
  { value: 'not_for_sale', label: 'Not for Sale' },
]

const CARDED_OPTIONS = [
  { value: 'carded', label: 'Carded' },
  { value: 'loose', label: 'Loose' },
]

export function ItemInstanceForm({ item, catalogModels, locations }: Props) {
  const action = item ? updateItemInstance.bind(null, item.id) : createItemInstance
  const [state, formAction, isPending] = useActionState<ItemActionState, FormData>(action, null)

  const catalogOptions = catalogModels.map((m) => ({
    value: m.id,
    label: `${m.brand} – ${m.name}${m.year ? ` (${m.year})` : ''}`,
  }))

  const locationOptions = [
    { value: '', label: '— No location —' },
    ...locations.map((l) => ({ value: l.id, label: l.label })),
  ]

  return (
    <form action={formAction} className="space-y-4 max-w-lg">
      <Input label="SKU" name="sku" required defaultValue={item?.sku ?? ''} error={state?.errors?.sku?.[0]} />

      <Select
        label="Catalog Model"
        name="catalogId"
        required
        options={catalogOptions}
        defaultValue={item?.catalogId ?? ''}
        placeholder="Select a model…"
        error={state?.errors?.catalogId?.[0]}
      />

      <Select
        label="Storage Location"
        name="locationId"
        options={locationOptions}
        defaultValue={item?.locationId ?? ''}
        error={state?.errors?.locationId?.[0]}
      />

      <Select
        label="Carded or Loose"
        name="cardedOrLoose"
        required
        options={CARDED_OPTIONS}
        defaultValue={item?.cardedOrLoose ?? ''}
        placeholder="Select…"
        error={state?.errors?.cardedOrLoose?.[0]}
      />

      <Select
        label="Condition"
        name="condition"
        required
        options={CONDITION_OPTIONS}
        defaultValue={item?.condition ?? ''}
        placeholder="Select…"
        error={state?.errors?.condition?.[0]}
      />

      <Input
        label="Condition Notes"
        name="conditionNotes"
        defaultValue={item?.conditionNotes ?? ''}
        error={state?.errors?.conditionNotes?.[0]}
      />

      <Input
        label="Purchase Price"
        name="purchasePrice"
        type="number"
        step="0.01"
        min="0"
        defaultValue={item?.purchasePrice ?? ''}
        error={state?.errors?.purchasePrice?.[0]}
      />

      <Input
        label="List Price"
        name="listPrice"
        type="number"
        step="0.01"
        min="0"
        defaultValue={item?.listPrice ?? ''}
        error={state?.errors?.listPrice?.[0]}
      />

      <Select
        label="Status"
        name="status"
        required
        options={STATUS_OPTIONS}
        defaultValue={item?.status ?? 'draft'}
        error={state?.errors?.status?.[0]}
      />

      <Input label="Notes" name="notes" defaultValue={item?.notes ?? ''} error={state?.errors?.notes?.[0]} />

      <div className="flex gap-3 pt-2">
        <Button type="submit" disabled={isPending}>
          {isPending ? 'Saving…' : item ? 'Update Item' : 'Create Item'}
        </Button>
        <Link href="/admin/items">
          <Button type="button" variant="secondary">Cancel</Button>
        </Link>
      </div>
    </form>
  )
}
