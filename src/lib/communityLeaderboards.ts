// ─── Constants ────────────────────────────────────────────────────────────────

export const HANDLE_REGEX = /^[a-z0-9_]{3,24}$/
export const RESERVED_HANDLES = new Set([
  'admin', 'account', 'api', 'market', 'community', 'login', 'sell', 'support',
])
export const LARGEST_COLLECTION_MIN_DISTINCT = 3
export const ACTIVE_COLLECTOR_MIN_ADDITIONS = 2
export const ACTIVE_COLLECTOR_WINDOW_DAYS = 30
export const ACTIVE_COLLECTOR_BADGE_MIN = 5
export const VERIFIED_COLLECTOR_WINDOW_DAYS = 180
export const VERIFIED_COLLECTOR_MIN_ITEMS = 1

// ─── Types ────────────────────────────────────────────────────────────────────

export type Badge =
  | 'public_collector'
  | 'collection_10'
  | 'collection_50'
  | 'collection_100'
  | 'active_collector'
  | 'verified_buyer'

export type QualifyingProfile = {
  profileId: string
  handle: string
  displayName: string
}

export type CollectionSummary = {
  distinctCatalogIds: Set<string>
  totalItems: number
}

export type RecentItemSummary = {
  additions: number
  distinctCatalogIds: Set<string>
  latestAddition: Date
}

export type VerifiedMarketplaceSummary = {
  completedItemCount: number
  latestCompletedAt: Date
}

export type LargestCollectionEntry = {
  rank: number
  handle: string
  displayName: string
  distinctModels: number
  totalItems: number
}

export type ActiveCollectorEntry = {
  rank: number
  handle: string
  displayName: string
  additions: number
  distinctModels: number
  latestAddition: Date
}

export type VerifiedCollectorEntry = {
  rank: number
  handle: string
  displayName: string
  completedItemCount: number
}

export type LeaderboardData = {
  largestCollections: LargestCollectionEntry[]
  activeCollectors: ActiveCollectorEntry[]
  verifiedCollectors: VerifiedCollectorEntry[]
}

export type PublicCollectionItem = {
  id: string
  catalogId: string
  catalogBrand: string
  catalogName: string
  catalogYear: number | null
  catalogSeries: string | null
  catalogColor: string | null
  photoUrl: string | null
  addedAt: Date
}

export type PublicProfileData = {
  handle: string
  displayName: string
  bio: string | null
  badges: Badge[]
  collection: {
    distinctModels: number
    totalItems: number
    recentItems: PublicCollectionItem[]
  }
  showOnLeaderboards: boolean
}

// ─── Validation ───────────────────────────────────────────────────────────────

export function trimInput(raw: string): string {
  return raw.trim()
}

export function validateNoControlChars(value: string): string | null {
  if (/[\x00-\x1F\x7F]/.test(value)) {
    return 'Input contains invalid characters. Please remove any special or control characters.'
  }
  return null
}

export function normalizeHandle(raw: string): string {
  return raw.toLowerCase().trim()
}

export function validateHandle(handle: string): string | null {
  if (!HANDLE_REGEX.test(handle)) {
    return 'Handle must be 3–24 characters: lowercase letters, numbers, and underscores only'
  }
  if (RESERVED_HANDLES.has(handle)) {
    return 'This handle is reserved and cannot be used'
  }
  return null
}

export function validateDisplayName(name: string): string | null {
  const trimmed = name.trim()
  if (trimmed.length < 2 || trimmed.length > 40) {
    return 'Display name must be 2–40 characters'
  }
  return null
}

export function validateBio(bio: string): string | null {
  if (bio.trim().length > 160) {
    return 'Bio must be 160 characters or fewer'
  }
  return null
}

// ─── Computation ──────────────────────────────────────────────────────────────

// Rank: distinctModels DESC, totalItems DESC, handle ASC
export function computeLargestCollections(
  profiles: QualifyingProfile[],
  itemsByProfile: Map<string, CollectionSummary>,
  minDistinct = LARGEST_COLLECTION_MIN_DISTINCT,
  maxResults = 20,
): LargestCollectionEntry[] {
  const entries: Omit<LargestCollectionEntry, 'rank'>[] = []
  for (const p of profiles) {
    const summary = itemsByProfile.get(p.profileId)
    if (!summary || summary.distinctCatalogIds.size < minDistinct) continue
    entries.push({
      handle: p.handle,
      displayName: p.displayName,
      distinctModels: summary.distinctCatalogIds.size,
      totalItems: summary.totalItems,
    })
  }
  return entries
    .sort((a, b) => {
      if (b.distinctModels !== a.distinctModels) return b.distinctModels - a.distinctModels
      if (b.totalItems !== a.totalItems) return b.totalItems - a.totalItems
      return a.handle.localeCompare(b.handle)
    })
    .slice(0, maxResults)
    .map((e, i) => ({ ...e, rank: i + 1 }))
}

// Rank: additions DESC, distinctModels DESC, latestAddition DESC, handle ASC
export function computeActiveCollectors(
  profiles: QualifyingProfile[],
  recentItems: Map<string, RecentItemSummary>,
  minAdditions = ACTIVE_COLLECTOR_MIN_ADDITIONS,
  maxResults = 20,
): ActiveCollectorEntry[] {
  const entries: Omit<ActiveCollectorEntry, 'rank'>[] = []
  for (const p of profiles) {
    const recent = recentItems.get(p.profileId)
    if (!recent || recent.additions < minAdditions) continue
    entries.push({
      handle: p.handle,
      displayName: p.displayName,
      additions: recent.additions,
      distinctModels: recent.distinctCatalogIds.size,
      latestAddition: recent.latestAddition,
    })
  }
  return entries
    .sort((a, b) => {
      if (b.additions !== a.additions) return b.additions - a.additions
      if (b.distinctModels !== a.distinctModels) return b.distinctModels - a.distinctModels
      const timeDiff = b.latestAddition.getTime() - a.latestAddition.getTime()
      if (timeDiff !== 0) return timeDiff
      return a.handle.localeCompare(b.handle)
    })
    .slice(0, maxResults)
    .map((e, i) => ({ ...e, rank: i + 1 }))
}

// Rank: completedItemCount DESC, latestCompletedAt DESC, handle ASC
// latestCompletedAt used for sorting only — not included in returned type
export function computeVerifiedCollectors(
  profiles: QualifyingProfile[],
  verifiedByProfile: Map<string, VerifiedMarketplaceSummary>,
  minItems = VERIFIED_COLLECTOR_MIN_ITEMS,
  maxResults = 20,
): VerifiedCollectorEntry[] {
  type Sortable = { handle: string; displayName: string; completedItemCount: number; latestCompletedAt: Date }
  const entries: Sortable[] = []
  for (const p of profiles) {
    const v = verifiedByProfile.get(p.profileId)
    if (!v || v.completedItemCount < minItems) continue
    entries.push({
      handle: p.handle,
      displayName: p.displayName,
      completedItemCount: v.completedItemCount,
      latestCompletedAt: v.latestCompletedAt,
    })
  }
  return entries
    .sort((a, b) => {
      if (b.completedItemCount !== a.completedItemCount) return b.completedItemCount - a.completedItemCount
      const timeDiff = b.latestCompletedAt.getTime() - a.latestCompletedAt.getTime()
      if (timeDiff !== 0) return timeDiff
      return a.handle.localeCompare(b.handle)
    })
    .slice(0, maxResults)
    .map((e, i) => ({
      rank: i + 1,
      handle: e.handle,
      displayName: e.displayName,
      completedItemCount: e.completedItemCount,
    }))
}

export function computeBadges(
  distinctModels: number,
  recentAdditions: number,
  hasVerifiedPurchase: boolean,
): Badge[] {
  const badges: Badge[] = ['public_collector']
  if (distinctModels >= 10) badges.push('collection_10')
  if (distinctModels >= 50) badges.push('collection_50')
  if (distinctModels >= 100) badges.push('collection_100')
  if (recentAdditions >= ACTIVE_COLLECTOR_BADGE_MIN) badges.push('active_collector')
  if (hasVerifiedPurchase) badges.push('verified_buyer')
  return badges
}
