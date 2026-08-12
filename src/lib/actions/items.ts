'use server'

import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'

function isValidNonNegativePrice(v: string | undefined): boolean {
  if (!v || !v.trim()) return true
  const n = Number(v)
  return Number.isFinite(n) && n >= 0
}

// 15C-review section 1: sku is the permanent, immutable operator-facing item
// identity — assigned exactly once, at creation. UpdateItemSchema deliberately has
// NO sku field at all, so an update request can never carry one, regardless of what a
// modified form/browser submits — this is enforced by the schema shape itself, not
// just by convention.
const MutableItemFields = {
  catalogId: z.string().min(1, 'Catalog model is required'),
  locationId: z.string().optional(),
  cardedOrLoose: z.enum(['carded', 'loose'], { error: 'Carded or Loose is required' }),
  condition: z.enum(['mint', 'near_mint', 'good', 'fair', 'poor', 'damaged'], {
    error: 'Condition is required',
  }),
  conditionNotes: z.string().optional(),
  purchasePrice: z.string().optional()
    .refine(isValidNonNegativePrice, 'Purchase price must be a valid number and cannot be negative'),
  listPrice: z.string().optional()
    .refine(isValidNonNegativePrice, 'List price must be a valid number and cannot be negative'),
  status: z.enum(['draft', 'available', 'reserved', 'sold', 'not_for_sale'], {
    error: 'Status is required',
  }),
  notes: z.string().optional(),
}

const CreateItemSchema = z.object({
  sku: z.string().min(1, 'SKU is required'),
  ...MutableItemFields,
})

const UpdateItemSchema = z.object(MutableItemFields)

export type ItemActionState = { errors: Record<string, string[]> } | null

function toMutableDbData(d: z.infer<typeof UpdateItemSchema>) {
  return {
    catalogId: d.catalogId,
    locationId: d.locationId || undefined,
    cardedOrLoose: d.cardedOrLoose,
    condition: d.condition,
    conditionNotes: d.conditionNotes || undefined,
    purchasePrice: d.purchasePrice?.trim() ? Number(d.purchasePrice.trim()) : undefined,
    listPrice: d.listPrice?.trim() ? Number(d.listPrice.trim()) : undefined,
    status: d.status,
    notes: d.notes || undefined,
  }
}

export async function createItemInstance(
  _prev: ItemActionState,
  formData: FormData
): Promise<ItemActionState> {
  const result = CreateItemSchema.safeParse(Object.fromEntries(formData))
  if (!result.success) return { errors: result.error.flatten().fieldErrors as Record<string, string[]> }

  if (!result.data.locationId) {
    return { errors: { locationId: ['Storage location is required.'] } }
  }

  const { sku, catalogId } = result.data

  const locationId = result.data.locationId

  const [existingItem, catalog, location] = await Promise.all([
    prisma.itemInstance.findUnique({ where: { sku }, select: { id: true } }),
    prisma.catalogModel.findUnique({ where: { id: catalogId }, select: { id: true } }),
    locationId ? prisma.storageLocation.findUnique({ where: { id: locationId }, select: { id: true } }) : null,
  ])
  if (existingItem) return { errors: { sku: ['SKU is already in use.'] } }
  if (!catalog) return { errors: { catalogId: ['Catalog model not found.'] } }
  if (locationId && !location) return { errors: { locationId: ['Storage location not found.'] } }

  try {
    // sku is assigned here, exactly once — this is the ONLY itemInstance.create call
    // site for this admin form (see itemIdentitySafety.test.ts for the codebase-wide
    // invariant that ItemInstance.create only ever happens here or at intake conversion).
    await prisma.itemInstance.create({ data: { sku, ...toMutableDbData(result.data) } })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return { errors: { sku: ['SKU is already in use.'] } }
    }
    throw error
  }
  if (formData.get('_redirect') === 'another') redirect('/admin/items/new')
  redirect('/admin/items')
}

export async function updateItemInstance(
  id: string,
  _prev: ItemActionState,
  formData: FormData
): Promise<ItemActionState> {
  // 15C-review section 1: UpdateItemSchema has no `sku` field — even a maliciously
  // modified form submitting one is simply ignored by safeParse (unrecognized keys
  // are dropped, not validated), and toMutableDbData never includes sku in the
  // update payload below. The stored SKU is permanent from creation onward.
  const result = UpdateItemSchema.safeParse(Object.fromEntries(formData))
  if (!result.success) return { errors: result.error.flatten().fieldErrors as Record<string, string[]> }

  const { catalogId, locationId: newLocationId } = result.data

  const [catalog, location] = await Promise.all([
    prisma.catalogModel.findUnique({ where: { id: catalogId }, select: { id: true } }),
    newLocationId ? prisma.storageLocation.findUnique({ where: { id: newLocationId }, select: { id: true } }) : null,
  ])
  if (!catalog) return { errors: { catalogId: ['Catalog model not found.'] } }
  if (newLocationId && !location) return { errors: { locationId: ['Storage location not found.'] } }

  await prisma.itemInstance.update({ where: { id }, data: toMutableDbData(result.data) })
  redirect('/admin/items')
}
