'use server'

import { z } from 'zod'
import { redirect } from 'next/navigation'
import { prisma } from '@/lib/prisma'

// ─── Helpers ────────────────────────────────────────────────────────────────

function trimOrNull(v: string | undefined | null): string | null {
  const t = v?.trim()
  return t || null
}

// ─── Zod schema ─────────────────────────────────────────────────────────────

const DraftSchema = z.object({
  frontPhotoUrl:   z.string().optional(),
  backPhotoUrl:    z.string().optional(),
  brand:           z.string().optional(),
  name:            z.string().optional(),
  year:            z.string().optional(),
  series:          z.string().optional(),
  color:           z.string().optional(),
  scale:           z.string().optional(),
  cardedOrLoose:   z.string().optional(),
  condition:       z.string().optional(),
  conditionNotes:  z.string().optional(),
  listPrice:       z.string().optional(),
  storageLocation: z.string().optional(),
  notes:           z.string().optional(),
})

export type IntakeActionState = { errors: Record<string, string[]> } | null

function toDraftDbData(data: z.infer<typeof DraftSchema>) {
  return {
    frontPhotoUrl:   trimOrNull(data.frontPhotoUrl),
    backPhotoUrl:    trimOrNull(data.backPhotoUrl),
    brand:           trimOrNull(data.brand),
    name:            trimOrNull(data.name),
    year:            data.year?.trim() ? (parseInt(data.year.trim(), 10) || null) : null,
    series:          trimOrNull(data.series),
    color:           trimOrNull(data.color),
    scale:           trimOrNull(data.scale),
    cardedOrLoose:   trimOrNull(data.cardedOrLoose),
    condition:       trimOrNull(data.condition),
    conditionNotes:  trimOrNull(data.conditionNotes),
    listPrice:       data.listPrice?.trim() ? (parseFloat(data.listPrice.trim()) || null) : null,
    storageLocation: trimOrNull(data.storageLocation),
    notes:           trimOrNull(data.notes),
  }
}

// ─── Create draft ────────────────────────────────────────────────────────────

export async function createIntakeDraft(
  _prev: IntakeActionState,
  formData: FormData
): Promise<IntakeActionState> {
  const result = DraftSchema.safeParse(Object.fromEntries(formData))
  if (!result.success) {
    return { errors: result.error.flatten().fieldErrors as Record<string, string[]> }
  }
  const draft = await prisma.intakeDraft.create({ data: toDraftDbData(result.data) })
  redirect(`/admin/intake/${draft.id}/edit`)
}

// ─── Update draft ─────────────────────────────────────────────────────────────

export async function updateIntakeDraft(
  id: string,
  _prev: IntakeActionState,
  formData: FormData
): Promise<IntakeActionState> {
  const draft = await prisma.intakeDraft.findUnique({ where: { id }, select: { status: true } })
  if (!draft) return { errors: { form: ['Draft not found.'] } }
  if (draft.status === 'converted' || draft.status === 'rejected') {
    return { errors: { form: ['This draft can no longer be edited.'] } }
  }

  const result = DraftSchema.safeParse(Object.fromEntries(formData))
  if (!result.success) {
    return { errors: result.error.flatten().fieldErrors as Record<string, string[]> }
  }

  await prisma.intakeDraft.update({ where: { id }, data: toDraftDbData(result.data) })
  redirect(`/admin/intake/${id}/edit`)
}

// ─── Mark reviewed ─────────────────────────────────────────────────────────────

export async function markDraftReviewed(id: string, _formData: FormData): Promise<void> {
  const draft = await prisma.intakeDraft.findUnique({ where: { id }, select: { status: true } })
  if (draft?.status === 'draft') {
    await prisma.intakeDraft.update({ where: { id }, data: { status: 'reviewed' } })
  }
  redirect(`/admin/intake/${id}/edit`)
}

// ─── Reject draft ─────────────────────────────────────────────────────────────

export async function rejectDraft(id: string, _formData: FormData): Promise<void> {
  const draft = await prisma.intakeDraft.findUnique({ where: { id }, select: { status: true } })
  if (draft && draft.status !== 'converted' && draft.status !== 'rejected') {
    await prisma.intakeDraft.update({ where: { id }, data: { status: 'rejected' } })
  }
  redirect(`/admin/intake/${id}/edit`)
}

// ─── Convert draft ────────────────────────────────────────────────────────────

export type ConvertActionState = { errors: Record<string, string[]> } | null

export async function convertDraft(
  id: string,
  _prev: ConvertActionState,
  formData: FormData
): Promise<ConvertActionState> {
  const sku = (formData.get('sku') as string)?.trim()
  if (!sku) return { errors: { sku: ['SKU is required.'] } }

  const draft = await prisma.intakeDraft.findUnique({ where: { id } })
  if (!draft) return { errors: { form: ['Draft not found.'] } }
  if (draft.status === 'converted') {
    return { errors: { form: ['This draft has already been converted.'] } }
  }
  if (draft.status === 'rejected') {
    return { errors: { form: ['Rejected drafts cannot be converted.'] } }
  }

  const brand = draft.brand?.trim()
  const name  = draft.name?.trim()
  if (!brand || !name) {
    return { errors: { form: ['Brand and name are required to convert.'] } }
  }
  if (!draft.condition || !draft.cardedOrLoose) {
    return { errors: { form: ['Condition and type (carded/loose) are required to convert.'] } }
  }

  // Check SKU uniqueness upfront for a clear user-facing error
  const existing = await prisma.itemInstance.findUnique({ where: { sku } })
  if (existing) return { errors: { sku: ['SKU is already taken.'] } }

  let newItemId: string | undefined

  await prisma.$transaction(async (tx) => {
    // 1. Exact-match lookup on all identity fields; null matches null.
    let catalog = await tx.catalogModel.findFirst({
      where: {
        brand,
        name,
        year:   draft.year   ?? null,
        series: trimOrNull(draft.series),
        color:  trimOrNull(draft.color),
        scale:  trimOrNull(draft.scale),
      },
    })
    if (!catalog) {
      catalog = await tx.catalogModel.create({
        data: {
          brand,
          name,
          year:   draft.year            ?? undefined,
          series: trimOrNull(draft.series) ?? undefined,
          color:  trimOrNull(draft.color)  ?? undefined,
          scale:  trimOrNull(draft.scale)  ?? undefined,
        },
      })
    }

    // 2. Look up or create StorageLocation by trimmed label.
    let locationId: string | null = null
    const locationLabel = draft.storageLocation?.trim()
    if (locationLabel) {
      let location = await tx.storageLocation.findFirst({ where: { label: locationLabel } })
      if (!location) {
        location = await tx.storageLocation.create({ data: { label: locationLabel } })
      }
      locationId = location.id
    }

    // 3. Create ItemInstance.
    const item = await tx.itemInstance.create({
      data: {
        sku,
        catalogId:     catalog.id,
        locationId,
        cardedOrLoose: draft.cardedOrLoose!,
        condition:     draft.condition!,
        conditionNotes: trimOrNull(draft.conditionNotes) ?? undefined,
        listPrice:     draft.listPrice   ?? undefined,
        status:        'available',
        notes:         trimOrNull(draft.notes) ?? undefined,
      },
    })
    newItemId = item.id

    // 4. Create Photo records only for non-blank URLs.
    const front = draft.frontPhotoUrl?.trim()
    if (front) {
      await tx.photo.create({ data: { itemId: item.id, url: front, type: 'front', sortOrder: 0 } })
    }
    const back = draft.backPhotoUrl?.trim()
    if (back) {
      await tx.photo.create({ data: { itemId: item.id, url: back, type: 'back', sortOrder: 1 } })
    }

    // 5. Lock the draft.
    await tx.intakeDraft.update({
      where: { id },
      data:  { status: 'converted', convertedItemId: item.id },
    })
  })

  redirect(`/admin/items/${newItemId!}/edit`)
}
