import { describe, it, expect, vi, beforeEach } from 'vitest'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({ prisma: { $transaction: vi.fn() } }))
vi.mock('@/lib/adminAuth', () => ({ isAdminAuthenticated: vi.fn().mockResolvedValue(true) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { prisma } from '@/lib/prisma'
import { isAdminAuthenticated } from '@/lib/adminAuth'
import { publishAutoListingPolicyVersionAction } from '@/lib/actions/autoListingPolicy'

function makeTx(latest: { version: number; effectiveFrom: Date } | null) {
  const create = vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => Promise.resolve({ ...args.data, id: 'new-policy' }))
  return { $executeRaw: vi.fn().mockResolvedValue(undefined), autoListingPolicyConfig: { findFirst: vi.fn().mockResolvedValue(latest), create } }
}
function mockTransaction(tx: ReturnType<typeof makeTx>) {
  ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(tx))
}
function baseFormData(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData()
  const defaults: Record<string, string> = { minimumPricingConfidence: 'high', pricePositionBps: '5000' }
  for (const [k, v] of Object.entries({ ...defaults, ...overrides })) fd.set(k, v)
  return fd
}

describe('publishAutoListingPolicyVersionAction — validation and versioning (Part Y section 51)', () => {
  beforeEach(() => { vi.resetAllMocks(); (isAdminAuthenticated as Mock).mockResolvedValue(true) })

  it('creates version 1 when no prior policy exists, disabled by default (checkbox absent)', async () => {
    const tx = makeTx(null)
    mockTransaction(tx)
    const result = await publishAutoListingPolicyVersionAction(null, baseFormData())
    expect(result).toBeNull()
    const data = (tx.autoListingPolicyConfig.create as Mock).mock.calls[0][0].data
    expect(data.version).toBe(1)
    expect(data.enabled).toBe(false)
  })

  it('auto-increments the version number from the latest — never mutates prior versions', async () => {
    const tx = makeTx({ version: 4, effectiveFrom: new Date('2020-01-01') })
    mockTransaction(tx)
    await publishAutoListingPolicyVersionAction(null, baseFormData())
    expect((tx.autoListingPolicyConfig.create as Mock).mock.calls[0][0].data.version).toBe(5)
    // No update()/updateMany() call exists on the mocked tx at all — nothing to mutate.
    expect(tx.autoListingPolicyConfig).not.toHaveProperty('update')
  })

  it('enabled=on is honored', async () => {
    const tx = makeTx(null)
    mockTransaction(tx)
    await publishAutoListingPolicyVersionAction(null, baseFormData({ enabled: 'on' }))
    expect((tx.autoListingPolicyConfig.create as Mock).mock.calls[0][0].data.enabled).toBe(true)
  })

  it('rejects an invalid minimumPricingConfidence (e.g. "low") before ever opening a transaction', async () => {
    const result = await publishAutoListingPolicyVersionAction(null, baseFormData({ minimumPricingConfidence: 'low' }))
    expect(result?.errors?.minimumPricingConfidence).toBeTruthy()
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('rejects pricePositionBps < 0', async () => {
    const result = await publishAutoListingPolicyVersionAction(null, baseFormData({ pricePositionBps: '-1' }))
    expect(result?.errors?.pricePositionBps).toBeTruthy()
  })

  it('rejects pricePositionBps > 10000', async () => {
    const result = await publishAutoListingPolicyVersionAction(null, baseFormData({ pricePositionBps: '10001' }))
    expect(result?.errors?.pricePositionBps).toBeTruthy()
  })

  it('rejects a non-integer pricePositionBps', async () => {
    const result = await publishAutoListingPolicyVersionAction(null, baseFormData({ pricePositionBps: '50.5' }))
    expect(result?.errors?.pricePositionBps).toBeTruthy()
  })

  it('rejects a new version dated at or before the currently active version — no ambiguous active version', async () => {
    const tx = makeTx({ version: 2, effectiveFrom: new Date('2026-06-01T00:00:00Z') })
    mockTransaction(tx)
    const result = await publishAutoListingPolicyVersionAction(null, baseFormData({ effectiveFrom: '2026-05-01T00:00:00' }))
    expect(result?.errors?._form?.[0]).toMatch(/ambiguous/)
    expect(tx.autoListingPolicyConfig.create).not.toHaveBeenCalled()
  })

  it('a future effectiveFrom is accepted but is not yet active — resolution is asOf-based, tested in autoListingPolicyQuery.test.ts', async () => {
    const tx = makeTx({ version: 1, effectiveFrom: new Date('2020-01-01') })
    mockTransaction(tx)
    const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 16)
    const result = await publishAutoListingPolicyVersionAction(null, baseFormData({ effectiveFrom: future }))
    expect(result).toBeNull()
    expect(tx.autoListingPolicyConfig.create).toHaveBeenCalledTimes(1)
  })

  it('admin authentication is required', async () => {
    ;(isAdminAuthenticated as Mock).mockResolvedValueOnce(false)
    const result = await publishAutoListingPolicyVersionAction(null, baseFormData())
    expect(result?.errors?._form).toBeTruthy()
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('createdBy is honestly "admin" — no fabricated per-admin identity (Part C section 5)', async () => {
    const tx = makeTx(null)
    mockTransaction(tx)
    await publishAutoListingPolicyVersionAction(null, baseFormData())
    expect((tx.autoListingPolicyConfig.create as Mock).mock.calls[0][0].data.createdBy).toBe('admin')
  })
})
