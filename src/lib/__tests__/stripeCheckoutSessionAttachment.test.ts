// 39B follow-up: session-creation-vs-cron-release race coverage for
// src/lib/actions/stripe.ts's createAndSendStripeCheckoutSession. Creating
// the Stripe Checkout Session (external API call) and attaching it to the
// Order in the DB are NOT one atomic operation — between them, the
// reservation-release cron can release this Order's pre-session reservation.
// attachStripeSession (src/lib/orderReservation.ts) is the guard; these tests
// verify the ACTION correctly reacts when that guard reports the race was lost.
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({
  prisma: { order: { findUnique: vi.fn() } },
}))
vi.mock('@/lib/stripe', () => ({ getStripe: vi.fn() }))
vi.mock('@/lib/orderReservation', () => ({
  computeInitialReservationExpiry: vi.fn(() => new Date('2026-01-01T00:30:00.000Z')),
  attachStripeSession: vi.fn(),
}))
vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(() => ({ emails: { send: vi.fn().mockResolvedValue({ error: null }) } })),
}))
vi.mock('@/lib/email/paymentLinkEmail', () => ({
  buildPaymentLinkEmail: vi.fn(() => ({ subject: 's', html: 'h', text: 't' })),
}))
vi.mock('next/navigation', () => ({ redirect: vi.fn(() => { throw new Error('REDIRECT') }) }))

import { prisma } from '@/lib/prisma'
import { getStripe } from '@/lib/stripe'
import { attachStripeSession } from '@/lib/orderReservation'
import { Resend } from 'resend'
import { buildPaymentLinkEmail } from '@/lib/email/paymentLinkEmail'
import { createAndSendStripeCheckoutSession } from '@/lib/actions/stripe'

function orderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order1',
    buyerName: 'Jane Buyer',
    buyerEmail: 'jane@example.com',
    status: 'pending',
    paymentStatus: 'unpaid',
    estimatedShipping: 5,
    stripeSessionId: null,
    orderItems: [{ itemId: 'item1', price: 20, listing: { title: 'Item One' } }],
    ...overrides,
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  process.env.STRIPE_SECRET_KEY = 'sk_test'
  process.env.RESEND_API_KEY = 're_test'
  process.env.ORDER_DIGEST_FROM_EMAIL = 'orders@example.com'
  process.env.APP_URL = 'https://example.com'
  // resetAllMocks() wipes factory-level mockImplementation too — restore the
  // email-sending stubs so the fire-and-forget email step doesn't throw and
  // add unrelated noise to test output.
  ;(Resend as unknown as Mock).mockImplementation(() => ({ emails: { send: vi.fn().mockResolvedValue({ error: null }) } }))
  ;(buildPaymentLinkEmail as Mock).mockReturnValue({ subject: 's', html: 'h', text: 't' })
})

describe('A. successful attachment (no race)', () => {
  it('creates the session, attaches it, and redirects on success', async () => {
    ;(prisma.order.findUnique as Mock).mockResolvedValue(orderRow())
    const sessionsCreate = vi.fn().mockResolvedValue({ id: 'sess1', url: 'https://pay.example/sess1' })
    const sessionsExpire = vi.fn()
    ;(getStripe as Mock).mockReturnValue({ checkout: { sessions: { create: sessionsCreate, expire: sessionsExpire } } })
    ;(attachStripeSession as Mock).mockResolvedValue('attached')

    await expect(createAndSendStripeCheckoutSession('order1', null, new FormData())).rejects.toThrow('REDIRECT')

    expect(attachStripeSession).toHaveBeenCalledWith('order1', ['item1'], expect.objectContaining({ stripeSessionId: 'sess1', paymentLink: 'https://pay.example/sess1' }))
    expect(sessionsExpire).not.toHaveBeenCalled()
  })
})

describe('B. session creation loses the race with the cron release', () => {
  it('expires the orphaned Stripe session and returns an error — never returns/sends the session URL', async () => {
    ;(prisma.order.findUnique as Mock).mockResolvedValue(orderRow())
    const sessionsCreate = vi.fn().mockResolvedValue({ id: 'sess1', url: 'https://pay.example/sess1' })
    const sessionsExpire = vi.fn().mockResolvedValue({ id: 'sess1', status: 'expired' })
    ;(getStripe as Mock).mockReturnValue({ checkout: { sessions: { create: sessionsCreate, expire: sessionsExpire } } })
    ;(attachStripeSession as Mock).mockResolvedValue('reservation_lost')

    const result = await createAndSendStripeCheckoutSession('order1', null, new FormData())

    expect(result).toEqual({
      errors: {
        form: ['This order\'s reservation expired before the payment link could be created. Please start a new checkout for this order.'],
      },
    })
    expect(sessionsExpire).toHaveBeenCalledWith('sess1')
  })

  it('does not throw / redirect when the race is lost — the admin sees the error, not a broken redirect', async () => {
    ;(prisma.order.findUnique as Mock).mockResolvedValue(orderRow())
    const sessionsCreate = vi.fn().mockResolvedValue({ id: 'sess1', url: 'https://pay.example/sess1' })
    ;(getStripe as Mock).mockReturnValue({ checkout: { sessions: { create: sessionsCreate, expire: vi.fn() } } })
    ;(attachStripeSession as Mock).mockResolvedValue('reservation_lost')

    await expect(createAndSendStripeCheckoutSession('order1', null, new FormData())).resolves.not.toThrow()
  })

  it('a failure to expire the orphaned session in Stripe is tolerated (best-effort) — still returns the same error', async () => {
    ;(prisma.order.findUnique as Mock).mockResolvedValue(orderRow())
    const sessionsCreate = vi.fn().mockResolvedValue({ id: 'sess1', url: 'https://pay.example/sess1' })
    const sessionsExpire = vi.fn().mockRejectedValue(new Error('already expired'))
    ;(getStripe as Mock).mockReturnValue({ checkout: { sessions: { create: sessionsCreate, expire: sessionsExpire } } })
    ;(attachStripeSession as Mock).mockResolvedValue('reservation_lost')

    const result = await createAndSendStripeCheckoutSession('order1', null, new FormData())

    expect(result).toEqual({
      errors: { form: ['This order\'s reservation expired before the payment link could be created. Please start a new checkout for this order.'] },
    })
  })
})

describe('C. pre-existing guards are unaffected by the attachment change', () => {
  it('still rejects when a payment link already exists', async () => {
    ;(prisma.order.findUnique as Mock).mockResolvedValue(orderRow({ stripeSessionId: 'existing-sess' }))

    const result = await createAndSendStripeCheckoutSession('order1', null, new FormData())

    expect(result).toEqual({ errors: { form: ['A payment link already exists. Expire it before generating a new one.'] } })
    expect(attachStripeSession).not.toHaveBeenCalled()
  })

  it('still rejects a completed/cancelled order before ever calling Stripe', async () => {
    ;(prisma.order.findUnique as Mock).mockResolvedValue(orderRow({ status: 'cancelled' }))

    const result = await createAndSendStripeCheckoutSession('order1', null, new FormData())

    expect(result).toEqual({ errors: { form: ['Cannot send a payment link for a completed or cancelled order.'] } })
    expect(attachStripeSession).not.toHaveBeenCalled()
  })
})
