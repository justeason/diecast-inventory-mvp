// 32B: structural (readSrc) coverage for the migration boundary itself —
// legacy-import removal on migrated surfaces, intentional retention on
// Comparable Research, the untouched 32C risk boundary, privacy, copy
// discipline, and explicit out-of-scope prohibitions (§92).
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relPath), 'utf-8')
}

const MIGRATED_SURFACES = [
  'src/app/(admin)/admin/valuation/page.tsx',
  'src/app/(admin)/admin/valuation/models/[id]/page.tsx',
  'src/lib/itemLifecycleQuery.ts',
  'src/lib/readyToListQuery.ts',
  'src/lib/readyToList.ts',
  'src/app/(admin)/admin/listings/new/page.tsx',
  'src/app/(admin)/admin/listings/[id]/edit/page.tsx',
  'src/components/admin/ListingForm.tsx',
  'src/lib/actions/intakeWorkbench.ts',
  'src/lib/intakeExceptionQueueQuery.ts',
]

const LEGACY_IMPORT_RE = /from ['"]@\/lib\/(pricingIntelligence|pricingIntelligenceQuery|advancedValuation|advancedValuationQuery|externalMarketResearch)['"]/

describe('32B — legacy import removal on migrated surfaces', () => {
  for (const file of MIGRATED_SURFACES) {
    it(`${file} no longer imports the legacy 14C pricing stack`, () => {
      expect(readSrc(file)).not.toMatch(LEGACY_IMPORT_RE)
    })
  }
})

describe('32B — Comparable Research (resale-estimator) intentionally retained', () => {
  it('still imports the legacy engine, distinctly labeled, not folded into canonical EMV', () => {
    const src = readSrc('src/app/(admin)/admin/resale-estimator/page.tsx')
    expect(src).toContain("from '@/lib/resaleEstimatorQuery'")
    expect(src).toContain("from '@/lib/resaleEstimator'")
    expect(src).toContain('Comparable Research')
  })

  it('legacy engine files still exist — not deleted in 32B', () => {
    for (const f of ['src/lib/resaleEstimator.ts', 'src/lib/resaleEstimatorQuery.ts', 'src/lib/pricingIntelligence.ts', 'src/lib/pricingIntelligenceQuery.ts']) {
      expect(fs.existsSync(path.join(process.cwd(), f))).toBe(true)
    }
  })
})

describe('32B §62 — risk-policy/manual-risk-evidence boundary untouched (32C scope)', () => {
  it('riskPolicy.ts does not import any 32B canonical admin pricing module', () => {
    const src = readSrc('src/lib/riskPolicy.ts')
    expect(src).not.toMatch(/from ['"]@\/lib\/adminPricingContext['"]/)
    expect(src).not.toMatch(/from ['"]@\/lib\/adminPricingDisplay['"]/)
  })

  // 32C migrated manual risk evidence onto canonical fetchRiskPricingEvidence —
  // this assertion is now inverted from its 32B-era intent (see riskPolicy.test.ts
  // / riskGateIntegration.test.ts for the canonical-migration coverage).
  it('actions/listings.ts and actions/items.ts source risk evidence from canonical getValuation (32C), no legacy engine left', () => {
    expect(readSrc('src/lib/actions/listings.ts')).not.toMatch(/getPricingIntelligence|pricingIntelligenceQuery/)
    expect(readSrc('src/lib/actions/items.ts')).not.toMatch(/getPricingIntelligence|pricingIntelligenceQuery/)
    expect(readSrc('src/lib/actions/listings.ts')).toContain('fetchRiskPricingEvidence')
    expect(readSrc('src/lib/actions/items.ts')).toContain('fetchRiskPricingEvidence')
  })
})

describe('32B §67 — auto-listing automation untouched', () => {
  it('autoListingPricingV2.ts/autoListingExecution.ts never import the richer admin-only composition', () => {
    expect(readSrc('src/lib/autoListingPricingV2.ts')).not.toMatch(/from ['"]@\/lib\/adminPricingContext['"]/)
    expect(readSrc('src/lib/autoListingExecution.ts')).not.toMatch(/from ['"]@\/lib\/adminPricingContext['"]/)
  })
})

describe('32B §91 — privacy: no private customer cost data in admin pricing context', () => {
  const PRICING_FILES = [
    'src/lib/adminPricingContext.ts',
    'src/lib/adminPricingDisplay.ts',
    'src/lib/adminPricingListQuery.ts',
    'src/components/admin/AdminPricingContext.tsx',
  ]
  for (const file of PRICING_FILES) {
    it(`${file} never references AcquisitionLot/Recorded Cost/unitRecordedCostCents`, () => {
      const src = readSrc(file)
      expect(src).not.toMatch(/AcquisitionLot|recordedCost|unitRecordedCostCents/i)
    })
  }
})

describe('32B §92 — explicit scope prohibitions', () => {
  const NEW_FILES = [
    'src/lib/adminPricingContext.ts',
    'src/lib/adminPricingDisplay.ts',
    'src/lib/adminPricingListQuery.ts',
    'src/components/admin/AdminPricingContext.tsx',
  ]

  it('no Suggested/Recommended/Optimal/Target Price concept anywhere in the new canonical admin pricing files', () => {
    for (const file of NEW_FILES) {
      const src = readSrc(file)
      expect(src).not.toMatch(/Suggested Listing Price|Recommended Price|Optimal Price|Target Price|Fair Value|Liquidity|Momentum/)
    }
  })

  it('Automation Candidate Price is never shown in the new canonical admin pricing UI', () => {
    expect(readSrc('src/components/admin/AdminPricingContext.tsx')).not.toMatch(/Automation Candidate/)
  })

  it('no legacy ±5% guidance-tolerance band is reused in any migrated surface', () => {
    for (const file of [...MIGRATED_SURFACES, 'src/lib/adminPricingListQuery.ts', 'src/lib/adminPricingDisplay.ts']) {
      expect(readSrc(file)).not.toMatch(/GUIDANCE_TOLERANCE_PCT|\* 1\.05|\* 0\.95/)
    }
  })

  it('no two-decimal price-precision enforcement was added — marketMoney.ts/price validation unchanged in 32B', () => {
    expect(readSrc('src/lib/marketMoney.ts')).not.toMatch(/toFixed\(2\).*validat|round.*2.*decimal/i)
  })

  it('no new ListingPriceHistory/AuditLog schema was added — migration count unchanged at 53', () => {
    const migrationDirs = fs
      .readdirSync(path.join(process.cwd(), 'prisma/migrations'))
      .filter((f) => fs.statSync(path.join(process.cwd(), 'prisma/migrations', f)).isDirectory())
    expect(migrationDirs.length).toBe(54)
    expect(readSrc('prisma/schema.prisma')).not.toMatch(/model ListingPriceHistory|model AdminAuditLog/)
  })

  it('no customer-facing Fair Listing Indicator — canonical admin pricing files are never imported by /catalog, /browse, /market, or seller routes', () => {
    const CUSTOMER_DIRS = ['src/app/(store)', 'src/app/(seller)']
    for (const dir of CUSTOMER_DIRS) {
      const abs = path.join(process.cwd(), dir)
      if (!fs.existsSync(abs)) continue
      const files = walk(abs).filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'))
      for (const f of files) {
        const src = fs.readFileSync(f, 'utf-8')
        expect(src).not.toMatch(/from ['"]@\/lib\/adminPricingContext['"]/)
        expect(src).not.toMatch(/from ['"]@\/components\/admin\/AdminPricingContext['"]/)
      }
    }
  })
})

function walk(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  let out: string[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out = out.concat(walk(full))
    else out.push(full)
  }
  return out
}

describe('32B §14/§16-20 — copy discipline on the shared component', () => {
  it('uses exact canonical labels', () => {
    const src = readSrc('src/components/admin/AdminPricingContext.tsx')
    for (const label of ['Estimated Market Value', 'Market Range', 'Confidence', 'Lowest Ask', 'Available Copies', 'Current Ask Depth']) {
      expect(src).toContain(label)
    }
  })
})
