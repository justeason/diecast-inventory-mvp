import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'

type Mock = ReturnType<typeof vi.fn>

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relPath), 'utf-8')
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    commissionPolicy: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    sellerCommissionOverride: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    sellerSubmission: { findUnique: vi.fn() },
    sellerProfile: { findUnique: vi.fn() },
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
  },
}))

import { prisma } from '@/lib/prisma'
import {
  previewCommissionForSubmission,
  createCommissionPolicy,
  createSellerCommissionOverride,
  endDateCommissionPolicy,
} from '@/lib/commissionPolicyQuery'

const ASOF = new Date('2026-08-01T00:00:00.000Z')

describe('commissionPolicyQuery: previewCommissionForSubmission', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns NO_ACTIVE_POLICY when no policy is active for asOf — fails clearly, never silently falls back', async () => {
    ;(prisma.sellerSubmission.findUnique as Mock).mockResolvedValueOnce({ profileId: 'cp1' })
    ;(prisma.sellerProfile.findUnique as Mock).mockResolvedValueOnce(null)
    ;(prisma.commissionPolicy.findFirst as Mock).mockResolvedValueOnce(null)

    const outcome = await previewCommissionForSubmission('sub1', 10, ASOF)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toBe('NO_ACTIVE_POLICY')
  })

  it('15A-review section 1: uses the caller-supplied acceptedItemCount as the tier denominator, never SellerSubmission.quantity', async () => {
    ;(prisma.sellerSubmission.findUnique as Mock).mockResolvedValueOnce({ profileId: 'cp1' })
    ;(prisma.sellerProfile.findUnique as Mock).mockResolvedValueOnce(null)
    ;(prisma.commissionPolicy.findFirst as Mock).mockResolvedValueOnce({
      id: 'pol1', name: 'Standard', defaultCommissionBps: 2000, minimumFeeCents: 250,
      tiers: [{ id: 't1', minItems: 1, commissionBps: 2000, minimumFeeCents: null }, { id: 't20', minItems: 20, commissionBps: 1700, minimumFeeCents: null }],
    })

    // Seller submitted 250 but only 53 were accepted for this agreement — the tier
    // must be selected from 53, and the submission's raw quantity is never fetched.
    const outcome = await previewCommissionForSubmission('sub1', 53, ASOF)
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.resolution.acceptedItemCount).toBe(53)
      expect(outcome.resolution.commissionBps).toBe(1700)
    }
    expect(prisma.sellerSubmission.findUnique).toHaveBeenCalledTimes(1)
    expect((prisma.sellerSubmission.findUnique as Mock).mock.calls[0][0].select).toEqual({ profileId: true })
  })

  it('an explicit agreement override is honored in preview even with no active policy, since it does not need one', async () => {
    ;(prisma.sellerSubmission.findUnique as Mock).mockResolvedValueOnce({ profileId: 'cp1' })
    ;(prisma.sellerProfile.findUnique as Mock).mockResolvedValueOnce(null)
    ;(prisma.commissionPolicy.findFirst as Mock).mockResolvedValueOnce(null)

    const outcome = await previewCommissionForSubmission('sub1', 5, ASOF, { commissionBps: 1000, minimumFeeCents: 100, reason: 'test override' })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.resolution.source).toBe('agreement_override')
      expect(outcome.resolution.commissionBps).toBe(1000)
    }
  })
})

describe('commissionPolicyQuery: createCommissionPolicy — validation before write (section 18)', () => {
  beforeEach(() => vi.resetAllMocks())

  it('rejects an invalid default commission rate before touching the database', async () => {
    const result = await createCommissionPolicy({
      name: 'Bad', effectiveFrom: new Date('2026-01-01'), effectiveTo: null,
      defaultCommissionBps: 20_000, minimumFeeCents: 250, tiers: [], activateImmediately: false,
    })
    expect(result.ok).toBe(false)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('rejects overlapping tiers (duplicate boundary) before writing', async () => {
    const result = await createCommissionPolicy({
      name: 'Bad tiers', effectiveFrom: new Date('2026-01-01'), effectiveTo: null,
      defaultCommissionBps: 2000, minimumFeeCents: 250,
      tiers: [{ minItems: 20, commissionBps: 1700, minimumFeeCents: null }, { minItems: 20, commissionBps: 1500, minimumFeeCents: null }],
      activateImmediately: false,
    })
    expect(result.ok).toBe(false)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('does not silently pick an arbitrary policy when activating over an overlapping active policy — fails clearly', async () => {
    ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        $executeRaw: vi.fn().mockResolvedValue(undefined),
        commissionPolicy: {
          findMany: vi.fn().mockResolvedValueOnce([{ id: 'existing', effectiveFrom: new Date('2026-01-01'), effectiveTo: null }]),
        },
      }
      return cb(tx)
    })

    const result = await createCommissionPolicy({
      name: 'Overlap', effectiveFrom: new Date('2026-03-01'), effectiveTo: null,
      defaultCommissionBps: 1800, minimumFeeCents: 250, tiers: [], activateImmediately: true,
    })
    expect(result.ok).toBe(false)
  })

  it('15A-review section 2: acquires the policy-wide advisory lock before reading existing active policies, so a second writer blocks until the first commits', async () => {
    const callOrder: string[] = []
    ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        $executeRaw: vi.fn().mockImplementation(() => {
          callOrder.push('lock')
          return Promise.resolve(undefined)
        }),
        commissionPolicy: {
          findMany: vi.fn().mockImplementationOnce(() => {
            callOrder.push('findMany')
            return Promise.resolve([])
          }),
          create: vi.fn().mockResolvedValueOnce({ id: 'pol-new' }),
        },
      }
      return cb(tx)
    })

    const result = await createCommissionPolicy({
      name: 'New', effectiveFrom: new Date('2026-03-01'), effectiveTo: null,
      defaultCommissionBps: 1800, minimumFeeCents: 250, tiers: [], activateImmediately: true,
    })
    expect(result.ok).toBe(true)
    expect(callOrder).toEqual(['lock', 'findMany'])
  })
})

describe('commissionPolicyQuery: createSellerCommissionOverride — audit requirements (section 6/17)', () => {
  beforeEach(() => vi.resetAllMocks())

  it('rejects an override with no reason', async () => {
    const result = await createSellerCommissionOverride({
      sellerProfileId: 'sp1', commissionBps: 1000, minimumFeeCents: null,
      effectiveFrom: ASOF, effectiveTo: null, reason: '', createdBy: 'admin',
    })
    expect(result.ok).toBe(false)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('rejects an override with neither commission rate nor minimum fee set', async () => {
    const result = await createSellerCommissionOverride({
      sellerProfileId: 'sp1', commissionBps: null, minimumFeeCents: null,
      effectiveFrom: ASOF, effectiveTo: null, reason: 'test', createdBy: 'admin',
    })
    expect(result.ok).toBe(false)
  })

  it('rejects an expiration date before the start date', async () => {
    const result = await createSellerCommissionOverride({
      sellerProfileId: 'sp1', commissionBps: 1000, minimumFeeCents: null,
      effectiveFrom: new Date('2026-06-01'), effectiveTo: new Date('2026-01-01'), reason: 'test', createdBy: 'admin',
    })
    expect(result.ok).toBe(false)
  })

  it('persists the reason and actor for audit when the override is valid', async () => {
    let capturedCreateCall: unknown = null
    ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        $executeRaw: vi.fn().mockResolvedValue(undefined),
        sellerCommissionOverride: {
          findMany: vi.fn().mockResolvedValueOnce([]),
          create: vi.fn().mockImplementationOnce((call: unknown) => {
            capturedCreateCall = call
            return Promise.resolve({ id: 'ov1' })
          }),
        },
      }
      return cb(tx)
    })

    const result = await createSellerCommissionOverride({
      sellerProfileId: 'sp1', commissionBps: 1000, minimumFeeCents: null,
      effectiveFrom: ASOF, effectiveTo: null, reason: 'High-volume negotiated rate', createdBy: 'admin',
    })
    expect(result.ok).toBe(true)
    const call = capturedCreateCall as { data: { reason: string; createdBy: string } }
    expect(call.data.reason).toBe('High-volume negotiated rate')
    expect(call.data.createdBy).toBe('admin')
  })

  it('15A-review section 3: does not silently pick an arbitrary override when activating over an overlapping window for the same seller — fails clearly', async () => {
    ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        $executeRaw: vi.fn().mockResolvedValue(undefined),
        sellerCommissionOverride: {
          findMany: vi.fn().mockResolvedValueOnce([
            { id: 'existing', effectiveFrom: new Date('2026-01-01'), effectiveTo: null },
          ]),
          create: vi.fn(),
        },
      }
      return cb(tx)
    })

    const result = await createSellerCommissionOverride({
      sellerProfileId: 'sp1', commissionBps: 1500, minimumFeeCents: null,
      effectiveFrom: new Date('2026-03-01'), effectiveTo: null, reason: 'Overlapping window', createdBy: 'admin',
    })
    expect(result.ok).toBe(false)
  })
})

describe('commissionPolicyQuery: endDateCommissionPolicy', () => {
  beforeEach(() => vi.resetAllMocks())

  it('rejects an end date at or before the policy start', async () => {
    ;(prisma.commissionPolicy.findUnique as Mock).mockResolvedValueOnce({ effectiveFrom: new Date('2026-06-01') })
    const result = await endDateCommissionPolicy('pol1', new Date('2026-01-01'))
    expect(result.ok).toBe(false)
    expect(prisma.commissionPolicy.update).not.toHaveBeenCalled()
  })
})

describe('commissionPolicyQuery: safety/scope (structural)', () => {
  const src = readSrc('src/lib/commissionPolicyQuery.ts')

  it('no automatic SellerAgreement status mutation — this module never writes agreement status', () => {
    expect(src).not.toMatch(/sellerAgreement\.(update|create)/)
  })

  it('no automatic payout creation or mutation', () => {
    expect(src).not.toMatch(/sellerPayout(Line)?\.(create|update)/)
  })

  it('no buyer PII fields selected anywhere in this module', () => {
    expect(src).not.toMatch(/buyerName|buyerEmail|buyerPhone/)
  })

  it('preview and finalization share a single resolveCommissionTerms call site — no duplicated tier logic', () => {
    const occurrences = src.match(/resolveCommissionTerms\(/g) ?? []
    expect(occurrences.length).toBe(1) // both previewCommissionForSubmission and resolveCommissionForFinalization delegate to resolveWithOptionalPolicy
    expect(src).toContain('function resolveWithOptionalPolicy')
    expect((src.match(/resolveWithOptionalPolicy\(/g) ?? []).length).toBe(3) // 1 definition + 2 call sites (preview, finalization)
  })

  it('finalization resolver is transaction-scoped (accepts a Prisma transaction client, not the global client)', () => {
    const fnSrc = src.slice(src.indexOf('export async function resolveCommissionForFinalization'), src.indexOf('export async function resolveCommissionForFinalization') + 800)
    expect(fnSrc).toContain('tx:')
    expect(fnSrc).toContain('fetchActivePolicy(tx')
  })
})
