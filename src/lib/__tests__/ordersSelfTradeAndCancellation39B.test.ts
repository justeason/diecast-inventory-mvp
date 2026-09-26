// 39B (+ follow-up correction): self-trade hard block (createOrder) and
// paid-order cancellation guard (updateOrderStatus) — both in
// src/lib/actions/orders.ts.
//
// CORRECTED DESIGN: self-trade now checks ONLY the cryptographically verified
// buyer session (getBuyerSession(), backed by CustomerSession — established
// via a consumed magic-link token or a correct password) — never the
// email-upserted CustomerProfile.id, which a guest can spoof by simply
// typing any email, including a real consignor's.
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({
  prisma: {
    listing: { findMany: vi.fn() },
    customerProfile: { upsert: vi.fn() },
    order: { findUnique: vi.fn() },
    orderItem: { findMany: vi.fn() },
    $transaction: vi.fn(),
  },
}))
vi.mock('@/lib/stripe', () => ({ getStripe: vi.fn(() => ({ checkout: { sessions: { expire: vi.fn() } } })) }))
vi.mock('@/lib/buyerSession', () => ({ getBuyerSession: vi.fn() }))
vi.mock('@/lib/actions/sellerPayouts', () => ({ ensureConsignmentPayoutLinesForCompletedOrder: vi.fn() }))
vi.mock('@/lib/actions/sellerLifecycle', () => ({ ensureSellerLifecycleEvent: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: vi.fn(() => { throw new Error('REDIRECT') }) }))

import { prisma } from '@/lib/prisma'
import { getBuyerSession } from '@/lib/buyerSession'
import { createOrder, updateOrderStatus } from '@/lib/actions/orders'

function listingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'listing1',
    itemId: 'item1',
    price: 10,
    item: {
      catalogId: 'cat1', marketVariantId: 'variant1', cardedOrLoose: 'carded', condition: 'mint',
      sellerAgreement: null,
      ...(overrides.item as Record<string, unknown> ?? {}),
    },
    ...overrides,
  }
}

function makeTx(overrides: Record<string, unknown> = {}) {
  return {
    order: { create: vi.fn().mockResolvedValue({ id: 'order1' }) },
    orderItem: { create: vi.fn().mockResolvedValue({}) },
    itemInstance: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    ...overrides,
  }
}

function mockTransaction(tx: ReturnType<typeof makeTx>) {
  ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(tx))
}

function singleItemFormData(email = 'jane@example.com'): FormData {
  const fd = new FormData()
  fd.set('listingIds', 'listing1')
  fd.set('buyerName', 'Jane Buyer')
  fd.set('buyerEmail', email)
  return fd
}

function twoItemFormData(): FormData {
  const fd = new FormData()
  fd.append('listingIds', 'listing1')
  fd.append('listingIds', 'listing2')
  fd.set('buyerName', 'Jane Buyer')
  fd.set('buyerEmail', 'jane@example.com')
  return fd
}

beforeEach(() => {
  vi.resetAllMocks()
  ;(prisma.customerProfile.upsert as Mock).mockResolvedValue({ id: 'prof1' })
  ;(getBuyerSession as Mock).mockResolvedValue(null) // default: guest, no verified session
})

describe('A. self-trade hard block — authenticated buyer (verified session)', () => {
  it('blocks an authenticated buyer purchasing their own consigned item', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'seller-prof' })
    ;(prisma.listing.findMany as Mock).mockResolvedValue([
      listingRow({ item: { sellerAgreement: { sellerProfile: { profileId: 'seller-prof' } } } }),
    ])

    const result = await createOrder(null, singleItemFormData())

    expect(result).toEqual({
      errors: { form: ['You cannot purchase an item you consigned. Please remove it from your cart and try again.'] },
    })
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('allows an authenticated, unrelated buyer whose session profileId does not match the consignor', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'buyer-prof' })
    ;(prisma.listing.findMany as Mock).mockResolvedValue([
      listingRow({ item: { sellerAgreement: { sellerProfile: { profileId: 'someone-else' } } } }),
    ])
    const tx = makeTx()
    mockTransaction(tx)

    await expect(createOrder(null, singleItemFormData())).resolves.toEqual({ success: true, orderId: 'order1' })
  })

  it('allows company-owned inventory (no sellerAgreement) even for an authenticated buyer', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'buyer-prof' })
    ;(prisma.listing.findMany as Mock).mockResolvedValue([listingRow({ item: { sellerAgreement: null } })])
    const tx = makeTx()
    mockTransaction(tx)

    await expect(createOrder(null, singleItemFormData())).resolves.toEqual({ success: true, orderId: 'order1' })
  })

  it('allows a consigned item whose sellerAgreement has no linked SellerProfile (chain broken — no determinable consignor)', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'buyer-prof' })
    ;(prisma.listing.findMany as Mock).mockResolvedValue([
      listingRow({ item: { sellerAgreement: { sellerProfile: null } } }),
    ])
    const tx = makeTx()
    mockTransaction(tx)

    await expect(createOrder(null, singleItemFormData())).resolves.toEqual({ success: true, orderId: 'order1' })
  })

  it('checks ALL cart items for an authenticated buyer — blocks on a match anywhere in a mixed cart, zero reservations attempted', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'seller-prof' })
    ;(prisma.listing.findMany as Mock).mockResolvedValue([
      listingRow({ id: 'listing1', itemId: 'item1', item: { sellerAgreement: null } }),
      listingRow({ id: 'listing2', itemId: 'item2', item: { sellerAgreement: { sellerProfile: { profileId: 'seller-prof' } } } }),
    ])

    const result = await createOrder(null, twoItemFormData())

    expect(result).toEqual({
      errors: { form: ['You cannot purchase an item you consigned. Please remove it from your cart and try again.'] },
    })
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('a blocked self-trade produces no Order and no OrderItems', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'seller-prof' })
    ;(prisma.listing.findMany as Mock).mockResolvedValue([
      listingRow({ item: { sellerAgreement: { sellerProfile: { profileId: 'seller-prof' } } } }),
    ])

    await createOrder(null, singleItemFormData())

    expect(prisma.$transaction).not.toHaveBeenCalled()
  })
})

describe('B. self-trade — guest checkout (no verified session): honest limitation, never spoofable', () => {
  it('a GUEST who types the SAME email as the consignor is NOT blocked — the email-upserted profileId is never used as identity proof', async () => {
    // The upsert resolves to the exact same CustomerProfile.id the consignor's
    // SellerProfile also points to — proving this test would have falsely
    // "worked" under the old (incorrect) design. It must NOT block here.
    ;(getBuyerSession as Mock).mockResolvedValue(null)
    ;(prisma.customerProfile.upsert as Mock).mockResolvedValue({ id: 'seller-prof' })
    ;(prisma.listing.findMany as Mock).mockResolvedValue([
      listingRow({ item: { sellerAgreement: { sellerProfile: { profileId: 'seller-prof' } } } }),
    ])
    const tx = makeTx()
    mockTransaction(tx)

    await expect(createOrder(null, singleItemFormData('consignor@example.com'))).resolves.toEqual({ success: true, orderId: 'order1' })
  })

  it('a guest purchasing company-owned inventory is unaffected (no session needed, no consignor to match)', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue(null)
    ;(prisma.listing.findMany as Mock).mockResolvedValue([listingRow({ item: { sellerAgreement: null } })])
    const tx = makeTx()
    mockTransaction(tx)

    await expect(createOrder(null, singleItemFormData())).resolves.toEqual({ success: true, orderId: 'order1' })
  })

  it('never calls getBuyerSession-derived logic in a way that blocks on upsert failure — guest checkout still proceeds if the profile upsert fails', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue(null)
    ;(prisma.customerProfile.upsert as Mock).mockRejectedValue(new Error('db unavailable'))
    ;(prisma.listing.findMany as Mock).mockResolvedValue([listingRow({ item: { sellerAgreement: null } })])
    const tx = makeTx()
    mockTransaction(tx)

    await expect(createOrder(null, singleItemFormData())).resolves.toEqual({ success: true, orderId: 'order1' })
  })
})

describe('C. paid-order cancellation guard — updateOrderStatus', () => {
  function cancelFormData(): FormData {
    const fd = new FormData()
    fd.set('status', 'cancelled')
    return fd
  }

  it('rejects cancelling a paid order — no transaction, no stock released, no Stripe session touched', async () => {
    ;(prisma.order.findUnique as Mock).mockResolvedValue({
      status: 'paid', paymentStatus: 'paid', stripeSessionId: null, completedAt: null,
      orderItems: [{ itemId: 'item1', listingId: 'listing1' }],
    })

    const result = await updateOrderStatus('order1', null, cancelFormData())

    expect(result).toEqual({
      errors: {
        form: ['This order has already been paid or completed and cannot be cancelled here. A paid order requires a refund process (not currently supported) before its items can be released.'],
      },
    })
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('rejects cancelling a completed order even if paymentStatus is somehow not "paid"', async () => {
    ;(prisma.order.findUnique as Mock).mockResolvedValue({
      status: 'complete', paymentStatus: 'unpaid', stripeSessionId: null, completedAt: new Date(),
      orderItems: [{ itemId: 'item1', listingId: 'listing1' }],
    })

    const result = await updateOrderStatus('order1', null, cancelFormData())

    expect(result?.errors).toBeDefined()
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('still allows cancelling a pending/unpaid order, and clears the Stripe session fields so a late payment can never re-match this order', async () => {
    ;(prisma.order.findUnique as Mock).mockResolvedValue({
      status: 'pending', paymentStatus: 'unpaid', stripeSessionId: 'sess1', completedAt: null,
      orderItems: [{ itemId: 'item1', listingId: 'listing1' }],
    })
    const orderUpdate = vi.fn()
    ;(prisma.$transaction as Mock).mockImplementation(async (cb: (tx: unknown) => unknown) =>
      cb({ order: { update: orderUpdate }, itemInstance: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) } }),
    )

    await expect(updateOrderStatus('order1', null, cancelFormData())).rejects.toThrow('REDIRECT')

    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(orderUpdate).toHaveBeenCalledWith({
      where: { id: 'order1' },
      data: {
        status: 'cancelled',
        stripeSessionId: null,
        stripeSessionExpiresAt: null,
        reservationExpiresAt: null,
        paymentLink: null,
      },
    })
  })
})
