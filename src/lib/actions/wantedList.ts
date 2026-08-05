'use server'

import { prisma } from '@/lib/prisma'
import { getBuyerSession } from '@/lib/buyerSession'
import { Prisma } from '@prisma/client'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { checkRateLimit } from '@/lib/rateLimit'

// 30 new entries per 10 minutes per profile (instance-local)
const CREATE_MAX    = 30
const CREATE_WINDOW = 10 * 60 * 1000

export type WantedListActionState = { errors: Record<string, string[]> } | null

function parsePositiveDecimal(raw: string): { value: string } | { error: string } {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return { error: 'Must be greater than 0.' }
  return { value: raw }
}

function validateWantedNotes(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed.length > 500) return 'Notes must be 500 characters or fewer.'
  if (/[\x00-\x1F\x7F]/.test(trimmed)) return 'Notes contain invalid characters.'
  return null
}

export async function addToWantedList(
  _prev: WantedListActionState,
  formData: FormData,
): Promise<WantedListActionState> {
  const session = await getBuyerSession()
  if (!session) return { errors: { _form: ['You must be signed in.'] } }

  const { allowed, resetMs } = checkRateLimit(
    `create_wanted:${session.profileId}`,
    CREATE_MAX,
    CREATE_WINDOW,
  )
  if (!allowed) {
    const secs = Math.ceil(resetMs / 1000)
    return { errors: { _form: [`Too many entries added. Please wait ${secs} seconds.`] } }
  }

  const catalogModelId = formData.get('catalogModelId')?.toString().trim() ?? ''
  if (!catalogModelId) return { errors: { catalogModelId: ['Select a catalog model.'] } }

  const maxDesiredPriceRaw = formData.get('maxDesiredPrice')?.toString().trim() ?? ''
  const notesRaw = formData.get('notes')?.toString() ?? ''

  let maxDesiredPrice: string | null = null
  if (maxDesiredPriceRaw) {
    const result = parsePositiveDecimal(maxDesiredPriceRaw)
    if ('error' in result) return { errors: { maxDesiredPrice: [result.error] } }
    maxDesiredPrice = result.value
  }

  const notesError = validateWantedNotes(notesRaw)
  if (notesError) return { errors: { notes: [notesError] } }

  const catalog = await prisma.catalogModel.findUnique({
    where: { id: catalogModelId },
    select: { id: true },
  })
  if (!catalog) return { errors: { catalogModelId: ['Catalog model not found.'] } }

  try {
    await prisma.wantedCatalogModel.create({
      data: {
        customerProfileId: session.profileId,
        catalogModelId,
        maxDesiredPrice,
        notes: notesRaw.trim() || null,
      },
    })
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return { errors: { catalogModelId: ['This model is already on your wanted list.'] } }
    }
    throw e
  }

  revalidatePath('/account/wanted')
  return null
}

export async function updateWantedListEntry(
  id: string,
  _prev: WantedListActionState,
  formData: FormData,
): Promise<WantedListActionState> {
  const session = await getBuyerSession()
  if (!session) return { errors: { _form: ['You must be signed in.'] } }

  const entry = await prisma.wantedCatalogModel.findFirst({
    where: { id, customerProfileId: session.profileId },
    select: { id: true },
  })
  if (!entry) return { errors: { _form: ['Entry not found or access denied.'] } }

  const maxDesiredPriceRaw = formData.get('maxDesiredPrice')?.toString().trim() ?? ''
  const notesRaw = formData.get('notes')?.toString() ?? ''

  let maxDesiredPrice: string | null = null
  if (maxDesiredPriceRaw) {
    const result = parsePositiveDecimal(maxDesiredPriceRaw)
    if ('error' in result) return { errors: { maxDesiredPrice: [result.error] } }
    maxDesiredPrice = result.value
  }

  const notesError = validateWantedNotes(notesRaw)
  if (notesError) return { errors: { notes: [notesError] } }

  await prisma.wantedCatalogModel.update({
    where: { id },
    data: { maxDesiredPrice, notes: notesRaw.trim() || null },
  })

  revalidatePath('/account/wanted')
  redirect('/account/wanted')
}

export async function removeFromWantedList(id: string): Promise<void> {
  const session = await getBuyerSession()
  if (!session) return

  const result = await prisma.wantedCatalogModel.deleteMany({
    where: { id, customerProfileId: session.profileId },
  })
  if (result.count === 0) return
  revalidatePath('/account/wanted')
}
