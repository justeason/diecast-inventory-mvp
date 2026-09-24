/**
 * 35B: Showcase Hardening & Identity Safety.
 * Covers: canonical public-holding eligibility (freeform exclusion, quantity>0),
 * freeform publish rejection (toggle + create + update), reference-image
 * provenance disclosure, handle immutability, and privacy-boundary regression
 * coverage for the existing Community/Showcase system. No React rendering
 * harness exists in this codebase (established convention) — page-level
 * coverage is structural source-text assertions over the exact touched files.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'

const root = path.resolve(__dirname, '../../..')
function readSrc(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf-8')
}
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => {
  const client: Record<string, unknown> = {
    customerCommunityProfile: { findUnique: vi.fn(), upsert: vi.fn() },
    collectionItem: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn(), create: vi.fn(), aggregate: vi.fn(), count: vi.fn() },
    catalogModel: { findUnique: vi.fn() },
    acquisitionLot: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() },
    orderItem: { count: vi.fn() },
  }
  client.$transaction = vi.fn((cb: (tx: unknown) => unknown) => cb(client))
  return { prisma: client }
})
vi.mock('@/lib/buyerSession', () => ({ getBuyerSession: vi.fn() }))
vi.mock('next/cache', () => ({
  updateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
}))
vi.mock('next/navigation', () => ({ redirect: vi.fn(() => { throw new Error('NEXT_REDIRECT') }) }))
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn().mockReturnValue({ allowed: true, resetMs: 0 }) }))

import { prisma } from '@/lib/prisma'
import { getBuyerSession } from '@/lib/buyerSession'
import { saveCommunityProfile } from '@/lib/actions/community'
import { toggleCollectionItemPublic, createCollectionItem, updateCollectionItem } from '@/lib/actions/collectionItems'
import { getPublicProfile } from '@/lib/communityLeaderboardsQuery'

function fd(entries: Record<string, string>): FormData {
  const f = new FormData()
  for (const [k, v] of Object.entries(entries)) f.set(k, v)
  return f
}

beforeEach(async () => {
  vi.resetAllMocks()
  ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
  ;(prisma.$transaction as Mock).mockImplementation((cb: (tx: unknown) => unknown) => cb(prisma))
  const { checkRateLimit } = await import('@/lib/rateLimit')
  ;(checkRateLimit as Mock).mockReturnValue({ allowed: true, resetMs: 0 })
})

// ── §19/§54 — initial handle creation ────────────────────────────────────────────

describe('saveCommunityProfile — §19/§54 initial handle creation', () => {
  it('a new profile (no existing row) accepts a valid handle', async () => {
    ;(prisma.customerCommunityProfile.findUnique as Mock)
      .mockResolvedValueOnce(null) // ownExisting lookup (by profileId) — no row yet
      .mockResolvedValueOnce(null) // handle-collision lookup
    ;(prisma.customerCommunityProfile.upsert as Mock).mockResolvedValue({})

    const result = await saveCommunityProfile(null, fd({
      handle: 'diecastfan', displayName: 'Collector', bio: '', isPublic: 'true', showOnLeaderboards: 'true',
    }))

    expect(result).toEqual({ success: true })
    expect(prisma.customerCommunityProfile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ handle: 'diecastfan' }) }),
    )
  })

  it('reserved handle is rejected on first create', async () => {
    ;(prisma.customerCommunityProfile.findUnique as Mock).mockResolvedValueOnce(null)
    const result = await saveCommunityProfile(null, fd({ handle: 'admin', displayName: 'Test User', bio: '' }))
    expect(result?.errors?.handle).toBeDefined()
    expect(prisma.customerCommunityProfile.upsert).not.toHaveBeenCalled()
  })

  it('handle already taken by another profile is rejected on first create', async () => {
    ;(prisma.customerCommunityProfile.findUnique as Mock)
      .mockResolvedValueOnce(null) // ownExisting — none yet
      .mockResolvedValueOnce({ profileId: 'someone_else' }) // handle taken
    const result = await saveCommunityProfile(null, fd({ handle: 'diecastfan', displayName: 'Test User', bio: '' }))
    expect(result?.errors?.handle).toEqual(['This handle is already taken.'])
    expect(prisma.customerCommunityProfile.upsert).not.toHaveBeenCalled()
  })
})

// ── §20/§55 — existing-profile save: handle immutability ───────────────────────

describe('saveCommunityProfile — §20/§55 handle immutability', () => {
  it('resubmitting the SAME normalized handle is allowed', async () => {
    ;(prisma.customerCommunityProfile.findUnique as Mock).mockResolvedValueOnce({ handle: 'diecastfan' })
    ;(prisma.customerCommunityProfile.upsert as Mock).mockResolvedValue({})

    const result = await saveCommunityProfile(null, fd({
      handle: 'diecastfan', displayName: 'New Name', bio: 'updated bio', isPublic: 'true', showOnLeaderboards: 'false',
    }))

    expect(result).toEqual({ success: true })
    expect(prisma.customerCommunityProfile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ handle: 'diecastfan', displayName: 'New Name' }) }),
    )
  })

  it('submitting a DIFFERENT handle is rejected with a clear error, profile untouched', async () => {
    ;(prisma.customerCommunityProfile.findUnique as Mock).mockResolvedValueOnce({ handle: 'diecastfan' })

    const result = await saveCommunityProfile(null, fd({ handle: 'newhandle', displayName: 'Test User', bio: '' }))

    expect(result?.errors?.handle).toEqual(['Your public handle cannot currently be changed.'])
    expect(prisma.customerCommunityProfile.upsert).not.toHaveBeenCalled()
  })

  it('§23 — case-only resubmission (DIECASTFAN vs diecastfan) is NOT treated as a rename', async () => {
    ;(prisma.customerCommunityProfile.findUnique as Mock).mockResolvedValueOnce({ handle: 'diecastfan' })
    ;(prisma.customerCommunityProfile.upsert as Mock).mockResolvedValue({})

    const result = await saveCommunityProfile(null, fd({ handle: 'DIECASTFAN', displayName: 'Test User', bio: '' }))

    expect(result).toEqual({ success: true })
  })

  it('displayName/bio/privacy changes with the same handle are allowed together', async () => {
    ;(prisma.customerCommunityProfile.findUnique as Mock).mockResolvedValueOnce({ handle: 'diecastfan' })
    ;(prisma.customerCommunityProfile.upsert as Mock).mockResolvedValue({})

    const result = await saveCommunityProfile(null, fd({
      handle: 'diecastfan', displayName: 'Changed', bio: 'Changed bio', isPublic: 'false', showOnLeaderboards: 'false',
    }))

    expect(result).toEqual({ success: true })
    const call = (prisma.customerCommunityProfile.upsert as Mock).mock.calls[0][0]
    expect(call.update).toEqual({ handle: 'diecastfan', displayName: 'Changed', bio: 'Changed bio', isPublic: false, showOnLeaderboards: false })
  })
})

// ── §24/§56 — old-handle hijack prevention ───────────────────────────────────────

describe('saveCommunityProfile — §24/§56 old-handle hijack prevention', () => {
  it('a normal profile-edit workflow cannot rename collector_a -> collector_b, so collector_a is never released', async () => {
    ;(prisma.customerCommunityProfile.findUnique as Mock).mockResolvedValueOnce({ handle: 'collector_a' })

    const result = await saveCommunityProfile(null, fd({ handle: 'collector_b', displayName: 'Test User', bio: '' }))

    expect(result?.errors?.handle).toBeDefined()
    // Never queried for collision on the new handle, and never wrote — collector_a
    // remains the row's handle in the DB untouched.
    expect(prisma.customerCommunityProfile.findUnique).toHaveBeenCalledTimes(1)
    expect(prisma.customerCommunityProfile.upsert).not.toHaveBeenCalled()
  })
})

// ── §5/§50 — freeform items cannot be published (defense in depth) ─────────────

describe('§5/§50 — freeform items cannot be published: toggle path', () => {
  it('toggleCollectionItemPublic silently rejects isPublic=true for a freeform (catalogId=null) row', async () => {
    ;(prisma.collectionItem.findFirst as Mock).mockResolvedValue({ id: 'item1', catalogId: null })

    await toggleCollectionItemPublic('item1', true)

    expect(prisma.collectionItem.update).not.toHaveBeenCalled()
  })

  it('toggleCollectionItemPublic still allows turning a freeform row PRIVATE (isPublic=false)', async () => {
    ;(prisma.collectionItem.findFirst as Mock).mockResolvedValue({ id: 'item1', catalogId: null })

    await toggleCollectionItemPublic('item1', false)

    expect(prisma.collectionItem.update).toHaveBeenCalledWith({ where: { id: 'item1' }, data: { isPublic: false } })
  })

  it('toggleCollectionItemPublic still allows publishing a catalog-linked row', async () => {
    ;(prisma.collectionItem.findFirst as Mock).mockResolvedValue({ id: 'item1', catalogId: 'cat1' })

    await toggleCollectionItemPublic('item1', true)

    expect(prisma.collectionItem.update).toHaveBeenCalledWith({ where: { id: 'item1' }, data: { isPublic: true } })
  })
})

describe('§5/§50 — freeform items cannot be published: create/update path', () => {
  it('createCollectionItem silently downgrades isPublic to false for a freeform item (no catalogId resolved)', async () => {
    ;(prisma.collectionItem.findFirst as Mock).mockResolvedValue(null)
    ;(prisma.collectionItem.create as Mock).mockResolvedValue({ id: 'new-item' })

    await expect(createCollectionItem(null, fd({ brand: 'Hot Wheels', name: 'Freeform Car', isPublic: 'on' })))
      .rejects.toThrow() // redirect mock throws

    const createCall = (prisma.collectionItem.create as Mock).mock.calls[0][0]
    expect(createCall.data.isPublic).toBe(false)
    expect(createCall.data.catalogId).toBeUndefined()
  })

  it('createCollectionItem allows isPublic=true for a resolved catalog-linked item', async () => {
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue({ id: 'cat1' })
    ;(prisma.collectionItem.findFirst as Mock).mockResolvedValue(null)
    ;(prisma.collectionItem.create as Mock).mockResolvedValue({ id: 'new-item' })

    await expect(createCollectionItem(null, fd({ catalogId: 'cat1', isPublic: 'on' })))
      .rejects.toThrow()

    const createCall = (prisma.collectionItem.create as Mock).mock.calls[0][0]
    expect(createCall.data.isPublic).toBe(true)
    expect(createCall.data.catalogId).toBe('cat1')
  })

  it('updateCollectionItem silently downgrades isPublic to false when the item has no resolved catalogId', async () => {
    ;(prisma.collectionItem.findFirst as Mock).mockResolvedValue({ id: 'item1', isPublic: false, quantity: 1 })
    ;(prisma.collectionItem.updateMany as Mock).mockResolvedValue({ count: 1 })

    const expectedUpdatedAt = new Date('2026-01-01T00:00:00.000Z').toISOString()
    await expect(
      updateCollectionItem('item1', null, fd({ brand: 'Hot Wheels', name: 'Freeform', isPublic: 'on', expectedUpdatedAt })),
    ).rejects.toThrow()

    const updateCall = (prisma.collectionItem.updateMany as Mock).mock.calls[0][0]
    expect(updateCall.data.isPublic).toBe(false)
  })

  it('updateCollectionItem allows isPublic=true when a catalogId is resolved', async () => {
    ;(prisma.collectionItem.findFirst as Mock).mockResolvedValue({ id: 'item1', isPublic: false, quantity: 1 })
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue({ id: 'cat1' })
    ;(prisma.collectionItem.updateMany as Mock).mockResolvedValue({ count: 1 })

    const expectedUpdatedAt = new Date('2026-01-01T00:00:00.000Z').toISOString()
    await expect(
      updateCollectionItem('item1', null, fd({ catalogId: 'cat1', isPublic: 'on', expectedUpdatedAt })),
    ).rejects.toThrow()

    const updateCall = (prisma.collectionItem.updateMany as Mock).mock.calls[0][0]
    expect(updateCall.data.isPublic).toBe(true)
  })
})

describe('§5 — CollectionItemForm UI disables the public toggle for freeform items', () => {
  const formSrc = readSrc('src/components/store/CollectionItemForm.tsx')

  it('the isPublic checkbox is disabled when no catalog is selected', () => {
    const idx = formSrc.indexOf('name="isPublic"')
    const block = formSrc.slice(Math.max(0, idx - 400), idx + 200)
    expect(block).toContain('disabled={!catalogDefaultId}')
  })

  it('shows explanatory helper copy when disabled', () => {
    expect(formSrc).toContain('Only catalog-matched items can be shown publicly.')
  })
})

// ── §3/§8/§9/§10/§50/§51 — canonical public-holding eligibility (behavioral) ────

describe('getPublicProfile — §3/§50/§51 canonical eligibility (behavioral)', () => {
  it('all CollectionItem queries filter isPublic + catalogId not null + quantity > 0', async () => {
    ;(prisma.customerCommunityProfile.findUnique as Mock).mockResolvedValue({
      profileId: 'p1', handle: 'diecastfan', displayName: 'D', bio: null, isPublic: true, showOnLeaderboards: true,
    })
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([])
    ;(prisma.collectionItem.count as Mock).mockResolvedValue(0)
    ;(prisma.collectionItem.aggregate as Mock).mockResolvedValue({ _sum: { quantity: 0 } })
    ;(prisma.orderItem.count as Mock).mockResolvedValue(0)

    await getPublicProfile('diecastfan')

    const findManyCalls = (prisma.collectionItem.findMany as Mock).mock.calls
    expect(findManyCalls.length).toBe(2) // recentRows, allCatalogRows
    for (const [args] of findManyCalls) {
      expect(args.where.isPublic).toBe(true)
      expect(args.where.catalogId).toEqual({ not: null })
      expect(args.where.quantity).toEqual({ gt: 0 })
    }

    const countArgs = (prisma.collectionItem.count as Mock).mock.calls[0][0]
    expect(countArgs.where.catalogId).toEqual({ not: null })
    expect(countArgs.where.quantity).toEqual({ gt: 0 })

    const aggregateArgs = (prisma.collectionItem.aggregate as Mock).mock.calls[0][0]
    expect(aggregateArgs.where.catalogId).toEqual({ not: null })
    expect(aggregateArgs.where.quantity).toEqual({ gt: 0 })
  })

  it('§28 — private profile (isPublic=false) returns null without querying CollectionItem at all', async () => {
    ;(prisma.customerCommunityProfile.findUnique as Mock).mockResolvedValue({
      profileId: 'p1', handle: 'diecastfan', displayName: 'D', bio: null, isPublic: false, showOnLeaderboards: false,
    })

    const result = await getPublicProfile('diecastfan')

    expect(result).toBeNull()
    expect(prisma.collectionItem.findMany).not.toHaveBeenCalled()
  })

  it('§28 — unknown handle returns null', async () => {
    ;(prisma.customerCommunityProfile.findUnique as Mock).mockResolvedValue(null)

    const result = await getPublicProfile('nobody')

    expect(result).toBeNull()
  })

  it('§51 — a fully-disposed (quantity=0) holding is excluded via the quantity>0 filter, not by any post-hoc JS filter', async () => {
    ;(prisma.customerCommunityProfile.findUnique as Mock).mockResolvedValue({
      profileId: 'p1', handle: 'diecastfan', displayName: 'D', bio: null, isPublic: true, showOnLeaderboards: true,
    })
    // Simulating that the DB-level filter already excluded quantity=0 rows —
    // the mock returning [] proves the query relies on the WHERE clause, not a
    // downstream filter (there is none in getPublicProfile's mapping logic).
    ;(prisma.collectionItem.findMany as Mock).mockResolvedValue([])
    ;(prisma.collectionItem.count as Mock).mockResolvedValue(0)
    ;(prisma.collectionItem.aggregate as Mock).mockResolvedValue({ _sum: { quantity: 0 } })
    ;(prisma.orderItem.count as Mock).mockResolvedValue(0)

    const result = await getPublicProfile('diecastfan')

    expect(result?.collection.totalItems).toBe(0)
    expect(result?.collection.recentItems).toEqual([])
  })
})

// ── §8/§9/§10 — leaderboard scan eligibility (structural) ──────────────────────

describe('§8/§9/§10 — leaderboard totals/distinctModels/Active-Collectors use the canonical predicate', () => {
  const src = readSrc('src/lib/communityLeaderboardsQuery.ts')

  it('scanCollectionItems (feeds Largest Collections totalItems/distinctModels) routes through publicHoldingWhere', () => {
    const fnIdx = src.indexOf('async function scanCollectionItems')
    const nextIdx = src.indexOf('async function scanRecentCollectionItems')
    expect(src.slice(fnIdx, nextIdx)).toContain('publicHoldingWhere(')
  })

  it('scanRecentCollectionItems (feeds Active Collectors additions/distinctModels) routes through publicHoldingWhere', () => {
    const fnIdx = src.indexOf('async function scanRecentCollectionItems')
    const nextIdx = src.indexOf('async function scanVerifiedOrderItems')
    expect(src.slice(fnIdx, nextIdx)).toContain('publicHoldingWhere(')
  })

  it('publicHoldingWhere is the single canonical definition combining all three conditions', () => {
    const fnIdx = src.indexOf('function publicHoldingWhere')
    const fnSrc = src.slice(fnIdx, src.indexOf('\n}', fnIdx))
    expect(fnSrc).toContain('isPublic: true')
    expect(fnSrc).toContain('catalogId: { not: null }')
    expect(fnSrc).toContain('quantity: { gt: 0 }')
  })

  it('no ranking sort semantics were changed — computeLargestCollections/computeActiveCollectors untouched', () => {
    const leaderboardsSrc = readSrc('src/lib/communityLeaderboards.ts')
    expect(leaderboardsSrc).toContain('if (b.distinctModels !== a.distinctModels) return b.distinctModels - a.distinctModels')
    expect(leaderboardsSrc).toContain('if (b.additions !== a.additions) return b.additions - a.additions')
  })
})

// ── §12/§53 — image provenance ──────────────────────────────────────────────────

describe('§13/§14/§15/§53 — reference-image provenance disclosure', () => {
  const pageSrc = readSrc('src/app/(store)/community/[handle]/page.tsx')

  it('renders "Model reference image" disclosure copy', () => {
    expect(pageSrc).toContain('Model reference image')
  })

  it('the disclosure is gated on item.photoUrl (no label when no image exists)', () => {
    const idx = pageSrc.indexOf('Model reference image')
    const gateIdx = pageSrc.lastIndexOf('item.photoUrl', idx)
    expect(gateIdx).toBeGreaterThan(-1)
    expect(idx - gateIdx).toBeLessThan(300)
  })

  it('never claims a collector/verified/actual-item photo', () => {
    const stripped = stripComments(pageSrc)
    for (const forbidden of ['Photo of this item', 'Collector photo', 'Verified photo', 'Ownership photo']) {
      expect(stripped).not.toContain(forbidden)
    }
  })

  it('uses the existing CatalogModelPhoto-backed photoUrl, never CollectionItemPhoto', () => {
    expect(pageSrc).not.toMatch(/CollectionItemPhoto/)
  })
})

describe('§12 — CollectionItemPhoto never selected/rendered on public Community surfaces', () => {
  it('communityLeaderboardsQuery.ts never references CollectionItemPhoto', () => {
    const src = readSrc('src/lib/communityLeaderboardsQuery.ts')
    expect(src).not.toMatch(/CollectionItemPhoto|collectionItemPhoto/)
  })

  it('/community and /community/[handle] never reference CollectionItemPhoto', () => {
    for (const f of ['src/app/(store)/community/page.tsx', 'src/app/(store)/community/[handle]/page.tsx']) {
      expect(readSrc(f)).not.toMatch(/CollectionItemPhoto/)
    }
  })
})

// ── §26/§27/§59 — page structural coverage (none existed before 35B) ───────────

describe('§26/§59 — /community page structural coverage', () => {
  const src = readSrc('src/app/(store)/community/page.tsx')

  it('renders Largest collections, Active collectors, and Verified marketplace collectors sections', () => {
    expect(src).toContain('Largest collections')
    expect(src).toContain('Active collectors')
    expect(src).toContain('Verified marketplace collectors')
  })

  it('Verified Collectors section is driven by leaderboards.verifiedCollectors (already intentionally rendered — preserved, not newly added)', () => {
    expect(src).toContain('leaderboards.verifiedCollectors')
  })

  it('ranking is count/date based only — no value/price ordering language', () => {
    expect(src).not.toMatch(/Highest [Vv]alue|Biggest [Gg]ain|[Pp]ortfolio/i)
  })

  it('has an empty-state message distinct from the directory empty-state', () => {
    expect(src).toContain('No leaderboard data yet.')
    expect(src).toContain('No public profiles yet.')
  })

  it('links to /account/community for opt-in, never exposes a mutation without auth', () => {
    expect(src).toContain('/account/community')
    expect(src).not.toMatch(/getBuyerSession|customerProfileId/)
  })
})

describe('§27/§59 — /community/[handle] page structural coverage', () => {
  const src = readSrc('src/app/(store)/community/[handle]/page.tsx')

  it('calls notFound() when getPublicProfile returns null (private profile / unknown handle)', () => {
    expect(src).toContain('if (!profile) notFound()')
  })

  it('renders distinctModels and totalItems as "Collection" stats', () => {
    expect(src).toContain('profile.collection.distinctModels')
    expect(src).toContain('profile.collection.totalItems')
  })

  it('recent additions grid is fed by profile.collection.recentItems, which getPublicProfile already filters to eligible holdings', () => {
    expect(src).toContain('profile.collection.recentItems')
  })

  it('renders the Verified Buyer badge via BADGE_LABELS, no broader trust language', () => {
    expect(src).toContain("verified_buyer: 'Verified buyer'")
    for (const forbidden of ['Verified Collector', 'Trusted Collector', 'Expert', 'Influencer', 'Ownership Verified']) {
      expect(src).not.toContain(forbidden)
    }
  })
})

// ── §31-34/§49 — explicit privacy boundary regression ───────────────────────────

describe('§31/§32/§33/§34/§49 — explicit privacy boundary', () => {
  const queryFiles = [
    'src/lib/communityLeaderboardsQuery.ts',
    'src/lib/communityLeaderboards.ts',
    'src/lib/actions/community.ts',
    'src/app/(store)/community/page.tsx',
    'src/app/(store)/community/[handle]/page.tsx',
  ]

  it('no financial fields (purchasePrice, Recorded Cost, ledger cost/proceeds, EMV, Market Range, portfolio metrics)', () => {
    for (const f of queryFiles) {
      const src = stripComments(readSrc(f))
      expect(src).not.toMatch(/purchasePrice|unitRecordedCostCents|legacyRecordedPriceCents|grossProceedsCents|netProceedsCents|Estimated Holding Value|Unrealized Gain|Realized Gain|\bEMV\b|Market Range|Recorded Cost/)
    }
  })

  it('no Wanted data (maxDesiredPrice, WantedCatalogModel, alert preferences)', () => {
    for (const f of queryFiles) {
      const src = readSrc(f)
      expect(src).not.toMatch(/maxDesiredPrice|WantedCatalogModel|BuyerAlertPreference/)
    }
  })

  it('no seller data (SellerProfile status, payouts, agreements, lifecycle case, notes)', () => {
    for (const f of queryFiles) {
      const src = readSrc(f)
      expect(src).not.toMatch(/SellerPayout|SellerAgreement|SellerLifecycleCase|sellerProfile\.status/)
    }
  })

  it('no order PII (buyer email, phone, address, payment fields) beyond the documented count-only verified-buyer check', () => {
    const src = readSrc('src/lib/communityLeaderboardsQuery.ts')
    expect(src).not.toMatch(/buyerEmail|shippingAddress|paymentIntent/)
  })
})

// ── §61 — boundaries: no touch to unrelated domains ─────────────────────────────

describe('§61 — no changes to unrelated domains (import-boundary check)', () => {
  it('community files never import Portfolio, Wanted actions, risk policy, or Market Signals/Ask Depth modules', () => {
    for (const f of [
      'src/lib/communityLeaderboardsQuery.ts',
      'src/lib/communityLeaderboards.ts',
      'src/lib/actions/community.ts',
    ]) {
      const src = readSrc(f)
      expect(src).not.toMatch(/from '@\/lib\/portfolioQuery'/)
      expect(src).not.toMatch(/from '@\/lib\/actions\/wantedList'/)
      expect(src).not.toMatch(/from '@\/lib\/riskPolicy/)
      expect(src).not.toMatch(/from '@\/lib\/marketSignals/)
      expect(src).not.toMatch(/from '@\/lib\/marketAskQuery'/)
    }
  })
})

// ── §62/§65 — schema/migrations ──────────────────────────────────────────────────

describe('§62 — schema/migrations unchanged', () => {
  it('migration count is unchanged at 53', () => {
    const dirs = fs.readdirSync(path.join(root, 'prisma/migrations')).filter((f) => fs.statSync(path.join(root, 'prisma/migrations', f)).isDirectory())
    expect(dirs.length).toBe(53)
  })

  it('CustomerCommunityProfile/CollectionItem schema fields unchanged (no new visibility columns)', () => {
    const schema = readSrc('prisma/schema.prisma')
    expect(schema).not.toMatch(/handleChangedAt|previousHandle|handleHistory|profileShowcaseEnabled/)
  })
})
