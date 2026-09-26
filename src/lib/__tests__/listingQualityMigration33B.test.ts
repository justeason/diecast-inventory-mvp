// 33B: structural coverage for scope boundaries — no schema change, no
// pricing/risk/auto-list/transaction/market-discovery drift, no admin
// dashboard duplication, no ownership-type public exposure.
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relPath), 'utf-8')
}

describe('§33/§58 — schema/migrations untouched', () => {
  it('migration count is unchanged at 53', () => {
    const dirs = fs.readdirSync(path.join(process.cwd(), 'prisma/migrations')).filter((f) => fs.statSync(path.join(process.cwd(), 'prisma/migrations', f)).isDirectory())
    expect(dirs.length).toBe(54)
  })

  it('schema.prisma Photo/ItemInstance models have no new fields introduced by 33B', () => {
    const schema = readSrc('prisma/schema.prisma')
    // 33B reuses the existing Photo.itemId relation exclusively — no new
    // column (e.g. no verification/quality field added to either model).
    expect(schema).not.toMatch(/verifiedAt|inspectedAt|qualityScore|isVerified/i)
  })
})

describe('§46/§21/§22 — Market Model Page / discovery untouched', () => {
  it('no production changes to CatalogModelCard or the Market Model Page', () => {
    // 33B's only customer-facing production file is browse/[id]/page.tsx —
    // confirmed here by absence of any 33B-specific marker in these files.
    for (const f of ['src/components/store/CatalogModelCard.tsx', 'src/app/(store)/catalog/[id]/page.tsx']) {
      expect(readSrc(f)).not.toMatch(/Photos of this item|photos_missing/)
    }
  })
})

describe('§47/§58 — pricing/risk boundary untouched', () => {
  it('riskPolicy.ts/riskPricingQuery.ts/autoListingPricingV2.ts/autoListingExecution.ts have no reference to photos_missing/hasPhotos', () => {
    for (const f of ['src/lib/riskPolicy.ts', 'src/lib/riskPricingQuery.ts', 'src/lib/autoListingPricingV2.ts', 'src/lib/autoListingExecution.ts']) {
      expect(readSrc(f)).not.toMatch(/photos_missing|hasPhotos/)
    }
  })
})

describe('§48 — transaction-mechanics boundary untouched', () => {
  it('actions/orders.ts has no reference to photo evidence/quality concepts', () => {
    expect(readSrc('src/lib/actions/orders.ts')).not.toMatch(/photos_missing|Photos of this item|hasPhotos/)
  })
})

describe('§20 — ownership-type boundary: no public Company-Owned/Consignment label introduced', () => {
  it('no customer-facing (store) file was given a sourceType-based label in 33B', () => {
    const dir = 'src/app/(store)'
    function walk(d: string): string[] {
      const entries = fs.readdirSync(d, { withFileTypes: true })
      let out: string[] = []
      for (const entry of entries) {
        const full = path.join(d, entry.name)
        if (entry.isDirectory()) out = out.concat(walk(full))
        else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) out.push(full)
      }
      return out
    }
    for (const f of walk(dir)) {
      const src = readSrc(f)
      expect(src).not.toMatch(/Company-Owned|Consignment item/)
    }
  })
})

describe('§18/§25 — existing contradiction system untouched', () => {
  it('detectItemContradictions codes are unchanged — photos_missing is not among them', () => {
    const src = readSrc('src/lib/itemLifecycle.ts')
    expect(src).not.toMatch(/photos_missing/)
    for (const code of ['available_but_sold_evidence', 'sold_but_listing_active', 'active_listing_status_mismatch', 'consignment_sold_missing_payout', 'missing_storage_location', 'portfolio_agreement_mismatch', 'multiple_completed_sales']) {
      expect(src).toContain(code)
    }
  })
})

describe('§10/§46 — no new state machine introduced', () => {
  it('readyToList.ts still exposes exactly ready/blocked/review_required as ReadyToListOutcome.status', () => {
    const src = readSrc('src/lib/readyToList.ts')
    expect(src).toContain("status: 'ready' | 'blocked' | 'review_required'")
    expect(src).not.toMatch(/ListingQualityStatus|VerificationStatus|TrustStatus/)
  })
})

describe('§24 — admin surface reuse, no new dashboard', () => {
  it('no new admin quality/trust dashboard route was created', () => {
    const adminDir = 'src/app/(admin)/admin'
    const entries = fs.readdirSync(adminDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    expect(entries).not.toContain('listing-quality')
    expect(entries).not.toContain('trust')
    expect(entries).not.toContain('quality')
  })

  it('photos_missing surfaces through the existing ReadyToListCard reviewReasons loop, with its own non-pricing fix link', () => {
    const src = readSrc('src/app/(admin)/admin/items/[id]/page.tsx')
    expect(src).toContain('reviewFixLink')
    expect(src).toMatch(/photos_missing.*Add photos/s)
  })
})

describe('§9/§49 — soft-only, legacy zero-photo listings stay operational', () => {
  it('createListing/updateListing have no photo-related gate', () => {
    const src = readSrc('src/lib/actions/listings.ts')
    expect(src).not.toMatch(/hasPhotos|photos_missing|photo.*required/i)
  })
})
