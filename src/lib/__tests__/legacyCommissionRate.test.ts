// 15A-review section 4: SellerProfile.commissionRate is a legacy Float field kept only
// for historical records — it must never be read by payout calculation or commission
// resolution, and the admin UI must never present it as if it were authoritative.
// These are structural/grep-based checks (not behavioral) so a future edit that
// reintroduces a `commissionRate` read into the payout/resolution path fails loudly
// here rather than silently reintroducing two apparently-valid commission settings.
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relPath), 'utf-8')
}

describe('legacy SellerProfile.commissionRate: never re-enters payout/resolution logic', () => {
  it('sellerPayoutCalculation.ts never references commissionRate', () => {
    expect(readSrc('src/lib/sellerPayoutCalculation.ts')).not.toMatch(/commissionRate/)
  })

  it('commissionPolicy.ts (the pure resolver) never references commissionRate', () => {
    expect(readSrc('src/lib/commissionPolicy.ts')).not.toMatch(/commissionRate/)
  })

  it('commissionPolicyQuery.ts (the DB boundary for resolution) never references commissionRate', () => {
    expect(readSrc('src/lib/commissionPolicyQuery.ts')).not.toMatch(/commissionRate/)
  })

  it('sellerAgreements.ts (agreement create/update/acceptance actions) never references commissionRate', () => {
    expect(readSrc('src/lib/actions/sellerAgreements.ts')).not.toMatch(/commissionRate/)
  })

  it('sellerPayouts.ts (payout generation/approval actions) never references commissionRate', () => {
    expect(readSrc('src/lib/actions/sellerPayouts.ts')).not.toMatch(/commissionRate/)
  })
})

describe('legacy SellerProfile.commissionRate: admin UI marks it non-authoritative', () => {
  it('the seller-profiles list column is labeled legacy', () => {
    const src = readSrc('src/app/(admin)/admin/seller-profiles/page.tsx')
    expect(src).toMatch(/Commission \(legacy\)/)
  })

  it('the seller-profile edit form is labeled legacy and explains it is not authoritative', () => {
    const src = readSrc('src/components/admin/SellerProfileForm.tsx')
    expect(src).toMatch(/legacy — not authoritative/)
    expect(src).toMatch(/never read by payout calculation or/)
  })
})
