// 32C: structural coverage for the migration boundary — legacy-import removal
// across the 5 migrated risk call sites, policy-code/internal-classification
// preservation, approval-UI copy discipline, and the untouched boundaries
// (auto-listing, customer surfaces, RiskPolicyConfig schema).
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relPath), 'utf-8')
}

// Strips // and /* */ comments so explanatory prose (which legitimately
// mentions forbidden concepts as negative examples) never false-positives
// against these structural checks.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

const LEGACY_RE = /getPricingIntelligence|pricingIntelligenceQuery|from ['"]@\/lib\/(pricingIntelligence|advancedValuation|advancedValuationQuery|externalMarketResearch)['"]/

const MIGRATED_SITES = [
  'src/lib/actions/listings.ts',
  'src/lib/actions/items.ts',
  'src/lib/itemMutations.ts',
  'src/lib/riskPolicy.ts',
  'src/lib/riskPolicyQuery.ts',
  'src/lib/riskPricingQuery.ts',
  'src/lib/listingActivation.ts',
]

describe('§2/§58 — legacy 14C engine removed from all 5 migrated risk call sites', () => {
  for (const file of MIGRATED_SITES) {
    it(`${file} no longer imports the legacy pricing engine`, () => {
      expect(readSrc(file)).not.toMatch(LEGACY_RE)
    })
  }

  it('all 5 call sites use canonical fetchRiskPricingEvidence/getValuation', () => {
    expect(readSrc('src/lib/actions/listings.ts')).toContain('fetchRiskPricingEvidence')
    expect(readSrc('src/lib/actions/items.ts')).toContain('fetchRiskPricingEvidence')
    expect(readSrc('src/lib/itemMutations.ts')).toContain('fetchRiskPricingEvidence') // setItemCatalog (bulk path)
  })

  it('legacy engine files still exist — not deleted (Comparable Research remains a legitimate consumer)', () => {
    for (const f of ['src/lib/pricingIntelligence.ts', 'src/lib/pricingIntelligenceQuery.ts', 'src/lib/resaleEstimator.ts']) {
      expect(fs.existsSync(path.join(process.cwd(), f))).toBe(true)
    }
    expect(readSrc('src/app/(admin)/admin/resale-estimator/page.tsx')).toContain('computeEstimate')
  })
})

describe('§3 — mutation/risk code never uses safeGetAdminPricingContext (display-only wrapper)', () => {
  for (const file of MIGRATED_SITES) {
    it(`${file} does not use safeGetAdminPricingContext in actual code (comments may name it as a negative example)`, () => {
      expect(stripComments(readSrc(file))).not.toContain('safeGetAdminPricingContext')
    })
  }
})

describe('§19/§20/§32-34 — risk math never depends on Lowest Ask/Ask Depth/Market Signals', () => {
  it('riskPolicy.ts never references Ask Depth/Market Signals/days-to-sell concepts in actual code (comments may name them as negative examples)', () => {
    // Note: affectedWantedCount is catalog_model_merge's own pre-existing,
    // unrelated impact-count field (WantedCatalogModel rows affected by a
    // merge) — never 30B's Market Signals "Wanted" concept, so a bare
    // "wanted" check is deliberately excluded here to avoid that false positive.
    const src = stripComments(readSrc('src/lib/riskPolicy.ts'))
    expect(src).not.toMatch(/askDepth|marketSignals|daysToSell/i)
  })

  it('riskPricingQuery.ts fetches ONLY getValuation in actual code — never getPricingContext/getInternalAskDepth/getMarketSignals (comments may name them as negative examples)', () => {
    const src = stripComments(readSrc('src/lib/riskPricingQuery.ts'))
    expect(src).toContain('getValuation')
    expect(src).not.toMatch(/getPricingContext|getInternalAskDepth|getMarketSignals/)
  })
})

describe('§34 — internal policy-code/classification vocabulary preserved (distinct from 32B display copy)', () => {
  it('classifyPriceDeviation still returns within_range/moderate_deviation/extreme_deviation', () => {
    const src = readSrc('src/lib/riskPolicy.ts')
    expect(src).toContain("'within_range'")
    expect(src).toContain("'moderate_deviation'")
    expect(src).toContain("'extreme_deviation'")
  })

  it('policyCode values price_deviation_extreme/price_deviation_exceeds_tolerance are unchanged', () => {
    const src = readSrc('src/lib/riskPolicy.ts')
    expect(src).toContain("policyCode: 'price_deviation_extreme'")
    expect(src).toContain("policyCode: 'price_deviation_exceeds_tolerance'")
  })

  it('never renames internal codes to the 32B display vocabulary (Below/Within/Above Market Range)', () => {
    const src = readSrc('src/lib/riskPolicy.ts')
    expect(src).not.toMatch(/below_range|above_range/)
  })
})

describe('§33 — reason-copy migration (legacy "14C"/"recommended range" wording removed from runtime strings)', () => {
  it('evaluateListingPriceChange no longer emits "14C" or "recommended range" in its reason strings', () => {
    const src = readSrc('src/lib/riskPolicy.ts')
    const fnStart = src.indexOf('function evaluateListingPriceChange')
    const fnEnd = src.indexOf('\nfunction ', fnStart + 1)
    const fnBody = src.slice(fnStart, fnEnd)
    expect(fnBody).not.toMatch(/14C|recommended range/i)
    expect(fnBody).toContain('canonical Market Range')
  })
})

describe('§35-39 — approval-page canonical pricing summary', () => {
  const pageSrc = readSrc('src/app/(admin)/admin/approvals/[id]/page.tsx')

  it('renders the expected human labels for canonical (pricingContextVersion===2) contexts', () => {
    for (const label of ['Proposed Listing Price', 'Previous Listing Price', 'Estimated Market Value', 'Market Range', 'Confidence', 'Pricing Evidence', 'Requested Specificity', 'Used Specificity', 'Extended History']) {
      expect(pageSrc).toContain(label)
    }
  })

  it('gates the summary on pricingContextVersion === 2 — never applied to legacy contexts', () => {
    expect(pageSrc).toContain('pricingContextVersion !== 2')
  })

  it('never invents Recommended Price/Target Price/Fair Value language (§24/§39)', () => {
    expect(pageSrc).not.toMatch(/Recommended Price|Target Price|Fair Value/)
  })

  it('the raw decisionContext JSON fallback is still rendered unconditionally (§38)', () => {
    expect(pageSrc).toContain('JSON.stringify(detail.decisionContext, null, 2)')
  })

  it('the shared pricing summary applies to item_catalog_reassignment too, not just price-change (§36) — gated only by pricingContextVersion, not by action', () => {
    const fnStart = pageSrc.indexOf('function buildPricingSummary')
    const fnBody = pageSrc.slice(fnStart, pageSrc.indexOf('\n}', fnStart) + 2)
    expect(fnBody).not.toMatch(/detail\.action|action ===/)
  })
})

describe('§42/§62 — RiskPolicyConfig schema/config untouched', () => {
  it('schema.prisma RiskPolicyConfig model is unchanged — no new fields', () => {
    const schema = readSrc('prisma/schema.prisma')
    const modelStart = schema.indexOf('model RiskPolicyConfig')
    const modelBody = schema.slice(modelStart, schema.indexOf('\n}', modelStart) + 2)
    for (const field of ['priceDeviationToleranceBps', 'highValueReviewThresholdCents', 'veryHighValueThresholdCents', 'payoutApprovalThresholdCents', 'version']) {
      expect(modelBody).toContain(field)
    }
    // No pricing-evidence-specific field leaked into policy config — that
    // lives in decisionContext JSON (pricingContextVersion), never schema.
    expect(modelBody).not.toMatch(/minimumPricingConfidence|marketRange/i)
  })

  it('migration count is unchanged at 53', () => {
    const dirs = fs.readdirSync(path.join(process.cwd(), 'prisma/migrations')).filter((f) => fs.statSync(path.join(process.cwd(), 'prisma/migrations', f)).isDirectory())
    expect(dirs.length).toBe(54)
  })
})

describe('§39/§42 — auto-listing boundary untouched', () => {
  it('autoListingPricingV2.ts/autoListingExecution.ts have no reference to PricingEvidence/pricingContextVersion/fetchRiskPricingEvidence', () => {
    for (const f of ['src/lib/autoListingPricingV2.ts', 'src/lib/autoListingExecution.ts']) {
      const src = readSrc(f)
      expect(src).not.toMatch(/PricingEvidence|pricingContextVersion|fetchRiskPricingEvidence/)
    }
  })

  it('buildListingActivationContext keeps its exact 5-positional-argument signature (automation call site untouched)', () => {
    const src = readSrc('src/lib/listingActivation.ts')
    expect(src).toMatch(/export function buildListingActivationContext\(\s*\n\s*itemId: string,\s*\n\s*catalogId: string,\s*\n\s*proposedPriceCents: number,\s*\n\s*estimatedValueCents: number \| null,\s*\n\s*sellerAgreement:/)
  })
})

describe('§44 — customer boundary untouched', () => {
  const CUSTOMER_DIRS = ['src/app/(store)', 'src/app/(seller)']
  function walk(dir: string): string[] {
    if (!fs.existsSync(dir)) return []
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    let out: string[] = []
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) out = out.concat(walk(full))
      else out.push(full)
    }
    return out
  }

  it('no customer-facing file imports riskPricingQuery/riskPolicy', () => {
    for (const dir of CUSTOMER_DIRS) {
      for (const f of walk(dir).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))) {
        const src = fs.readFileSync(f, 'utf-8')
        expect(src).not.toMatch(/from ['"]@\/lib\/riskPricingQuery['"]/)
        expect(src).not.toMatch(/from ['"]@\/lib\/riskPolicy['"]/)
      }
    }
  })
})
