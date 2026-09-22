// 27B: /account/sell/[id] redesign — legacy engine removal, canonical
// valuation wiring, terminology, privacy, ownership, scope discipline.
// Structural (source-inspection), matching this codebase's established
// convention (no React rendering harness exists here).
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
function stripComments(src: string): string {
  return src.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n')
}
function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? walk(full) : [full]
  })
}

const pageSrc = readSrc('src/app/(store)/account/sell/[id]/page.tsx')
const pageCode = stripComments(pageSrc)
const marketSnapshotSrc = readSrc('src/components/store/SellerMarketSnapshot.tsx')
const proceedsEstimatorSrc = readSrc('src/components/store/SellerProceedsEstimator.tsx')
const costContextSrc = readSrc('src/components/store/SellerCostContext.tsx')
const sellItemFormSrc = readSrc('src/components/store/SellItemForm.tsx')
const manualFormSrc = readSrc('src/components/store/ManualSellRequestForm.tsx')

// ── §77/§90: legacy customer migration ──────────────────────────────────────

describe('27B §77/§90: customer seller route no longer uses legacy pricing engines', () => {
  it('the page never imports computeEstimate/computeGuidance/getPricingIntelligence/AdvancedValuation/resaleEstimator/pricingIntelligence', () => {
    expect(pageCode).not.toMatch(/computeEstimate|computeGuidance|getPricingIntelligence|AdvancedValuation|resaleEstimator|from ['"]@\/lib\/pricingIntelligence['"]/)
  })

  it('the page no longer imports PricingGuidanceForm/PricingIntelligenceSummary', () => {
    expect(pageCode).not.toMatch(/PricingGuidanceForm|PricingIntelligenceSummary/)
  })

  it('the page imports the canonical 23B/24B/27B modules instead', () => {
    expect(pageSrc).toContain("from '@/lib/marketQuoteQuery'")
    expect(pageSrc).toContain("from '@/lib/marketVariant'")
    expect(pageSrc).toContain("from '@/lib/ownershipLedger'")
    expect(pageSrc).toContain("from '@/lib/sellerProceedsEstimator'")
  })

  it('legacy engine FILES still exist — admin/automation consumers remain untouched (§65/§75/§80)', () => {
    expect(exists('src/lib/resaleEstimator.ts')).toBe(true)
    expect(exists('src/lib/advancedValuation.ts')).toBe(true)
    expect(exists('src/lib/pricingIntelligence.ts')).toBe(true)
    expect(exists('src/lib/sellerPricingGuidance.ts')).toBe(true)
  })

  // 32B migrated the valuation detail page and readyToListQuery.ts onto the
  // canonical stack — resale-estimator remains the one intentionally-retained
  // legacy consumer (§36/§88).
  it('admin resale-estimator intentionally still imports the legacy engine; valuation detail page is canonical (32B)', () => {
    expect(readSrc('src/app/(admin)/admin/resale-estimator/page.tsx')).toContain('computeEstimate')
    expect(readSrc('src/app/(admin)/admin/valuation/models/[id]/page.tsx')).not.toMatch(/getPricingIntelligence/)
  })

  it('ready-to-list no longer imports pricingIntelligenceQuery — migrated to canonical getValuation/getValuationsBatch in 32B', () => {
    expect(readSrc('src/lib/readyToListQuery.ts')).not.toContain('pricingIntelligenceQuery')
    expect(readSrc('src/lib/readyToListQuery.ts')).toContain("from '@/lib/marketValuation'")
  })

  // 31B: autoListingExecution.ts is the one production path where pricing output
  // directly becomes Listing.price — the load-bearing consumer 31B migrates onto
  // canonical Pricing Intelligence V2. It no longer imports the legacy 14C stack at
  // all; readyToListQuery.ts above remains a legitimate, unmigrated legacy consumer.
  it('31B: auto-listing execution no longer imports pricingIntelligenceQuery/legacy pricing — migrated to canonical getPricingContext/evaluateAutoListingPricingV2', () => {
    const execCode = stripComments(readSrc('src/lib/autoListingExecution.ts'))
    expect(execCode).not.toContain('pricingIntelligenceQuery')
    expect(execCode).not.toMatch(/getPricingIntelligence\(/)
    expect(execCode).toContain("from '@/lib/pricingContext'")
    expect(execCode).toContain("from '@/lib/autoListingPricingV2'")
  })
})

// ── §78: SellerPricingPreference legacy-only ────────────────────────────────

describe('27B §78: SellerPricingPreference is legacy-only — no new customer writes/reads as active guidance', () => {
  it('the page no longer selects pricingPreference from the submission query', () => {
    expect(pageSrc).not.toContain('pricingPreference')
  })

  it('no customer-facing action creates or updates a SellerPricingPreference row', () => {
    const storeActionsDir = path.join(root, 'src/lib/actions')
    for (const f of fs.readdirSync(storeActionsDir)) {
      if (f === 'sellerPricingGuidance.ts') continue // legacy file itself, no longer wired to any customer route
      const content = fs.readFileSync(path.join(storeActionsDir, f), 'utf-8')
      expect(content).not.toMatch(/sellerPricingPreference\.(create|update|upsert)/)
    }
  })

  it('the SellerPricingPreference Prisma model is untouched (schema preserved, no migration)', () => {
    const schema = readSrc('prisma/schema.prisma')
    expect(schema).toContain('model SellerPricingPreference')
  })
})

// ── §79: canonical EMV wiring — variant/condition resolution ───────────────

describe('27B §9/§10/§13/§79: seller valuation identity resolution', () => {
  it('resolves packaging live via computeMarketVariantId — never trusts a stored marketVariantId (none exists on SellerSubmission)', () => {
    expect(pageSrc).toContain('computeMarketVariantId(prisma, submission.catalogId, submission.cardedOrLoose)')
  })

  it('condition is only passed when marketVariantId resolved AND the value is canonical (ITEM_CONDITIONS) — never passed alone', () => {
    const idx = pageSrc.indexOf('const condition =')
    const block = pageSrc.slice(idx, pageSrc.indexOf('\n\n', idx))
    expect(block).toContain('marketVariantId &&')
    expect(block).toContain('ITEM_CONDITIONS')
  })

  it('getMarketQuote is called with catalogModelId + optional marketVariantId + optional condition — never condition without marketVariantId', () => {
    const idx = pageSrc.indexOf('getMarketQuote({')
    const block = pageSrc.slice(idx, idx + 400)
    expect(block).toContain('catalogModelId: submission.catalogId')
    expect(block).toContain('marketVariantId ? { marketVariantId }')
    expect(block).toContain('condition ? { condition }')
  })

  it('no manual condition multiplier/adjustment exists anywhere in the new seller files', () => {
    for (const src of [pageCode, marketSnapshotSrc, proceedsEstimatorSrc, costContextSrc]) {
      expect(src).not.toMatch(/conditionMultiplier|adjustmentFactor|conditionAdjustment/i)
    }
  })
})

// ── §81: asks ────────────────────────────────────────────────────────────────

describe('27B §19/§20/§21/§81: current internal asks only, variant-scoped, never condition-implying', () => {
  it('SellerMarketSnapshot renders Lowest Ask / Available Copies from askSummary, never external asks', () => {
    expect(marketSnapshotSrc).toContain('askSummary.lowestAskCents')
    expect(marketSnapshotSrc).toContain('askSummary.availableCopies')
    expect(marketSnapshotSrc).not.toMatch(/external.*[Aa]sk/)
  })

  it('the ask-scope heading is explicit ("Current {Variant} supply") — never implies condition specificity', () => {
    expect(marketSnapshotSrc).toContain("requestedVariantLabel ? `Current ${requestedVariantLabel} supply` : 'Current supply'")
  })

  it('Market Range is omitted (not a fabricated dash/zero) when null — only rendered when both low and high are present', () => {
    const idx = marketSnapshotSrc.indexOf('marketRangeLowCents !== null')
    expect(idx).toBeGreaterThan(-1)
    expect(marketSnapshotSrc.slice(idx, idx + 80)).toContain('marketRangeHighCents !== null')
  })
})

// ── §85: buyout ──────────────────────────────────────────────────────────────

describe('27B §40/§41/§45/§46/§85: buyout offer is a real-agreement passthrough, never computed/invented', () => {
  it('the page calls findActualBuyoutOffer and shows a fallback note only when no actual offer exists', () => {
    expect(pageSrc).toContain('findActualBuyoutOffer(submission.id)')
    expect(pageSrc).toContain('Buyout offers are provided after review.')
  })

  it('the fallback note is gated on !buyoutOffer, never shown when a real offer exists (the existing Agreement section already renders it)', () => {
    const idx = pageSrc.indexOf('Buyout offers are provided after review.')
    const block = pageSrc.slice(Math.max(0, idx - 200), idx)
    expect(block).toContain('!buyoutOffer')
  })

  it('EMV is never labeled or used as a buyout offer anywhere in the new seller components', () => {
    for (const src of [marketSnapshotSrc, proceedsEstimatorSrc]) {
      expect(src).not.toMatch(/buyout.*offer/i)
    }
  })

  it('sellerProceedsEstimator.ts never computes a buyout amount from EMV — findActualBuyoutOffer only reads the stored agreement amount', () => {
    const src = readSrc('src/lib/sellerProceedsEstimator.ts')
    const idx = src.indexOf('export async function findActualBuyoutOffer')
    const block = src.slice(idx)
    expect(block).not.toMatch(/estimatedValueCents|getValuation/)
  })
})

// ── §89: privacy ─────────────────────────────────────────────────────────────

describe('27B §61/§68/§89: Recorded Cost / FIFO / Estimated Difference / commission context stay private', () => {
  it('the Market Model Page never references Recorded Cost, FIFO preview, or commission terms', () => {
    const catalogPageSrc = readSrc('src/app/(store)/catalog/[id]/page.tsx')
    expect(catalogPageSrc).not.toMatch(/recordedCost|RecordedCostPreview|previewRecordedCostForSale|commissionPercent|estimateSellerProceeds/i)
  })

  it('guest actions/components never reference Recorded Cost, FIFO, or commission terms', () => {
    const guestSrc = readSrc('src/lib/actions/guestMarketQuote.ts')
    const flowSrc = readSrc('src/components/store/SellCaptureFlow.tsx')
    for (const src of [guestSrc, flowSrc]) {
      expect(src).not.toMatch(/recordedCost|RecordedCostPreview|previewRecordedCostForSale|commissionPercent|estimateSellerProceeds/i)
    }
  })

  it('no community/showcase/leaderboard file references the new seller-proceeds/cost-preview modules', () => {
    const communityDir = path.join(root, 'src/app/(store)/community')
    for (const f of walk(communityDir)) {
      const content = fs.readFileSync(f, 'utf-8')
      expect(content).not.toMatch(/sellerProceedsEstimator|previewRecordedCostForSale|RecordedCostPreview/)
    }
  })

  it('no admin file imports sellerProceedsEstimator.ts or the FIFO cost preview (no new admin exposure)', () => {
    const adminDir = path.join(root, 'src/app/(admin)')
    for (const f of walk(adminDir)) {
      const content = fs.readFileSync(f, 'utf-8')
      expect(content).not.toContain('sellerProceedsEstimator')
    }
  })
})

// ── §91: ownership ledger boundary ──────────────────────────────────────────

describe('27B §42/§52/§67/§91: viewing seller guidance never mutates the ownership ledger', () => {
  it('the page never calls createAcquisitionLot/createDisposal/reverseDisposal — only the read-only preview', () => {
    expect(pageCode).not.toMatch(/createAcquisitionLot\(|createDisposal\(|reverseDisposal\(/)
    expect(pageSrc).toContain('previewRecordedCostForSale')
  })

  it('sellerProceedsEstimator.ts and the proceeds-preview action never touch AcquisitionLot/CollectionDisposal', () => {
    const estimatorSrc = readSrc('src/lib/sellerProceedsEstimator.ts')
    const actionSrc = readSrc('src/lib/actions/sellerProceedsPreview.ts')
    for (const src of [estimatorSrc, actionSrc]) {
      expect(src).not.toMatch(/acquisitionLot\.(create|update)|collectionDisposal\.create|createDisposal|createAcquisitionLot/)
    }
  })

  it('SellCaptureFlow/guestMarketQuote never call collection/ledger mutation functions', () => {
    const flowSrc = readSrc('src/components/store/SellCaptureFlow.tsx')
    const guestSrc = readSrc('src/lib/actions/guestMarketQuote.ts')
    for (const src of [flowSrc, guestSrc]) {
      expect(src).not.toMatch(/createAcquisitionLot|createDisposal/)
    }
  })
})

// ── §92: UI copy ─────────────────────────────────────────────────────────────

describe('27B §5/§25-27/§92: terminology — forbidden legacy language absent, canonical language present', () => {
  it('no Target price / Sell faster / Maximize proceeds / Est. days to sell / pricing intelligence CODE anywhere in the new seller surface (explanatory comments about the exclusion are fine)', () => {
    for (const src of [pageCode, marketSnapshotSrc, proceedsEstimatorSrc, costContextSrc]) {
      const code = stripComments(src)
      expect(code).not.toMatch(/Target [Pp]rice|Sell faster|Maximize proceeds|Est\. days to sell|[Pp]ricing intelligence/)
    }
  })

  it('no 0–100 numeric confidence score rendered — only categorical labels', () => {
    for (const src of [marketSnapshotSrc]) {
      expect(src).not.toMatch(/confidence\.score|confidenceScore/)
    }
  })

  it('uses Estimated Market Value / Market Range / Confidence / Estimated Seller Proceeds / Recorded Cost / Estimated Difference / View Market', () => {
    expect(marketSnapshotSrc).toContain('Estimated Market Value')
    expect(pageSrc).toContain('Estimated Seller Proceeds')
    expect(proceedsEstimatorSrc).toContain('Estimated Seller Proceeds')
    expect(proceedsEstimatorSrc).toContain('Estimated Difference')
    expect(costContextSrc).toContain('Recorded Cost')
    expect(marketSnapshotSrc).toContain('View Market')
  })

  it('proceeds are never called "Payout" pre-finalization — only "Estimated Seller Proceeds"', () => {
    expect(proceedsEstimatorSrc).not.toMatch(/\bPayout\b/)
  })

  it('the cost block never labels itself "tax basis" as customer-visible copy (the code comment disclaiming this is fine)', () => {
    expect(stripComments(costContextSrc)).not.toMatch(/tax basis/i)
  })

  it('the Estimated Difference disclosure never uses profit/investment-return/ROI language', () => {
    const code = stripComments(proceedsEstimatorSrc)
    expect(code).not.toMatch(/\bprofit\b|\binvestment return\b|% return|\bROI\b/i)
  })

  it('the new price-input labels use "Desired selling price per item" — never "Target Price"', () => {
    expect(sellItemFormSrc).toContain('Desired selling price per item')
    expect(manualFormSrc).toContain('Desired selling price per item')
    expect(sellItemFormSrc).not.toMatch(/Target [Pp]rice/)
    expect(manualFormSrc).not.toMatch(/Target [Pp]rice/)
  })

  it('the new price-input helper copy never promises control of the final listing price', () => {
    expect(sellItemFormSrc).toContain('It does not set the final listing price.')
    expect(manualFormSrc).toContain('It does not set the final listing price.')
  })
})

// ── §83/§93: empty states ───────────────────────────────────────────────────

describe('27B §54/§55/§76/§93: empty states degrade independently, seller flow stays usable', () => {
  it('insufficient/no-catalog EMV shows the standard disclosure, never a fabricated $0', () => {
    expect(marketSnapshotSrc).toContain('Not enough direct sales data yet.')
  })

  it('no-asks state is independent of EMV availability ("None available right now.")', () => {
    expect(marketSnapshotSrc).toContain('None available right now.')
  })

  it('proceeds-unavailable (no policy, no agreement) shows a concise note, never a crash/blank state', () => {
    expect(proceedsEstimatorSrc).toContain('Consignment terms are not yet available for this submission.')
  })

  it('no-recorded-cost / partial-cost states are handled explicitly in SellerCostContext', () => {
    expect(costContextSrc).toContain('Cost not recorded for these copies.')
    expect(costContextSrc).toContain('Recorded Cost Coverage')
  })
})

// ── §29/§62/§63/§83: seller price freedom (no forced validation boundary) ──

describe('27B §29/§62/§63: market context never becomes a validation boundary on the seller\'s own price', () => {
  it('the proceeds price input has no market-tied max — only a basic non-negative numeric check (client) and server-side re-validation', () => {
    expect(proceedsEstimatorSrc).toContain('min="0"')
    expect(proceedsEstimatorSrc).not.toMatch(/valuation\.estimatedValueCents.*(max|clamp)/i)
  })

  it('the server action only rejects non-finite/negative prices — never compares against EMV/Market Range/Lowest Ask', () => {
    const actionSrc = readSrc('src/lib/actions/sellerProceedsPreview.ts')
    expect(actionSrc).not.toMatch(/estimatedValueCents|marketRange|lowestAsk/i)
  })
})

// ── §94: mobile structure ───────────────────────────────────────────────────

describe('27B §74/§77/§78/§94: stacked contextual cards, no wide market/pricing table', () => {
  it('no <table> element in any new seller component', () => {
    for (const src of [marketSnapshotSrc, proceedsEstimatorSrc, costContextSrc]) {
      expect(src).not.toMatch(/<table/)
    }
  })

  it('the page retains its existing max-w-lg single-column layout — no new wide-layout wrapper', () => {
    expect(pageSrc).toContain('max-w-lg')
  })
})

// ── §95: scope discipline ───────────────────────────────────────────────────

describe('27B §55-60/§66/§95: explicitly out of scope', () => {
  it('no Suggested Listing Price / Recommended Listing Range algorithmic output', () => {
    for (const src of [pageCode, marketSnapshotSrc, proceedsEstimatorSrc]) {
      expect(src).not.toMatch(/Suggested Listing Price|Recommended Listing Range/)
    }
  })

  it('no Fair Listing Indicator language (Below/Within/Above Typical Range)', () => {
    for (const src of [pageCode, marketSnapshotSrc, proceedsEstimatorSrc]) {
      expect(src).not.toMatch(/Below Typical Range|Within Market Range|Above Typical Range/)
    }
  })

  it('no liquidity score / trend / 30D / momentum / velocity / Wanted signal CODE in the new seller surface (comments explaining the exclusion are fine)', () => {
    for (const src of [pageCode, marketSnapshotSrc, proceedsEstimatorSrc]) {
      const code = stripComments(src)
      expect(code).not.toMatch(/liquidity|\btrend\b|30D|momentum|velocity/i)
    }
  })

  it('no lot-selection UI — no raw AcquisitionLot id ever rendered, FIFO stays automatic', () => {
    for (const src of [pageCode, proceedsEstimatorSrc, costContextSrc]) {
      expect(src).not.toMatch(/acquisitionLotId|\blotId\b/)
    }
  })

  it('no SellerAgreement creation/acceptance/commission-locking logic was added — only reads', () => {
    const estimatorSrc = readSrc('src/lib/sellerProceedsEstimator.ts')
    expect(estimatorSrc).not.toMatch(/sellerAgreement\.(create|update)/)
  })

  it('migration count stays 53 — no schema change', () => {
    const migrationDirs = fs.readdirSync(path.join(root, 'prisma/migrations')).filter((d) => /^\d/.test(d))
    expect(migrationDirs.length).toBe(53)
  })
})
