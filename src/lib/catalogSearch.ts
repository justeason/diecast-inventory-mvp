import { prisma } from '@/lib/prisma'
import type { CatalogSearchResult } from '@/lib/catalogFormat'

function rankResult(m: CatalogSearchResult, qLower: string): number {
  const b = m.brand.toLowerCase()
  const n = m.name.toLowerCase()
  if (`${b} ${n}` === qLower || b === qLower || n === qLower) return 0
  if (b.startsWith(qLower) || n.startsWith(qLower)) return 1
  if (b.includes(qLower) || n.includes(qLower)) return 2
  return 3
}

export async function searchCatalogModels(rawQuery: string): Promise<CatalogSearchResult[]> {
  const q = rawQuery.trim().slice(0, 100)
  if (q.length < 2) return []

  // Escape LIKE special characters so user input is treated literally
  const escaped = q.replace(/[%_\\]/g, (c) => `\\${c}`)
  const yearNum = /^\d{4}$/.test(q) ? parseInt(q, 10) : null

  const candidates = await prisma.catalogModel.findMany({
    where: {
      OR: [
        { brand:  { contains: escaped, mode: 'insensitive' } },
        { name:   { contains: escaped, mode: 'insensitive' } },
        { series: { contains: escaped, mode: 'insensitive' } },
        { color:  { contains: escaped, mode: 'insensitive' } },
        { scale:  { contains: escaped, mode: 'insensitive' } },
        ...(yearNum !== null ? [{ year: yearNum }] : []),
      ],
    },
    select: { id: true, brand: true, name: true, series: true, year: true, color: true, scale: true },
    take: 30,
  })

  const qLower = q.toLowerCase()
  return candidates
    .sort((a, b) => rankResult(a, qLower) - rankResult(b, qLower))
    .slice(0, 10)
}
