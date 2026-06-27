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

const ItemSchema = z.object({
  sku: z.string().min(1, 'SKU is required'),
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
})

export type ItemActionState = { errors: Record<string, string[]> } | null

function toDbData(d: z.infer<typeof ItemSchema>) {
  return {
    sku: d.sku,
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
  const result = ItemSchema.safeParse(Object.fromEntries(formData))
  if (!result.success) return { errors: result.error.flatten().fieldErrors as Record<string, string[]> }

  const { sku } = result.data
  const existing = await prisma.itemInstance.findUnique({ where: { sku } })
  if (existing) return { errors: { sku: ['SKU is already in use.'] } }

  try {
    await prisma.itemInstance.create({ data: toDbData(result.data) })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return { errors: { sku: ['SKU is already in use.'] } }
    }
    throw error
  }
  redirect('/admin/items')
}

export async function updateItemInstance(
  id: string,
  _prev: ItemActionState,
  formData: FormData
): Promise<ItemActionState> {
  const result = ItemSchema.safeParse(Object.fromEntries(formData))
  if (!result.success) return { errors: result.error.flatten().fieldErrors as Record<string, string[]> }

  const { sku } = result.data
  const conflict = await prisma.itemInstance.findFirst({ where: { sku, NOT: { id } } })
  if (conflict) return { errors: { sku: ['SKU is already in use.'] } }

  try {
    await prisma.itemInstance.update({ where: { id }, data: toDbData(result.data) })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return { errors: { sku: ['SKU is already in use.'] } }
    }
    throw error
  }
  redirect('/admin/items')
}
