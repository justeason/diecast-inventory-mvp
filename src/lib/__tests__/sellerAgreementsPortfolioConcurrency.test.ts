// 15B-review section 2: behavioral coverage for portfolio-scoped "current agreement"
// enforcement in createSellerAgreement. True concurrent transactions can't be
// exercised against a mocked prisma client, so these tests instead prove the
// MECHANISM that makes two concurrent attempts resolve to "one succeeds, one fails
// clearly": the existing-agreement check is scoped to the whole portfolio (not just
// the calling submission), and the portfolio row is locked before that check runs.
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({
  prisma: {
    sellerSubmission: { findUnique: vi.fn() },
    sellerProfile: { findUnique: vi.fn() },
    sellerAgreement: { findFirst: vi.fn(), create: vi.fn() },
    sellerPortfolio: { findUnique: vi.fn() },
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
  },
}))

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => { throw new Error(`REDIRECT:${url}`) }),
}))

import { prisma } from '@/lib/prisma'
import { createSellerAgreement } from '@/lib/actions/sellerAgreements'

function buyoutFormData(): FormData {
  const f = new FormData()
  f.set('type', 'buyout')
  f.set('agreedBuyoutAmount', '100.00')
  return f
}

describe('createSellerAgreement — portfolio-scoped current-agreement enforcement (section 2)', () => {
  beforeEach(() => vi.resetAllMocks())

  it('two different submissions of the SAME portfolio: the second attempt is rejected because the existing-agreement check is scoped to the portfolio, not the submission', async () => {
    // Pre-transaction lock-order hint: submission B belongs to portfolio P.
    ;(prisma.sellerSubmission.findUnique as Mock).mockResolvedValueOnce({ sellerPortfolioId: 'portfolioP' })

    let existingCheckWhere: unknown = null
    ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue(undefined),
        sellerSubmission: {
          findUnique: vi.fn().mockResolvedValue({ profileId: 'profB', sellerPortfolioId: 'portfolioP' }),
        },
        sellerAgreement: {
          findFirst: vi.fn().mockImplementation((args: { where: unknown }) => {
            existingCheckWhere = args.where
            // Simulate: submission A (also in portfolio P) already got a current
            // agreement created moments earlier by a concurrent request.
            return Promise.resolve({ id: 'agreement-from-submission-A' })
          }),
        },
        sellerProfile: { findUnique: vi.fn() },
      }
      return cb(tx)
    })

    const result = await createSellerAgreement('submissionB', null, buyoutFormData())
    expect(result?.errors?._form?.[0]).toMatch(/portfolio already has a current agreement/)
    // The check that caught it was scoped to the PORTFOLIO, not submissionB.
    expect(existingCheckWhere).toMatchObject({ sellerPortfolioId: 'portfolioP', status: { not: 'cancelled' } })
    expect(existingCheckWhere).not.toHaveProperty('submissionId')
  })

  it('exactly one of two concurrent attempts for the same portfolio can succeed: the first (no existing agreement found) creates successfully', async () => {
    ;(prisma.sellerSubmission.findUnique as Mock).mockResolvedValueOnce({ sellerPortfolioId: 'portfolioP' })
    ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue(undefined),
        sellerSubmission: { findUnique: vi.fn().mockResolvedValue({ profileId: 'profA', sellerPortfolioId: 'portfolioP' }) },
        sellerAgreement: {
          findFirst: vi.fn().mockResolvedValue(null), // no current agreement yet — this request wins
          create: vi.fn().mockResolvedValue({ id: 'agreement-from-submission-A' }),
        },
        sellerProfile: { findUnique: vi.fn().mockResolvedValue({ id: 'sp1' }) },
      }
      return cb(tx)
    })

    await expect(createSellerAgreement('submissionA', null, buyoutFormData()))
      .rejects.toThrow('REDIRECT:/admin/seller-submissions/submissionA/agreement')
  })

  it('the portfolio row is locked before the portfolio-scoped existing-agreement check runs (serializes the two concurrent attempts)', async () => {
    ;(prisma.sellerSubmission.findUnique as Mock).mockResolvedValueOnce({ sellerPortfolioId: 'portfolioP' })
    const calls: string[] = []
    ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        $queryRaw: vi.fn().mockImplementation((strings: TemplateStringsArray) => {
          calls.push(strings.join('').includes('SellerPortfolio') ? 'lock-portfolio' : 'lock-submission')
          return Promise.resolve(undefined)
        }),
        sellerSubmission: { findUnique: vi.fn().mockResolvedValue({ profileId: 'profA', sellerPortfolioId: 'portfolioP' }) },
        sellerAgreement: {
          findFirst: vi.fn().mockImplementation(() => { calls.push('existing-check'); return Promise.resolve(null) }),
          create: vi.fn().mockResolvedValue({ id: 'agr1' }),
        },
        sellerProfile: { findUnique: vi.fn().mockResolvedValue({ id: 'sp1' }) },
      }
      return cb(tx)
    })

    await expect(createSellerAgreement('submissionA', null, buyoutFormData())).rejects.toThrow('REDIRECT:')
    expect(calls).toEqual(['lock-portfolio', 'lock-submission', 'existing-check'])
  })

  it('separate portfolios use different lock targets — the lock is parameterized by the actual portfolio id, so unrelated portfolios never contend on the same row', async () => {
    ;(prisma.sellerSubmission.findUnique as Mock).mockResolvedValueOnce({ sellerPortfolioId: 'portfolio-OTHER' })
    let lockedId: string | null = null
    ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        $queryRaw: vi.fn().mockImplementation((strings: TemplateStringsArray, id: string) => {
          if (strings.join('').includes('SellerPortfolio')) lockedId = id
          return Promise.resolve(undefined)
        }),
        sellerSubmission: { findUnique: vi.fn().mockResolvedValue({ profileId: 'profX', sellerPortfolioId: 'portfolio-OTHER' }) },
        sellerAgreement: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'agr2' }) },
        sellerProfile: { findUnique: vi.fn().mockResolvedValue({ id: 'sp2' }) },
      }
      return cb(tx)
    })
    await expect(createSellerAgreement('submissionX', null, buyoutFormData())).rejects.toThrow('REDIRECT:')
    expect(lockedId).toBe('portfolio-OTHER')
  })

  it('a historical/cancelled agreement does not block a valid replacement (existing-check excludes cancelled)', async () => {
    ;(prisma.sellerSubmission.findUnique as Mock).mockResolvedValueOnce({ sellerPortfolioId: 'portfolioP' })
    let existingCheckWhere: unknown = null
    ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue(undefined),
        sellerSubmission: { findUnique: vi.fn().mockResolvedValue({ profileId: 'profA', sellerPortfolioId: 'portfolioP' }) },
        sellerAgreement: {
          // The DB query itself excludes cancelled rows (status: {not: 'cancelled'})
          // — a cancelled agreement is simply never returned here.
          findFirst: vi.fn().mockImplementation((args: { where: unknown }) => {
            existingCheckWhere = args.where
            return Promise.resolve(null)
          }),
          create: vi.fn().mockResolvedValue({ id: 'agreement-replacement' }),
        },
        sellerProfile: { findUnique: vi.fn().mockResolvedValue({ id: 'sp1' }) },
      }
      return cb(tx)
    })

    await expect(createSellerAgreement('submissionA', null, buyoutFormData())).rejects.toThrow('REDIRECT:')
    expect(existingCheckWhere).toMatchObject({ status: { not: 'cancelled' } })
  })

  it('a non-portfolio submission keeps the original submission-scoped existing-agreement check (unchanged 15A behavior)', async () => {
    ;(prisma.sellerSubmission.findUnique as Mock).mockResolvedValueOnce({ sellerPortfolioId: null })
    let existingCheckWhere: unknown = null
    ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue(undefined),
        sellerSubmission: { findUnique: vi.fn().mockResolvedValue({ profileId: 'profA', sellerPortfolioId: null }) },
        sellerAgreement: {
          findFirst: vi.fn().mockImplementation((args: { where: unknown }) => {
            existingCheckWhere = args.where
            return Promise.resolve(null)
          }),
          create: vi.fn().mockResolvedValue({ id: 'agr3' }),
        },
        sellerProfile: { findUnique: vi.fn().mockResolvedValue({ id: 'sp1' }) },
      }
      return cb(tx)
    })

    await expect(createSellerAgreement('submissionSolo', null, buyoutFormData())).rejects.toThrow('REDIRECT:')
    expect(existingCheckWhere).toMatchObject({ submissionId: 'submissionSolo', status: { not: 'cancelled' } })
    expect(existingCheckWhere).not.toHaveProperty('sellerPortfolioId')
  })
})
