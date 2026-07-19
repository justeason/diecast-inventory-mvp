// Pure helpers with no server dependencies — safe to import from client components.

export type CatalogSearchResult = {
  id: string
  brand: string
  name: string
  series: string | null
  year: number | null
  color: string | null
  scale: string | null
}

export function formatCatalogResult(m: CatalogSearchResult): string {
  const parts: string[] = [m.brand, m.name]
  if (m.year) parts.push(`(${m.year})`)
  if (m.color) parts.push(`— ${m.color}`)
  if (m.series) parts.push(`[${m.series}]`)
  return parts.join(' ')
}
