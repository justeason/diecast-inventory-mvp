'use server'

import { redirect } from 'next/navigation'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { isAdminAuthenticated } from '@/lib/adminAuth'
import { ingestCsvImport, type ImportBatchResult } from '@/lib/externalMarketImport'

export type ImportActionState = {
  errors?: Record<string, string[]>
  result?: ImportBatchResult
  batchError?: string
} | null

export async function importMarketDataCsv(
  _prev: ImportActionState,
  formData: FormData,
): Promise<ImportActionState> {
  if (!await isAdminAuthenticated()) return { errors: { form: ['Unauthorized'] } }

  const provider  = formData.get('provider')?.toString().trim() ?? ''
  const adminInfo = formData.get('adminInfo')?.toString().trim() || null
  const file      = formData.get('file')

  const errors: Record<string, string[]> = {}
  if (!provider) errors['provider'] = ['Provider name is required']
  if (!(file instanceof File) || file.size === 0) errors['file'] = ['CSV file is required']
  if (Object.keys(errors).length > 0) return { errors }

  const csvText = await (file as File).text()

  try {
    const result = await ingestCsvImport(csvText, provider, (file as File).name || null, adminInfo)
    return { result }
  } catch (e) {
    return { batchError: e instanceof Error ? e.message : 'Import failed' }
  }
}

export type MatchActionState = { errors?: Record<string, string[]> } | null

const matchSchema = z.object({
  catalogModelId: z.string().min(1, 'Catalog model is required'),
  updatedAt:      z.string().min(1, 'Missing updatedAt'),
})

export async function matchObservationToCatalog(
  observationId: string,
  _prev: MatchActionState,
  formData: FormData,
): Promise<MatchActionState> {
  if (!await isAdminAuthenticated()) return { errors: { form: ['Unauthorized'] } }

  const parsed = matchSchema.safeParse({
    catalogModelId: formData.get('catalogModelId'),
    updatedAt:      formData.get('updatedAt'),
  })
  if (!parsed.success) return { errors: parsed.error.flatten().fieldErrors }

  const catalog = await prisma.catalogModel.findUnique({ where: { id: parsed.data.catalogModelId } })
  if (!catalog) return { errors: { catalogModelId: ['Catalog model not found'] } }

  try {
    await prisma.$transaction(async (tx) => {
      const obs = await tx.externalMarketObservation.findUnique({ where: { id: observationId } })
      if (!obs) throw new Error('NOT_FOUND')
      if (obs.updatedAt.toISOString() !== parsed.data.updatedAt) throw new Error('STALE')

      const before = {
        matchStatus:    obs.matchStatus,
        catalogModelId: obs.catalogModelId,
        matchMethod:    obs.matchMethod,
      }

      await tx.externalMarketObservation.update({
        where: { id: observationId },
        data: {
          matchStatus:     'matched',
          catalogModelId:  parsed.data.catalogModelId,
          matchMethod:     'manual',
          rejectionReason: null,
        },
      })
      await tx.externalMarketObservationAudit.create({
        data: {
          observationId,
          action: 'matched',
          beforeSnapshot: before,
          afterSnapshot: {
            matchStatus:    'matched',
            catalogModelId: parsed.data.catalogModelId,
            matchMethod:    'manual',
          },
        },
      })
    })
  } catch (e) {
    if (e instanceof Error && e.message === 'NOT_FOUND') return { errors: { form: ['Observation not found'] } }
    if (e instanceof Error && e.message === 'STALE') return { errors: { form: ['Observation was modified by another admin. Please refresh.'] } }
    throw e
  }

  redirect(`/admin/market-research/observations/${observationId}`)
}

// updatedAt is bound from the page to guard against concurrent edits.
// Stale → redirect without mutation; the page re-renders with current state.
export async function unmatchObservation(observationId: string, updatedAt: string): Promise<void> {
  if (!await isAdminAuthenticated()) return

  try {
    await prisma.$transaction(async (tx) => {
      const obs = await tx.externalMarketObservation.findUnique({ where: { id: observationId } })
      if (!obs || obs.updatedAt.toISOString() !== updatedAt) return

      const before = { matchStatus: obs.matchStatus, catalogModelId: obs.catalogModelId }

      await tx.externalMarketObservation.update({
        where: { id: observationId },
        data: { matchStatus: 'unmatched', catalogModelId: null, matchMethod: null },
      })
      await tx.externalMarketObservationAudit.create({
        data: {
          observationId,
          action: 'unmatched',
          beforeSnapshot: before,
          afterSnapshot: { matchStatus: 'unmatched', catalogModelId: null },
        },
      })
    })
  } catch { /* redirect still occurs; page shows current state */ }

  redirect(`/admin/market-research/observations/${observationId}`)
}

const rejectSchema = z.object({
  rejectionReason: z.string().min(1, 'Rejection reason is required').max(500),
  updatedAt:       z.string().min(1, 'Missing updatedAt'),
})

export async function rejectObservation(
  observationId: string,
  _prev: MatchActionState,
  formData: FormData,
): Promise<MatchActionState> {
  if (!await isAdminAuthenticated()) return { errors: { form: ['Unauthorized'] } }

  const parsed = rejectSchema.safeParse({
    rejectionReason: formData.get('rejectionReason'),
    updatedAt:       formData.get('updatedAt'),
  })
  if (!parsed.success) return { errors: parsed.error.flatten().fieldErrors }

  try {
    await prisma.$transaction(async (tx) => {
      const obs = await tx.externalMarketObservation.findUnique({ where: { id: observationId } })
      if (!obs) throw new Error('NOT_FOUND')
      if (obs.updatedAt.toISOString() !== parsed.data.updatedAt) throw new Error('STALE')

      const before = {
        matchStatus:     obs.matchStatus,
        catalogModelId:  obs.catalogModelId,
        rejectionReason: obs.rejectionReason,
      }

      await tx.externalMarketObservation.update({
        where: { id: observationId },
        data: { matchStatus: 'rejected', rejectionReason: parsed.data.rejectionReason },
      })
      await tx.externalMarketObservationAudit.create({
        data: {
          observationId,
          action: 'rejected',
          beforeSnapshot: before,
          afterSnapshot: { matchStatus: 'rejected', rejectionReason: parsed.data.rejectionReason },
        },
      })
    })
  } catch (e) {
    if (e instanceof Error && e.message === 'NOT_FOUND') return { errors: { form: ['Observation not found'] } }
    if (e instanceof Error && e.message === 'STALE') return { errors: { form: ['Observation was modified by another admin. Please refresh.'] } }
    throw e
  }

  redirect(`/admin/market-research/observations/${observationId}`)
}

// updatedAt is bound from the page to guard against concurrent edits.
export async function restoreObservation(observationId: string, updatedAt: string): Promise<void> {
  if (!await isAdminAuthenticated()) return

  try {
    await prisma.$transaction(async (tx) => {
      const obs = await tx.externalMarketObservation.findUnique({ where: { id: observationId } })
      if (!obs || obs.matchStatus !== 'rejected' || obs.updatedAt.toISOString() !== updatedAt) return

      const before = { matchStatus: obs.matchStatus, rejectionReason: obs.rejectionReason }

      await tx.externalMarketObservation.update({
        where: { id: observationId },
        data: { matchStatus: 'unmatched', rejectionReason: null },
      })
      await tx.externalMarketObservationAudit.create({
        data: {
          observationId,
          action: 'restored',
          beforeSnapshot: before,
          afterSnapshot: { matchStatus: 'unmatched', rejectionReason: null },
        },
      })
    })
  } catch { /* redirect still occurs; page shows current state */ }

  redirect(`/admin/market-research/observations/${observationId}`)
}
