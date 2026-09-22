// 32B: structural coverage for the listing create/edit canonical pricing
// context wiring (§39/§40/§41/§42/§43/§80). No React rendering harness exists
// in this codebase (established convention) — these are source-text
// assertions over the exact touched files.
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relPath), 'utf-8')
}

const formSrc = readSrc('src/components/admin/ListingForm.tsx')
const newPageSrc = readSrc('src/app/(admin)/admin/listings/new/page.tsx')
const editPageSrc = readSrc('src/app/(admin)/admin/listings/[id]/edit/page.tsx')

describe('listing create page — additive canonical context (§39)', () => {
  it('fetches safeGetAdminPricingContext server-side only for the pre-selected item', () => {
    expect(newPageSrc).toContain('safeGetAdminPricingContext')
    expect(newPageSrc).toContain('preSelectedItem')
  })

  it('never fetches pricing context for every eligible item (no N x safeGetAdminPricingContext)', () => {
    expect(newPageSrc).not.toMatch(/eligibleItems\.map.*safeGetAdminPricingContext/s)
  })
})

describe('listing edit page — canonical context for the fixed item (§40)', () => {
  it('fetches safeGetAdminPricingContext unconditionally using the listing item identity', () => {
    expect(editPageSrc).toContain('safeGetAdminPricingContext')
    expect(editPageSrc).toContain('listing.item.catalogId')
    expect(editPageSrc).toContain('listing.item.marketVariantId')
    expect(editPageSrc).toContain('listing.item.condition')
  })
})

describe('ListingForm.tsx — server/client boundary and price independence (§41/§42)', () => {
  it('no Prisma/DB import in the client form component', () => {
    expect(formSrc).not.toMatch(/from ['"]@\/lib\/prisma['"]/)
    expect(formSrc).not.toMatch(/PrismaClient/)
  })

  it('renders the shared AdminPricingContextPanel for both create and edit', () => {
    const occurrences = formSrc.match(/<AdminPricingContextPanel/g) ?? []
    expect(occurrences.length).toBeGreaterThanOrEqual(2)
  })

  it('Entered Listing Price is its own distinct label — never styled/positioned as derived from EMV', () => {
    expect(formSrc).toContain('Entered Listing Price')
  })

  it('never auto-fills the price input from EMV/Market Range (price state is seeded only from item.listPrice/listing.price)', () => {
    expect(formSrc).not.toMatch(/setPrice\([^)]*estimatedValueCents/)
    expect(formSrc).not.toMatch(/setPrice\([^)]*marketRange/i)
  })

  it('no algorithmic Suggested/Recommended/Optimal Price concept', () => {
    expect(formSrc).not.toMatch(/Suggested Listing Price|Recommended Price|Optimal Price/)
  })

  it('the live price-vs-range comparison is fed by the current price input string — reacts without a network call', () => {
    expect(formSrc).toContain('parsePriceInputToCents(price)')
    expect(formSrc).toContain('parsePriceInputToCents(priceForPreview)')
  })

  it('preserves the pre-existing Projected Seller Payout consignment panel unchanged', () => {
    expect(formSrc).toContain('Projected seller payout')
    expect(formSrc).toContain('calculateConsignmentPreview')
  })
})
