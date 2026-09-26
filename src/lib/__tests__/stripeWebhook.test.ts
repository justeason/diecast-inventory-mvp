// 39B (+ two follow-up correction rounds): behavioral coverage for
// src/app/api/webhooks/stripe/route.ts. Deep amount/currency/reservation/
// payment_status verification logic now lives in the shared
// src/lib/orderReservation.ts (see orderReservation.test.ts, section H, for
// that coverage) — this file focuses on webhook-specific concerns: signature
// verification, event routing (including the two new asynchronous-payment
// event types), the payment_status gate before delegating to the shared
// verified-paid path, and delegation to the shared release path.
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/stripe', () => ({ getStripe: vi.fn() }))
vi.mock('@/lib/serverLogger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/lib/orderReservation', () => ({
  verifyAndMarkOrderPaid: vi.fn().mockResolvedValue('paid'),
  releaseOnConfirmedNonPayment: vi.fn().mockResolvedValue('no_op'),
}))

import { getStripe } from '@/lib/stripe'
import { logger } from '@/lib/serverLogger'
import { verifyAndMarkOrderPaid, releaseOnConfirmedNonPayment } from '@/lib/orderReservation'
import { POST } from '@/app/api/webhooks/stripe/route'

function makeRequest(body: string, sig = 'test-sig'): Request {
  return new Request('https://example.com/api/webhooks/stripe', {
    method: 'POST',
    headers: { 'stripe-signature': sig },
    body,
  })
}

function checkoutEvent(type: string, session: Record<string, unknown>) {
  return { type, data: { object: session } }
}

beforeEach(() => {
  vi.resetAllMocks()
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test'
  ;(verifyAndMarkOrderPaid as Mock).mockResolvedValue('paid')
  ;(releaseOnConfirmedNonPayment as Mock).mockResolvedValue('no_op')
})

describe('A. signature verification', () => {
  it('rejects with 400 on an invalid signature — never processes the event', async () => {
    ;(getStripe as Mock).mockReturnValue({
      webhooks: { constructEvent: vi.fn(() => { throw new Error('bad sig') }) },
    })

    const res = await POST(makeRequest('{}'))

    expect(res.status).toBe(400)
    expect(verifyAndMarkOrderPaid).not.toHaveBeenCalled()
  })

  it('rejects with 500 when STRIPE_WEBHOOK_SECRET is missing — fails closed, never processes unverified', async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET

    const res = await POST(makeRequest('{}'))

    expect(res.status).toBe(500)
    expect(getStripe).not.toHaveBeenCalled()
  })

  it('ignores an event with no orderId metadata (not created by this app)', async () => {
    ;(getStripe as Mock).mockReturnValue({
      webhooks: { constructEvent: vi.fn(() => checkoutEvent('checkout.session.completed', { id: 'sess1', metadata: {} })) },
    })

    const res = await POST(makeRequest('{}'))

    expect(res.status).toBe(200)
    expect(verifyAndMarkOrderPaid).not.toHaveBeenCalled()
  })
})

describe('B. checkout.session.completed — payment_status gate before delegating to the shared verified-paid path', () => {
  it('delegates to verifyAndMarkOrderPaid with the session facts (including payment_status) when payment_status is "paid"', async () => {
    const session = { id: 'sess1', metadata: { orderId: 'order1' }, amount_total: 1500, currency: 'usd', payment_intent: 'pi_1', payment_status: 'paid' }
    ;(getStripe as Mock).mockReturnValue({
      webhooks: { constructEvent: vi.fn(() => checkoutEvent('checkout.session.completed', session)) },
    })

    const res = await POST(makeRequest('{}'))

    expect(res.status).toBe(200)
    expect(verifyAndMarkOrderPaid).toHaveBeenCalledWith('order1', {
      id: 'sess1', payment_status: 'paid', amount_total: 1500, currency: 'usd', payment_intent: 'pi_1',
    })
  })

  it('does NOT delegate when payment_status is "unpaid" — asynchronous payment still pending, never treated as paid', async () => {
    const session = { id: 'sess1', metadata: { orderId: 'order1' }, amount_total: 1500, currency: 'usd', payment_intent: null, payment_status: 'unpaid' }
    ;(getStripe as Mock).mockReturnValue({
      webhooks: { constructEvent: vi.fn(() => checkoutEvent('checkout.session.completed', session)) },
    })

    const res = await POST(makeRequest('{}'))

    expect(res.status).toBe(200)
    expect(verifyAndMarkOrderPaid).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith('stripe.webhook.asyncPaymentPending', expect.objectContaining({ orderId: 'order1', sessionId: 'sess1' }))
  })

  it('does NOT delegate when payment_status is "no_payment_required" — this app has no zero-value checkout feature', async () => {
    const session = { id: 'sess1', metadata: { orderId: 'order1' }, amount_total: 1500, currency: 'usd', payment_intent: null, payment_status: 'no_payment_required' }
    ;(getStripe as Mock).mockReturnValue({
      webhooks: { constructEvent: vi.fn(() => checkoutEvent('checkout.session.completed', session)) },
    })

    await POST(makeRequest('{}'))

    expect(verifyAndMarkOrderPaid).not.toHaveBeenCalled()
  })

  it('extracts a string payment_intent id, never a raw object', async () => {
    const session = {
      id: 'sess1', metadata: { orderId: 'order1' }, amount_total: 1500, currency: 'usd',
      payment_intent: { id: 'pi_1' }, payment_status: 'paid',
    }
    ;(getStripe as Mock).mockReturnValue({
      webhooks: { constructEvent: vi.fn(() => checkoutEvent('checkout.session.completed', session)) },
    })

    await POST(makeRequest('{}'))

    expect(verifyAndMarkOrderPaid).toHaveBeenCalledWith('order1', expect.objectContaining({ payment_intent: null }))
  })
})

describe('C. checkout.session.async_payment_succeeded — uses the SAME shared verifyAndMarkOrderPaid transition', () => {
  it('delegates to verifyAndMarkOrderPaid exactly like checkout.session.completed does', async () => {
    const session = { id: 'sess1', metadata: { orderId: 'order1' }, amount_total: 1500, currency: 'usd', payment_intent: 'pi_1', payment_status: 'paid' }
    ;(getStripe as Mock).mockReturnValue({
      webhooks: { constructEvent: vi.fn(() => checkoutEvent('checkout.session.async_payment_succeeded', session)) },
    })

    const res = await POST(makeRequest('{}'))

    expect(res.status).toBe(200)
    expect(verifyAndMarkOrderPaid).toHaveBeenCalledWith('order1', {
      id: 'sess1', payment_status: 'paid', amount_total: 1500, currency: 'usd', payment_intent: 'pi_1',
    })
  })

  it('never marks paid if this event somehow carries a non-"paid" payment_status', async () => {
    const session = { id: 'sess1', metadata: { orderId: 'order1' }, amount_total: 1500, currency: 'usd', payment_intent: null, payment_status: 'unpaid' }
    ;(getStripe as Mock).mockReturnValue({
      webhooks: { constructEvent: vi.fn(() => checkoutEvent('checkout.session.async_payment_succeeded', session)) },
    })

    await POST(makeRequest('{}'))

    expect(verifyAndMarkOrderPaid).not.toHaveBeenCalled()
  })
})

describe('D. checkout.session.expired — delegates to the shared release path', () => {
  it('calls releaseOnConfirmedNonPayment with the order id and session id', async () => {
    const session = { id: 'sess1', metadata: { orderId: 'order1' } }
    ;(getStripe as Mock).mockReturnValue({
      webhooks: { constructEvent: vi.fn(() => checkoutEvent('checkout.session.expired', session)) },
    })
    ;(releaseOnConfirmedNonPayment as Mock).mockResolvedValue('released')

    const res = await POST(makeRequest('{}'))

    expect(res.status).toBe(200)
    expect(releaseOnConfirmedNonPayment).toHaveBeenCalledWith('order1', 'sess1')
    expect(logger.info).toHaveBeenCalledWith('stripe.webhook.sessionExpiredReleased', { orderId: 'order1', sessionId: 'sess1' })
  })

  it('does not log a release when the shared path reports a no-op (idempotent duplicate delivery)', async () => {
    const session = { id: 'sess1', metadata: { orderId: 'order1' } }
    ;(getStripe as Mock).mockReturnValue({
      webhooks: { constructEvent: vi.fn(() => checkoutEvent('checkout.session.expired', session)) },
    })
    ;(releaseOnConfirmedNonPayment as Mock).mockResolvedValue('no_op')

    await POST(makeRequest('{}'))

    expect(logger.info).not.toHaveBeenCalledWith('stripe.webhook.sessionExpiredReleased', expect.anything())
  })
})

describe('E. checkout.session.async_payment_failed — confirmed terminal failure, releases via the SAME shared guard', () => {
  it('calls releaseOnConfirmedNonPayment (same function checkout.session.expired uses) with the order id and session id', async () => {
    const session = { id: 'sess1', metadata: { orderId: 'order1' } }
    ;(getStripe as Mock).mockReturnValue({
      webhooks: { constructEvent: vi.fn(() => checkoutEvent('checkout.session.async_payment_failed', session)) },
    })
    ;(releaseOnConfirmedNonPayment as Mock).mockResolvedValue('released')

    const res = await POST(makeRequest('{}'))

    expect(res.status).toBe(200)
    expect(releaseOnConfirmedNonPayment).toHaveBeenCalledWith('order1', 'sess1')
    expect(logger.info).toHaveBeenCalledWith('stripe.webhook.asyncPaymentFailedReleased', { orderId: 'order1', sessionId: 'sess1' })
  })

  it('a duplicate/no-op outcome (e.g. already paid, or already released) logs nothing further', async () => {
    const session = { id: 'sess1', metadata: { orderId: 'order1' } }
    ;(getStripe as Mock).mockReturnValue({
      webhooks: { constructEvent: vi.fn(() => checkoutEvent('checkout.session.async_payment_failed', session)) },
    })
    ;(releaseOnConfirmedNonPayment as Mock).mockResolvedValue('no_op')

    await POST(makeRequest('{}'))

    expect(logger.info).not.toHaveBeenCalledWith('stripe.webhook.asyncPaymentFailedReleased', expect.anything())
  })

  it('never calls verifyAndMarkOrderPaid — a failure event never marks anything paid', async () => {
    const session = { id: 'sess1', metadata: { orderId: 'order1' } }
    ;(getStripe as Mock).mockReturnValue({
      webhooks: { constructEvent: vi.fn(() => checkoutEvent('checkout.session.async_payment_failed', session)) },
    })

    await POST(makeRequest('{}'))

    expect(verifyAndMarkOrderPaid).not.toHaveBeenCalled()
  })
})
