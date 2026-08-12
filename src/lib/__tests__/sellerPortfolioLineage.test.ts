// 15B: structural checks that ItemInstance/shipment/agreement portfolio lineage is
// wired correctly through the existing action files. Behavioral coverage for the
// underlying transactions already exists (intake.test-equivalent, sellerInboundShipment
// flows) — these checks pin down the SPECIFIC portfolio-lineage additions so a future
// edit can't silently drop them.
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relPath), 'utf-8')
}

describe('intake.ts: ItemInstance retains portfolio lineage from the accepted agreement (section 11)', () => {
  const src = readSrc('src/lib/actions/intake.ts')

  it('reads sellerPortfolioId from the agreement records fetched inside the transaction', () => {
    expect(src).toMatch(/select:\s*{\s*id:\s*true,\s*type:\s*true,\s*status:\s*true,\s*agreedBuyoutAmount:\s*true,\s*sellerPortfolioId:\s*true\s*}/)
  })

  it('derives conversionPortfolioId from the ACCEPTED agreement, never from SellerProfile alone', () => {
    expect(src).toMatch(/conversionPortfolioId = agreements\.find\(\(a\) => a\.id === conversionAgreementId\)\?\.sellerPortfolioId/)
  })

  it('writes sellerPortfolioId onto the created ItemInstance', () => {
    const createIdx = src.indexOf('const item = await tx.itemInstance.create(')
    const createEnd = src.indexOf('})', createIdx)
    const createSrc = src.slice(createIdx, createEnd)
    expect(createSrc).toMatch(/sellerPortfolioId:\s*conversionPortfolioId/)
  })
})

describe('sellerInboundShipment.ts: shipment portfolio lineage set once at creation (section 10/23)', () => {
  const src = readSrc('src/lib/actions/sellerInboundShipment.ts')

  it('reads sellerPortfolioId from the locked submission row', () => {
    expect(src).toMatch(/sellerPortfolioId:\s*true,/)
  })

  it('sets it on shipment creation, and never on update (no re-derivation path — a shipment cannot end up on a different portfolio than it started with)', () => {
    const createIdx = src.indexOf('await tx.sellerInboundShipment.create(')
    const createEnd = src.indexOf('})', createIdx)
    const createSrc = src.slice(createIdx, createEnd)
    expect(createSrc).toMatch(/sellerPortfolioId:\s*submission\.sellerPortfolioId/)

    const updateIdx = src.indexOf('await tx.sellerInboundShipment.update(')
    const updateEnd = src.indexOf('})', updateIdx)
    const updateSrc = src.slice(updateIdx, updateEnd)
    expect(updateSrc).not.toMatch(/sellerPortfolioId/)
  })
})

describe('sellerAgreements.ts: portfolio-aware accepted-count sourcing (section 5)', () => {
  const src = readSrc('src/lib/actions/sellerAgreements.ts')

  function createSellerAgreementBody(): string {
    const start = src.indexOf('export async function createSellerAgreement')
    const nextExport = src.indexOf('\nexport async function', start + 1)
    return src.slice(start, nextExport === -1 ? undefined : nextExport)
  }

  it('createSellerAgreement locks the submission row before checking for an existing agreement (concurrency, section 23)', () => {
    const fnSrc = createSellerAgreementBody()
    const lockIdx = fnSrc.indexOf('FOR UPDATE')
    const existingCheckIdx = fnSrc.indexOf('findFirst')
    expect(lockIdx).toBeGreaterThan(-1)
    expect(existingCheckIdx).toBeGreaterThan(-1)
    expect(lockIdx).toBeLessThan(existingCheckIdx)
  })

  it('15B-review section 2: createSellerAgreement locks the PORTFOLIO row (when one exists) before the SUBMISSION row — the portfolio, not the submission, is the serialization boundary for "current agreement"', () => {
    const fnSrc = createSellerAgreementBody()
    const portfolioLockIdx = fnSrc.indexOf('SELECT id FROM "SellerPortfolio"')
    const submissionLockIdx = fnSrc.indexOf('SELECT id FROM "SellerSubmission"')
    expect(portfolioLockIdx).toBeGreaterThan(-1)
    expect(submissionLockIdx).toBeGreaterThan(-1)
    expect(portfolioLockIdx).toBeLessThan(submissionLockIdx)
  })

  it('15B-review section 2: the existing-agreement check is scoped to the whole portfolio (not just this submission) when portfolio-linked — this is what actually prevents two submissions of the same portfolio from each getting a "current" agreement', () => {
    const fnSrc = createSellerAgreementBody()
    expect(fnSrc).toMatch(/sellerPortfolioId:\s*submission\.sellerPortfolioId,\s*status:\s*{\s*not:\s*'cancelled'\s*}/)
  })

  it('a portfolio-linked draft agreement sources acceptedItemCount from the portfolio, never the raw form value, for both create and update', () => {
    const occurrences = src.match(/resolvePortfolioAcceptedItemCount\(/g) ?? []
    // 1 definition + create + update + acceptance = 4
    expect(occurrences.length).toBe(4)
  })

  it('acceptance locks the PORTFOLIO row (when one exists) before the SUBMISSION row, matching createSellerAgreement\'s canonical order (prevents deadlock between the two)', () => {
    const fnStart = src.indexOf('export async function recordSellerAgreementAcceptance')
    const fnSrc = src.slice(fnStart)
    const portfolioLockIdx = fnSrc.indexOf('SELECT id FROM "SellerPortfolio" WHERE id = ${agreement.sellerPortfolioId} FOR UPDATE')
    const submissionLockIdx = fnSrc.indexOf('SELECT id FROM "SellerSubmission" WHERE id = ${agreement.submissionId} FOR UPDATE')
    expect(portfolioLockIdx).toBeGreaterThan(-1)
    expect(submissionLockIdx).toBeGreaterThan(-1)
    expect(portfolioLockIdx).toBeLessThan(submissionLockIdx)
  })

  it('the final acceptance cap-check uses the portfolio-aware submitted-quantity helper, not a single-submission quantity', () => {
    const occurrences = src.match(/resolveSubmittedQuantityCap\(/g) ?? []
    // 1 definition + resolvePortfolioAcceptedItemCount's fallback + validateAcceptedItemCountCap's call + acceptance's call = 4
    expect(occurrences.length).toBe(4)
  })

  it('createSellerAgreement persists sellerPortfolioId onto the new agreement', () => {
    const fnStart = src.indexOf('export async function createSellerAgreement')
    const createCallIdx = src.indexOf('await tx.sellerAgreement.create(', fnStart)
    const createEnd = src.indexOf('})', createCallIdx)
    const createSrc = src.slice(createCallIdx, createEnd)
    expect(createSrc).toMatch(/sellerPortfolioId:\s*submission\.sellerPortfolioId/)
  })
})

describe('sellerPortfolios.ts: updatePortfolioAcceptedCount is blocked once the agreement is accepted (section 3)', () => {
  const src = readSrc('src/lib/actions/sellerPortfolios.ts')

  it('checks for a current ACCEPTED agreement before allowing the write, and blocks it', () => {
    const fnStart = src.indexOf('export async function updatePortfolioAcceptedCount')
    const fnSrc = src.slice(fnStart, src.indexOf('\nexport async function', fnStart + 1))
    const checkIdx = fnSrc.indexOf("status: 'accepted'")
    const updateIdx = fnSrc.indexOf('tx.sellerPortfolio.update(')
    expect(checkIdx).toBeGreaterThan(-1)
    expect(updateIdx).toBeGreaterThan(-1)
    expect(checkIdx).toBeLessThan(updateIdx) // guard runs BEFORE the write, not after
    expect(fnSrc).toMatch(/if \(acceptedAgreement\)/)
  })
})

describe('portfolio detail page: signed quantity is immutable, physical variance is clearly labeled, never re-tiers commission (section 3)', () => {
  const src = readSrc('src/app/(admin)/admin/seller-portfolios/[id]/page.tsx')

  it('shows the signed quantity as "Agreed quantity ... immutable" once the agreement is accepted', () => {
    expect(src).toMatch(/Agreed quantity \(signed, immutable\)/)
  })

  it('shows a distinctly-labeled "Variance" between received and agreed quantity, not a silent overwrite of the agreed figure', () => {
    expect(src).toMatch(/Variance/)
    expect(src).toMatch(/detail\.counts\.received - detail\.currentAgreement\.acceptedItemCount/)
  })

  it('explicitly states that physical variance never changes the locked-in commission tier', () => {
    expect(src).toMatch(/never changes the commission tier already locked in at acceptance/)
  })

  it('hides the editable accepted-quantity form once the agreement is accepted (edits would be silently meaningless otherwise)', () => {
    // Skip the import line — find the JSX USAGE of the form (after the import).
    const formUsageIdx = src.indexOf('<UpdateAcceptedCountForm')
    const guardIdx = src.lastIndexOf("detail.currentAgreement?.status === 'accepted'", formUsageIdx)
    expect(formUsageIdx).toBeGreaterThan(-1)
    expect(guardIdx).toBeGreaterThan(-1)
  })
})
