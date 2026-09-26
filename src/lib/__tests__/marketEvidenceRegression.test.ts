// 22B §25/§52-54/§75: scope-discipline regression. 22B adds a new read-time
// canonical layer only — existing consumers (marketplaceMerchandising*,
// advancedValuation*, pricingIntelligence*, resaleEstimator*) are untouched;
// no public UI; no schema/migration; no new package.
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'

const root = path.resolve(__dirname, '../../..')
function readSrc(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf-8')
}

describe('§25 — existing consumers not migrated to 22B', () => {
  const consumers = [
    'src/lib/marketplaceMerchandisingQuery.ts',
    'src/lib/marketplaceMerchandising.ts',
    'src/lib/advancedValuationQuery.ts',
    'src/lib/advancedValuation.ts',
    'src/lib/pricingIntelligenceQuery.ts',
    'src/lib/resaleEstimatorQuery.ts',
    'src/lib/resaleEstimator.ts',
  ]
  for (const file of consumers) {
    it(`${file} does not import the new 22B modules`, () => {
      const src = readSrc(file)
      expect(src).not.toMatch(/marketSaleQuery|marketAskQuery|marketMoney/)
    })
  }
})

describe('§75 — no changes to git-tracked behavior of untouched files (spot check)', () => {
  it('marketplaceMerchandisingQuery.ts has zero uncommitted diff', () => {
    const out = execSync('git status --short -- src/lib/marketplaceMerchandisingQuery.ts', { cwd: root }).toString()
    expect(out.trim()).toBe('')
  })
  it('advancedValuationQuery.ts has zero uncommitted diff', () => {
    const out = execSync('git status --short -- src/lib/advancedValuationQuery.ts', { cwd: root }).toString()
    expect(out.trim()).toBe('')
  })
})

describe('§52 — no public UI added', () => {
  it('no new customer-facing market-model route exists', () => {
    expect(fs.existsSync(path.join(root, 'src/app/(store)/market/model'))).toBe(false)
  })
  it('/market page source is unchanged by 22B (no import of the new modules)', () => {
    const src = readSrc('src/app/(store)/market/page.tsx')
    expect(src).not.toMatch(/marketSaleQuery|marketAskQuery/)
  })
  it('homepage is unchanged by 22B', () => {
    const src = readSrc('src/app/(store)/page.tsx')
    expect(src).not.toMatch(/marketSaleQuery|marketAskQuery/)
  })
  it('CatalogModelCard is unchanged by 22B', () => {
    const src = readSrc('src/components/store/CatalogModelCard.tsx')
    expect(src).not.toMatch(/marketSaleQuery|marketAskQuery/)
  })
})

// §53 originally also asserted schema.prisma had zero uncommitted diff — a
// point-in-time check valid only immediately after 22B itself (which added no
// schema changes). It cannot survive any later schema-touching milestone by
// construction; 26B legitimately adds the ownership-ledger models. Removed
// rather than kept as a perpetually-broken invariant — 22B's own schema-free
// scope is already provable from its commit history, not a live git-status check.
describe('§53 — schema/migration footprint', () => {
  it('migration count reflects all milestones through 26B (22B itself added none)', () => {
    const migrationsDir = path.join(root, 'prisma/migrations')
    const dirs = fs.readdirSync(migrationsDir).filter((d) => fs.statSync(path.join(migrationsDir, d)).isDirectory())
    expect(dirs.length).toBe(54) // 26B added the ownership-ledger migration
  })
})

describe('§54 — no new package', () => {
  it('marketSaleQuery/marketAskQuery/marketMoney import only from this repo (relative or @/ alias) or @prisma/client — no new external package', () => {
    for (const file of ['src/lib/marketSaleQuery.ts', 'src/lib/marketAskQuery.ts', 'src/lib/marketMoney.ts']) {
      const src = readSrc(file)
      const imports = [...src.matchAll(/from ['"]([^'"]+)['"]/g)].map((m) => m[1])
      for (const imp of imports) {
        expect(imp === '@prisma/client' || imp.startsWith('@/') || imp.startsWith('.')).toBe(true)
      }
    }
  })
})

describe('§24 — existing valuation untouched', () => {
  it('advancedValuation.ts still has its IQR outlier filter and confidence tiers, unmodified by 22B', () => {
    const src = readSrc('src/lib/advancedValuation.ts')
    expect(src).toContain('OUTLIER_MIN_SAMPLE')
    expect(src).toContain('deriveAdvancedConfidence')
  })
})
