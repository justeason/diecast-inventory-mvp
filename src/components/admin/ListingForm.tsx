'use client'

import { useActionState, useState } from 'react'
import Link from 'next/link'
import type { CatalogModel, ItemInstance, Listing, StorageLocation } from '@prisma/client'
import { createListing, updateListing, type ListingActionState } from '@/lib/actions/listings'
import { Button } from '@/components/admin/ui/Button'
import { Input } from '@/components/admin/ui/Input'
import { Select } from '@/components/admin/ui/Select'

// ---------- shared types ----------

export type ItemWithRelations = ItemInstance & {
  catalog: CatalogModel
  location: StorageLocation | null
}

export type ListingWithItem = Listing & {
  item: ItemWithRelations
}

// ---------- helpers ----------

function generateTitle(item: ItemWithRelations): string {
  const c = item.catalog
  const details = [c.year?.toString(), c.series, c.color].filter(Boolean)
  const suffix = details.length ? ` - ${details.join(' ')}` : ''
  return `${c.brand} ${c.name}${suffix}`
}

const CONDITION_LABELS: Record<string, string> = {
  mint: 'Mint',
  near_mint: 'Near Mint',
  good: 'Good',
  fair: 'Fair',
  poor: 'Poor',
  damaged: 'Damaged',
}

const LISTING_STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'sold', label: 'Sold' },
  { value: 'archived', label: 'Archived' },
]

// ---------- shared item summary ----------

function ItemSummary({ item }: { item: ItemWithRelations }) {
  return (
    <div className="rounded-md bg-gray-50 border border-gray-200 p-4 text-sm">
      <p className="font-medium text-gray-700 mb-3">Item Details</p>
      <dl className="grid grid-cols-[7rem_1fr] gap-y-1.5">
        <dt className="text-gray-500">SKU</dt>
        <dd className="font-mono text-xs">{item.sku}</dd>
        <dt className="text-gray-500">Model</dt>
        <dd>{item.catalog.brand} – {item.catalog.name}</dd>
        <dt className="text-gray-500">Condition</dt>
        <dd>{CONDITION_LABELS[item.condition] ?? item.condition}</dd>
        <dt className="text-gray-500">Location</dt>
        <dd>{item.location?.label ?? '—'}</dd>
        <dt className="text-gray-500">List Price</dt>
        <dd>{item.listPrice != null ? `$${item.listPrice.toFixed(2)}` : '—'}</dd>
      </dl>
    </div>
  )
}

// ---------- Create ----------

type CreateProps = {
  items: ItemWithRelations[]
  preSelectedItem: ItemWithRelations | null
}

export function CreateListingForm({ items, preSelectedItem }: CreateProps) {
  const [selectedItem, setSelectedItem] = useState<ItemWithRelations | null>(preSelectedItem)
  const [title, setTitle] = useState(preSelectedItem ? generateTitle(preSelectedItem) : '')
  const [price, setPrice] = useState(preSelectedItem?.listPrice?.toString() ?? '')
  const [state, formAction, isPending] = useActionState<ListingActionState, FormData>(createListing, null)

  const itemOptions = items.map((item) => ({
    value: item.id,
    label: `${item.sku} — ${item.catalog.brand} ${item.catalog.name}`,
  }))

  function handleItemChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const item = items.find((i) => i.id === e.target.value) ?? null
    setSelectedItem(item)
    setTitle(item ? generateTitle(item) : '')
    setPrice(item?.listPrice?.toString() ?? '')
  }

  if (items.length === 0) {
    return (
      <div className="rounded-md bg-yellow-50 border border-yellow-200 p-4 text-sm text-yellow-800">
        No eligible items found. Items must have status <strong>available</strong> and no existing
        listing.
      </div>
    )
  }

  return (
    <form action={formAction} className="space-y-4 max-w-lg">
      <Select
        label="Item"
        name="itemId"
        required
        options={itemOptions}
        value={selectedItem?.id ?? ''}
        onChange={handleItemChange}
        placeholder="Select an item…"
        error={state?.errors?.itemId?.[0]}
      />

      {selectedItem && <ItemSummary item={selectedItem} />}

      <Input
        label="Title"
        name="title"
        required
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        error={state?.errors?.title?.[0]}
      />

      <Input
        label="Price ($)"
        name="price"
        type="number"
        step="0.01"
        min="0"
        required
        value={price}
        onChange={(e) => setPrice(e.target.value)}
        error={state?.errors?.price?.[0]}
      />

      <Input
        label="Description"
        name="description"
        placeholder="Optional details about this listing…"
        error={state?.errors?.description?.[0]}
      />

      <div className="flex gap-3 pt-2">
        <Button type="submit" disabled={isPending || !selectedItem}>
          {isPending ? 'Saving…' : 'Create Listing'}
        </Button>
        <Link href="/admin/listings">
          <Button type="button" variant="secondary">Cancel</Button>
        </Link>
      </div>
    </form>
  )
}

// ---------- Edit ----------

type EditProps = { listing: ListingWithItem }

export function EditListingForm({ listing }: EditProps) {
  const action = updateListing.bind(null, listing.id)
  const [state, formAction, isPending] = useActionState<ListingActionState, FormData>(action, null)

  return (
    <form action={formAction} className="space-y-4 max-w-lg">
      <ItemSummary item={listing.item} />

      <Input
        label="Title"
        name="title"
        required
        defaultValue={listing.title}
        error={state?.errors?.title?.[0]}
      />

      <Input
        label="Price ($)"
        name="price"
        type="number"
        step="0.01"
        min="0"
        required
        defaultValue={listing.price.toString()}
        error={state?.errors?.price?.[0]}
      />

      <Input
        label="Description"
        name="description"
        defaultValue={listing.description ?? ''}
        error={state?.errors?.description?.[0]}
      />

      <Select
        label="Status"
        name="status"
        options={LISTING_STATUS_OPTIONS}
        defaultValue={listing.status}
        error={state?.errors?.status?.[0]}
      />

      <div className="flex gap-3 pt-2">
        <Button type="submit" disabled={isPending}>
          {isPending ? 'Saving…' : 'Update Listing'}
        </Button>
        <Link href="/admin/listings">
          <Button type="button" variant="secondary">Cancel</Button>
        </Link>
      </div>
    </form>
  )
}
