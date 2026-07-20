'use server'

import { z } from 'zod'
import { del } from '@vercel/blob'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'

export type MergeActionState = { errors: Record<string, string[]> } | null

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

export async function mergeCatalogModels(
  _prev: MergeActionState,
  formData: FormData
): Promise<MergeActionState> {
  const canonicalId   = (formData.get('canonicalId') as string)?.trim() || ''
  const duplicateIds  = formData.getAll('duplicateId')
    .map((v) => (v as string).trim())
    .filter(Boolean)

  if (!canonicalId)         return { errors: { form: ['No canonical model selected.'] } }
  if (duplicateIds.length === 0) return { errors: { form: ['No duplicate models selected.'] } }
  if (duplicateIds.includes(canonicalId))
    return { errors: { form: ['The canonical model cannot also be in the merge list.'] } }

  // Load all involved models — validates they exist and share the same normalized brand+name.
  const allIds = [canonicalId, ...duplicateIds]
  const models = await prisma.catalogModel.findMany({
    where: { id: { in: allIds } },
    select: { id: true, brand: true, name: true },
  })

  if (models.length !== allIds.length)
    return { errors: { form: ['One or more selected models no longer exist. Please refresh and try again.'] } }

  const canonical = models.find((m) => m.id === canonicalId)!
  const targetBrand = canonical.brand.trim().toLowerCase()
  const targetName  = canonical.name.trim().toLowerCase()

  for (const m of models) {
    if (m.brand.trim().toLowerCase() !== targetBrand || m.name.trim().toLowerCase() !== targetName)
      return { errors: { form: ['All selected models must share the same brand and name.'] } }
  }

  // Collect duplicate catalog image URLs before the transaction — cascade delete removes the rows.
  const duplicatePhotoUrls = await prisma.catalogModelPhoto.findMany({
    where: { catalogId: { in: duplicateIds } },
    select: { url: true },
  })

  // Move items then delete duplicates — all in one transaction.
  try {
    await prisma.$transaction(async (tx) => {
      for (const dupeId of duplicateIds) {
        await tx.itemInstance.updateMany({
          where: { catalogId: dupeId },
          data:  { catalogId: canonicalId },
        })
        await tx.catalogModel.delete({ where: { id: dupeId } })
      }
    })
  } catch {
    return { errors: { form: ['Merge failed. Please try again.'] } }
  }

  // Best-effort blob cleanup after successful transaction — never blocks the merge.
  for (const { url } of duplicatePhotoUrls) {
    try {
      await del(url)
    } catch (err) {
      console.error('[mergeCatalogModels] Failed to delete catalog image blob:', err)
    }
  }

  redirect('/admin/catalog/duplicates')
}
