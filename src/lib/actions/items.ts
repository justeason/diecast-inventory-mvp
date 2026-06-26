'use server'

import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'

const ItemSchema = z.object({
  sku: z.string().min(1, 'SKU is required'),
  catalogId: z.string().min(1, 'Catalog model is required'),
  locationId: z.string().optional(),
  cardedOrLoose: z.enum(['carded', 'loose'], { error: 'Carded or Loose is required' }),
  condition: z.enum(['mint', 'near_mint', 'good', 'fair', 'poor', 'damaged'], {
    error: 'Condition is required',
  }),
  conditionNotes: z.string().optional(),
  purchasePrice: z.string().optional(),
  listPrice: z.string().optional(),
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
    purchasePrice: d.purchasePrice ? parseFloat(d.purchasePrice) : undefined,
    listPrice: d.listPrice ? parseFloat(d.listPrice) : undefined,
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

  await prisma.itemInstance.create({ data: toDbData(result.data) })
  redirect('/admin/items')
}

export async function updateItemInstance(
  id: string,
  _prev: ItemActionState,
  formData: FormData
): Promise<ItemActionState> {
  const result = ItemSchema.safeParse(Object.fromEntries(formData))
  if (!result.success) return { errors: result.error.flatten().fieldErrors as Record<string, string[]> }

  await prisma.itemInstance.update({ where: { id }, data: toDbData(result.data) })
  redirect('/admin/items')
}
