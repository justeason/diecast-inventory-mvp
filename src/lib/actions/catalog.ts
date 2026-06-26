'use server'

import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'

const CatalogSchema = z.object({
  brand: z.string().min(1, 'Brand is required'),
  name: z.string().min(1, 'Name is required'),
  series: z.string().optional(),
  year: z.string().optional(),
  color: z.string().optional(),
  scale: z.string().optional(),
  notes: z.string().optional(),
})

export type CatalogActionState = { errors: Record<string, string[]> } | null

function toDbData(d: z.infer<typeof CatalogSchema>) {
  return {
    brand: d.brand,
    name: d.name,
    series: d.series || undefined,
    year: d.year ? parseInt(d.year) : undefined,
    color: d.color || undefined,
    scale: d.scale || undefined,
    notes: d.notes || undefined,
  }
}

export async function createCatalogModel(
  _prev: CatalogActionState,
  formData: FormData
): Promise<CatalogActionState> {
  const result = CatalogSchema.safeParse(Object.fromEntries(formData))
  if (!result.success) return { errors: result.error.flatten().fieldErrors as Record<string, string[]> }

  await prisma.catalogModel.create({ data: toDbData(result.data) })
  redirect('/admin/catalog')
}

export async function updateCatalogModel(
  id: string,
  _prev: CatalogActionState,
  formData: FormData
): Promise<CatalogActionState> {
  const result = CatalogSchema.safeParse(Object.fromEntries(formData))
  if (!result.success) return { errors: result.error.flatten().fieldErrors as Record<string, string[]> }

  await prisma.catalogModel.update({ where: { id }, data: toDbData(result.data) })
  redirect('/admin/catalog')
}
