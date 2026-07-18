'use server'

import Anthropic from '@anthropic-ai/sdk'
import { prisma } from '@/lib/prisma'
import { getBuyerSession } from '@/lib/buyerSession'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'

export type CollectionAiActionState = { error: string } | null

const VALID_CONDITIONS   = new Set(['mint', 'near_mint', 'good', 'fair', 'poor', 'damaged'])
const VALID_CARDED_LOOSE = new Set(['carded', 'loose'])

const COLLECTION_EXTRACTION_TOOL: Anthropic.Messages.Tool = {
  name: 'extract_collection_fields',
  description:
    'Extract diecast car model information from a collection photo. Return only fields you can identify with reasonable confidence. Leave others absent.',
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
        description: 'Any other relevant information visible in the photo',
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

function isBlank(v: unknown): boolean {
  return v == null || (typeof v === 'string' && v.trim() === '')
}

export async function extractCollectionItemFields(
  itemId: string
): Promise<CollectionAiActionState> {
  const session = await getBuyerSession()
  if (!session) return { error: 'You must be signed in to use AI scan.' }

  // Ownership check — fetch only through profileId to prevent IDOR
  const item = await prisma.collectionItem.findFirst({
    where: { id: itemId, profileId: session.profileId },
    include: {
      photos: {
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      },
    },
  })
  if (!item) return { error: 'Collection item not found.' }

  if (item.photos.length === 0) {
    return { error: 'Upload at least one photo before scanning with AI.' }
  }

  // Photo selection: prefer type='front'; else lowest sortOrder (already ordered); else oldest createdAt
  const photo = item.photos.find((p) => p.type === 'front') ?? item.photos[0]

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return { error: 'AI scanning is not configured yet.' }

  const model = process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001'

  try {
    const client = new Anthropic({ apiKey })

    const response = await client.messages.create({
      model,
      max_tokens: 1024,
      tools: [COLLECTION_EXTRACTION_TOOL],
      tool_choice: { type: 'tool', name: 'extract_collection_fields' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'url', url: photo.url } },
            {
              type: 'text',
              text: 'Extract diecast car model information from this collection photo using the extract_collection_fields tool.',
            },
          ],
        },
      ],
    })

    const toolBlock = response.content.find(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use'
    )

    const extracted: Record<string, unknown> = (toolBlock?.input as Record<string, unknown>) ?? {}

    // AI metadata is always written regardless of field extraction results
    const updateData: Record<string, unknown> = {
      aiExtractedAt: new Date(),
      aiExtractionNotes:
        typeof extracted.extractionNotes === 'string' ? extracted.extractionNotes : null,
      aiExtractionConfidence:
        typeof extracted.confidence === 'number'
          ? Math.min(1, Math.max(0, extracted.confidence))
          : null,
    }

    // Plain string fields — only fill blank ones
    const stringFields = ['brand', 'name', 'series', 'color', 'scale', 'conditionNotes'] as const
    for (const field of stringFields) {
      const aiVal = extracted[field]
      if (typeof aiVal === 'string' && aiVal.trim() && isBlank(item[field])) {
        updateData[field] = aiVal.trim()
      }
    }

    // cardedOrLoose — normalize to lowercase, validate against allowed values
    if (isBlank(item.cardedOrLoose)) {
      const raw =
        typeof extracted.cardedOrLoose === 'string'
          ? extracted.cardedOrLoose.trim().toLowerCase()
          : null
      if (raw && VALID_CARDED_LOOSE.has(raw)) {
        updateData.cardedOrLoose = raw
      }
    }

    // condition — normalize to lowercase, validate against allowed values
    if (isBlank(item.condition)) {
      const raw =
        typeof extracted.condition === 'string'
          ? extracted.condition.trim().toLowerCase()
          : null
      if (raw && VALID_CONDITIONS.has(raw)) {
        updateData.condition = raw
      }
    }

    // year — validate range 1950–2100
    if (item.year == null && extracted.year != null) {
      const yr =
        typeof extracted.year === 'number'
          ? Math.round(extracted.year)
          : parseInt(String(extracted.year), 10)
      if (!isNaN(yr) && yr >= 1950 && yr <= 2100) {
        updateData.year = yr
      }
    }

    // notes — conservative: fill only if blank and AI provides something useful
    if (isBlank(item.notes)) {
      const aiNotes = typeof extracted.notes === 'string' ? extracted.notes.trim() : null
      if (aiNotes) updateData.notes = aiNotes
    }

    await prisma.collectionItem.update({ where: { id: item.id }, data: updateData })
  } catch {
    return { error: 'AI scan failed. Please try again later or enter details manually.' }
  }

  revalidatePath('/account/collection')
  revalidatePath(`/account/collection/${itemId}`)
  revalidatePath(`/account/collection/${itemId}/edit`)
  redirect(`/account/collection/${itemId}`)
}
