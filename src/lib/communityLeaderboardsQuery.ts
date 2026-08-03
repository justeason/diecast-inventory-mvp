import { unstable_cache } from 'next/cache'
import { prisma } from '@/lib/prisma'
import {
  computeLargestCollections,
  computeActiveCollectors,
  computeVerifiedCollectors,
  computeBadges,
  ACTIVE_COLLECTOR_WINDOW_DAYS,
  VERIFIED_COLLECTOR_WINDOW_DAYS,
  type QualifyingProfile,
  type CollectionSummary,
  type RecentItemSummary,
  type VerifiedMarketplaceSummary,
  type LeaderboardData,
  type PublicProfileData,
  type PublicCollectionItem,
} from './communityLeaderboards'

const SCAN_BATCH = 100
const MS_PER_DAY = 24 * 60 * 60 * 1000
export const DIRECTORY_PAGE_SIZE = 24
const PROFILE_RECENT_LIMIT = 24

async function scanOptInProfiles(): Promise<QualifyingProfile[]> {
  const results: QualifyingProfile[] = []
  let cursorId: string | undefined

  for (;;) {
    const batch = await prisma.customerCommunityProfile.findMany({
      where: { isPublic: true, showOnLeaderboards: true },
      select: { id: true, profileId: true, handle: true, displayName: true },
      orderBy: { id: 'asc' },
      take: SCAN_BATCH,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    })
    results.push(...batch.map(r => ({ profileId: r.profileId, handle: r.handle, displayName: r.displayName })))
    if (batch.length < SCAN_BATCH) break
    cursorId = batch[batch.length - 1].id
  }
  return results
}

async function scanCollectionItems(
  profileIds: string[],
): Promise<{ profileId: string; catalogId: string | null; quantity: number }[]> {
  if (profileIds.length === 0) return []
  const results: { profileId: string; catalogId: string | null; quantity: number }[] = []
  let cursorId: string | undefined

  for (;;) {
    const batch = await prisma.collectionItem.findMany({
      where: { profileId: { in: profileIds }, isPublic: true, quantity: { gt: 0 } },
      select: { id: true, profileId: true, catalogId: true, quantity: true },
      orderBy: { id: 'asc' },
      take: SCAN_BATCH,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    })
    results.push(...batch)
    if (batch.length < SCAN_BATCH) break
    cursorId = batch[batch.length - 1].id
  }
  return results
}

async function scanRecentCollectionItems(
  profileIds: string[],
  windowStart: Date,
): Promise<{ profileId: string; catalogId: string | null; createdAt: Date }[]> {
  if (profileIds.length === 0) return []
  const results: { profileId: string; catalogId: string | null; createdAt: Date }[] = []
  let cursorId: string | undefined

  for (;;) {
    const batch = await prisma.collectionItem.findMany({
      where: { profileId: { in: profileIds }, isPublic: true, createdAt: { gte: windowStart } },
      select: { id: true, profileId: true, catalogId: true, createdAt: true },
      orderBy: { id: 'asc' },
      take: SCAN_BATCH,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    })
    results.push(...batch)
    if (batch.length < SCAN_BATCH) break
    cursorId = batch[batch.length - 1].id
  }
  return results
}

// Scan completed OrderItems for qualifying profiles.
// Only non-null customerProfileId rows enter computation.
// Does not select order IDs, prices, buyer email, or payment fields.
async function scanVerifiedOrderItems(
  profileIds: string[],
  windowStart: Date,
): Promise<{ profileId: string; completedAt: Date }[]> {
  if (profileIds.length === 0) return []
  const results: { profileId: string; completedAt: Date }[] = []
  let cursorId: string | undefined

  for (;;) {
    const batch = await prisma.orderItem.findMany({
      where: {
        order: {
          customerProfileId: { in: profileIds },
          status: 'complete',
          completedAt: { gte: windowStart },
        },
      },
      select: {
        id: true,
        order: { select: { customerProfileId: true, completedAt: true } },
      },
      orderBy: { id: 'asc' },
      take: SCAN_BATCH,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    })

    for (const oi of batch) {
      if (!oi.order.customerProfileId || !oi.order.completedAt) continue
      results.push({ profileId: oi.order.customerProfileId, completedAt: oi.order.completedAt })
    }

    if (batch.length < SCAN_BATCH) break
    cursorId = batch[batch.length - 1].id
  }
  return results
}

function buildCollectionSummaries(
  rows: { profileId: string; catalogId: string | null; quantity: number }[],
): Map<string, CollectionSummary> {
  const map = new Map<string, CollectionSummary>()
  for (const row of rows) {
    const s = map.get(row.profileId) ?? { distinctCatalogIds: new Set<string>(), totalItems: 0 }
    s.totalItems += row.quantity
    if (row.catalogId) s.distinctCatalogIds.add(row.catalogId)
    map.set(row.profileId, s)
  }
  return map
}

function buildRecentSummaries(
  rows: { profileId: string; catalogId: string | null; createdAt: Date }[],
): Map<string, RecentItemSummary> {
  const map = new Map<string, RecentItemSummary>()
  for (const row of rows) {
    const s = map.get(row.profileId) ?? {
      additions: 0,
      distinctCatalogIds: new Set<string>(),
      latestAddition: row.createdAt,
    }
    s.additions++
    if (row.catalogId) s.distinctCatalogIds.add(row.catalogId)
    if (row.createdAt > s.latestAddition) s.latestAddition = row.createdAt
    map.set(row.profileId, s)
  }
  return map
}

function buildVerifiedSummaries(
  rows: { profileId: string; completedAt: Date }[],
): Map<string, VerifiedMarketplaceSummary> {
  const map = new Map<string, VerifiedMarketplaceSummary>()
  for (const row of rows) {
    const s = map.get(row.profileId) ?? { completedItemCount: 0, latestCompletedAt: row.completedAt }
    s.completedItemCount++
    if (row.completedAt > s.latestCompletedAt) s.latestCompletedAt = row.completedAt
    map.set(row.profileId, s)
  }
  return map
}

async function buildLeaderboardData(): Promise<LeaderboardData> {
  const nowMs = Date.now()
  const activeWindowStart = new Date(nowMs - ACTIVE_COLLECTOR_WINDOW_DAYS * MS_PER_DAY)
  const verifiedWindowStart = new Date(nowMs - VERIFIED_COLLECTOR_WINDOW_DAYS * MS_PER_DAY)

  const profiles = await scanOptInProfiles()
  const profileIds = profiles.map(p => p.profileId)

  const [allItems, recentRows, verifiedRows] = await Promise.all([
    scanCollectionItems(profileIds),
    scanRecentCollectionItems(profileIds, activeWindowStart),
    scanVerifiedOrderItems(profileIds, verifiedWindowStart),
  ])

  const collectionSummaries = buildCollectionSummaries(allItems)
  const recentSummaries = buildRecentSummaries(recentRows)
  const verifiedSummaries = buildVerifiedSummaries(verifiedRows)

  return {
    largestCollections: computeLargestCollections(profiles, collectionSummaries),
    activeCollectors: computeActiveCollectors(profiles, recentSummaries),
    verifiedCollectors: computeVerifiedCollectors(profiles, verifiedSummaries),
  }
}

export const getLeaderboardData = unstable_cache(
  buildLeaderboardData,
  ['public', 'community', 'leaderboards'],
  { revalidate: 300, tags: ['community-leaderboards'] },
)

export async function getPublicDirectory(cursor?: string): Promise<{
  items: { handle: string; displayName: string; bio: string | null }[]
  nextCursor: string | null
}> {
  const rows = await prisma.customerCommunityProfile.findMany({
    where: {
      isPublic: true,
      ...(cursor ? { handle: { gt: cursor } } : {}),
    },
    orderBy: { handle: 'asc' },
    take: DIRECTORY_PAGE_SIZE + 1,
    select: { handle: true, displayName: true, bio: true },
  })

  const hasMore = rows.length > DIRECTORY_PAGE_SIZE
  const items = hasMore ? rows.slice(0, DIRECTORY_PAGE_SIZE) : rows
  const nextCursor = hasMore ? items[items.length - 1].handle : null

  return { items, nextCursor }
}

export async function getPublicProfile(handle: string): Promise<PublicProfileData | null> {
  const community = await prisma.customerCommunityProfile.findUnique({
    where: { handle: handle.toLowerCase() },
    select: { profileId: true, handle: true, displayName: true, bio: true, isPublic: true, showOnLeaderboards: true },
  })

  if (!community || !community.isPublic) return null

  const windowStart = new Date(Date.now() - ACTIVE_COLLECTOR_WINDOW_DAYS * MS_PER_DAY)

  const [recentRows, allCatalogRows, recentCount, totalItems, verifiedCount] = await Promise.all([
    prisma.collectionItem.findMany({
      where: { profileId: community.profileId, isPublic: true, catalogId: { not: null } },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: PROFILE_RECENT_LIMIT,
      select: {
        id: true,
        catalogId: true,
        createdAt: true,
        catalog: {
          select: {
            brand: true,
            name: true,
            year: true,
            series: true,
            color: true,
            photos: { take: 1, orderBy: { sortOrder: 'asc' }, select: { url: true } },
          },
        },
      },
    }),
    prisma.collectionItem.findMany({
      where: { profileId: community.profileId, isPublic: true, catalogId: { not: null } },
      select: { catalogId: true },
    }),
    prisma.collectionItem.count({
      where: { profileId: community.profileId, isPublic: true, createdAt: { gte: windowStart } },
    }),
    prisma.collectionItem.aggregate({
      where: { profileId: community.profileId, isPublic: true },
      _sum: { quantity: true },
    }),
    // Verified buyer: at least one completed OrderItem via authoritative FK
    prisma.orderItem.count({
      where: {
        order: {
          customerProfileId: community.profileId,
          status: 'complete',
          completedAt: { not: null },
        },
      },
    }),
  ])

  const distinctModels = new Set(allCatalogRows.map(r => r.catalogId!)).size

  const recentItems: PublicCollectionItem[] = recentRows
    .filter((ci): ci is typeof ci & { catalog: NonNullable<typeof ci.catalog> } => ci.catalog != null)
    .map(ci => ({
      catalogId: ci.catalogId!,
      catalogBrand: ci.catalog.brand,
      catalogName: ci.catalog.name,
      catalogYear: ci.catalog.year,
      catalogSeries: ci.catalog.series,
      catalogColor: ci.catalog.color,
      photoUrl: ci.catalog.photos[0]?.url ?? null,
    }))

  return {
    handle: community.handle,
    displayName: community.displayName,
    bio: community.bio,
    badges: computeBadges(distinctModels, recentCount, verifiedCount > 0),
    collection: {
      distinctModels,
      totalItems: totalItems._sum.quantity ?? 0,
      recentItems,
    },
    showOnLeaderboards: community.showOnLeaderboards,
  }
}
