'use client'

import { useState } from 'react'
import { useActionState } from 'react'
import Link from 'next/link'
import { ItemInstance, StorageLocation } from '@prisma/client'
import { createItemInstance, updateItemInstance, ItemActionState } from '@/lib/actions/items'
import { CatalogModelCombobox } from '@/components/admin/CatalogModelCombobox'
import { Button } from '@/components/admin/ui/Button'
import { Input } from '@/components/admin/ui/Input'
import { Select } from '@/components/admin/ui/Select'

type Props = {
  item?: ItemInstance
  defaultCatalogId?: string
  defaultCatalogLabel?: string
  locations: StorageLocation[]
  prefill?: ItemInstance
  suggestedSku?: string
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

export function ItemInstanceForm({ item, defaultCatalogId, defaultCatalogLabel, locations, prefill, suggestedSku }: Props) {
  const action = item ? updateItemInstance.bind(null, item.id) : createItemInstance
  const [state, formAction, isPending] = useActionState<ItemActionState, FormData>(action, null)

  const isCreate = !item
  const src = prefill ?? item

  // Controlled SKU state in create mode so we can offer a clickable suggestion.
  const [sku, setSku] = useState(prefill ? '' : (item?.sku ?? ''))

  const locationOptions = [
    { value: '', label: '— No location —' },
    ...locations.map((l) => ({ value: l.id, label: l.label })),
  ]

  // Status default: always 'available' when duplicating, otherwise use item value or 'draft'
  const defaultStatus = prefill ? 'available' : (item?.status ?? 'draft')

  return (
    <form action={formAction} className="space-y-4 max-w-lg">
      <div className="flex flex-col gap-1">
        {isCreate && suggestedSku && (
          <p className="text-xs text-gray-500">
            Suggested:{' '}
            <button
              type="button"
              onClick={() => setSku(suggestedSku)}
              className="font-mono text-indigo-600 hover:underline focus:outline-none"
            >
              {suggestedSku}
            </button>
            <span className="ml-1 text-gray-400">(click to use)</span>
          </p>
        )}
        <Input
          label="SKU"
          name="sku"
          required
          value={sku}
          onChange={(e) => setSku(e.target.value)}
          autoFocus={!!prefill}
          error={state?.errors?.sku?.[0]}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium text-gray-700">
          Catalog Model <span className="text-red-500">*</span>
        </label>
        <CatalogModelCombobox
          name="catalogId"
          defaultValue={defaultCatalogId ?? src?.catalogId ?? ''}
          defaultLabel={defaultCatalogLabel ?? ''}
        />
        {state?.errors?.catalogId?.[0] && (
          <p className="text-xs text-red-600">{state.errors.catalogId[0]}</p>
        )}
      </div>

      {isCreate && locations.length === 0 ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
          <p className="font-medium text-amber-800 mb-1">No storage locations defined.</p>
          <p className="text-amber-700">
            <Link href="/admin/locations/new" className="underline hover:no-underline">
              Create one
            </Link>{' '}
            before adding inventory.
          </p>
        </div>
      ) : (
        <Select
          label="Storage Location"
          name="locationId"
          required={isCreate}
          options={locationOptions}
          defaultValue={src?.locationId ?? ''}
          error={state?.errors?.locationId?.[0]}
        />
      )}

      <Select
        label="Carded or Loose"
        name="cardedOrLoose"
        required
        options={CARDED_OPTIONS}
        defaultValue={src?.cardedOrLoose ?? ''}
        placeholder="Select…"
        error={state?.errors?.cardedOrLoose?.[0]}
      />

      <Select
        label="Condition"
        name="condition"
        required
        options={CONDITION_OPTIONS}
        defaultValue={src?.condition ?? ''}
        placeholder="Select…"
        error={state?.errors?.condition?.[0]}
      />

      <Input
        label="Condition Notes"
        name="conditionNotes"
        defaultValue={src?.conditionNotes ?? ''}
        error={state?.errors?.conditionNotes?.[0]}
      />

      <Input
        label="Purchase Price"
        name="purchasePrice"
        type="number"
        step="0.01"
        min="0"
        defaultValue={src?.purchasePrice ?? ''}
        error={state?.errors?.purchasePrice?.[0]}
      />

      <Input
        label="List Price"
        name="listPrice"
        type="number"
        step="0.01"
        min="0"
        defaultValue={src?.listPrice ?? ''}
        error={state?.errors?.listPrice?.[0]}
      />

      <Select
        label="Status"
        name="status"
        required
        options={STATUS_OPTIONS}
        defaultValue={defaultStatus}
        error={state?.errors?.status?.[0]}
      />

      <Input
        label="Notes"
        name="notes"
        defaultValue={src?.notes ?? ''}
        error={state?.errors?.notes?.[0]}
      />

      <div className="flex flex-wrap gap-3 pt-2">
        <Button type="submit" disabled={isPending}>
          {isPending ? 'Saving…' : item ? 'Update Item' : 'Create Item'}
        </Button>
        {isCreate && (
          <Button
            type="submit"
            name="_redirect"
            value="another"
            variant="secondary"
            disabled={isPending}
          >
            Save and create another
          </Button>
        )}
        <Link href="/admin/items">
          <Button type="button" variant="secondary">Cancel</Button>
        </Link>
      </div>
    </form>
  )
}
