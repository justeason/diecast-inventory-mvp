import { describe, it, expect, vi, beforeEach } from 'vitest'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({
  prisma: {
    sellerSubmission: { findUnique: vi.fn(), update: vi.fn() },
    sellerProfile: { findUnique: vi.fn() },
    sellerPortfolio: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    sellerAgreement: { findFirst: vi.fn() },
    sellerInboundShipment: { findMany: vi.fn() },
    intakeDraft: { count: vi.fn() },
    itemInstance: { groupBy: vi.fn() },
    sellerPayoutLine: { aggregate: vi.fn() },
    sellerLifecycleCase: { count: vi.fn() },
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
  },
}))

vi.mock('@/lib/adminAuth', () => ({ isAdminAuthenticated: vi.fn().mockResolvedValue(true) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`) }),
}))

import { prisma } from '@/lib/prisma'
import { isAdminAuthenticated } from '@/lib/adminAuth'
import {
  createPortfolioFromSubmission,
  addSubmissionToPortfolio,
  updatePortfolioAcceptedCount,
  cancelSellerPortfolio,
  completeSellerPortfolio,
} from '@/lib/actions/sellerPortfolios'

function fd(entries: Record<string, string>): FormData {
  const f = new FormData()
  for (const [k, v] of Object.entries(entries)) f.set(k, v)
  return f
}

// vi.resetAllMocks() (used throughout this file) clears mock implementations, not
// just call history — re-establish the admin-auth pass in every test's beforeEach.
function mockAdminAuthenticated() {
  ;(isAdminAuthenticated as Mock).mockResolvedValue(true)
}

describe('createPortfolioFromSubmission — concurrency (section 23)', () => {
  beforeEach(() => { vi.resetAllMocks(); mockAdminAuthenticated() })

  it('locks the submission row (FOR UPDATE) before creating the portfolio', async () => {
    const calls: string[] = []
    ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        $queryRaw: vi.fn().mockImplementation(() => { calls.push('lock'); return Promise.resolve(undefined) }),
        sellerSubmission: {
          findUnique: vi.fn().mockImplementation(() => { calls.push('read'); return Promise.resolve({ id: 'sub1', profileId: 'prof1', sellerPortfolioId: null }) }),
          update: vi.fn().mockImplementation(() => { calls.push('update'); return Promise.resolve({}) }),
        },
        sellerProfile: { findUnique: vi.fn().mockResolvedValue({ id: 'sp1' }) },
        sellerPortfolio: { create: vi.fn().mockImplementation(() => { calls.push('create'); return Promise.resolve({ id: 'port1' }) }) },
      }
      return cb(tx)
    })

    await expect(createPortfolioFromSubmission('sub1', fd({}))).rejects.toThrow('REDIRECT:/admin/seller-portfolios/port1')
    expect(calls).toEqual(['lock', 'read', 'create', 'update'])
  })

  it('a submission already linked to a portfolio is not double-assigned — no-ops and redirects back', async () => {
    ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue(undefined),
        sellerSubmission: {
          findUnique: vi.fn().mockResolvedValue({ id: 'sub1', profileId: 'prof1', sellerPortfolioId: 'already-linked' }),
          update: vi.fn(),
        },
        sellerProfile: { findUnique: vi.fn() },
        sellerPortfolio: { create: vi.fn() },
      }
      return cb(tx)
    })

    await expect(createPortfolioFromSubmission('sub1', fd({}))).rejects.toThrow('REDIRECT:/admin/seller-submissions/sub1')
  })
})

describe('addSubmissionToPortfolio — validation & concurrency (sections 4/8/23)', () => {
  beforeEach(() => { vi.resetAllMocks(); mockAdminAuthenticated() })

  it('rejects a submission belonging to a different seller than the portfolio', async () => {
    ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue(undefined),
        sellerPortfolio: { findUnique: vi.fn().mockResolvedValue({ id: 'port1', sellerProfileId: 'sp-A', status: 'open' }) },
        sellerSubmission: {
          findUnique: vi.fn().mockResolvedValue({ id: 'sub2', profileId: 'prof-B', sellerPortfolioId: null }),
          update: vi.fn(),
        },
        sellerProfile: { findUnique: vi.fn().mockResolvedValue({ id: 'sp-B' }) },
      }
      return cb(tx)
    })
    const result = await addSubmissionToPortfolio('port1', null, fd({ submissionId: 'sub2' }))
    expect(result?.errors?.submissionId).toBeDefined()
  })

  it('rejects a submission that already belongs to a different portfolio (prevents double-assignment)', async () => {
    ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue(undefined),
        sellerPortfolio: { findUnique: vi.fn().mockResolvedValue({ id: 'port1', sellerProfileId: 'sp-A', status: 'open' }) },
        sellerSubmission: {
          findUnique: vi.fn().mockResolvedValue({ id: 'sub2', profileId: 'prof-A', sellerPortfolioId: 'other-portfolio' }),
          update: vi.fn(),
        },
        sellerProfile: { findUnique: vi.fn() },
      }
      return cb(tx)
    })
    const result = await addSubmissionToPortfolio('port1', null, fd({ submissionId: 'sub2' }))
    expect(result?.errors?.submissionId).toBeDefined()
  })

  it('rejects adding a submission to a cancelled or completed portfolio', async () => {
    ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue(undefined),
        sellerPortfolio: { findUnique: vi.fn().mockResolvedValue({ id: 'port1', sellerProfileId: 'sp-A', status: 'cancelled' }) },
        sellerSubmission: { findUnique: vi.fn().mockResolvedValue({ id: 'sub2', profileId: 'prof-A', sellerPortfolioId: null }), update: vi.fn() },
        sellerProfile: { findUnique: vi.fn() },
      }
      return cb(tx)
    })
    const result = await addSubmissionToPortfolio('port1', null, fd({ submissionId: 'sub2' }))
    expect(result?.errors?.form).toBeDefined()
  })
})

describe('updatePortfolioAcceptedCount — format & cap validation (section 5)', () => {
  beforeEach(() => { vi.resetAllMocks(); mockAdminAuthenticated() })

  it('rejects a non-integer value', async () => {
    const result = await updatePortfolioAcceptedCount('port1', null, fd({ acceptedItemCount: 'abc' }))
    expect(result?.errors?.acceptedItemCount).toBeDefined()
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('rejects zero/negative', async () => {
    const result = await updatePortfolioAcceptedCount('port1', null, fd({ acceptedItemCount: '0' }))
    expect(result?.errors?.acceptedItemCount).toBeDefined()
  })

  it('rejects an accepted count exceeding the portfolio submitted total', async () => {
    ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue(undefined),
        sellerPortfolio: { findUnique: vi.fn().mockResolvedValue({ id: 'port1' }), update: vi.fn() },
        sellerSubmission: { aggregate: vi.fn().mockResolvedValue({ _sum: { quantity: 70 } }) },
        sellerAgreement: { findFirst: vi.fn().mockResolvedValue(null) }, // no accepted agreement yet
      }
      return cb(tx)
    })
    const result = await updatePortfolioAcceptedCount('port1', null, fd({ acceptedItemCount: '75' }))
    expect(result?.errors?.acceptedItemCount).toBeDefined()
  })

  it('pre-sign: accepts a value within the submitted total', async () => {
    let updated = false
    ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue(undefined),
        sellerPortfolio: { findUnique: vi.fn().mockResolvedValue({ id: 'port1' }), update: vi.fn().mockImplementation(() => { updated = true; return Promise.resolve({}) }) },
        sellerSubmission: { aggregate: vi.fn().mockResolvedValue({ _sum: { quantity: 70 } }) },
        sellerAgreement: { findFirst: vi.fn().mockResolvedValue(null) },
      }
      return cb(tx)
    })
    const result = await updatePortfolioAcceptedCount('port1', null, fd({ acceptedItemCount: '60' }))
    expect(result).toBeNull()
    expect(updated).toBe(true)
  })

  it('15B-review section 3: post-sign — rejects editing once the portfolio has a current ACCEPTED agreement (signed count is immutable)', async () => {
    let updated = false
    ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue(undefined),
        sellerPortfolio: { findUnique: vi.fn().mockResolvedValue({ id: 'port1' }), update: vi.fn().mockImplementation(() => { updated = true; return Promise.resolve({}) }) },
        sellerSubmission: { aggregate: vi.fn().mockResolvedValue({ _sum: { quantity: 70 } }) },
        sellerAgreement: { findFirst: vi.fn().mockResolvedValue({ id: 'agr1' }) }, // current agreement IS accepted
      }
      return cb(tx)
    })
    const result = await updatePortfolioAcceptedCount('port1', null, fd({ acceptedItemCount: '60' }))
    expect(result?.errors?.form).toBeDefined()
    expect(updated).toBe(false)
  })
})

describe('completeSellerPortfolio — cannot force-complete with outstanding liability (section 16)', () => {
  beforeEach(() => { vi.resetAllMocks(); mockAdminAuthenticated() })

  function mockCompletionInputs(opts: {
    outstandingNetAmount: number
    rejectedIntakeCount?: number
    openCaseCount?: number
    shipmentStatus?: string
  }) {
    ;(prisma.sellerPortfolio.findUnique as Mock).mockResolvedValueOnce({ id: 'port1', status: 'open' })
    ;(prisma.sellerAgreement.findFirst as Mock).mockResolvedValueOnce({ status: 'accepted' })
    ;(prisma.sellerInboundShipment.findMany as Mock).mockResolvedValueOnce([{ status: opts.shipmentStatus ?? 'received' }])
    ;(prisma.intakeDraft.count as Mock)
      .mockResolvedValueOnce(10) // intakeCompleteCount
      .mockResolvedValueOnce(opts.rejectedIntakeCount ?? 0) // rejectedIntakeCount
    ;(prisma.itemInstance.groupBy as Mock).mockResolvedValueOnce([{ status: 'sold', _count: { _all: 10 } }])
    ;(prisma.sellerPayoutLine.aggregate as Mock).mockResolvedValueOnce({ _sum: { netAmount: opts.outstandingNetAmount } })
    ;(prisma.sellerLifecycleCase.count as Mock).mockResolvedValueOnce(opts.openCaseCount ?? 0)
  }

  it('rejects completion while outstanding payout liability remains', async () => {
    mockCompletionInputs({ outstandingNetAmount: 25.5 })

    const result = await completeSellerPortfolio('port1', null, new FormData())
    expect(result?.errors?.form).toBeDefined()
    expect(prisma.sellerPortfolio.update).not.toHaveBeenCalled()
  })

  it('15B-review section 4: rejects completion while an intake exception (rejected draft) is open', () => {
    mockCompletionInputs({ outstandingNetAmount: 0, rejectedIntakeCount: 1 })
    return completeSellerPortfolio('port1', null, new FormData()).then((result) => {
      expect(result?.errors?.form).toBeDefined()
      expect(prisma.sellerPortfolio.update).not.toHaveBeenCalled()
    })
  })

  it('15B-review section 4: rejects completion while a lifecycle case is open', () => {
    mockCompletionInputs({ outstandingNetAmount: 0, openCaseCount: 1 })
    return completeSellerPortfolio('port1', null, new FormData()).then((result) => {
      expect(result?.errors?.form).toBeDefined()
      expect(prisma.sellerPortfolio.update).not.toHaveBeenCalled()
    })
  })

  it('15B-review section 4: rejects completion while a shipment is flagged "issue" (unresolved inbound discrepancy)', () => {
    mockCompletionInputs({ outstandingNetAmount: 0, shipmentStatus: 'issue' })
    return completeSellerPortfolio('port1', null, new FormData()).then((result) => {
      expect(result?.errors?.form).toBeDefined()
      expect(prisma.sellerPortfolio.update).not.toHaveBeenCalled()
    })
  })

  it('allows completion when fully resolved and no outstanding liability, exceptions, or discrepancies', async () => {
    mockCompletionInputs({ outstandingNetAmount: 0 })
    ;(prisma.sellerPortfolio.update as Mock).mockResolvedValueOnce({})

    const result = await completeSellerPortfolio('port1', null, new FormData())
    expect(result).toBeNull()
    expect(prisma.sellerPortfolio.update).toHaveBeenCalled()
  })
})

describe('cancelSellerPortfolio', () => {
  beforeEach(() => { vi.resetAllMocks(); mockAdminAuthenticated() })

  it('requires a reason', async () => {
    const result = await cancelSellerPortfolio('port1', null, new FormData())
    expect(result?.errors?.reason).toBeDefined()
  })
})
