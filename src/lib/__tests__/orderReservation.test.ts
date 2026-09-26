// 39B (+ two follow-up correction rounds): reservation-expiry, safe-release,
// session-attachment, and unified paid-verification behavioral coverage for
// src/lib/orderReservation.ts — the shared module used by the cron, the
// Stripe webhook, and createAndSendStripeCheckoutSession.
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({
  prisma: {
    order: { findMany: vi.fn(), findFirst: vi.fn() },
    $transaction: vi.fn(),
  },
}))
vi.mock('@/lib/stripe', () => ({ getStripe: vi.fn() }))
vi.mock('@/lib/serverLogger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { prisma } from '@/lib/prisma'
import { getStripe } from '@/lib/stripe'
import { logger } from '@/lib/serverLogger'
import {
  RESERVATION_INITIAL_MINUTES,
  EXPECTED_CURRENCY,
  computeInitialReservationExpiry,
  computeExpectedOrderAmountCents,
  releaseExpiredReservations,
  releaseOnConfirmedNonPayment,
  attachStripeSession,
  verifyAndMarkOrderPaid,
} from '@/lib/orderReservation'

function orderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order1',
    status: 'pending',
    paymentStatus: 'unpaid',
    stripeSessionId: null,
    estimatedShipping: 5,
    orderItems: [{ itemId: 'item1', price: 10 }],
    ...overrides,
  }
}

function txStub(overrides: Record<string, unknown> = {}) {
  return {
    order: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    itemInstance: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      count: vi.fn().mockResolvedValue(1),
    },
    ...overrides,
  }
}

function mockTransactionOnce(tx: ReturnType<typeof txStub>) {
  ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(tx))
}
function mockTransactionAlways(tx: ReturnType<typeof txStub>) {
  ;(prisma.$transaction as Mock).mockImplementation(async (cb: (tx: unknown) => unknown) => cb(tx))
}

beforeEach(() => {
  vi.resetAllMocks()
})

describe('A. computeInitialReservationExpiry — 30-minute deadline', () => {
  it('is exactly RESERVATION_INITIAL_MINUTES (30) minutes from the given time', () => {
    expect(RESERVATION_INITIAL_MINUTES).toBe(30)
    const now = new Date('2026-01-01T00:00:00.000Z')
    const expiry = computeInitialReservationExpiry(now)
    expect(expiry.getTime() - now.getTime()).toBe(30 * 60 * 1000)
  })
})

describe('B. computeExpectedOrderAmountCents — canonical integer-cents, independent of any client input', () => {
  it('sums OrderItem prices plus shipping, converted to integer cents', () => {
    const cents = computeExpectedOrderAmountCents({
      estimatedShipping: 5.5,
      orderItems: [{ price: 10 }, { price: 19.99 }],
    })
    expect(cents).toBe(1000 + 1999 + 550)
  })

  it('treats a null estimatedShipping as zero shipping', () => {
    const cents = computeExpectedOrderAmountCents({ estimatedShipping: null, orderItems: [{ price: 10 }] })
    expect(cents).toBe(1000)
  })
})

describe('C. releaseExpiredReservations — pre-session release (no Stripe session attached)', () => {
  it('releases a pending/unpaid, deadline-past, session-less order via a guarded transaction', async () => {
    ;(prisma.order.findMany as Mock).mockResolvedValue([orderRow()])
    const tx = txStub()
    mockTransactionOnce(tx)

    const result = await releaseExpiredReservations()

    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order1', status: 'pending', paymentStatus: { in: ['unpaid', 'requested'] }, stripeSessionId: null },
      data: expect.objectContaining({ stripeSessionId: null, reservationExpiresAt: null, paymentStatus: 'unpaid' }),
    })
    expect(tx.itemInstance.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['item1'] }, status: 'reserved' },
      data: { status: 'available' },
    })
    expect(result).toEqual({ checked: 1, released: 1, retained: 0, reconciledPaid: 0 })
    expect(getStripe).not.toHaveBeenCalled()
  })

  it('no-ops when the guarded updateMany finds the order already changed', async () => {
    ;(prisma.order.findMany as Mock).mockResolvedValue([orderRow()])
    const tx = txStub({ order: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) } })
    mockTransactionOnce(tx)

    const result = await releaseExpiredReservations()

    expect(tx.itemInstance.updateMany).not.toHaveBeenCalled()
    expect(result).toEqual({ checked: 1, released: 0, retained: 1, reconciledPaid: 0 })
  })

  it('releases every item across a multi-item order atomically (single guarded transaction)', async () => {
    ;(prisma.order.findMany as Mock).mockResolvedValue([
      orderRow({ orderItems: [{ itemId: 'item1', price: 10 }, { itemId: 'item2', price: 20 }] }),
    ])
    const tx = txStub()
    mockTransactionOnce(tx)

    await releaseExpiredReservations()

    expect(tx.itemInstance.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['item1', 'item2'] }, status: 'reserved' },
      data: { status: 'available' },
    })
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
  })
})

describe('D. releaseExpiredReservations — active-session release (Stripe reconciliation required first)', () => {
  it('releases when the session is conclusively expired and non-payable', async () => {
    ;(prisma.order.findMany as Mock).mockResolvedValue([orderRow({ stripeSessionId: 'sess1' })])
    const retrieve = vi.fn().mockResolvedValue({ status: 'expired', payment_status: 'unpaid' })
    ;(getStripe as Mock).mockReturnValue({ checkout: { sessions: { retrieve, expire: vi.fn() } } })
    const tx = txStub()
    mockTransactionOnce(tx)

    const result = await releaseExpiredReservations()

    expect(retrieve).toHaveBeenCalledWith('sess1')
    expect(result.released).toBe(1)
  })

  it('an OPEN (still payable) session is expired first, then released only if still not paid', async () => {
    ;(prisma.order.findMany as Mock).mockResolvedValue([orderRow({ stripeSessionId: 'sess1' })])
    const retrieve = vi.fn().mockResolvedValue({ status: 'open', payment_status: 'unpaid' })
    const expire = vi.fn().mockResolvedValue({ status: 'expired', payment_status: 'unpaid' })
    ;(getStripe as Mock).mockReturnValue({ checkout: { sessions: { retrieve, expire } } })
    const tx = txStub()
    mockTransactionOnce(tx)

    const result = await releaseExpiredReservations()

    expect(expire).toHaveBeenCalledWith('sess1')
    expect(result.released).toBe(1)
  })

  it('a PAID (payment_status:"paid") session is never released — reconciled as a paid order instead (verified path)', async () => {
    ;(prisma.order.findMany as Mock).mockResolvedValue([orderRow({ stripeSessionId: 'sess1' })])
    const retrieve = vi.fn().mockResolvedValue({
      status: 'complete', payment_status: 'paid', payment_intent: 'pi_1', amount_total: 1500, currency: 'usd',
    })
    ;(getStripe as Mock).mockReturnValue({ checkout: { sessions: { retrieve, expire: vi.fn() } } })
    ;(prisma.order.findFirst as Mock).mockResolvedValue(orderRow({ stripeSessionId: 'sess1' }))
    const tx = txStub()
    mockTransactionAlways(tx)

    const result = await releaseExpiredReservations()

    expect(tx.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ paymentStatus: 'paid' }) }),
    )
    expect(result).toEqual({ checked: 1, released: 0, retained: 0, reconciledPaid: 1 })
  })

  it('a NO_PAYMENT_REQUIRED session does NOT mark paid — this app never creates zero-value sessions, so that state does not prove funds received', async () => {
    ;(prisma.order.findMany as Mock).mockResolvedValue([orderRow({ stripeSessionId: 'sess1' })])
    // no_payment_required sessions have no PaymentIntent — the ambiguous
    // 'complete' branch's paymentIntentId-null guard retains conservatively.
    const retrieve = vi.fn().mockResolvedValue({
      status: 'complete', payment_status: 'no_payment_required', payment_intent: null, amount_total: 1500, currency: 'usd',
    })
    ;(getStripe as Mock).mockReturnValue({ checkout: { sessions: { retrieve, expire: vi.fn() } } })

    const result = await releaseExpiredReservations()

    expect(prisma.order.findFirst).not.toHaveBeenCalled() // verifyAndMarkOrderPaid never invoked
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(result).toEqual({ checked: 1, released: 0, retained: 1, reconciledPaid: 0 })
  })

  describe('D2. status:"complete" + payment_status not "paid" — PaymentIntent inspection (webhook-delivery backstop)', () => {
    it('a still-processing PaymentIntent means genuinely pending — retained, never released', async () => {
      ;(prisma.order.findMany as Mock).mockResolvedValue([orderRow({ stripeSessionId: 'sess1' })])
      const retrieve = vi.fn().mockResolvedValue({ status: 'complete', payment_status: 'unpaid', payment_intent: 'pi_1' })
      const piRetrieve = vi.fn().mockResolvedValue({ status: 'processing' })
      ;(getStripe as Mock).mockReturnValue({ checkout: { sessions: { retrieve, expire: vi.fn() } }, paymentIntents: { retrieve: piRetrieve } })

      const result = await releaseExpiredReservations()

      expect(piRetrieve).toHaveBeenCalledWith('pi_1')
      expect(prisma.$transaction).not.toHaveBeenCalled()
      expect(result).toEqual({ checked: 1, released: 0, retained: 1, reconciledPaid: 0 })
    })

    it('a PaymentIntent that succeeded triggers a FRESH session re-retrieve; only if THAT now reports paid is the real shared transition run (never a synthesized payment_status)', async () => {
      ;(prisma.order.findMany as Mock).mockResolvedValue([orderRow({ stripeSessionId: 'sess1' })])
      const retrieve = vi.fn()
        .mockResolvedValueOnce({ status: 'complete', payment_status: 'unpaid', payment_intent: 'pi_1', amount_total: 1500, currency: 'usd' })
        .mockResolvedValueOnce({ status: 'complete', payment_status: 'paid', payment_intent: 'pi_1', amount_total: 1500, currency: 'usd' })
      const piRetrieve = vi.fn().mockResolvedValue({ status: 'succeeded' })
      ;(getStripe as Mock).mockReturnValue({ checkout: { sessions: { retrieve, expire: vi.fn() } }, paymentIntents: { retrieve: piRetrieve } })
      ;(prisma.order.findFirst as Mock).mockResolvedValue(orderRow({ stripeSessionId: 'sess1' }))
      const tx = txStub()
      mockTransactionAlways(tx)

      const result = await releaseExpiredReservations()

      expect(retrieve).toHaveBeenCalledTimes(2)
      expect(result.reconciledPaid).toBe(1)
    })

    it('regression: PaymentIntent "succeeded" but the RE-RETRIEVED session still reports unpaid — a genuine provider-state discrepancy, never released, never marked paid, never falsely reported as successful reconciliation', async () => {
      ;(prisma.order.findMany as Mock).mockResolvedValue([orderRow({ stripeSessionId: 'sess1' })])
      // Both the initial retrieve AND the follow-up re-retrieve report the
      // SAME inconsistent state: Session says unpaid, PaymentIntent says
      // succeeded. This must never be treated as a resolved outcome.
      const retrieve = vi.fn().mockResolvedValue({
        status: 'complete', payment_status: 'unpaid', payment_intent: 'pi_1', amount_total: 1500, currency: 'usd',
      })
      const piRetrieve = vi.fn().mockResolvedValue({ status: 'succeeded' })
      ;(getStripe as Mock).mockReturnValue({ checkout: { sessions: { retrieve, expire: vi.fn() } }, paymentIntents: { retrieve: piRetrieve } })

      const result = await releaseExpiredReservations()

      expect(retrieve).toHaveBeenCalledTimes(2)
      expect(prisma.order.findFirst).not.toHaveBeenCalled() // verifyAndMarkOrderPaid never invoked
      expect(prisma.$transaction).not.toHaveBeenCalled() // never released either
      expect(result).toEqual({ checked: 1, released: 0, retained: 1, reconciledPaid: 0 })
      expect(logger.warn).toHaveBeenCalledWith('orders.reservation.sessionPaymentIntentMismatch', {
        orderId: 'order1', sessionId: 'sess1', sessionPaymentStatus: 'unpaid', paymentIntentStatus: 'succeeded',
      })
    })

    it('a PaymentIntent in "requires_payment_method" (confirmed failed async attempt) is released — never leaves inventory reserved forever', async () => {
      ;(prisma.order.findMany as Mock).mockResolvedValue([orderRow({ stripeSessionId: 'sess1' })])
      const retrieve = vi.fn().mockResolvedValue({ status: 'complete', payment_status: 'unpaid', payment_intent: 'pi_1' })
      const piRetrieve = vi.fn().mockResolvedValue({ status: 'requires_payment_method' })
      ;(getStripe as Mock).mockReturnValue({ checkout: { sessions: { retrieve, expire: vi.fn() } }, paymentIntents: { retrieve: piRetrieve } })
      const tx = txStub()
      mockTransactionOnce(tx)

      const result = await releaseExpiredReservations()

      expect(result.released).toBe(1)
    })

    it('a PaymentIntent in "canceled" is also released as a confirmed terminal failure', async () => {
      ;(prisma.order.findMany as Mock).mockResolvedValue([orderRow({ stripeSessionId: 'sess1' })])
      const retrieve = vi.fn().mockResolvedValue({ status: 'complete', payment_status: 'unpaid', payment_intent: 'pi_1' })
      const piRetrieve = vi.fn().mockResolvedValue({ status: 'canceled' })
      ;(getStripe as Mock).mockReturnValue({ checkout: { sessions: { retrieve, expire: vi.fn() } }, paymentIntents: { retrieve: piRetrieve } })
      const tx = txStub()
      mockTransactionOnce(tx)

      const result = await releaseExpiredReservations()

      expect(result.released).toBe(1)
    })

    it('never uses payment_status:"unpaid" alone as proof of terminal failure — no PaymentIntent id present retains conservatively', async () => {
      ;(prisma.order.findMany as Mock).mockResolvedValue([orderRow({ stripeSessionId: 'sess1' })])
      const retrieve = vi.fn().mockResolvedValue({ status: 'complete', payment_status: 'unpaid', payment_intent: null })
      ;(getStripe as Mock).mockReturnValue({ checkout: { sessions: { retrieve, expire: vi.fn() } } })

      const result = await releaseExpiredReservations()

      expect(prisma.$transaction).not.toHaveBeenCalled()
      expect(result.retained).toBe(1)
    })

    it('a PaymentIntent retrieval failure is provider uncertainty — retained, never released', async () => {
      ;(prisma.order.findMany as Mock).mockResolvedValue([orderRow({ stripeSessionId: 'sess1' })])
      const retrieve = vi.fn().mockResolvedValue({ status: 'complete', payment_status: 'unpaid', payment_intent: 'pi_1' })
      const piRetrieve = vi.fn().mockRejectedValue(new Error('network timeout'))
      ;(getStripe as Mock).mockReturnValue({ checkout: { sessions: { retrieve, expire: vi.fn() } }, paymentIntents: { retrieve: piRetrieve } })

      const result = await releaseExpiredReservations()

      expect(prisma.$transaction).not.toHaveBeenCalled()
      expect(result.retained).toBe(1)
    })
  })

  it('an unrecognized/unexpected session status is retained, never released', async () => {
    ;(prisma.order.findMany as Mock).mockResolvedValue([orderRow({ stripeSessionId: 'sess1' })])
    const retrieve = vi.fn().mockResolvedValue({ status: 'processing' as unknown as string, payment_status: 'unpaid' })
    ;(getStripe as Mock).mockReturnValue({ checkout: { sessions: { retrieve, expire: vi.fn() } } })

    const result = await releaseExpiredReservations()

    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(result.retained).toBe(1)
  })

  it('a Stripe API failure on retrieve is treated conservatively — retained, never released, never reconciled', async () => {
    ;(prisma.order.findMany as Mock).mockResolvedValue([orderRow({ stripeSessionId: 'sess1' })])
    const retrieve = vi.fn().mockRejectedValue(new Error('network timeout'))
    ;(getStripe as Mock).mockReturnValue({ checkout: { sessions: { retrieve, expire: vi.fn() } } })

    const result = await releaseExpiredReservations()

    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(result).toEqual({ checked: 1, released: 0, retained: 1, reconciledPaid: 0 })
  })

  it('a Stripe API failure on expire (after an open session) is also treated conservatively — retained', async () => {
    ;(prisma.order.findMany as Mock).mockResolvedValue([orderRow({ stripeSessionId: 'sess1' })])
    const retrieve = vi.fn().mockResolvedValue({ status: 'open', payment_status: 'unpaid' })
    const expire = vi.fn().mockRejectedValue(new Error('network timeout'))
    ;(getStripe as Mock).mockReturnValue({ checkout: { sessions: { retrieve, expire } } })

    const result = await releaseExpiredReservations()

    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(result.retained).toBe(1)
  })
})

describe('E. releaseExpiredReservations — duplicate/overlapping cron run idempotency', () => {
  it('a second run against an already-released order (count=0 on retry) safely no-ops, never double-releases', async () => {
    ;(prisma.order.findMany as Mock).mockResolvedValue([orderRow()])
    const tx = txStub({ order: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) } })
    mockTransactionOnce(tx)

    const result = await releaseExpiredReservations()

    expect(tx.itemInstance.updateMany).not.toHaveBeenCalled()
    expect(result.retained).toBe(1)
  })
})

describe('F. releaseOnConfirmedNonPayment — shared by checkout.session.expired AND checkout.session.async_payment_failed', () => {
  it('releases when the order still matches the expected session id and is unpaid', async () => {
    ;(prisma.order.findFirst as Mock).mockResolvedValue(orderRow({ stripeSessionId: 'sess1' }))
    const tx = txStub()
    mockTransactionOnce(tx)

    const outcome = await releaseOnConfirmedNonPayment('order1', 'sess1')

    expect(outcome).toBe('released')
    expect(tx.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ stripeSessionId: 'sess1' }) }),
    )
  })

  it('a stale/replaced session id (order no longer matches) never releases the current reservation', async () => {
    ;(prisma.order.findFirst as Mock).mockResolvedValue(null)

    const outcome = await releaseOnConfirmedNonPayment('order1', 'sess1-old')

    expect(outcome).toBe('no_op')
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('arriving after payment never reverses payment or releases inventory', async () => {
    ;(prisma.order.findFirst as Mock).mockResolvedValue(orderRow({ stripeSessionId: 'sess1', paymentStatus: 'paid' }))

    const outcome = await releaseOnConfirmedNonPayment('order1', 'sess1')

    expect(outcome).toBe('no_op')
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('a duplicate confirmed-non-payment event for the same session is idempotent', async () => {
    ;(prisma.order.findFirst as Mock)
      .mockResolvedValueOnce(orderRow({ stripeSessionId: 'sess1' }))
      .mockResolvedValueOnce(orderRow({ stripeSessionId: null, paymentStatus: 'unpaid' }))
    const tx = txStub()
    mockTransactionOnce(tx)

    const first = await releaseOnConfirmedNonPayment('order1', 'sess1')
    expect(first).toBe('released')

    const tx2 = txStub({ order: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) } })
    mockTransactionOnce(tx2)
    const second = await releaseOnConfirmedNonPayment('order1', 'sess1')
    expect(second).toBe('no_op')
  })
})

describe('G. attachStripeSession — session-creation-vs-cron-release race + expired pre-session deadline guard', () => {
  it('attaches successfully when the reservation is still intact and the deadline is in the future', async () => {
    const tx = txStub()
    mockTransactionOnce(tx)
    const now = new Date('2026-01-01T00:00:00.000Z')

    const outcome = await attachStripeSession('order1', ['item1'], {
      stripeSessionId: 'sess1', stripeSessionExpiresAt: new Date(), reservationExpiresAt: new Date(),
      paymentLink: 'https://pay', paymentRequestedAt: new Date(),
    }, now)

    expect(outcome).toBe('attached')
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order1', status: 'pending', paymentStatus: 'unpaid', stripeSessionId: null, reservationExpiresAt: { gt: now } },
      data: expect.objectContaining({ stripeSessionId: 'sess1', paymentStatus: 'requested', paymentMethod: 'stripe' }),
    })
  })

  it('reports reservation_lost when the item is no longer reserved (cron released it mid-flight) — never attaches', async () => {
    const tx = txStub({ itemInstance: { count: vi.fn().mockResolvedValue(0), updateMany: vi.fn() } })
    mockTransactionOnce(tx)

    const outcome = await attachStripeSession('order1', ['item1'], {
      stripeSessionId: 'sess1', stripeSessionExpiresAt: new Date(), reservationExpiresAt: new Date(),
      paymentLink: 'https://pay', paymentRequestedAt: new Date(),
    })

    expect(outcome).toBe('reservation_lost')
    expect(tx.order.updateMany).not.toHaveBeenCalled()
  })

  it('reports reservation_lost when the Order guard fails even though items still look reserved (order state changed concurrently)', async () => {
    const tx = txStub({ order: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) } })
    mockTransactionOnce(tx)

    const outcome = await attachStripeSession('order1', ['item1'], {
      stripeSessionId: 'sess1', stripeSessionExpiresAt: new Date(), reservationExpiresAt: new Date(),
      paymentLink: 'https://pay', paymentRequestedAt: new Date(),
    })

    expect(outcome).toBe('reservation_lost')
  })

  it('checks reservation status for every item in a multi-item order', async () => {
    const tx = txStub()
    mockTransactionOnce(tx)

    await attachStripeSession('order1', ['item1', 'item2'], {
      stripeSessionId: 'sess1', stripeSessionExpiresAt: new Date(), reservationExpiresAt: new Date(),
      paymentLink: 'https://pay', paymentRequestedAt: new Date(),
    })

    expect(tx.itemInstance.count).toHaveBeenCalledWith({ where: { id: { in: ['item1', 'item2'] }, status: 'reserved' } })
  })

  it('an expired pre-session deadline rejects attachment — the guard\'s WHERE clause requires reservationExpiresAt strictly greater than now', async () => {
    // count=0 simulates the real DB rejecting the conditional updateMany
    // because reservationExpiresAt is no longer > now — asserted directly
    // below via the exact WHERE clause passed.
    const tx = txStub({ order: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) } })
    mockTransactionOnce(tx)
    const now = new Date('2026-01-01T00:30:00.000Z')

    const outcome = await attachStripeSession('order1', ['item1'], {
      stripeSessionId: 'sess1', stripeSessionExpiresAt: new Date(), reservationExpiresAt: new Date(),
      paymentLink: 'https://pay', paymentRequestedAt: new Date(),
    }, now)

    expect(outcome).toBe('reservation_lost')
    expect(tx.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ reservationExpiresAt: { gt: now } }) }),
    )
  })

  it('passes "now" as a strict gt bound — exactly-at-deadline is expressed as gt, never gte (rejects when reservationExpiresAt === now)', async () => {
    const tx = txStub()
    mockTransactionOnce(tx)
    const now = new Date('2026-01-01T00:30:00.000Z')

    await attachStripeSession('order1', ['item1'], {
      stripeSessionId: 'sess1', stripeSessionExpiresAt: new Date(), reservationExpiresAt: new Date(),
      paymentLink: 'https://pay', paymentRequestedAt: new Date(),
    }, now)

    const call = (tx.order.updateMany as Mock).mock.calls[0][0]
    expect(call.where.reservationExpiresAt).toEqual({ gt: now })
    expect(call.where.reservationExpiresAt).not.toEqual({ gte: now })
  })

  it('defaults "now" to the current time when not passed explicitly', async () => {
    const tx = txStub()
    mockTransactionOnce(tx)
    const before = Date.now()

    await attachStripeSession('order1', ['item1'], {
      stripeSessionId: 'sess1', stripeSessionExpiresAt: new Date(), reservationExpiresAt: new Date(),
      paymentLink: 'https://pay', paymentRequestedAt: new Date(),
    })

    const call = (tx.order.updateMany as Mock).mock.calls[0][0]
    const usedNow = (call.where.reservationExpiresAt as { gt: Date }).gt
    expect(usedNow.getTime()).toBeGreaterThanOrEqual(before)
    expect(usedNow.getTime()).toBeLessThanOrEqual(Date.now())
  })
})

describe('H. verifyAndMarkOrderPaid — the ONE verified path to paid, shared by webhook + cron', () => {
  const sessionFacts = { id: 'sess1', payment_status: 'paid', amount_total: 1500, currency: 'usd', payment_intent: 'pi_1' }

  it('marks paid when payment_status is "paid" and session identity, amount/currency, and reservation state all verify', async () => {
    ;(prisma.order.findFirst as Mock).mockResolvedValue(orderRow({ stripeSessionId: 'sess1' }))
    const tx = txStub()
    mockTransactionOnce(tx)

    const outcome = await verifyAndMarkOrderPaid('order1', sessionFacts)

    expect(outcome).toBe('paid')
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order1', stripeSessionId: 'sess1', paymentStatus: { not: 'paid' }, status: { not: 'cancelled' } },
      data: expect.objectContaining({ paymentStatus: 'paid', stripePaymentIntentId: 'pi_1' }),
    })
  })

  it('EXPECTED_CURRENCY is "usd" — the codebase single-currency invariant', () => {
    expect(EXPECTED_CURRENCY).toBe('usd')
  })

  it('never marks paid when payment_status is "unpaid" — the function is the one authority, not just its callers', async () => {
    const outcome = await verifyAndMarkOrderPaid('order1', { ...sessionFacts, payment_status: 'unpaid' })

    expect(outcome).toBe('not_paid')
    expect(prisma.order.findFirst).not.toHaveBeenCalled()
  })

  it('never marks paid when payment_status is "no_payment_required" — this app has no zero-value checkout feature', async () => {
    const outcome = await verifyAndMarkOrderPaid('order1', { ...sessionFacts, payment_status: 'no_payment_required' })

    expect(outcome).toBe('not_paid')
    expect(prisma.order.findFirst).not.toHaveBeenCalled()
  })

  it('rejects on amount mismatch — never marks paid, logs a structured reconciliation error', async () => {
    ;(prisma.order.findFirst as Mock).mockResolvedValue(orderRow({ stripeSessionId: 'sess1' }))

    const outcome = await verifyAndMarkOrderPaid('order1', { ...sessionFacts, amount_total: 999 })

    expect(outcome).toBe('amount_mismatch')
    expect(prisma.$transaction).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith('orders.payment.amountMismatch', undefined, expect.objectContaining({ orderId: 'order1', expectedCents: 1500, actualCents: 999 }))
  })

  it('rejects on currency mismatch', async () => {
    ;(prisma.order.findFirst as Mock).mockResolvedValue(orderRow({ stripeSessionId: 'sess1' }))

    const outcome = await verifyAndMarkOrderPaid('order1', { ...sessionFacts, currency: 'eur' })

    expect(outcome).toBe('amount_mismatch')
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('rejects on missing amount_total', async () => {
    ;(prisma.order.findFirst as Mock).mockResolvedValue(orderRow({ stripeSessionId: 'sess1' }))

    const outcome = await verifyAndMarkOrderPaid('order1', { ...sessionFacts, amount_total: null })

    expect(outcome).toBe('amount_mismatch')
  })

  it('is idempotent — an already-paid order is a silent no_match, no error logged', async () => {
    ;(prisma.order.findFirst as Mock).mockResolvedValue(orderRow({ stripeSessionId: 'sess1', paymentStatus: 'paid' }))

    const outcome = await verifyAndMarkOrderPaid('order1', sessionFacts)

    expect(outcome).toBe('no_match')
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('a stale/replaced session id is a silent no_match', async () => {
    ;(prisma.order.findFirst as Mock).mockResolvedValue(null)

    const outcome = await verifyAndMarkOrderPaid('order1', sessionFacts)

    expect(outcome).toBe('no_match')
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('never resurrects a cancelled order — the lookup itself excludes status:cancelled', async () => {
    ;(prisma.order.findFirst as Mock).mockResolvedValue(null) // simulates the where:{status:{not:'cancelled'}} finding nothing

    const outcome = await verifyAndMarkOrderPaid('order1', sessionFacts)

    expect(prisma.order.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: { not: 'cancelled' } }) }),
    )
    expect(outcome).toBe('no_match')
  })

  it('a late payment after this order\'s reservation was already released is an exception — never silently marked paid', async () => {
    ;(prisma.order.findFirst as Mock).mockResolvedValue(orderRow({ stripeSessionId: 'sess1' }))
    const tx = txStub({ itemInstance: { count: vi.fn().mockResolvedValue(0), updateMany: vi.fn() } })
    mockTransactionOnce(tx)

    const outcome = await verifyAndMarkOrderPaid('order1', sessionFacts)

    expect(outcome).toBe('reservation_released_exception')
    expect(tx.order.updateMany).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith('orders.payment.paidAfterReservationReleased', undefined, { orderId: 'order1', sessionId: 'sess1' })
  })

  it('checks reservation state for every item in a multi-item order before marking paid', async () => {
    ;(prisma.order.findFirst as Mock).mockResolvedValue(
      orderRow({ stripeSessionId: 'sess1', orderItems: [{ itemId: 'item1', price: 5 }, { itemId: 'item2', price: 10 }] }),
    )
    const tx = txStub()
    mockTransactionOnce(tx)

    await verifyAndMarkOrderPaid('order1', { ...sessionFacts, amount_total: 500 + 1000 + 500 })

    expect(tx.itemInstance.count).toHaveBeenCalledWith({ where: { id: { in: ['item1', 'item2'] }, status: 'reserved' } })
  })
})
