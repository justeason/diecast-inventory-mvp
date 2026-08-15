// 15F: behavioral coverage for the approval gate lifecycle via the established
// $transaction(async tx => cb(tx)) mock pattern, with a STATEFUL riskApprovalRequest
// store (Map-based) so create-then-refetch sequences behave like a real transaction.
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({ prisma: { $transaction: vi.fn(), riskApprovalRequest: { updateMany: vi.fn() } } }))
vi.mock('@/lib/adminAuth', () => ({ isAdminAuthenticated: vi.fn().mockResolvedValue(true) }))
vi.mock('@/lib/riskPolicyQuery', () => ({ getEffectiveRiskPolicy: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { prisma } from '@/lib/prisma'
import { isAdminAuthenticated } from '@/lib/adminAuth'
import { getEffectiveRiskPolicy } from '@/lib/riskPolicyQuery'
import {
  checkRiskGate,
  consumeApprovedRiskGate,
  markApprovalConsumed,
  approveRiskApprovalRequest,
  rejectRiskApprovalRequest,
  cancelRiskApprovalRequest,
} from '@/lib/actions/riskApprovals'
import type { RiskPolicySnapshot } from '@/lib/riskPolicy'

const policy: RiskPolicySnapshot = {
  version: 3,
  highValueReviewThresholdCents: 20_000,
  veryHighValueThresholdCents: 100_000,
  payoutApprovalThresholdCents: 100_000,
  priceDeviationToleranceBps: 1500,
  destructiveActionsRequireApproval: true,
  commercialOverridesRequireApproval: true,
}

function makeStore(rows: Record<string, unknown>[] = []) {
  const store = new Map<string, Record<string, unknown>>(rows.map((r) => [r.id as string, { ...r }]))
  let seq = rows.length

  function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([k, v]) => row[k] === v)
  }

  const riskApprovalRequest = {
    findFirst: vi.fn().mockImplementation((args: { where: Record<string, unknown>; orderBy?: unknown }) => {
      const rows = [...store.values()].filter((r) => matches(r, args.where))
      return Promise.resolve(rows[0] ?? null)
    }),
    findUnique: vi.fn().mockImplementation((args: { where: { id: string } }) => Promise.resolve(store.get(args.where.id) ?? null)),
    create: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
      const id = `approval-${seq++}`
      const row = { id, approvedBy: null, rejectedBy: null, decisionNote: null, consumedAt: null, ...args.data }
      store.set(id, row)
      return Promise.resolve(row)
    }),
    update: vi.fn().mockImplementation((args: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = store.get(args.where.id)
      if (row) Object.assign(row, args.data)
      return Promise.resolve(row ?? null)
    }),
    updateMany: vi.fn().mockImplementation((args: { where: { id: string; status?: string }; data: Record<string, unknown> }) => {
      const row = store.get(args.where.id)
      if (!row || (args.where.status !== undefined && row.status !== args.where.status)) return Promise.resolve({ count: 0 })
      Object.assign(row, args.data)
      return Promise.resolve({ count: 1 })
    }),
  }

  const tx = { $executeRaw: vi.fn().mockResolvedValue(undefined), $queryRaw: vi.fn().mockResolvedValue(undefined), riskApprovalRequest }
  return { store, tx }
}

function mockTransaction(tx: unknown) {
  ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(tx))
}

function defaultAdminAuth() {
  ;(isAdminAuthenticated as Mock).mockResolvedValue(true)
}

describe('checkRiskGate (section 2/26/27)', () => {
  beforeEach(() => { vi.resetAllMocks(); defaultAdminAuth(); (getEffectiveRiskPolicy as Mock).mockResolvedValue(policy) })

  it('allow decisions never touch the database (no transaction opened)', async () => {
    const result = await checkRiskGate({
      action: 'seller_payout_mark_paid', context: { payoutId: 'p1', totalAmountCents: 1000 },
      targetType: 'seller_payout', targetId: 'p1', requestedBy: 'admin',
    })
    expect(result).toEqual({ decision: 'allow' })
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('deny decisions never create an approval request (section 29)', async () => {
    const result = await checkRiskGate({
      action: 'item_catalog_reassignment',
      context: { itemId: 'i1', oldCatalogModelId: 'c1', newCatalogModelId: 'c2', hasCompletedSale: true, completedSaleAmountCents: 100 },
      targetType: 'item_instance', targetId: 'i1', requestedBy: 'admin',
    })
    expect(result.decision).toBe('deny')
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('require_approval creates a durable pending row', async () => {
    const { tx, store } = makeStore()
    mockTransaction(tx)
    const result = await checkRiskGate({
      action: 'seller_payout_mark_paid', context: { payoutId: 'p1', totalAmountCents: 150_000 },
      targetType: 'seller_payout', targetId: 'p1', requestedBy: 'admin',
    })
    expect(result.decision).toBe('pending')
    expect(store.size).toBe(1)
    const row = [...store.values()][0]
    expect(row.status).toBe('pending')
    expect(row.policyVersion).toBe(3)
  })

  it('a duplicate request for the exact same action/target/context is deduped to the existing pending row (section 27)', async () => {
    const context = { payoutId: 'p1', totalAmountCents: 150_000 }
    const { tx: tx1, store } = makeStore()
    mockTransaction(tx1)
    const first = await checkRiskGate({ action: 'seller_payout_mark_paid', context, targetType: 'seller_payout', targetId: 'p1', requestedBy: 'admin' })
    if (first.decision !== 'pending') throw new Error('unreachable')

    // second call shares the SAME underlying store (simulating the row already committed)
    const { tx: tx2 } = makeStore([store.get(first.approvalRequestId) as never])
    mockTransaction(tx2)
    const second = await checkRiskGate({ action: 'seller_payout_mark_paid', context, targetType: 'seller_payout', targetId: 'p1', requestedBy: 'admin' })
    expect(second.decision).toBe('pending')
    if (second.decision !== 'pending') throw new Error('unreachable')
    expect(second.approvalRequestId).toBe(first.approvalRequestId)
    expect(tx2.riskApprovalRequest.create).not.toHaveBeenCalled()
  })

  it('finds and reuses an existing APPROVED unexpired request for the identical fingerprint', async () => {
    const { tx: txCreate, store } = makeStore()
    mockTransaction(txCreate)
    const created = await checkRiskGate({ action: 'seller_payout_mark_paid', context: { payoutId: 'p1', totalAmountCents: 150_000 }, targetType: 'seller_payout', targetId: 'p1', requestedBy: 'admin' })
    if (created.decision !== 'pending') throw new Error('unreachable')
    const row = store.get(created.approvalRequestId)!
    row.status = 'approved'
    row.approvedAt = new Date()

    const { tx: txReuse } = makeStore([row as never])
    mockTransaction(txReuse)
    const reused = await checkRiskGate({ action: 'seller_payout_mark_paid', context: { payoutId: 'p1', totalAmountCents: 150_000 }, targetType: 'seller_payout', targetId: 'p1', requestedBy: 'admin' })
    expect(reused).toEqual({ decision: 'consume_approved', approvalRequestId: created.approvalRequestId })
  })

  it('an expired approved request is NOT reused — falls through to a fresh pending request', async () => {
    const { tx: txCreate, store } = makeStore()
    mockTransaction(txCreate)
    const created = await checkRiskGate({ action: 'seller_payout_mark_paid', context: { payoutId: 'p1', totalAmountCents: 150_000 }, targetType: 'seller_payout', targetId: 'p1', requestedBy: 'admin' })
    if (created.decision !== 'pending') throw new Error('unreachable')
    const row = store.get(created.approvalRequestId)!
    row.status = 'approved'
    row.expiresAt = new Date('2020-01-01')

    const { tx: txExpired } = makeStore([row as never])
    mockTransaction(txExpired)
    const result = await checkRiskGate({ action: 'seller_payout_mark_paid', context: { payoutId: 'p1', totalAmountCents: 150_000 }, targetType: 'seller_payout', targetId: 'p1', requestedBy: 'admin' })
    expect(result.decision).toBe('pending')
  })
})

describe('consumeApprovedRiskGate + markApprovalConsumed (section 16/17/19)', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('a valid, matching, unexpired approval passes verification', async () => {
    const { tx } = makeStore([{ id: 'a1', status: 'approved', expiresAt: null, contextFingerprint: 'fp' }])
    const context = { foo: 'bar' }
    // Force the stored fingerprint to match what consumeApprovedRiskGate recomputes.
    const { computeContextFingerprint } = await import('@/lib/riskPolicy')
    const fp = computeContextFingerprint('item_catalog_reassignment', 'i1', context)
    ;(tx.riskApprovalRequest.findUnique as Mock).mockResolvedValueOnce({ id: 'a1', status: 'approved', expiresAt: null, contextFingerprint: fp })
    const result = await consumeApprovedRiskGate(tx, { approvalRequestId: 'a1', action: 'item_catalog_reassignment', targetId: 'i1', context })
    expect(result).toEqual({ ok: true })
  })

  it('rejects when the approval is not in approved status', async () => {
    const { tx } = makeStore()
    ;(tx.riskApprovalRequest.findUnique as Mock).mockResolvedValueOnce({ id: 'a1', status: 'rejected', expiresAt: null, contextFingerprint: 'fp' })
    const result = await consumeApprovedRiskGate(tx, { approvalRequestId: 'a1', action: 'x', targetId: 'y', context: {} })
    expect(result.ok).toBe(false)
  })

  it('rejects and expires an approval past its expiresAt', async () => {
    const { tx } = makeStore()
    ;(tx.riskApprovalRequest.findUnique as Mock).mockResolvedValueOnce({ id: 'a1', status: 'approved', expiresAt: new Date('2020-01-01'), contextFingerprint: 'fp' })
    const result = await consumeApprovedRiskGate(tx, { approvalRequestId: 'a1', action: 'x', targetId: 'y', context: {} })
    expect(result.ok).toBe(false)
    expect(tx.riskApprovalRequest.update).toHaveBeenCalledWith({ where: { id: 'a1' }, data: { status: 'expired' } })
  })

  it('rejects when the current context no longer matches the approved fingerprint — a changed proposal requires a new approval (section 17/28)', async () => {
    const { tx } = makeStore()
    ;(tx.riskApprovalRequest.findUnique as Mock).mockResolvedValueOnce({ id: 'a1', status: 'approved', expiresAt: null, contextFingerprint: 'stale-fingerprint' })
    const result = await consumeApprovedRiskGate(tx, { approvalRequestId: 'a1', action: 'x', targetId: 'y', context: { changed: true } })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toMatch(/no longer matches/)
  })

  it('markApprovalConsumed flips status exactly once — a second consumption attempt fails (section 19)', async () => {
    const { tx } = makeStore([{ id: 'a1', status: 'approved' }])
    await markApprovalConsumed(tx, 'a1')
    expect(tx.riskApprovalRequest.updateMany).toHaveBeenCalledWith({ where: { id: 'a1', status: 'approved' }, data: expect.objectContaining({ status: 'consumed' }) })
    await expect(markApprovalConsumed(tx, 'a1')).rejects.toThrow()
  })
})

describe('approveRiskApprovalRequest / rejectRiskApprovalRequest / cancelRiskApprovalRequest (section 22/23/32)', () => {
  beforeEach(() => { vi.resetAllMocks(); defaultAdminAuth() })

  it('approving a HIGH risk request requires a decision note', async () => {
    const { tx } = makeStore([{ id: 'a1', status: 'pending', riskLevel: 'high', action: 'seller_payout_mark_paid' }])
    mockTransaction(tx)
    const fd = new FormData()
    const result = await approveRiskApprovalRequest('a1', null, fd)
    expect(result?.errors?.decisionNote).toBeTruthy()
  })

  it('approving with a note succeeds and records approvedBy honestly as "admin" (section 23 — no fabricated identity)', async () => {
    const { tx, store } = makeStore([{ id: 'a1', status: 'pending', riskLevel: 'high', action: 'seller_payout_mark_paid' }])
    mockTransaction(tx)
    const fd = new FormData()
    fd.set('decisionNote', 'Reviewed and confirmed with seller.')
    const result = await approveRiskApprovalRequest('a1', null, fd)
    expect(result).toBeNull()
    expect(store.get('a1')?.status).toBe('approved')
    expect(store.get('a1')?.approvedBy).toBe('admin')
  })

  it('a request that is not pending cannot be approved a second time', async () => {
    const { tx } = makeStore([{ id: 'a1', status: 'approved', riskLevel: 'medium', action: 'seller_commission_override' }])
    mockTransaction(tx)
    const fd = new FormData()
    const result = await approveRiskApprovalRequest('a1', null, fd)
    expect(result?.errors?._form?.[0]).toMatch(/already approved/)
  })

  it('rejecting always requires a decision note', async () => {
    const fd = new FormData()
    const result = await rejectRiskApprovalRequest('a1', null, fd)
    expect(result?.errors?.decisionNote).toBeTruthy()
  })

  it('rejecting with a note succeeds', async () => {
    const { tx, store } = makeStore([{ id: 'a1', status: 'pending', riskLevel: 'medium', action: 'listing_price_change' }])
    mockTransaction(tx)
    const fd = new FormData()
    fd.set('decisionNote', 'Price looks wrong, please recheck 14C guidance.')
    const result = await rejectRiskApprovalRequest('a1', null, fd)
    expect(result).toBeNull()
    expect(store.get('a1')?.status).toBe('rejected')
  })

  it('admin authentication is required for approve/reject/cancel', async () => {
    ;(isAdminAuthenticated as Mock).mockResolvedValueOnce(false)
    const result = await approveRiskApprovalRequest('a1', null, new FormData())
    expect(result?.errors?._form).toBeTruthy()
  })

  it('cancel only works on pending or approved requests', async () => {
    ;(prisma.riskApprovalRequest.updateMany as Mock).mockResolvedValueOnce({ count: 0 })
    const result = await cancelRiskApprovalRequest('a1', null, new FormData())
    expect(result?.errors?._form).toBeTruthy()
  })
})
