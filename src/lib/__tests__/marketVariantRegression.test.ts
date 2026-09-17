// 21B §31-52: scope-discipline and regression proofs. Structural (source-
// inspection), matching this codebase's established convention.
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const root = path.resolve(__dirname, '../../..')
function readSrc(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf-8')
}
function exists(rel: string): boolean {
  return fs.existsSync(path.join(root, rel))
}

describe('§31/§32 — public catalog surfaces unchanged', () => {
  const cardSrc = readSrc('src/components/store/CatalogModelCard.tsx')
  const catalogPage = readSrc('src/app/(store)/catalog/page.tsx')
  const hubPage = readSrc('src/app/(store)/catalog/[id]/page.tsx')

  it('CatalogModelCard never imports/references MarketVariant — one CatalogModel card, no public variant tabs', () => {
    expect(cardSrc).not.toMatch(/marketVariant/i)
  })

  it('/catalog list page never references MarketVariant', () => {
    expect(catalogPage).not.toMatch(/marketVariant/i)
  })

  // 24B: the hub page now legitimately composes MarketVariant scoping (the
  // Series-24 Carded/Loose variant selector) — this is an intentional,
  // approved change to the 21B-era "never references MarketVariant" rule.
  // The narrower invariant that still holds: MarketVariant is never exposed to
  // customers as raw terminology (only "Carded"/"Loose"/"All"), and Available
  // Copies still aggregates all eligible ItemInstances when no variant is selected.
  it('/catalog/[id] hub page composes MarketVariant scoping only through the resolved packagingType id — never the raw "MarketVariant" term as visible customer text', () => {
    expect(hubPage).toMatch(/marketVariantId/)
    expect(hubPage).not.toMatch(/>\s*MarketVariant\s*</)
  })

  it('Available Copies aggregates across all eligible ItemInstances for the model when no variant is selected (marketVariantId undefined)', () => {
    expect(hubPage).toContain('getCatalogModelHub(id, cursor, marketVariantId ?? undefined)')
  })
})

describe('§33 — valuation/pricing intelligence untouched (except mechanical relation-selection)', () => {
  it('advancedValuation.ts has no MarketVariant reference', () => {
    expect(readSrc('src/lib/advancedValuation.ts')).not.toMatch(/marketVariant/i)
  })
  it('pricingIntelligenceQuery.ts has no MarketVariant reference', () => {
    expect(readSrc('src/lib/pricingIntelligenceQuery.ts')).not.toMatch(/marketVariant/i)
  })
  it('resaleEstimator.ts has no MarketVariant reference', () => {
    expect(readSrc('src/lib/resaleEstimator.ts')).not.toMatch(/marketVariant/i)
  })
})

describe('§34 — no standalone MarketVariant admin CRUD surface', () => {
  it('no admin route exists for creating/deleting MarketVariant rows', () => {
    expect(exists('src/app/(admin)/admin/market-variants')).toBe(false)
  })
  it('no production file calls marketVariant.delete or marketVariant.update directly (only deleteMany inside merge reconciliation, and the system-managed ensure/find/resolve helpers)', () => {
    const catalogSrc = readSrc('src/lib/actions/catalog.ts')
    expect(catalogSrc).not.toMatch(/marketVariant\.delete\(/)
    expect(catalogSrc).not.toMatch(/marketVariant\.update\(/)
  })
})

describe('§35 — intake UX unchanged, no new staff-facing "Market Variant" field', () => {
  it('the intake draft edit form file has no new MarketVariant selector/label', () => {
    // The edit PAGE (not the action file) is where a new field would appear.
    const editPage = readSrc('src/app/(admin)/admin/intake/[id]/edit/page.tsx')
    expect(editPage).not.toMatch(/market\s*variant/i)
  })
})

describe('§47/§48 — recognition and Sell/Series-19 flows unchanged', () => {
  it('captureIdentifyCore (recognition) has no MarketVariant import — still returns CatalogModel, never MarketVariant', () => {
    expect(readSrc('src/lib/captureIdentifyCore.ts')).not.toMatch(/marketVariant/i)
  })

  it('guest capture / mobile capture actions have no MarketVariant reference — Series 19 frictionless flow preserved', () => {
    for (const f of ['src/lib/actions/guestSeller.ts', 'src/lib/actions/sellCapture.ts']) {
      expect(exists(f)).toBe(true)
      expect(readSrc(f)).not.toMatch(/marketVariant/i)
    }
  })

  it('the guest Sell flow page has no packaging/variant question and no "Market Variant" customer language', () => {
    const sellPage = readSrc('src/app/(store)/sell/page.tsx')
    expect(sellPage).not.toMatch(/market\s*variant/i)
  })
})

describe('§18/§49 — Collection untouched', () => {
  const schema = readSrc('prisma/schema.prisma')
  function modelBlock(name: string): string {
    const start = schema.indexOf(`model ${name} {`)
    const end = schema.indexOf('\nmodel ', start + 1)
    return schema.slice(start, end === -1 ? undefined : end)
  }

  it('CollectionItem schema has no marketVariantId field or MarketVariant relation', () => {
    expect(modelBlock('CollectionItem')).not.toMatch(/marketVariant/i)
  })

  it('CollectionItem @@unique([profileId, catalogId]) is unchanged', () => {
    expect(modelBlock('CollectionItem')).toContain('@@unique([profileId, catalogId])')
  })

  it('collection actions have no MarketVariant reference — Want/Own actions untouched', () => {
    const files = ['src/lib/actions/collectionItems.ts', 'src/lib/actions/catalogModelDomainActions.ts']
    for (const f of files) {
      if (!exists(f)) continue
      expect(readSrc(f)).not.toMatch(/marketVariant/i)
    }
  })
})

describe('§19 — Wanted/BuyerAlert remain CatalogModel-level only', () => {
  const schema = readSrc('prisma/schema.prisma')
  function modelBlock(name: string): string {
    const start = schema.indexOf(`model ${name} {`)
    const end = schema.indexOf('\nmodel ', start + 1)
    return schema.slice(start, end === -1 ? undefined : end)
  }
  it('WantedCatalogModel/BuyerAlertEvent/BuyerAlertFanout have no marketVariantId field', () => {
    expect(modelBlock('WantedCatalogModel')).not.toMatch(/marketVariant/i)
    expect(modelBlock('BuyerAlertEvent')).not.toMatch(/marketVariant/i)
    expect(modelBlock('BuyerAlertFanout')).not.toMatch(/marketVariant/i)
  })
})

describe('§13 — SellerSubmission has no MarketVariant relation (no dual seller-claimed-vs-verified model in V1)', () => {
  it('schema has no marketVariantId on SellerSubmission', () => {
    const schema = readSrc('prisma/schema.prisma')
    const start = schema.indexOf('model SellerSubmission {')
    const end = schema.indexOf('\nmodel ', start + 1)
    expect(schema.slice(start, end)).not.toMatch(/marketVariant/i)
  })
})

describe('§51/§52 — no chase taxonomy, no portfolio/lot redesign introduced by 21B', () => {
  const schema = readSrc('prisma/schema.prisma')
  it('MarketVariant model has no variantKind/chase/treasureHunt/label/attributes field', () => {
    const start = schema.indexOf('model MarketVariant {')
    const end = schema.indexOf('\nmodel ', start + 1)
    const block = schema.slice(start, end)
    expect(block).not.toMatch(/variantKind|chase|treasureHunt|label\s|attributes\s+Json/i)
  })
  // 26B legitimately introduces AcquisitionLot (an ownership-ledger model,
  // unrelated to MarketVariant/21B's own scope) — this assertion only ever
  // proved 21B itself didn't smuggle in a lot/chase redesign, which remains
  // true regardless of later, unrelated milestones adding one deliberately.
  it('no CollectionLot model exists (21B itself never introduced one; AcquisitionLot is 26B\'s unrelated ownership ledger)', () => {
    expect(schema).not.toContain('model CollectionLot')
  })
})
