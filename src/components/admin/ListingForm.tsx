'use client'

import { useActionState, useState } from 'react'
import Link from 'next/link'
import type { CatalogModel, ItemInstance, Listing, StorageLocation } from '@prisma/client'
import { createListing, updateListing, type ListingActionState } from '@/lib/actions/listings'
import { Button } from '@/components/admin/ui/Button'
import { Input } from '@/components/admin/ui/Input'
import { Select } from '@/components/admin/ui/Select'
import {
  calculateConsignmentPreview,
  type ConsignmentPreview,
} from '@/lib/sellerAgreementInventory'
import { formatCommissionDisplay } from '@/lib/sellerAgreementDisplay'

// ---------- shared types ----------

export type ConsignmentContextForListing = {
  agreementId: string
  submissionId: string
  commissionPercent: string
  fixedFee: string | null
  minimumSellerPayout: string | null
  agreedListPrice: string | null
  sellerTermsSummary: string | null
}

export type ItemWithRelations = ItemInstance & {
  catalog: CatalogModel
  location: StorageLocation | null
  consignmentContext?: ConsignmentContextForListing | null
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
        {item.sourceType === 'consignment' && (
          <>
            <dt className="text-gray-500">Ownership</dt>
            <dd className="text-blue-700 font-medium">Consignment</dd>
          </>
        )}
        {item.sourceType === 'buyout' && (
          <>
            <dt className="text-gray-500">Ownership</dt>
            <dd className="text-gray-700">Buyout</dd>
          </>
        )}
      </dl>
    </div>
  )
}

// ---------- consignment pricing panel ----------

function PreviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-xs">
      <dt className="text-gray-500">{label}</dt>
      <dd className="font-mono">{value}</dd>
    </div>
  )
}

function PayoutPreview({ preview }: { preview: ConsignmentPreview }) {
  if (!preview.valid) return null
  return (
    <div
      className={`rounded-md px-3 py-2 text-xs ${
        preview.belowMinimum
          ? 'bg-amber-50 border border-amber-200'
          : 'bg-white border border-blue-200'
      }`}
    >
      <p className="font-medium text-blue-900 mb-1.5">Projected seller payout</p>
      <dl className="space-y-0.5">
        <PreviewRow label="Listing price" value={`$${preview.listingPrice.toFixed(2)}`} />
        <PreviewRow label="Commission" value={`− $${preview.estimatedCommission.toFixed(2)}`} />
        {preview.estimatedFixedFee > 0 && (
          <PreviewRow label="Fixed fee" value={`− $${preview.estimatedFixedFee.toFixed(2)}`} />
        )}
        <div className="flex justify-between text-xs font-medium border-t border-gray-200 pt-0.5 mt-0.5">
          <dt>Seller proceeds</dt>
          <dd className="font-mono">${preview.estimatedProceeds.toFixed(2)}</dd>
        </div>
      </dl>
      {preview.belowMinimum && (
        <p className="mt-1.5 text-amber-800">
          Estimated proceeds are below the agreed minimum seller payout. Review listing price.
        </p>
      )}
      <p className="mt-1.5 text-gray-400 italic">Advisory only. Payout is not automatic.</p>
    </div>
  )
}

function ConsignmentPricingPanel({
  context,
  listingPriceStr,
}: {
  context: ConsignmentContextForListing
  listingPriceStr: string
}) {
  const preview = calculateConsignmentPreview({
    listingPriceStr,
    commissionPercent: context.commissionPercent,
    fixedFee: context.fixedFee,
    minimumSellerPayout: context.minimumSellerPayout,
  })

  return (
    <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-sm space-y-3">
      <div className="flex items-center justify-between">
        <p className="font-semibold text-blue-900">Consignment pricing context</p>
        <Link
          href={`/admin/seller-submissions/${context.submissionId}/agreement`}
          className="text-xs text-blue-700 hover:underline"
        >
          View agreement →
        </Link>
      </div>

      <dl className="space-y-1 text-xs">
        <div className="flex gap-3">
          <dt className="text-blue-700 w-32 shrink-0">Commission</dt>
          <dd className="text-blue-900">{formatCommissionDisplay(context.commissionPercent)}</dd>
        </div>
        {context.fixedFee && (
          <div className="flex gap-3">
            <dt className="text-blue-700 w-32 shrink-0">Fixed fee</dt>
            <dd className="text-blue-900">${parseFloat(context.fixedFee).toFixed(2)}</dd>
          </div>
        )}
        {context.minimumSellerPayout && (
          <div className="flex gap-3">
            <dt className="text-blue-700 w-32 shrink-0">Min. payout</dt>
            <dd className="text-blue-900">${parseFloat(context.minimumSellerPayout).toFixed(2)}</dd>
          </div>
        )}
        {context.agreedListPrice && (
          <div className="flex gap-3">
            <dt className="text-blue-700 w-32 shrink-0">Agreed price</dt>
            <dd className="text-blue-900">${parseFloat(context.agreedListPrice).toFixed(2)}</dd>
          </div>
        )}
      </dl>

      <PayoutPreview preview={preview} />

      {context.sellerTermsSummary && (
        <p className="text-xs text-blue-700 whitespace-pre-wrap border-t border-blue-200 pt-2">
          {context.sellerTermsSummary}
        </p>
      )}
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

      {selectedItem?.consignmentContext && (
        <ConsignmentPricingPanel
          context={selectedItem.consignmentContext}
          listingPriceStr={price}
        />
      )}

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

type EditProps = {
  listing: ListingWithItem
  consignmentContext?: ConsignmentContextForListing | null
}

export function EditListingForm({ listing, consignmentContext }: EditProps) {
  const action = updateListing.bind(null, listing.id)
  const [state, formAction, isPending] = useActionState<ListingActionState, FormData>(action, null)
  const [priceForPreview, setPriceForPreview] = useState(listing.price.toString())

  return (
    <form action={formAction} className="space-y-4 max-w-lg">
      <ItemSummary item={listing.item} />

      {consignmentContext && (
        <ConsignmentPricingPanel context={consignmentContext} listingPriceStr={priceForPreview} />
      )}

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
        onChange={(e) => setPriceForPreview(e.target.value)}
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
