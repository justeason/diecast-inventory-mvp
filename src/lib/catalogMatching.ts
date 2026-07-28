// Pure catalog matching helper — no DB or server dependencies.

export type CatalogCandidate = {
  id: string
  brand: string
  name: string
  series: string | null
  year: number | null
  color: string | null
  scale: string | null
}

export type CatalogMatchResult = CatalogCandidate & {
  catalogModelId: string
  label: string
  score: number
  matchReasons: string[]
  matchedFields: string[]
}

// Score >= threshold indicates likely duplicate (brand+name or stronger match)
export const DUPLICATE_SCORE_THRESHOLD = 80

export function normalize(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function tokenize(q: string): string[] {
  return normalize(q)
    .split(' ')
    .filter((t) => t.length >= 2)
}

export function formatCandidateLabel(c: CatalogCandidate): string {
  const parts: string[] = [c.brand, c.name]
  if (c.year) parts.push(`(${c.year})`)
  if (c.color) parts.push(`— ${c.color}`)
  if (c.series) parts.push(`[${c.series}]`)
  return parts.join(' ')
}

function scoreOne(
  c: CatalogCandidate,
  normQuery: string,
  tokens: string[],
): { score: number; matchReasons: string[]; matchedFields: string[] } {
  if (!tokens.length) return { score: 0, matchReasons: [], matchedFields: [] }

  const nb = normalize(c.brand)
  const nn = normalize(c.name)
  const ns = c.series ? normalize(c.series) : null
  const nc = c.color ? normalize(c.color) : null
  const nsc = c.scale ? normalize(c.scale) : null
  const ys = c.year != null ? String(c.year) : null
  const full = `${nb} ${nn}`

  // Rule 1: exact full match
  if (full === normQuery || nb === normQuery || nn === normQuery) {
    return { score: 100, matchReasons: ['Exact match'], matchedFields: ['brand', 'name'] }
  }

  // Rule 2: exact brand token + exact name token both present
  const brandExact = tokens.some((t) => nb === t)
  const nameExact = tokens.some((t) => nn === t)
  if (brandExact && nameExact) {
    const reasons = ['Brand and name match']
    const fields = ['brand', 'name']
    let score = 92
    if (ns && tokens.some((t) => ns.includes(t))) { score += 3; fields.push('series'); reasons.push('Series match') }
    if (ys && tokens.includes(ys)) { score += 3; fields.push('year'); reasons.push('Year match') }
    if (nc && tokens.some((t) => nc.includes(t))) { score += 2; fields.push('color'); reasons.push('Color match') }
    return { score: Math.min(99, score), matchReasons: reasons, matchedFields: fields }
  }

  // Rule 3: prefix — brand+name starts with query (min 4 chars)
  if (normQuery.length >= 4 && full.startsWith(normQuery)) {
    return { score: 78, matchReasons: ['Prefix match'], matchedFields: ['brand', 'name'] }
  }

  // Rule 4: all tokens present across any candidate field
  const allCandidateFields = [nb, nn, ns, nc, nsc, ys].filter((f): f is string => f !== null)
  if (tokens.every((t) => allCandidateFields.some((f) => f.includes(t)))) {
    const reasons: string[] = ['All tokens matched']
    const fields: string[] = []
    let score = 65
    if (tokens.some((t) => nb.includes(t))) fields.push('brand')
    if (tokens.some((t) => nn.includes(t))) fields.push('name')
    if (ns && tokens.some((t) => ns.includes(t))) { fields.push('series'); score += 3; reasons.push('Series match') }
    if (ys && tokens.includes(ys)) { fields.push('year'); score += 3; reasons.push('Year match') }
    if (nc && tokens.some((t) => nc.includes(t))) fields.push('color')
    return { score, matchReasons: reasons, matchedFields: fields }
  }

  // Rule 5: brand + series + year
  const bPresent = tokens.some((t) => nb.includes(t))
  const sPresent = ns != null && tokens.some((t) => t.length >= 2 && ns.includes(t))
  const yPresent = ys != null && tokens.includes(ys)
  if (bPresent && sPresent && yPresent) {
    const fields = ['brand']
    if (ns) fields.push('series')
    fields.push('year')
    return { score: 55, matchReasons: ['Brand, series, and year match'], matchedFields: fields }
  }

  // Rule 6: partial token matches — additive
  const reasons: string[] = []
  const fields: string[] = []
  let partial = 0
  if (bPresent) { partial += 20; fields.push('brand') }
  if (tokens.some((t) => nn.includes(t))) { partial += 20; fields.push('name') }
  if (sPresent) { partial += 10; fields.push('series') }
  if (yPresent) { partial += 10; fields.push('year') }
  if (nc && tokens.some((t) => nc.includes(t))) { partial += 5; fields.push('color') }

  if (partial > 0) {
    if (fields.includes('brand') && fields.includes('name')) reasons.push('Brand and name match')
    else if (fields.includes('brand')) reasons.push('Brand match')
    else if (fields.includes('name')) reasons.push('Name match')
    if (fields.includes('series')) reasons.push('Series match')
    if (fields.includes('year')) reasons.push('Year match')
    return { score: Math.min(49, partial), matchReasons: reasons, matchedFields: fields }
  }

  return { score: 0, matchReasons: [], matchedFields: [] }
}

export function rankCandidates(
  candidates: CatalogCandidate[],
  query: string,
): CatalogMatchResult[] {
  if (!query.trim() || !candidates.length) return []
  const normQuery = normalize(query)
  const tokens = tokenize(query)
  return candidates
    .map((c) => {
      const { score, matchReasons, matchedFields } = scoreOne(c, normQuery, tokens)
      return { ...c, catalogModelId: c.id, label: formatCandidateLabel(c), score, matchReasons, matchedFields }
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.brand.localeCompare(b.brand) || a.name.localeCompare(b.name))
}
