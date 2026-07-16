'use client'

import { useActionState } from 'react'
import Link from 'next/link'
import type { CatalogModel, CollectionItem } from '@prisma/client'
import {
  createCollectionItem,
  updateCollectionItem,
  type CollectionItemActionState,
} from '@/lib/actions/collectionItems'

const CONDITION_OPTIONS = [
  { value: 'mint',      label: 'Mint' },
  { value: 'near_mint', label: 'Near Mint' },
  { value: 'good',      label: 'Good' },
  { value: 'fair',      label: 'Fair' },
  { value: 'poor',      label: 'Poor' },
  { value: 'damaged',   label: 'Damaged' },
]

const CARDED_LOOSE_OPTIONS = [
  { value: 'carded', label: 'Carded (on original packaging)' },
  { value: 'loose',  label: 'Loose (removed from packaging)' },
]

type CatalogOption = Pick<CatalogModel, 'id' | 'brand' | 'name' | 'year' | 'color' | 'series'>

type CreateProps = {
  mode: 'create'
  catalogModels: CatalogOption[]
}

type EditProps = {
  mode: 'edit'
  item: CollectionItem
  catalogModels: CatalogOption[]
}

type Props = CreateProps | EditProps

function formatCatalogOption(m: CatalogOption): string {
  const parts = [m.brand, m.name]
  if (m.year) parts.push(`(${m.year})`)
  if (m.color) parts.push(`— ${m.color}`)
  if (m.series) parts.push(`[${m.series}]`)
  return parts.join(' ')
}

function formatDateForInput(d: Date | string | null | undefined): string {
  if (!d) return ''
  const date = d instanceof Date ? d : new Date(d)
  return date.toISOString().split('T')[0]
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null
  return <p className="mt-0.5 text-xs text-red-600">{message}</p>
}

export function CollectionItemForm(props: Props) {
  const isCreate = props.mode === 'create'
  const item = isCreate ? null : (props as EditProps).item
  const { catalogModels } = props

  const action = isCreate
    ? createCollectionItem
    : updateCollectionItem.bind(null, (props as EditProps).item.id)

  const [state, formAction, isPending] = useActionState<CollectionItemActionState, FormData>(
    action,
    null
  )

  const errors = state?.errors ?? {}
  const cancelHref = item ? `/account/collection/${item.id}` : '/account/collection'

  const inputClass = (field: string) =>
    `w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900 ${
      errors[field] ? 'border-red-500' : 'border-gray-300'
    }`

  return (
    <form action={formAction} className="space-y-8 max-w-lg">
      {/* Global form error */}
      {errors.form && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {errors.form[0]}
        </div>
      )}

      {/* ── Identification ────────────────────────────────────────── */}
      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">Item identification</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            At least one of catalog match, brand, or name is required.
          </p>
        </div>

        {/* Catalog model (optional) */}
        <div className="flex flex-col gap-1">
          <label htmlFor="catalogId" className="text-sm font-medium text-gray-700">
            Catalog model <span className="font-normal text-gray-400">(optional)</span>
          </label>
          <select
            id="catalogId"
            name="catalogId"
            defaultValue={item?.catalogId ?? ''}
            className={inputClass('catalogId')}
          >
            <option value="">No catalog match</option>
            {catalogModels.map((m) => (
              <option key={m.id} value={m.id}>
                {formatCatalogOption(m)}
              </option>
            ))}
          </select>
          <p className="text-xs text-gray-400">
            Linking to a catalog model is optional. Your collection details stay private and do not
            create or modify any public catalog records.
          </p>
          <FieldError message={errors.catalogId?.[0]} />
        </div>

        {/* Brand */}
        <div className="flex flex-col gap-1">
          <label htmlFor="brand" className="text-sm font-medium text-gray-700">Brand</label>
          <input
            id="brand"
            name="brand"
            type="text"
            defaultValue={item?.brand ?? ''}
            placeholder="e.g. Hot Wheels, Matchbox"
            className={inputClass('brand')}
          />
          <FieldError message={errors.brand?.[0]} />
        </div>

        {/* Name */}
        <div className="flex flex-col gap-1">
          <label htmlFor="name" className="text-sm font-medium text-gray-700">Model name</label>
          <input
            id="name"
            name="name"
            type="text"
            defaultValue={item?.name ?? ''}
            placeholder="e.g. Ferrari 308 GTS"
            className={inputClass('name')}
          />
          <FieldError message={errors.name?.[0]} />
        </div>

        {/* Year + Series */}
        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-1">
            <label htmlFor="year" className="text-sm font-medium text-gray-700">Year</label>
            <input
              id="year"
              name="year"
              type="number"
              min="1950"
              max="2100"
              defaultValue={item?.year ?? ''}
              placeholder="e.g. 1995"
              className={inputClass('year')}
            />
            <FieldError message={errors.year?.[0]} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="series" className="text-sm font-medium text-gray-700">Series</label>
            <input
              id="series"
              name="series"
              type="text"
              defaultValue={item?.series ?? ''}
              placeholder="e.g. Treasure Hunt"
              className={inputClass('series')}
            />
            <FieldError message={errors.series?.[0]} />
          </div>
        </div>

        {/* Color + Scale */}
        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-1">
            <label htmlFor="color" className="text-sm font-medium text-gray-700">Color</label>
            <input
              id="color"
              name="color"
              type="text"
              defaultValue={item?.color ?? ''}
              placeholder="e.g. Red"
              className={inputClass('color')}
            />
            <FieldError message={errors.color?.[0]} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="scale" className="text-sm font-medium text-gray-700">Scale</label>
            <input
              id="scale"
              name="scale"
              type="text"
              defaultValue={item?.scale ?? ''}
              placeholder="e.g. 1:64"
              className={inputClass('scale')}
            />
            <FieldError message={errors.scale?.[0]} />
          </div>
        </div>
      </section>

      {/* ── Condition ─────────────────────────────────────────────── */}
      <section className="space-y-4 pt-4 border-t border-gray-100">
        <h2 className="text-sm font-semibold text-gray-900">Condition</h2>

        {/* Carded / Loose */}
        <div className="flex flex-col gap-1">
          <label htmlFor="cardedOrLoose" className="text-sm font-medium text-gray-700">
            Carded or loose
          </label>
          <select
            id="cardedOrLoose"
            name="cardedOrLoose"
            defaultValue={item?.cardedOrLoose ?? ''}
            className={inputClass('cardedOrLoose')}
          >
            <option value="">Not specified</option>
            {CARDED_LOOSE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <FieldError message={errors.cardedOrLoose?.[0]} />
        </div>

        {/* Condition */}
        <div className="flex flex-col gap-1">
          <label htmlFor="condition" className="text-sm font-medium text-gray-700">Condition</label>
          <select
            id="condition"
            name="condition"
            defaultValue={item?.condition ?? ''}
            className={inputClass('condition')}
          >
            <option value="">Not specified</option>
            {CONDITION_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <FieldError message={errors.condition?.[0]} />
        </div>

        {/* Condition notes */}
        <div className="flex flex-col gap-1">
          <label htmlFor="conditionNotes" className="text-sm font-medium text-gray-700">
            Condition notes
          </label>
          <input
            id="conditionNotes"
            name="conditionNotes"
            type="text"
            defaultValue={item?.conditionNotes ?? ''}
            placeholder="e.g. Minor card crease, paint chip on roof"
            className={inputClass('conditionNotes')}
          />
          <FieldError message={errors.conditionNotes?.[0]} />
        </div>
      </section>

      {/* ── Personal details ──────────────────────────────────────── */}
      <section className="space-y-4 pt-4 border-t border-gray-100">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">Personal details</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            These fields are private and only visible to you.
          </p>
        </div>

        {/* Quantity */}
        <div className="flex flex-col gap-1">
          <label htmlFor="quantity" className="text-sm font-medium text-gray-700">Quantity</label>
          <input
            id="quantity"
            name="quantity"
            type="number"
            min="1"
            step="1"
            defaultValue={item?.quantity ?? 1}
            className={`${inputClass('quantity')} max-w-[8rem]`}
          />
          <FieldError message={errors.quantity?.[0]} />
        </div>

        {/* Purchase price + date */}
        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-1">
            <label htmlFor="purchasePrice" className="text-sm font-medium text-gray-700">
              Purchase price ($)
            </label>
            <input
              id="purchasePrice"
              name="purchasePrice"
              type="number"
              min="0"
              step="0.01"
              defaultValue={item?.purchasePrice ?? ''}
              placeholder="0.00"
              className={inputClass('purchasePrice')}
            />
            <FieldError message={errors.purchasePrice?.[0]} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="purchaseDate" className="text-sm font-medium text-gray-700">
              Purchase date
            </label>
            <input
              id="purchaseDate"
              name="purchaseDate"
              type="date"
              defaultValue={formatDateForInput(item?.purchaseDate)}
              className={inputClass('purchaseDate')}
            />
            <FieldError message={errors.purchaseDate?.[0]} />
          </div>
        </div>

        {/* Notes */}
        <div className="flex flex-col gap-1">
          <label htmlFor="notes" className="text-sm font-medium text-gray-700">Notes</label>
          <textarea
            id="notes"
            name="notes"
            rows={3}
            defaultValue={item?.notes ?? ''}
            placeholder="Any personal notes about this item…"
            className={`${inputClass('notes')} resize-y`}
          />
          <FieldError message={errors.notes?.[0]} />
        </div>
      </section>

      {/* ── Actions ───────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 pt-2">
        <button
          type="submit"
          disabled={isPending}
          className="rounded-md bg-gray-900 px-5 py-2 text-sm font-medium text-white hover:bg-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isPending
            ? 'Saving…'
            : isCreate
            ? 'Add to Collection'
            : 'Save Changes'}
        </button>
        <Link
          href={cancelHref}
          className="text-sm text-gray-500 hover:text-gray-900 transition-colors"
        >
          Cancel
        </Link>
      </div>
    </form>
  )
}
