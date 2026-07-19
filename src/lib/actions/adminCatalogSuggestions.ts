'use server'

import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'

// Admin suggestion actions rely on the (admin) route group middleware for auth,
// consistent with all other admin server actions in this repo (catalog.ts, items.ts, etc.).

export type AdminSuggestionActionState = { errors: Record<string, string[]> } | null

function trimOrNull(v: string | undefined | null): string | null {
  const t = v?.trim()
  return t || null
}

// ─── Approve ──────────────────────────────────────────────────────────────────

const ApproveSchema = z.object({
  brand: z.string().min(1, 'Brand is required'),
  name: z.string().min(1, 'Model name is required'),
  series: z.string().optional(),
  year: z
    .string()
    .optional()
    .refine((v) => {
      if (!v || !v.trim()) return true
      const n = parseInt(v.trim(), 10)
      return !isNaN(n) && n >= 1950 && n <= 2100
    }, 'Year must be between 1950 and 2100'),
  color: z.string().optional(),
  scale: z.string().optional(),
  adminNotes: z.string().optional(),
  linkItem: z.string().optional(),
})

export async function approveSuggestion(
  id: string,
  _prev: AdminSuggestionActionState,
  formData: FormData
): Promise<AdminSuggestionActionState> {
  const suggestion = await prisma.catalogSuggestion.findUnique({
    where: { id },
    select: { id: true, status: true, collectionItemId: true },
  })
  if (!suggestion) return { errors: { form: ['Suggestion not found.'] } }
  if (suggestion.status !== 'pending') {
    return { errors: { form: ['Only pending suggestions can be approved.'] } }
  }

  const result = ApproveSchema.safeParse(Object.fromEntries(formData))
  if (!result.success) {
    return { errors: result.error.flatten().fieldErrors as Record<string, string[]> }
  }

  const data = result.data
  const approvedBrand  = data.brand.trim()
  const approvedName   = data.name.trim()
  const approvedSeries = trimOrNull(data.series)
  const approvedYear   = data.year?.trim() ? parseInt(data.year.trim(), 10) : null
  const approvedColor  = trimOrNull(data.color)
  const approvedScale  = trimOrNull(data.scale)
  const adminNotes     = trimOrNull(data.adminNotes)
  const linkItem       = data.linkItem === 'on' && !!suggestion.collectionItemId

  // Exact-match duplicate check before creating — all six fields must match.
  // Prevents silently creating a duplicate CatalogModel.
  const dupWhere: Prisma.CatalogModelWhereInput = {
    brand:  { equals: approvedBrand,  mode: 'insensitive' },
    name:   { equals: approvedName,   mode: 'insensitive' },
    year:   approvedYear,
    series: approvedSeries !== null ? { equals: approvedSeries, mode: 'insensitive' } : null,
    color:  approvedColor  !== null ? { equals: approvedColor,  mode: 'insensitive' } : null,
    scale:  approvedScale  !== null ? { equals: approvedScale,  mode: 'insensitive' } : null,
  }
  const existingDup = await prisma.catalogModel.findFirst({ where: dupWhere })
  if (existingDup) {
    return {
      errors: {
        form: [
          `A catalog model with these exact fields already exists (${existingDup.brand} ${existingDup.name}). ` +
            `Please mark as duplicate instead.`,
        ],
      },
    }
  }

  try {
    await prisma.$transaction(async (tx) => {
      const catalog = await tx.catalogModel.create({
        data: {
          brand:  approvedBrand,
          name:   approvedName,
          series: approvedSeries ?? undefined,
          year:   approvedYear   ?? undefined,
          color:  approvedColor  ?? undefined,
          scale:  approvedScale  ?? undefined,
        },
      })

      await tx.catalogSuggestion.update({
        where: { id },
        data: {
          status:           'approved',
          approvedCatalogId: catalog.id,
          adminNotes,
          reviewedAt:        new Date(),
        },
      })

      if (linkItem && suggestion.collectionItemId) {
        await tx.collectionItem.update({
          where: { id: suggestion.collectionItemId },
          data:  { catalogId: catalog.id },
        })
      }
    })
  } catch {
    return { errors: { form: ['Approval failed. Please try again.'] } }
  }

  revalidatePath('/admin/catalog-suggestions')
  revalidatePath(`/admin/catalog-suggestions/${id}`)
  revalidatePath('/admin/catalog')
  if (suggestion.collectionItemId) {
    revalidatePath(`/account/collection/${suggestion.collectionItemId}`)
    revalidatePath('/account/collection')
  }
  redirect(`/admin/catalog-suggestions/${id}`)
}

// ─── Reject ───────────────────────────────────────────────────────────────────

export async function rejectSuggestion(
  id: string,
  _prev: AdminSuggestionActionState,
  formData: FormData
): Promise<AdminSuggestionActionState> {
  const suggestion = await prisma.catalogSuggestion.findUnique({
    where: { id },
    select: { id: true, status: true },
  })
  if (!suggestion) return { errors: { form: ['Suggestion not found.'] } }
  if (suggestion.status !== 'pending') {
    return { errors: { form: ['Only pending suggestions can be rejected.'] } }
  }

  const adminNotes = trimOrNull((formData.get('adminNotes') as string) ?? '')

  await prisma.catalogSuggestion.update({
    where: { id },
    data: { status: 'rejected', adminNotes, reviewedAt: new Date() },
  })

  revalidatePath('/admin/catalog-suggestions')
  revalidatePath(`/admin/catalog-suggestions/${id}`)
  redirect(`/admin/catalog-suggestions/${id}`)
}

// ─── Mark Duplicate ───────────────────────────────────────────────────────────

const DuplicateSchema = z.object({
  existingCatalogId: z.string().min(1, 'Please select an existing catalog model.'),
  adminNotes: z.string().optional(),
  linkItem: z.string().optional(),
})

export async function markSuggestionDuplicate(
  id: string,
  _prev: AdminSuggestionActionState,
  formData: FormData
): Promise<AdminSuggestionActionState> {
  const suggestion = await prisma.catalogSuggestion.findUnique({
    where: { id },
    select: { id: true, status: true, collectionItemId: true },
  })
  if (!suggestion) return { errors: { form: ['Suggestion not found.'] } }
  if (suggestion.status !== 'pending') {
    return { errors: { form: ['Only pending suggestions can be marked as duplicate.'] } }
  }

  const result = DuplicateSchema.safeParse(Object.fromEntries(formData))
  if (!result.success) {
    return { errors: result.error.flatten().fieldErrors as Record<string, string[]> }
  }

  const { existingCatalogId, adminNotes: rawNotes, linkItem: rawLink } = result.data
  const adminNotes = trimOrNull(rawNotes)
  const linkItem   = rawLink === 'on' && !!suggestion.collectionItemId

  const existingCatalog = await prisma.catalogModel.findUnique({
    where: { id: existingCatalogId },
    select: { id: true, brand: true, name: true },
  })
  if (!existingCatalog) {
    return { errors: { form: ['Selected catalog model not found. Please refresh and try again.'] } }
  }

  await prisma.$transaction(async (tx) => {
    await tx.catalogSuggestion.update({
      where: { id },
      data: {
        status:            'duplicate',
        approvedCatalogId: existingCatalog.id,
        adminNotes,
        reviewedAt:        new Date(),
      },
    })

    if (linkItem && suggestion.collectionItemId) {
      await tx.collectionItem.update({
        where: { id: suggestion.collectionItemId },
        data:  { catalogId: existingCatalog.id },
      })
    }
  })

  revalidatePath('/admin/catalog-suggestions')
  revalidatePath(`/admin/catalog-suggestions/${id}`)
  if (suggestion.collectionItemId) {
    revalidatePath(`/account/collection/${suggestion.collectionItemId}`)
    revalidatePath('/account/collection')
  }
  redirect(`/admin/catalog-suggestions/${id}`)
}
