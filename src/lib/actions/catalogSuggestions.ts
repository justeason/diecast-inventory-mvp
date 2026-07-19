'use server'

import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { getBuyerSession } from '@/lib/buyerSession'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'

function trimOrNull(v: string | undefined | null): string | null {
  const t = v?.trim()
  return t || null
}

const SuggestionSchema = z.object({
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
  userNotes: z.string().optional(),
})

export type CatalogSuggestionActionState = { errors: Record<string, string[]> } | null

export async function submitCatalogSuggestion(
  itemId: string,
  _prev: CatalogSuggestionActionState,
  formData: FormData
): Promise<CatalogSuggestionActionState> {
  const session = await getBuyerSession()
  if (!session) {
    return { errors: { form: ['You must be signed in to submit a suggestion.'] } }
  }

  // Ownership check — must verify item belongs to this session's profile
  const item = await prisma.collectionItem.findFirst({
    where: { id: itemId, profileId: session.profileId },
    select: {
      id: true,
      catalogId: true,
      aiExtractionConfidence: true,
      catalogSuggestions: {
        where: { status: 'pending' },
        select: { id: true },
      },
    },
  })
  if (!item) return { errors: { form: ['Collection item not found.'] } }

  if (item.catalogId) {
    return { errors: { form: ['This item already has a catalog match.'] } }
  }

  if (item.catalogSuggestions.length > 0) {
    return { errors: { form: ['This item already has a pending catalog suggestion.'] } }
  }

  const result = SuggestionSchema.safeParse(Object.fromEntries(formData))
  if (!result.success) {
    return { errors: result.error.flatten().fieldErrors as Record<string, string[]> }
  }

  const data = result.data

  await prisma.catalogSuggestion.create({
    data: {
      profileId: session.profileId,
      collectionItemId: item.id,
      brand: data.brand.trim(),
      name: data.name.trim(),
      series: trimOrNull(data.series),
      year: data.year?.trim() ? parseInt(data.year.trim(), 10) : null,
      color: trimOrNull(data.color),
      scale: trimOrNull(data.scale),
      userNotes: trimOrNull(data.userNotes),
      // Snapshot AI confidence from the item at submission time
      aiExtractionConfidence: item.aiExtractionConfidence,
    },
  })

  revalidatePath('/account/collection')
  revalidatePath(`/account/collection/${itemId}`)
  redirect(`/account/collection/${itemId}`)
}

export async function cancelCatalogSuggestion(suggestionId: string): Promise<void> {
  const session = await getBuyerSession()
  if (!session) redirect('/account/orders')

  // Ownership + status check — user can only cancel their own pending suggestions
  const suggestion = await prisma.catalogSuggestion.findFirst({
    where: {
      id: suggestionId,
      profileId: session.profileId,
      status: 'pending',
    },
    select: { id: true, collectionItemId: true },
  })
  if (!suggestion) redirect('/account/collection')

  await prisma.catalogSuggestion.delete({ where: { id: suggestion.id } })

  const itemId = suggestion.collectionItemId
  revalidatePath('/account/collection')
  if (itemId) {
    revalidatePath(`/account/collection/${itemId}`)
    redirect(`/account/collection/${itemId}`)
  } else {
    redirect('/account/collection')
  }
}
