// 21C §46: regression proofs — normalization is additive-only. Series 19 Sell,
// Collection, recognition, MarketVariant foundation, public Market, and
// valuation/pricing must all be unaffected; no customer UI, no admin override
// surface, no SellerSubmission/Listing evidence usage.
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

describe('§38/§39 — SellerSubmission and Listing are never used as normalization evidence', () => {
  it('historicalSaleNormalization.ts never accesses a sellerSubmission or listing field/relation', () => {
    const src = readSrc('src/lib/historicalSaleNormalization.ts')
    expect(src).not.toMatch(/\.sellerSubmission\b/)
    expect(src).not.toMatch(/\.listing\b/)
  })
  it('normalizeHistoricalSales.ts never queries sellerSubmission or listing', () => {
    const src = readSrc('scripts/normalizeHistoricalSales.ts')
    expect(src).not.toMatch(/prisma\.sellerSubmission/)
    expect(src).not.toMatch(/prisma\.listing/)
  })
  it('SellerSubmission/Listing schema models are unchanged by 21C', () => {
    const schema = readSrc('prisma/schema.prisma')
    for (const model of ['SellerSubmission', 'Listing']) {
      const start = schema.indexOf(`model ${model} {`)
      const end = schema.indexOf('\nmodel ', start + 1)
      expect(schema.slice(start, end)).not.toMatch(/snapshotProvenance|historicalNormalized/i)
    }
  })
})

describe('§30 — no manual override UI for historical sale classification', () => {
  it('no admin route for historical-sale classification exists', () => {
    expect(exists('src/app/(admin)/admin/historical-sales')).toBe(false)
    expect(exists('src/app/(admin)/admin/legacy-sales')).toBe(false)
  })
  it('no server action exposes a manual snapshotProvenance-setting endpoint', () => {
    const actionsDir = path.join(root, 'src/lib/actions')
    const files = fs.readdirSync(actionsDir).filter((f) => f.endsWith('.ts'))
    const offenders = files.filter((f) => {
      if (f === 'orders.ts') return false // the one legitimate sale_time write path
      return readSrc(`src/lib/actions/${f}`).includes('snapshotProvenance')
    })
    expect(offenders).toEqual([])
  })
})

describe('§46 — Series 19 Sell / Collection / recognition / Market / valuation unaffected', () => {
  it('the guest Sell flow page has no snapshotProvenance/historical-sale language', () => {
    expect(readSrc('src/app/(store)/sell/page.tsx')).not.toMatch(/snapshotProvenance|historicalIdentityQuality/i)
  })
  it('CollectionItem schema is unchanged by 21C', () => {
    const schema = readSrc('prisma/schema.prisma')
    const start = schema.indexOf('model CollectionItem {')
    const end = schema.indexOf('\nmodel ', start + 1)
    expect(schema.slice(start, end)).not.toMatch(/snapshotProvenance/i)
  })
  it('recognition (captureIdentifyCore) has no snapshotProvenance reference', () => {
    expect(readSrc('src/lib/captureIdentifyCore.ts')).not.toMatch(/snapshotProvenance/i)
  })
  it('public /catalog and /market pages have no snapshotProvenance reference', () => {
    expect(readSrc('src/app/(store)/catalog/page.tsx')).not.toMatch(/snapshotProvenance/i)
    expect(readSrc('src/app/(store)/market/page.tsx')).not.toMatch(/snapshotProvenance/i)
  })
  it('advancedValuation/pricingIntelligence/resaleEstimator are unchanged by 21C', () => {
    for (const f of ['src/lib/advancedValuation.ts', 'src/lib/pricingIntelligenceQuery.ts', 'src/lib/resaleEstimatorQuery.ts']) {
      expect(readSrc(f)).not.toMatch(/snapshotProvenance|historicalIdentityQuality|normalizeInternalSale/i)
    }
  })
})

describe('§47/§48 — schema/migration/package footprint', () => {
  it('exactly one new schema field (snapshotProvenance) and no new model', () => {
    const schema = readSrc('prisma/schema.prisma')
    expect(schema).not.toContain('model HistoricalSale')
    expect(schema).not.toContain('model NormalizedSale')
  })
  it('package.json has no new dependency added for this milestone', () => {
    const pkg = JSON.parse(readSrc('package.json'))
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
    expect(Object.keys(allDeps)).toContain('tsx')
  })
})
