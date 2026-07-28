import { prisma } from '@/lib/prisma'
import { tokenize, rankCandidates } from '@/lib/catalogMatching'
import type { CatalogMatchResult } from '@/lib/catalogMatching'

export type { CatalogMatchResult }

const TEXT_FIELDS = ['brand', 'name', 'series', 'color', 'scale'] as const

export async function searchCatalogModels(rawQuery: string): Promise<CatalogMatchResult[]> {
  const q = rawQuery.trim().slice(0, 100)
  if (q.length < 2) return []

  const tokens = tokenize(q)
  if (tokens.length === 0) return []

  // AND of per-token OR conditions: every token must appear in at least one candidate field.
  // This keeps DB candidates bounded and relevant without loading the full catalog.
  const perTokenConditions = tokens.map((token) => {
    const yearNum = /^\d{4}$/.test(token) ? parseInt(token, 10) : null
    const fieldMatches = TEXT_FIELDS.map((field) => ({
      [field]: { contains: token, mode: 'insensitive' as const },
    }))
    if (yearNum !== null) (fieldMatches as Array<Record<string, unknown>>).push({ year: yearNum })
    return { OR: fieldMatches }
  })

  const candidates = await prisma.catalogModel.findMany({
    where: { AND: perTokenConditions },
    select: { id: true, brand: true, name: true, series: true, year: true, color: true, scale: true },
    take: 60,
  })

  return rankCandidates(candidates, q).slice(0, 20)
}
