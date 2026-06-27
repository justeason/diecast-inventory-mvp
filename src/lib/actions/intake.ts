'use server'

import fs from 'fs'
import path from 'path'
import Anthropic from '@anthropic-ai/sdk'
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

// ─── AI Extraction ────────────────────────────────────────────────────────────
//
// ANTHROPIC_MODEL env var controls which model is used.
// Recommended value: claude-haiku-4-5-20251001 (current Haiku 4.5 model ID).
// See: https://docs.anthropic.com/en/docs/models-overview

export type ExtractionActionState = { error: string } | null

const EXTRACTION_TOOL: Anthropic.Messages.Tool = {
  name: 'extract_intake_fields',
  description:
    'Extract diecast car model information from product photos. Return only fields you can identify with reasonable confidence. Leave others absent.',
  input_schema: {
    type: 'object',
    properties: {
      brand: {
        type: 'string',
        description: 'Manufacturer brand name (e.g. Hot Wheels, Matchbox, Greenlight)',
      },
      name: {
        type: 'string',
        description: 'Model/casting name shown on the card or base (e.g. Ferrari 308 GTS)',
      },
      year: {
        type: 'integer',
        description: 'Production year visible on card or base (e.g. 1995)',
      },
      series: {
        type: 'string',
        description: 'Series or product line name (e.g. Treasure Hunt, Basic)',
      },
      color: {
        type: 'string',
        description: 'Primary color of the die-cast model body',
      },
      scale: {
        type: 'string',
        description: 'Scale ratio (e.g. 1:64, 1:18)',
      },
      cardedOrLoose: {
        type: 'string',
        enum: ['carded', 'loose'],
        description: 'Whether the item is on its original card/blister (carded) or removed (loose)',
      },
      condition: {
        type: 'string',
        enum: ['mint', 'near_mint', 'good', 'fair', 'poor', 'damaged'],
        description: 'Overall physical condition of the item',
      },
      conditionNotes: {
        type: 'string',
        description: 'Specific visible condition observations (scratches, card creases, paint chips)',
      },
      notes: {
        type: 'string',
        description: 'Any other relevant information visible in the photos',
      },
      extractionNotes: {
        type: 'string',
        description: 'Notes on extraction quality, ambiguities, or what could not be determined',
      },
      confidence: {
        type: 'number',
        description: 'Overall extraction confidence from 0.0 (very uncertain) to 1.0 (very confident)',
      },
    },
    required: ['extractionNotes', 'confidence'],
  },
}

export async function extractDraftFields(
  id: string,
  _prev: ExtractionActionState,
  _formData: FormData
): Promise<ExtractionActionState> {
  const draft = await prisma.intakeDraft.findUnique({ where: { id } })
  if (!draft) return { error: 'Draft not found.' }
  if (draft.status === 'converted' || draft.status === 'rejected') {
    return { error: 'Cannot extract fields for a converted or rejected draft.' }
  }

  const frontUrl = draft.frontPhotoUrl?.trim()
  if (!frontUrl) return { error: 'A front photo URL is required for extraction.' }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return { error: 'ANTHROPIC_API_KEY is not configured on the server.' }

  // Model ID is set via ANTHROPIC_MODEL env var. Recommended: claude-haiku-4-5-20251001
  const model = process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001'

  let rawResponse: string | null = null
  let extractionError: string | null = null

  try {
    const client = new Anthropic({ apiKey })

    const imageContent: Anthropic.Messages.MessageParam['content'] = [
      { type: 'image', source: { type: 'url', url: frontUrl } },
    ]
    const backUrl = draft.backPhotoUrl?.trim()
    if (backUrl) {
      imageContent.push({ type: 'image', source: { type: 'url', url: backUrl } })
    }
    imageContent.push({
      type: 'text',
      text: 'Extract diecast car model information from the provided photo(s) using the extract_intake_fields tool.',
    })

    const response = await client.messages.create({
      model,
      max_tokens: 1024,
      tools: [EXTRACTION_TOOL],
      tool_choice: { type: 'tool', name: 'extract_intake_fields' },
      messages: [{ role: 'user', content: imageContent }],
    })

    rawResponse = JSON.stringify(response)

    const toolBlock = response.content.find(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use'
    )
    if (!toolBlock) {
      await prisma.intakeDraft.update({
        where: { id },
        data: {
          aiExtractionRaw: rawResponse,
          aiExtractionNotes: 'No tool use block found in AI response.',
        },
      })
      return { error: 'AI returned an unexpected response. Raw output has been saved.' }
    }

    const extracted = toolBlock.input as Record<string, unknown>

    // Build update: AI metadata always written; fields only filled if currently blank.
    const updateData: Record<string, unknown> = {
      aiExtractionRaw: rawResponse,
      aiExtractionNotes:
        typeof extracted.extractionNotes === 'string' ? extracted.extractionNotes : null,
      aiExtractionConfidence:
        typeof extracted.confidence === 'number'
          ? Math.min(1, Math.max(0, extracted.confidence))
          : null,
    }

    // String fields: only fill if currently blank
    const stringFields = [
      'brand', 'name', 'series', 'color', 'scale',
      'cardedOrLoose', 'condition', 'conditionNotes', 'notes',
    ] as const
    for (const field of stringFields) {
      const aiVal = extracted[field]
      const existing = draft[field]
      if (typeof aiVal === 'string' && aiVal.trim() && !existing) {
        updateData[field] = aiVal.trim()
      }
    }

    // Year: only fill if currently blank; validate range
    if (extracted.year != null && draft.year == null) {
      const yr =
        typeof extracted.year === 'number'
          ? Math.round(extracted.year)
          : parseInt(String(extracted.year), 10)
      if (!isNaN(yr) && yr >= 1950 && yr <= 2100) {
        updateData.year = yr
      }
    }

    await prisma.intakeDraft.update({ where: { id }, data: updateData })
  } catch (err) {
    // Attempt to save raw response for debugging even on failure
    if (rawResponse) {
      await prisma.intakeDraft
        .update({
          where: { id },
          data: {
            aiExtractionRaw: rawResponse,
            aiExtractionNotes: 'Extraction failed during processing. See raw output.',
          },
        })
        .catch(() => {})
    }
    extractionError = err instanceof Error ? err.message : 'Unknown error'
  }

  if (extractionError) {
    return { error: `AI extraction failed: ${extractionError}` }
  }

  redirect(`/admin/intake/${id}/edit`)
}

// ─── Photo Upload ─────────────────────────────────────────────────────────────

export type UploadActionState = { error: string } | null

const ALLOWED_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png':  'png',
  'image/webp': 'webp',
}
const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5 MB

export async function uploadIntakePhoto(
  draftId: string,
  field: 'front' | 'back',
  _prev: UploadActionState,
  formData: FormData
): Promise<UploadActionState> {
  const draft = await prisma.intakeDraft.findUnique({
    where: { id: draftId },
    select: { status: true },
  })
  if (!draft) return { error: 'Draft not found.' }
  if (draft.status === 'converted' || draft.status === 'rejected') {
    return { error: 'Cannot upload photos for a converted or rejected draft.' }
  }

  const file = formData.get('photo')
  if (!(file instanceof File) || file.size === 0) {
    return { error: 'No file selected.' }
  }

  const ext = ALLOWED_MIME[file.type]
  if (!ext) return { error: 'Only JPEG, PNG, and WebP images are allowed.' }
  if (file.size > MAX_FILE_SIZE) return { error: 'File must be 5 MB or smaller.' }

  // Filename is generated server-side; the original filename is never used.
  const filename = `${Date.now()}-${field}.${ext}`
  const uploadDir = path.join(process.cwd(), 'public', 'uploads', 'intake', draftId)
  await fs.promises.mkdir(uploadDir, { recursive: true })

  const buffer = Buffer.from(await file.arrayBuffer())
  await fs.promises.writeFile(path.join(uploadDir, filename), buffer)

  const urlPath = `/uploads/intake/${draftId}/${filename}`
  const dbField = field === 'front' ? 'frontPhotoUrl' : 'backPhotoUrl'
  await prisma.intakeDraft.update({ where: { id: draftId }, data: { [dbField]: urlPath } })

  redirect(`/admin/intake/${draftId}/edit`)
}
