// 27B: Estimated Seller Proceeds — canonical calculator reuse, agreement-term
// precedence (accepted > proposed > policy preview), buyout passthrough.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Prisma } from '@prisma/client'
import fs from 'fs'
import path from 'path'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({
  prisma: { sellerAgreement: { findMany: vi.fn() } },
}))
vi.mock('@/lib/commissionPolicyQuery', () => ({
  previewCommissionForSubmission: vi.fn(),
}))

import { prisma } from '@/lib/prisma'
import { previewCommissionForSubmission } from '@/lib/commissionPolicyQuery'
import { estimateSellerProceeds, findActualBuyoutOffer } from '@/lib/sellerProceedsEstimator'

beforeEach(() => {
  vi.resetAllMocks()
})

describe('estimateSellerProceeds — agreement precedence (§32/§33)', () => {
  it('an accepted consignment agreement takes precedence over policy preview', async () => {
    ;(prisma.sellerAgreement.findMany as Mock).mockResolvedValue([
      { status: 'accepted', commissionPercent: new Prisma.Decimal('0.20'), commissionMinimumFee: null, fixedFee: null, minimumSellerPayout: null },
    ])
    const result = await estimateSellerProceeds({ submissionId: 's1', perItemPriceCents: 10000, quantity: 1 })
    expect(result).not.toBeNull()
    expect(result!.termsSource).toBe('accepted_agreement')
    expect(result!.netProceedsPerItemCents).toBe(8000) // 100 - 20% commission
    expect(previewCommissionForSubmission).not.toHaveBeenCalled()
  })

  it('a proposed (not yet accepted) agreement is used over policy preview, labeled proposed', async () => {
    ;(prisma.sellerAgreement.findMany as Mock).mockResolvedValue([
      { status: 'proposed', commissionPercent: new Prisma.Decimal('0.10'), commissionMinimumFee: null, fixedFee: null, minimumSellerPayout: null },
    ])
    const result = await estimateSellerProceeds({ submissionId: 's1', perItemPriceCents: 10000, quantity: 1 })
    expect(result!.termsSource).toBe('proposed_agreement')
    expect(result!.netProceedsPerItemCents).toBe(9000)
  })

  it('accepted is preferred over proposed when both somehow exist', async () => {
    ;(prisma.sellerAgreement.findMany as Mock).mockResolvedValue([
      { status: 'proposed', commissionPercent: new Prisma.Decimal('0.50'), commissionMinimumFee: null, fixedFee: null, minimumSellerPayout: null },
      { status: 'accepted', commissionPercent: new Prisma.Decimal('0.20'), commissionMinimumFee: null, fixedFee: null, minimumSellerPayout: null },
    ])
    const result = await estimateSellerProceeds({ submissionId: 's1', perItemPriceCents: 10000, quantity: 1 })
    expect(result!.termsSource).toBe('accepted_agreement')
    expect(result!.netProceedsPerItemCents).toBe(8000)
  })

  it('no actual agreement -> falls back to previewCommissionForSubmission, labeled policy_preview', async () => {
    ;(prisma.sellerAgreement.findMany as Mock).mockResolvedValue([])
    ;(previewCommissionForSubmission as Mock).mockResolvedValue({
      ok: true,
      resolution: { commissionBps: 1500, minimumFeeCents: 0, source: 'policy_default', policyId: 'p1', tierId: null, acceptedItemCount: 1, explanation: '' },
    })
    const result = await estimateSellerProceeds({ submissionId: 's1', perItemPriceCents: 10000, quantity: 1 })
    expect(result!.termsSource).toBe('policy_preview')
    expect(result!.netProceedsPerItemCents).toBe(8500) // 100 - 15%
    expect(previewCommissionForSubmission).toHaveBeenCalledWith('s1', 1)
  })

  it('no agreement AND no active policy -> null, never a fabricated $0 estimate', async () => {
    ;(prisma.sellerAgreement.findMany as Mock).mockResolvedValue([])
    ;(previewCommissionForSubmission as Mock).mockResolvedValue({ ok: false, error: 'NO_ACTIVE_POLICY' })
    const result = await estimateSellerProceeds({ submissionId: 's1', perItemPriceCents: 10000, quantity: 1 })
    expect(result).toBeNull()
  })
})

describe('estimateSellerProceeds — quantity/per-item/total (§35/§51)', () => {
  it('total = perItem * quantity for quantity > 1 under consignment (genuinely per-item terms)', async () => {
    ;(prisma.sellerAgreement.findMany as Mock).mockResolvedValue([
      { status: 'accepted', commissionPercent: new Prisma.Decimal('0.20'), commissionMinimumFee: null, fixedFee: null, minimumSellerPayout: null },
    ])
    const result = await estimateSellerProceeds({ submissionId: 's1', perItemPriceCents: 10000, quantity: 3 })
    expect(result!.netProceedsPerItemCents).toBe(8000)
    expect(result!.netProceedsTotalCents).toBe(24000)
  })
})

describe('estimateSellerProceeds — minimum payout (§36/§44)', () => {
  it('minimumSellerPayout tops up net proceeds above simple price-minus-fees arithmetic', async () => {
    ;(prisma.sellerAgreement.findMany as Mock).mockResolvedValue([
      { status: 'accepted', commissionPercent: new Prisma.Decimal('0.50'), commissionMinimumFee: null, fixedFee: null, minimumSellerPayout: new Prisma.Decimal('60') },
    ])
    const result = await estimateSellerProceeds({ submissionId: 's1', perItemPriceCents: 10000, quantity: 1 })
    // Simple: 100 - 50% = 50. Minimum payout 60 tops it up to 60.
    expect(result!.netProceedsPerItemCents).toBe(6000)
  })

  it('canonical calculator is reused verbatim — no simplified price-percent-fee duplicate', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/sellerProceedsEstimator.ts'), 'utf-8')
    expect(src).toContain('calculateConsignmentPayoutSnapshot')
    expect(src).not.toMatch(/grossSalePrice\s*[-*]\s*commission/i)
  })
})

describe('findActualBuyoutOffer — passthrough only, never computed (§41/§45/§46/§85)', () => {
  it('an accepted buyout agreement returns the exact lump-sum amount verbatim', async () => {
    ;(prisma.sellerAgreement.findMany as Mock).mockResolvedValue([
      { status: 'accepted', agreedBuyoutAmount: new Prisma.Decimal('500.00'), acceptedItemCount: 1 },
    ])
    const result = await findActualBuyoutOffer('s1')
    expect(result).toEqual({ status: 'accepted', agreedBuyoutAmountCents: 50000, acceptedItemCount: 1 })
  })

  it('a proposed-only buyout agreement is still returned, labeled proposed', async () => {
    ;(prisma.sellerAgreement.findMany as Mock).mockResolvedValue([
      { status: 'proposed', agreedBuyoutAmount: new Prisma.Decimal('300.00'), acceptedItemCount: null },
    ])
    const result = await findActualBuyoutOffer('s1')
    expect(result!.status).toBe('proposed')
  })

  it('no buyout agreement at all -> null, never an invented offer', async () => {
    ;(prisma.sellerAgreement.findMany as Mock).mockResolvedValue([])
    const result = await findActualBuyoutOffer('s1')
    expect(result).toBeNull()
  })

  it('multi-item (acceptedItemCount != 1) lump sum is never divided — amount returned verbatim regardless', async () => {
    ;(prisma.sellerAgreement.findMany as Mock).mockResolvedValue([
      { status: 'accepted', agreedBuyoutAmount: new Prisma.Decimal('900.00'), acceptedItemCount: 3 },
    ])
    const result = await findActualBuyoutOffer('s1')
    expect(result!.agreedBuyoutAmountCents).toBe(90000) // NOT divided by 3
    expect(result!.acceptedItemCount).toBe(3)
  })

  it('queries only type: buyout — never conflated with a consignment agreement', async () => {
    ;(prisma.sellerAgreement.findMany as Mock).mockResolvedValue([])
    await findActualBuyoutOffer('s1')
    const call = (prisma.sellerAgreement.findMany as Mock).mock.calls[0][0]
    expect(call.where.type).toBe('buyout')
  })
})
