import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import {
  trimInput,
  normalizeHandle,
  validateNoControlChars,
  validateHandle,
  validateDisplayName,
  validateBio,
  computeLargestCollections,
  computeActiveCollectors,
  computeVerifiedCollectors,
  computeBadges,
  HANDLE_REGEX,
  RESERVED_HANDLES,
  LARGEST_COLLECTION_MIN_DISTINCT,
  ACTIVE_COLLECTOR_MIN_ADDITIONS,
  ACTIVE_COLLECTOR_BADGE_MIN,
  VERIFIED_COLLECTOR_WINDOW_DAYS,
  VERIFIED_COLLECTOR_MIN_ITEMS,
  type QualifyingProfile,
  type CollectionSummary,
  type RecentItemSummary,
  type VerifiedMarketplaceSummary,
} from '../communityLeaderboards'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeProfile(profileId: string, handle: string, displayName = 'User'): QualifyingProfile {
  return { profileId, handle, displayName }
}

function makeCollectionSummary(distinctCount: number, totalItems: number): CollectionSummary {
  const distinctCatalogIds = new Set(Array.from({ length: distinctCount }, (_, i) => `cat-${i}`))
  return { distinctCatalogIds, totalItems }
}

function makeRecentSummary(
  additions: number,
  distinctCount: number,
  latestAddition: Date,
): RecentItemSummary {
  const distinctCatalogIds = new Set(Array.from({ length: distinctCount }, (_, i) => `cat-${i}`))
  return { additions, distinctCatalogIds, latestAddition }
}

function makeVerifiedSummary(completedItemCount: number, latestCompletedAt: Date): VerifiedMarketplaceSummary {
  return { completedItemCount, latestCompletedAt }
}

// ─── trimInput ────────────────────────────────────────────────────────────────

describe('trimInput', () => {
  it('trims leading and trailing whitespace', () => {
    expect(trimInput('  hello  ')).toBe('hello')
  })

  it('preserves normal text', () => {
    expect(trimInput('Hot Wheels')).toBe('Hot Wheels')
  })

  it('does NOT strip control characters (detection is separate)', () => {
    expect(trimInput('abc\x00def')).toBe('abc\x00def')
  })
})

// ─── validateNoControlChars ───────────────────────────────────────────────────

describe('validateNoControlChars', () => {
  it('returns null for normal text', () => {
    expect(validateNoControlChars('Hot Wheels collector')).toBeNull()
    expect(validateNoControlChars('')).toBeNull()
    expect(validateNoControlChars('hello_world')).toBeNull()
  })

  it('returns an error for NUL byte', () => {
    expect(validateNoControlChars('abc\x00def')).not.toBeNull()
  })

  it('returns an error for other control chars (\\x01-\\x1F)', () => {
    expect(validateNoControlChars('abc\x01def')).not.toBeNull()
    expect(validateNoControlChars('abc\x1Fdef')).not.toBeNull()
  })

  it('returns an error for DEL (\\x7F)', () => {
    expect(validateNoControlChars('abc\x7Fdef')).not.toBeNull()
  })

  it('returns an error for newline embedded in input', () => {
    expect(validateNoControlChars('abc\ndef')).not.toBeNull()
  })

  it('returns an error for carriage return', () => {
    expect(validateNoControlChars('abc\rdef')).not.toBeNull()
  })

  it('error is a non-empty string', () => {
    const err = validateNoControlChars('abc\x00def')
    expect(typeof err).toBe('string')
    expect((err as string).length).toBeGreaterThan(0)
  })
})

// ─── normalizeHandle ──────────────────────────────────────────────────────────

describe('normalizeHandle', () => {
  it('lowercases input', () => {
    expect(normalizeHandle('MyHandle')).toBe('myhandle')
  })

  it('trims whitespace', () => {
    expect(normalizeHandle('  abc  ')).toBe('abc')
  })
})

// ─── validateHandle ───────────────────────────────────────────────────────────

describe('validateHandle', () => {
  it('accepts valid handles', () => {
    expect(validateHandle('hot_wheels')).toBeNull()
    expect(validateHandle('abc')).toBeNull()
    expect(validateHandle('a'.repeat(24))).toBeNull()
    expect(validateHandle('collector123')).toBeNull()
    expect(validateHandle('abc_123')).toBeNull()
  })

  it('rejects handles shorter than 3 chars', () => {
    expect(validateHandle('ab')).not.toBeNull()
  })

  it('rejects handles longer than 24 chars', () => {
    expect(validateHandle('a'.repeat(25))).not.toBeNull()
  })

  it('rejects uppercase', () => {
    expect(validateHandle('MyHandle')).not.toBeNull()
  })

  it('rejects spaces', () => {
    expect(validateHandle('my handle')).not.toBeNull()
  })

  it('rejects hyphens', () => {
    expect(validateHandle('my-handle')).not.toBeNull()
  })

  it('rejects empty string', () => {
    expect(validateHandle('')).not.toBeNull()
  })

  it('rejects all reserved handles', () => {
    for (const reserved of RESERVED_HANDLES) {
      expect(validateHandle(reserved)).not.toBeNull()
    }
  })

  it('HANDLE_REGEX matches only valid chars', () => {
    expect(HANDLE_REGEX.test('abc')).toBe(true)
    expect(HANDLE_REGEX.test('abc_123')).toBe(true)
    expect(HANDLE_REGEX.test('ABC')).toBe(false)
    expect(HANDLE_REGEX.test('a-b')).toBe(false)
  })
})

// ─── validateDisplayName ──────────────────────────────────────────────────────

describe('validateDisplayName', () => {
  it('accepts 2-char minimum', () => {
    expect(validateDisplayName('AB')).toBeNull()
  })

  it('accepts 40-char maximum', () => {
    expect(validateDisplayName('A'.repeat(40))).toBeNull()
  })

  it('rejects 1-char name', () => {
    expect(validateDisplayName('A')).not.toBeNull()
  })

  it('rejects 41-char name', () => {
    expect(validateDisplayName('A'.repeat(41))).not.toBeNull()
  })

  it('rejects empty', () => {
    expect(validateDisplayName('')).not.toBeNull()
  })
})

// ─── validateBio ──────────────────────────────────────────────────────────────

describe('validateBio', () => {
  it('accepts empty bio', () => {
    expect(validateBio('')).toBeNull()
  })

  it('accepts 160-char bio', () => {
    expect(validateBio('A'.repeat(160))).toBeNull()
  })

  it('rejects 161-char bio', () => {
    expect(validateBio('A'.repeat(161))).not.toBeNull()
  })
})

// ─── computeLargestCollections ────────────────────────────────────────────────

describe('computeLargestCollections', () => {
  const profiles = [
    makeProfile('p1', 'alpha'),
    makeProfile('p2', 'beta'),
    makeProfile('p3', 'gamma'),
  ]

  it('returns empty when no profiles', () => {
    expect(computeLargestCollections([], new Map())).toEqual([])
  })

  it('excludes profiles below minDistinct', () => {
    const map = new Map([['p1', makeCollectionSummary(2, 10)]])
    const result = computeLargestCollections(profiles.slice(0, 1), map)
    expect(result).toHaveLength(0)
  })

  it('includes profiles meeting minDistinct', () => {
    const map = new Map([['p1', makeCollectionSummary(3, 5)]])
    const result = computeLargestCollections(profiles.slice(0, 1), map)
    expect(result).toHaveLength(1)
    expect(result[0].rank).toBe(1)
  })

  it('sorts by distinctModels DESC then totalItems DESC then handle ASC', () => {
    const map = new Map([
      ['p1', makeCollectionSummary(5, 10)],
      ['p2', makeCollectionSummary(5, 20)],
      ['p3', makeCollectionSummary(3, 100)],
    ])
    const result = computeLargestCollections(profiles, map)
    expect(result[0].handle).toBe('beta')
    expect(result[1].handle).toBe('alpha')
    expect(result[2].handle).toBe('gamma')
  })

  it('breaks totalItems tie with handle ASC', () => {
    const p = [makeProfile('p1', 'zebra'), makeProfile('p2', 'aardvark')]
    const map = new Map([
      ['p1', makeCollectionSummary(5, 10)],
      ['p2', makeCollectionSummary(5, 10)],
    ])
    const result = computeLargestCollections(p, map)
    expect(result[0].handle).toBe('aardvark')
    expect(result[1].handle).toBe('zebra')
  })

  it('assigns sequential ranks', () => {
    const map = new Map([
      ['p1', makeCollectionSummary(5, 10)],
      ['p2', makeCollectionSummary(4, 10)],
      ['p3', makeCollectionSummary(3, 10)],
    ])
    const result = computeLargestCollections(profiles, map)
    expect(result.map(r => r.rank)).toEqual([1, 2, 3])
  })

  it('respects maxResults', () => {
    const map = new Map([
      ['p1', makeCollectionSummary(5, 10)],
      ['p2', makeCollectionSummary(4, 10)],
      ['p3', makeCollectionSummary(3, 10)],
    ])
    const result = computeLargestCollections(profiles, map, LARGEST_COLLECTION_MIN_DISTINCT, 2)
    expect(result).toHaveLength(2)
  })

  it('includes totalItems from quantity sum', () => {
    const map = new Map([['p1', makeCollectionSummary(3, 7)]])
    const result = computeLargestCollections(profiles.slice(0, 1), map)
    expect(result[0].totalItems).toBe(7)
  })

  it('excludes profiles missing from itemsByProfile map', () => {
    const result = computeLargestCollections(profiles, new Map())
    expect(result).toHaveLength(0)
  })
})

// ─── computeActiveCollectors ──────────────────────────────────────────────────

describe('computeActiveCollectors', () => {
  const profiles = [
    makeProfile('p1', 'alpha'),
    makeProfile('p2', 'beta'),
    makeProfile('p3', 'gamma'),
  ]
  const now = new Date('2026-08-02T12:00:00Z')
  const earlier = new Date('2026-08-01T00:00:00Z')
  const latest = new Date('2026-08-02T11:00:00Z')

  it('returns empty when no profiles', () => {
    expect(computeActiveCollectors([], new Map())).toEqual([])
  })

  it('excludes profiles below minAdditions', () => {
    const map = new Map([['p1', makeRecentSummary(1, 2, now)]])
    expect(computeActiveCollectors(profiles.slice(0, 1), map)).toHaveLength(0)
  })

  it('includes profiles meeting minAdditions', () => {
    const map = new Map([['p1', makeRecentSummary(2, 2, now)]])
    const result = computeActiveCollectors(profiles.slice(0, 1), map)
    expect(result).toHaveLength(1)
    expect(result[0].rank).toBe(1)
  })

  it('sorts by additions DESC', () => {
    const map = new Map([
      ['p1', makeRecentSummary(3, 2, now)],
      ['p2', makeRecentSummary(5, 2, now)],
    ])
    const result = computeActiveCollectors(profiles.slice(0, 2), map)
    expect(result[0].handle).toBe('beta')
    expect(result[1].handle).toBe('alpha')
  })

  it('breaks additions tie by distinctModels DESC', () => {
    const map = new Map([
      ['p1', makeRecentSummary(3, 1, now)],
      ['p2', makeRecentSummary(3, 3, now)],
    ])
    const result = computeActiveCollectors(profiles.slice(0, 2), map)
    expect(result[0].handle).toBe('beta')
  })

  it('breaks distinctModels tie by latestAddition DESC', () => {
    const map = new Map([
      ['p1', makeRecentSummary(3, 2, earlier)],
      ['p2', makeRecentSummary(3, 2, latest)],
    ])
    const result = computeActiveCollectors(profiles.slice(0, 2), map)
    expect(result[0].handle).toBe('beta')
  })

  it('breaks latestAddition tie by handle ASC', () => {
    const map = new Map([
      ['p1', makeRecentSummary(3, 2, now)],
      ['p2', makeRecentSummary(3, 2, now)],
    ])
    const result = computeActiveCollectors(profiles.slice(0, 2), map)
    expect(result[0].handle).toBe('alpha')
  })

  it('assigns sequential ranks', () => {
    const map = new Map([
      ['p1', makeRecentSummary(5, 2, now)],
      ['p2', makeRecentSummary(3, 2, now)],
    ])
    const result = computeActiveCollectors(profiles.slice(0, 2), map)
    expect(result.map(r => r.rank)).toEqual([1, 2])
  })

  it('respects maxResults', () => {
    const map = new Map([
      ['p1', makeRecentSummary(5, 2, now)],
      ['p2', makeRecentSummary(4, 2, now)],
      ['p3', makeRecentSummary(3, 2, now)],
    ])
    const result = computeActiveCollectors(profiles, map, ACTIVE_COLLECTOR_MIN_ADDITIONS, 2)
    expect(result).toHaveLength(2)
  })
})

// ─── computeVerifiedCollectors ────────────────────────────────────────────────

describe('computeVerifiedCollectors', () => {
  const profiles = [
    makeProfile('p1', 'alpha'),
    makeProfile('p2', 'beta'),
    makeProfile('p3', 'gamma'),
  ]
  const t1 = new Date('2026-07-01T00:00:00Z')
  const t2 = new Date('2026-08-01T00:00:00Z')

  it('returns empty when no profiles', () => {
    expect(computeVerifiedCollectors([], new Map())).toEqual([])
  })

  it('qualifies a profile with non-null FK-linked completed order (count >= 1)', () => {
    const map = new Map([['p1', makeVerifiedSummary(1, t1)]])
    const result = computeVerifiedCollectors(profiles.slice(0, 1), map)
    expect(result).toHaveLength(1)
    expect(result[0].handle).toBe('alpha')
    expect(result[0].completedItemCount).toBe(1)
  })

  it('excludes profiles with no linked completed orders (not in map = unlinked)', () => {
    const result = computeVerifiedCollectors(profiles, new Map())
    expect(result).toHaveLength(0)
  })

  it('excludes profiles below minItems (handles incomplete/cancelled orders being absent from map)', () => {
    // count=0 simulates a profile that appears in verifiedByProfile but has no qualifying items
    const map = new Map([['p1', makeVerifiedSummary(0, t1)]])
    const result = computeVerifiedCollectors(profiles.slice(0, 1), map, VERIFIED_COLLECTOR_MIN_ITEMS)
    expect(result).toHaveLength(0)
  })

  it('sorts by completedItemCount DESC', () => {
    const map = new Map([
      ['p1', makeVerifiedSummary(2, t1)],
      ['p2', makeVerifiedSummary(5, t1)],
    ])
    const result = computeVerifiedCollectors(profiles.slice(0, 2), map)
    expect(result[0].handle).toBe('beta')
    expect(result[1].handle).toBe('alpha')
  })

  it('breaks count tie by latestCompletedAt DESC', () => {
    const map = new Map([
      ['p1', makeVerifiedSummary(3, t1)],
      ['p2', makeVerifiedSummary(3, t2)],
    ])
    const result = computeVerifiedCollectors(profiles.slice(0, 2), map)
    expect(result[0].handle).toBe('beta') // t2 is more recent
  })

  it('breaks latestCompletedAt tie by handle ASC', () => {
    const map = new Map([
      ['p1', makeVerifiedSummary(3, t1)],
      ['p2', makeVerifiedSummary(3, t1)],
    ])
    const result = computeVerifiedCollectors(profiles.slice(0, 2), map)
    expect(result[0].handle).toBe('alpha')
  })

  it('assigns sequential ranks', () => {
    const map = new Map([
      ['p1', makeVerifiedSummary(5, t2)],
      ['p2', makeVerifiedSummary(3, t1)],
    ])
    const result = computeVerifiedCollectors(profiles.slice(0, 2), map)
    expect(result.map(r => r.rank)).toEqual([1, 2])
  })

  it('respects maxResults', () => {
    const map = new Map([
      ['p1', makeVerifiedSummary(5, t2)],
      ['p2', makeVerifiedSummary(4, t2)],
      ['p3', makeVerifiedSummary(3, t2)],
    ])
    const result = computeVerifiedCollectors(profiles, map, 1, 2)
    expect(result).toHaveLength(2)
  })

  it('VerifiedCollectorEntry does not include latestCompletedAt in output', () => {
    const map = new Map([['p1', makeVerifiedSummary(2, t1)]])
    const result = computeVerifiedCollectors(profiles.slice(0, 1), map)
    const entry = result[0]
    expect('latestCompletedAt' in entry).toBe(false)
    expect('completedItemCount' in entry).toBe(true)
  })

  it('VERIFIED_COLLECTOR_WINDOW_DAYS is 180', () => {
    expect(VERIFIED_COLLECTOR_WINDOW_DAYS).toBe(180)
  })

  it('VERIFIED_COLLECTOR_MIN_ITEMS is 1', () => {
    expect(VERIFIED_COLLECTOR_MIN_ITEMS).toBe(1)
  })
})

// ─── computeBadges ────────────────────────────────────────────────────────────

describe('computeBadges', () => {
  it('always includes public_collector', () => {
    expect(computeBadges(0, 0, false)).toContain('public_collector')
  })

  it('grants collection_10 at exactly 10', () => {
    expect(computeBadges(10, 0, false)).toContain('collection_10')
    expect(computeBadges(9, 0, false)).not.toContain('collection_10')
  })

  it('grants collection_50 at exactly 50', () => {
    expect(computeBadges(50, 0, false)).toContain('collection_50')
    expect(computeBadges(49, 0, false)).not.toContain('collection_50')
  })

  it('grants collection_100 at exactly 100', () => {
    expect(computeBadges(100, 0, false)).toContain('collection_100')
    expect(computeBadges(99, 0, false)).not.toContain('collection_100')
  })

  it('grants active_collector at ACTIVE_COLLECTOR_BADGE_MIN', () => {
    expect(computeBadges(0, ACTIVE_COLLECTOR_BADGE_MIN, false)).toContain('active_collector')
    expect(computeBadges(0, ACTIVE_COLLECTOR_BADGE_MIN - 1, false)).not.toContain('active_collector')
  })

  it('grants verified_buyer only when hasVerifiedPurchase is true', () => {
    expect(computeBadges(0, 0, true)).toContain('verified_buyer')
    expect(computeBadges(0, 0, false)).not.toContain('verified_buyer')
  })

  it('verified_buyer requires authoritative completed OrderItem — false gives no badge', () => {
    expect(computeBadges(100, 100, false)).not.toContain('verified_buyer')
  })

  it('stacks all badges', () => {
    const badges = computeBadges(100, 10, true)
    expect(badges).toContain('public_collector')
    expect(badges).toContain('collection_10')
    expect(badges).toContain('collection_50')
    expect(badges).toContain('collection_100')
    expect(badges).toContain('active_collector')
    expect(badges).toContain('verified_buyer')
  })
})

// ─── Structural: migration SQL ────────────────────────────────────────────────

describe('migration SQL privacy defaults', () => {
  const migrationPath = path.join(
    __dirname,
    '../../../prisma/migrations/20260802000000_add_customer_community_profile/migration.sql',
  )
  const sql = fs.readFileSync(migrationPath, 'utf8')

  it('isPublic defaults to false in migration', () => {
    expect(sql).toContain('"isPublic" BOOLEAN NOT NULL DEFAULT false')
  })

  it('showOnLeaderboards defaults to false in migration', () => {
    expect(sql).toContain('"showOnLeaderboards" BOOLEAN NOT NULL DEFAULT false')
  })

  it('handle has a UNIQUE constraint', () => {
    expect(sql).toContain('CREATE UNIQUE INDEX "CustomerCommunityProfile_handle_key"')
  })

  it('profileId has a UNIQUE constraint', () => {
    expect(sql).toContain('CREATE UNIQUE INDEX "CustomerCommunityProfile_profileId_key"')
  })
})

// ─── Structural: query file ───────────────────────────────────────────────────

describe('communityLeaderboardsQuery structural', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../communityLeaderboardsQuery.ts'),
    'utf8',
  )

  it('uses unstable_cache for leaderboard data only', () => {
    expect(src).toContain("unstable_cache(")
    expect(src).toContain("'community-leaderboards'")
    expect(src).toContain("revalidate: 300")
  })

  it('getPublicDirectory is not wrapped in unstable_cache (only one occurrence)', () => {
    const cacheCount = src.split('unstable_cache(').length - 1
    expect(cacheCount).toBe(1)
  })

  it('getPublicProfile is not wrapped in unstable_cache', () => {
    const profileFn = src.slice(src.indexOf('export async function getPublicProfile'))
    expect(profileFn).not.toContain('unstable_cache')
  })

  it('directory query filters isPublic: true in DB', () => {
    const dirFn = src.slice(
      src.indexOf('export async function getPublicDirectory'),
      src.indexOf('export async function getPublicProfile'),
    )
    expect(dirFn).toContain('isPublic: true')
  })

  it('leaderboard scan requires both isPublic and showOnLeaderboards', () => {
    const block = src.slice(src.indexOf('scanOptInProfiles'), src.indexOf('scanCollectionItems'))
    expect(block).toContain('isPublic: true')
    expect(block).toContain('showOnLeaderboards: true')
  })

  it('verified scan filters by customerProfileId IN profileIds — no email matching', () => {
    const block = src.slice(src.indexOf('scanVerifiedOrderItems'), src.indexOf('buildCollectionSummaries'))
    expect(block).toContain('customerProfileId: { in: profileIds }')
    expect(block).not.toContain('buyerEmail')
    expect(block).not.toContain('email')
  })

  it('verified scan filters status=complete and completedAt gte windowStart', () => {
    const block = src.slice(src.indexOf('scanVerifiedOrderItems'), src.indexOf('buildCollectionSummaries'))
    expect(block).toContain("status: 'complete'")
    expect(block).toContain('completedAt: { gte: windowStart }')
  })

  it('verified scan select does not include price, orderId, buyerEmail, or payment fields', () => {
    const block = src.slice(src.indexOf('scanVerifiedOrderItems'), src.indexOf('buildCollectionSummaries'))
    expect(block).not.toContain('price')
    expect(block).not.toContain('buyerEmail')
    expect(block).not.toContain('paymentMethod')
    expect(block).not.toContain('paymentReference')
    expect(block).not.toContain('estimatedShipping')
    expect(block).not.toContain('orderId')
  })

  it('verified scan select only exposes customerProfileId and completedAt', () => {
    const block = src.slice(src.indexOf('scanVerifiedOrderItems'), src.indexOf('buildCollectionSummaries'))
    expect(block).toContain('customerProfileId: true')
    expect(block).toContain('completedAt: true')
  })

  it('VERIFIED_COLLECTOR_WINDOW_DAYS used as verifiedWindowStart', () => {
    expect(src).toContain('VERIFIED_COLLECTOR_WINDOW_DAYS')
    expect(src).toContain('verifiedWindowStart')
  })

  it('uses keyset pagination with cursor in collection scan', () => {
    expect(src).toContain('cursorId')
    expect(src).toContain('orderBy: { id:')
  })

  it('includes quantity in collection item scan', () => {
    expect(src).toContain('quantity: true')
  })

  it('getPublicProfile normalizes handle to lowercase', () => {
    expect(src).toContain('handle.toLowerCase()')
  })

  it('getPublicProfile counts verified orders via FK — no email matching', () => {
    const profileFn = src.slice(src.indexOf('export async function getPublicProfile'))
    expect(profileFn).toContain('customerProfileId: community.profileId')
    expect(profileFn).not.toContain('buyerEmail')
    expect(profileFn).not.toContain('email:')
  })

  it('getPublicProfile does not expose purchasePrice, purchaseDate, or notes', () => {
    const profileFn = src.slice(src.indexOf('export async function getPublicProfile'))
    expect(profileFn).not.toContain('purchasePrice')
    expect(profileFn).not.toContain('purchaseDate')
    expect(profileFn).not.toContain('notes: true')
  })

  it('scanOptInProfiles select does not include email, phone, or PII', () => {
    const block = src.slice(src.indexOf('scanOptInProfiles'), src.indexOf('scanCollectionItems'))
    expect(block).not.toContain('email')
    expect(block).not.toContain('phone')
    expect(block).not.toContain('address')
  })

  it('getPublicDirectory select does not expose profileId or DB id', () => {
    const dirFn = src.slice(
      src.indexOf('export async function getPublicDirectory'),
      src.indexOf('export async function getPublicProfile'),
    )
    expect(dirFn).not.toContain('profileId')
    const selectIdx = dirFn.indexOf('select:')
    const selectBlock = dirFn.slice(selectIdx, selectIdx + 200)
    expect(selectBlock).not.toContain('id: true')
  })

  it('revalidates community-leaderboards tag on save', () => {
    const actionSrc = fs.readFileSync(
      path.join(__dirname, '../actions/community.ts'),
      'utf8',
    )
    expect(actionSrc).toContain("updateTag('community-leaderboards')")
  })
})

// ─── Structural: action file ──────────────────────────────────────────────────

describe('community action structural', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../actions/community.ts'),
    'utf8',
  )

  it('is a server action', () => {
    expect(src).toContain("'use server'")
  })

  it('uses updateTag (not revalidateTag) for immediate cache invalidation', () => {
    expect(src).toContain("updateTag('community-leaderboards')")
    expect(src).not.toContain('revalidateTag(')
  })

  it('uses getBuyerSession for identity — never reads profileId from form data', () => {
    expect(src).toContain('getBuyerSession()')
    expect(src).not.toContain("get('profileId')")
  })

  it('trims inputs before validation', () => {
    expect(src).toContain('trimInput(')
  })

  it('validates for control characters per field before normalization', () => {
    expect(src).toContain('validateNoControlChars(')
  })

  it('control character check returns a field error (not silently strips)', () => {
    expect(src).toContain('errors.handle = [ctrlErr]')
    expect(src).toContain('errors.displayName = [ctrlErr]')
    expect(src).toContain('errors.bio = [ctrlErr]')
  })

  it('normalizes handle before uniqueness check', () => {
    const handleBlock = src.slice(src.indexOf('const handle = '))
    expect(handleBlock.slice(0, 200)).toContain('normalizeHandle(')
  })

  it('checks handle uniqueness excluding own profile', () => {
    expect(src).toContain('existing.profileId !== session.profileId')
  })

  it('catches P2002 unique constraint violation and returns handle error', () => {
    expect(src).toContain("'P2002'")
    expect(src).toContain('PrismaClientKnownRequestError')
  })

  it('uses upsert to create or update', () => {
    expect(src).toContain('.upsert(')
  })

  it('does not match by email anywhere', () => {
    expect(src).not.toContain('buyerEmail')
    expect(src).not.toContain("get('email')")
  })

  it('does not reference order, listing, or payout tables', () => {
    expect(src).not.toContain('prisma.order')
    expect(src).not.toContain('prisma.listing')
    expect(src).not.toContain('prisma.orderItem')
    expect(src).not.toContain('payout')
  })
})
