'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'
import { stablePairKey, scorePair, rankPairs } from '@/lib/catalogDuplicateDetection'
import type { DuplicatePair } from '@/lib/catalogDuplicateDetection'
import type { CatalogCandidate } from '@/lib/catalogMatching'
import type { Prisma } from '@prisma/client'

export type DuplicateActionState = { errors: Record<string, string[]> } | null

const PAIR_CAP = 100
const CANDIDATE_PAGE_SIZE = 2000

export type FindDuplicatePairsResult = {
  pairs: DuplicatePair[]
  nextModelCursor: string | null
}

export async function findDuplicatePairs(options?: {
  minScore?: number
  brand?: string
  series?: string
  search?: string
  cursor?: string
}): Promise<FindDuplicatePairsResult> {
  const { minScore = 1, brand, series, search, cursor } = options ?? {}

  const where: Prisma.CatalogModelWhereInput = {}
  if (brand) where.brand = { contains: brand, mode: 'insensitive' }
  if (series) where.series = { contains: series, mode: 'insensitive' }
  if (search) {
    where.OR = [
      { brand: { contains: search, mode: 'insensitive' } },
      { name: { contains: search, mode: 'insensitive' } },
      { series: { contains: search, mode: 'insensitive' } },
    ]
  }

  const models = await prisma.catalogModel.findMany({
    where,
    select: { id: true, brand: true, name: true, series: true, year: true, color: true, scale: true },
    // id as tiebreaker ensures deterministic cursor pagination
    orderBy: [{ brand: 'asc' }, { name: 'asc' }, { id: 'asc' }],
    take: CANDIDATE_PAGE_SIZE,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  })

  const nextModelCursor = models.length === CANDIDATE_PAGE_SIZE ? models[models.length - 1].id : null

  const suppressed = await prisma.catalogDuplicateSuppression.findMany({
    select: { pairKey: true },
  })
  const suppressedKeys = new Set(suppressed.map((s) => s.pairKey))

  const candidates = models as CatalogCandidate[]
  const pairs: DuplicatePair[] = []

  outer: for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i]
      const b = candidates[j]
      const key = stablePairKey(a.id, b.id)
      if (suppressedKeys.has(key)) continue
      const { score, matchReasons } = scorePair(a, b)
      if (score < minScore) continue
      const confidence = score >= 80 ? 'high' : score >= 50 ? 'medium' : 'low'
      pairs.push({ pairKey: key, modelA: a, modelB: b, score, confidence, matchReasons })
      if (pairs.length >= PAIR_CAP) break outer
    }
  }

  return { pairs: rankPairs(pairs), nextModelCursor }
}

export async function suppressPair(
  _prev: DuplicateActionState,
  formData: FormData
): Promise<DuplicateActionState> {
  const idA = formData.get('idA')?.toString().trim() ?? ''
  const idB = formData.get('idB')?.toString().trim() ?? ''
  const adminNote = formData.get('adminNote')?.toString().trim() || null

  if (!idA || !idB) return { errors: { form: ['Missing model IDs.'] } }
  if (idA === idB) return { errors: { form: ['Cannot suppress a model with itself.'] } }

  const [mA, mB] = await Promise.all([
    prisma.catalogModel.findUnique({ where: { id: idA }, select: { id: true } }),
    prisma.catalogModel.findUnique({ where: { id: idB }, select: { id: true } }),
  ])
  if (!mA || !mB) return { errors: { form: ['One or both models not found.'] } }

  const pairKey = stablePairKey(idA, idB)
  await prisma.catalogDuplicateSuppression.upsert({
    where: { pairKey },
    create: { pairKey, adminNote },
    update: { adminNote },
  })

  revalidatePath('/admin/catalog/duplicates')
  revalidatePath('/admin/catalog/duplicates/suppressed')
  return null
}

export async function unsuppressPair(
  _prev: DuplicateActionState,
  formData: FormData
): Promise<DuplicateActionState> {
  const pairKey = formData.get('pairKey')?.toString().trim() ?? ''
  if (!pairKey) return { errors: { form: ['Missing pair key.'] } }

  await prisma.catalogDuplicateSuppression.deleteMany({ where: { pairKey } })

  revalidatePath('/admin/catalog/duplicates')
  revalidatePath('/admin/catalog/duplicates/suppressed')
  return null
}
