'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { isAdminAuthenticated } from '@/lib/adminAuth'
import {
  computeWhitespaceRepair,
  needsWhitespaceRepair,
  computeOptionalNulls,
  needsOptionalNulls,
} from '@/lib/catalogDataQuality'

const BULK_MAX = 50

export type RepairResult = { ok: true } | { ok: false; error: string }
export type BulkRepairRowResult = { catalogModelId: string; status: 'repaired' | 'skipped' | 'error'; detail?: string }
export type BulkRepairResult = {
  repairedCount: number
  skippedCount:  number
  errorCount:    number
  rows:          BulkRepairRowResult[]
}

// ── Single-model whitespace repair ────────────────────────────────────────────
// Trims leading/trailing whitespace, collapses repeated whitespace, removes
// control characters from brand, name, and series.
// Requires the model's current updatedAt for optimistic concurrency.
// Writes audit in same transaction.

export async function repairTrimWhitespace(
  catalogModelId: string,
  expectedUpdatedAt: string,
  adminNote?: string,
): Promise<RepairResult> {
  if (!await isAdminAuthenticated()) return { ok: false, error: 'Unauthorized.' }
  if (!catalogModelId) return { ok: false, error: 'Missing model ID.' }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "CatalogModel" WHERE id = ${catalogModelId} FOR UPDATE`

      const model = await tx.catalogModel.findUnique({
        where:  { id: catalogModelId },
        select: { id: true, brand: true, name: true, series: true, updatedAt: true },
      })
      if (!model) throw new Error('NOT_FOUND')
      if (model.updatedAt.toISOString() !== new Date(expectedUpdatedAt).toISOString()) {
        throw new Error('STALE')
      }
      if (!needsWhitespaceRepair({ brand: model.brand, name: model.name, series: model.series })) {
        throw new Error('NO_CHANGE')
      }

      const repaired = computeWhitespaceRepair({ brand: model.brand, name: model.name, series: model.series })

      await tx.catalogModel.update({
        where: { id: catalogModelId },
        data:  { brand: repaired.brand, name: repaired.name, series: repaired.series },
      })

      await tx.catalogDataQualityAudit.create({
        data: {
          issueKey:       `whitespace:${catalogModelId}`,
          action:         'trim_whitespace',
          catalogModelId,
          beforeSnapshot: { brand: model.brand, name: model.name, series: model.series } as object,
          afterSnapshot:  repaired as object,
          adminNote:      adminNote ?? null,
        },
      })
    })
  } catch (e) {
    const msg = (e instanceof Error) ? e.message : ''
    if (msg === 'NOT_FOUND')  return { ok: false, error: 'Model not found.' }
    if (msg === 'STALE')      return { ok: false, error: 'Model was modified elsewhere. Refresh and try again.' }
    if (msg === 'NO_CHANGE')  return { ok: false, error: 'No whitespace issues found — nothing to repair.' }
    throw e
  }

  revalidatePath('/admin/catalog-quality')
  return { ok: true }
}

// ── Single-model null-empty-optionals repair ──────────────────────────────────
// Sets empty optional strings (series, color, scale, notes) to null.

export async function repairNullEmptyOptionals(
  catalogModelId: string,
  expectedUpdatedAt: string,
  adminNote?: string,
): Promise<RepairResult> {
  if (!await isAdminAuthenticated()) return { ok: false, error: 'Unauthorized.' }
  if (!catalogModelId) return { ok: false, error: 'Missing model ID.' }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "CatalogModel" WHERE id = ${catalogModelId} FOR UPDATE`

      const model = await tx.catalogModel.findUnique({
        where:  { id: catalogModelId },
        select: { id: true, series: true, color: true, scale: true, notes: true, updatedAt: true },
      })
      if (!model) throw new Error('NOT_FOUND')
      if (model.updatedAt.toISOString() !== new Date(expectedUpdatedAt).toISOString()) {
        throw new Error('STALE')
      }
      if (!needsOptionalNulls({ series: model.series, color: model.color, scale: model.scale, notes: model.notes })) {
        throw new Error('NO_CHANGE')
      }

      const nulled = computeOptionalNulls({ series: model.series, color: model.color, scale: model.scale, notes: model.notes })

      await tx.catalogModel.update({
        where: { id: catalogModelId },
        data:  { series: nulled.series, color: nulled.color, scale: nulled.scale, notes: nulled.notes },
      })

      await tx.catalogDataQualityAudit.create({
        data: {
          issueKey:       `null_optionals:${catalogModelId}`,
          action:         'null_empty_optionals',
          catalogModelId,
          beforeSnapshot: { series: model.series, color: model.color, scale: model.scale, notes: model.notes } as object,
          afterSnapshot:  nulled as object,
          adminNote:      adminNote ?? null,
        },
      })
    })
  } catch (e) {
    const msg = (e instanceof Error) ? e.message : ''
    if (msg === 'NOT_FOUND') return { ok: false, error: 'Model not found.' }
    if (msg === 'STALE')     return { ok: false, error: 'Model was modified elsewhere. Refresh and try again.' }
    if (msg === 'NO_CHANGE') return { ok: false, error: 'No empty optional strings found — nothing to repair.' }
    throw e
  }

  revalidatePath('/admin/catalog-quality')
  return { ok: true }
}

// ── Bulk whitespace repair ────────────────────────────────────────────────────
// Max 50 IDs. Processes each row independently — no all-or-nothing.
// Returns truthful per-row status. Skips rows that need no repair.
// Does NOT claim overall success when individual rows fail.

export async function bulkRepairTrimWhitespace(
  catalogModelIds: string[],
  confirmed: boolean,
): Promise<BulkRepairResult> {
  if (!await isAdminAuthenticated()) {
    return { repairedCount: 0, skippedCount: 0, errorCount: 1, rows: [{ catalogModelId: '', status: 'error', detail: 'Unauthorized.' }] }
  }
  if (!confirmed) {
    return { repairedCount: 0, skippedCount: 0, errorCount: 1, rows: [{ catalogModelId: '', status: 'error', detail: 'Confirmation required.' }] }
  }
  if (!Array.isArray(catalogModelIds) || catalogModelIds.length === 0) {
    return { repairedCount: 0, skippedCount: 0, errorCount: 0, rows: [] }
  }
  const ids = [...new Set(catalogModelIds)]
  if (ids.length > BULK_MAX) {
    return { repairedCount: 0, skippedCount: 0, errorCount: 1, rows: [{ catalogModelId: '', status: 'error', detail: `Too many IDs (${ids.length}). Maximum is ${BULK_MAX}.` }] }
  }
  const rows: BulkRepairRowResult[] = []

  // Fetch all models in one query, then process individually to maintain lock ordering.
  const models = await prisma.catalogModel.findMany({
    where:  { id: { in: ids } },
    select: { id: true, brand: true, name: true, series: true, updatedAt: true },
    orderBy: { id: 'asc' },
  })

  for (const model of models) {
    if (!needsWhitespaceRepair({ brand: model.brand, name: model.name, series: model.series })) {
      rows.push({ catalogModelId: model.id, status: 'skipped', detail: 'No whitespace issues.' })
      continue
    }

    try {
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "CatalogModel" WHERE id = ${model.id} FOR UPDATE`

        const locked = await tx.catalogModel.findUnique({
          where:  { id: model.id },
          select: { brand: true, name: true, series: true, updatedAt: true },
        })
        if (!locked) throw new Error('GONE')
        if (locked.updatedAt.getTime() !== model.updatedAt.getTime()) throw new Error('STALE')

        const repaired = computeWhitespaceRepair({ brand: locked.brand, name: locked.name, series: locked.series })

        await tx.catalogModel.update({
          where: { id: model.id },
          data:  { brand: repaired.brand, name: repaired.name, series: repaired.series },
        })
        await tx.catalogDataQualityAudit.create({
          data: {
            issueKey:       `whitespace:${model.id}`,
            action:         'bulk_trim_whitespace',
            catalogModelId: model.id,
            beforeSnapshot: { brand: locked.brand, name: locked.name, series: locked.series } as object,
            afterSnapshot:  repaired as object,
          },
        })
      })
      rows.push({ catalogModelId: model.id, status: 'repaired' })
    } catch (e) {
      const msg = (e instanceof Error) ? e.message : 'Unknown error'
      const detail = msg === 'GONE' ? 'Model was deleted.' : msg === 'STALE' ? 'Stale — skip and retry.' : msg
      rows.push({ catalogModelId: model.id, status: 'error', detail })
    }
  }

  // IDs not found in DB
  for (const id of ids) {
    if (!models.find(m => m.id === id)) {
      rows.push({ catalogModelId: id, status: 'error', detail: 'Model not found.' })
    }
  }

  revalidatePath('/admin/catalog-quality')
  return {
    repairedCount: rows.filter(r => r.status === 'repaired').length,
    skippedCount:  rows.filter(r => r.status === 'skipped').length,
    errorCount:    rows.filter(r => r.status === 'error').length,
    rows,
  }
}

// ── Bulk null-empty-optionals repair ──────────────────────────────────────────

export async function bulkRepairNullEmptyOptionals(
  catalogModelIds: string[],
  confirmed: boolean,
): Promise<BulkRepairResult> {
  if (!await isAdminAuthenticated()) {
    return { repairedCount: 0, skippedCount: 0, errorCount: 1, rows: [{ catalogModelId: '', status: 'error', detail: 'Unauthorized.' }] }
  }
  if (!confirmed) {
    return { repairedCount: 0, skippedCount: 0, errorCount: 1, rows: [{ catalogModelId: '', status: 'error', detail: 'Confirmation required.' }] }
  }
  if (!Array.isArray(catalogModelIds) || catalogModelIds.length === 0) {
    return { repairedCount: 0, skippedCount: 0, errorCount: 0, rows: [] }
  }
  const ids = [...new Set(catalogModelIds)]
  if (ids.length > BULK_MAX) {
    return { repairedCount: 0, skippedCount: 0, errorCount: 1, rows: [{ catalogModelId: '', status: 'error', detail: `Too many IDs (${ids.length}). Maximum is ${BULK_MAX}.` }] }
  }
  const rows: BulkRepairRowResult[] = []

  const models = await prisma.catalogModel.findMany({
    where:  { id: { in: ids } },
    select: { id: true, series: true, color: true, scale: true, notes: true, updatedAt: true },
    orderBy: { id: 'asc' },
  })

  for (const model of models) {
    if (!needsOptionalNulls({ series: model.series, color: model.color, scale: model.scale, notes: model.notes })) {
      rows.push({ catalogModelId: model.id, status: 'skipped', detail: 'No empty optional strings.' })
      continue
    }

    try {
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "CatalogModel" WHERE id = ${model.id} FOR UPDATE`

        const locked = await tx.catalogModel.findUnique({
          where:  { id: model.id },
          select: { series: true, color: true, scale: true, notes: true, updatedAt: true },
        })
        if (!locked) throw new Error('GONE')
        if (locked.updatedAt.getTime() !== model.updatedAt.getTime()) throw new Error('STALE')

        const nulled = computeOptionalNulls({ series: locked.series, color: locked.color, scale: locked.scale, notes: locked.notes })

        await tx.catalogModel.update({
          where: { id: model.id },
          data:  { series: nulled.series, color: nulled.color, scale: nulled.scale, notes: nulled.notes },
        })
        await tx.catalogDataQualityAudit.create({
          data: {
            issueKey:       `null_optionals:${model.id}`,
            action:         'bulk_null_empty_optionals',
            catalogModelId: model.id,
            beforeSnapshot: { series: locked.series, color: locked.color, scale: locked.scale, notes: locked.notes } as object,
            afterSnapshot:  nulled as object,
          },
        })
      })
      rows.push({ catalogModelId: model.id, status: 'repaired' })
    } catch (e) {
      const msg = (e instanceof Error) ? e.message : 'Unknown error'
      const detail = msg === 'GONE' ? 'Model was deleted.' : msg === 'STALE' ? 'Stale — skip and retry.' : msg
      rows.push({ catalogModelId: model.id, status: 'error', detail })
    }
  }

  for (const id of ids) {
    if (!models.find(m => m.id === id)) {
      rows.push({ catalogModelId: id, status: 'error', detail: 'Model not found.' })
    }
  }

  revalidatePath('/admin/catalog-quality')
  return {
    repairedCount: rows.filter(r => r.status === 'repaired').length,
    skippedCount:  rows.filter(r => r.status === 'skipped').length,
    errorCount:    rows.filter(r => r.status === 'error').length,
    rows,
  }
}

// ── Remove stale duplicate suppression ───────────────────────────────────────
// Removes a suppression where one or both referenced models no longer exist.

export async function removeStaleSuppressionAction(
  pairKey: string,
): Promise<RepairResult> {
  if (!await isAdminAuthenticated()) return { ok: false, error: 'Unauthorized.' }
  if (!pairKey || !pairKey.includes('|')) return { ok: false, error: 'Invalid pair key.' }

  const [idA, idB] = pairKey.split('|')
  const [mA, mB] = await Promise.all([
    prisma.catalogModel.findUnique({ where: { id: idA }, select: { id: true } }),
    prisma.catalogModel.findUnique({ where: { id: idB }, select: { id: true } }),
  ])

  if (mA && mB) {
    return { ok: false, error: 'Both models still exist — this suppression is not stale.' }
  }

  await prisma.catalogDuplicateSuppression.deleteMany({ where: { pairKey } })
  revalidatePath('/admin/catalog-quality')
  revalidatePath('/admin/catalog/duplicates/suppressed')
  return { ok: true }
}
