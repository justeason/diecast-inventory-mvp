import { describe, it, expect } from 'vitest'
import { buildPaymentLinkEmail } from '@/lib/email/paymentLinkEmail'

const SAMPLE_ORDER = {
  id: 'cltest0000000000000000001',
  buyerName: 'Jane Buyer',
  buyerEmail: 'jane@example.com',
  estimatedShipping: 8.99,
  orderItems: [
    { price: 24.99, listing: { title: 'Hot Wheels Ferrari' } },
    { price: 19.99, listing: { title: 'Matchbox Mustang' } },
  ],
}

const CHECKOUT_URL = 'https://checkout.stripe.com/pay/cs_test_abc123'
const APP_URL = 'https://www.collectntrades.com'

describe('buildPaymentLinkEmail', () => {
  it('returns the expected subject', () => {
    const { subject } = buildPaymentLinkEmail(SAMPLE_ORDER, CHECKOUT_URL, APP_URL)
    expect(subject).toBe(
      'Your CollectNTrades order is reserved — complete payment to confirm'
    )
  })

  it('html contains the checkout URL', () => {
    const { html } = buildPaymentLinkEmail(SAMPLE_ORDER, CHECKOUT_URL, APP_URL)
    expect(html).toContain(CHECKOUT_URL)
  })

  it('text contains the checkout URL', () => {
    const { text } = buildPaymentLinkEmail(SAMPLE_ORDER, CHECKOUT_URL, APP_URL)
    expect(text).toContain(CHECKOUT_URL)
  })

  it('html contains buyer name', () => {
    const { html } = buildPaymentLinkEmail(SAMPLE_ORDER, CHECKOUT_URL, APP_URL)
    expect(html).toContain('Jane Buyer')
  })

  it('renders subtotal correctly', () => {
    const { html, text } = buildPaymentLinkEmail(SAMPLE_ORDER, CHECKOUT_URL, APP_URL)
    expect(html).toContain('44.98')
    expect(text).toContain('44.98')
  })

  it('renders shipping correctly', () => {
    const { html, text } = buildPaymentLinkEmail(SAMPLE_ORDER, CHECKOUT_URL, APP_URL)
    expect(html).toContain('8.99')
    expect(text).toContain('8.99')
  })

  it('renders total correctly', () => {
    // subtotal 44.98 + shipping 8.99 = 53.97
    const { html, text } = buildPaymentLinkEmail(SAMPLE_ORDER, CHECKOUT_URL, APP_URL)
    expect(html).toContain('53.97')
    expect(text).toContain('53.97')
  })

  it('contains both item titles', () => {
    const { html } = buildPaymentLinkEmail(SAMPLE_ORDER, CHECKOUT_URL, APP_URL)
    expect(html).toContain('Hot Wheels Ferrari')
    expect(html).toContain('Matchbox Mustang')
  })

  it('does not expose admin notes or Stripe internal IDs', () => {
    const { html, text } = buildPaymentLinkEmail(SAMPLE_ORDER, CHECKOUT_URL, APP_URL)
    for (const forbidden of ['adminNotes', 'PaymentIntent', 'stripeSessionId', 'customerProfileId']) {
      expect(html).not.toContain(forbidden)
      expect(text).not.toContain(forbidden)
    }
  })

  it('shows free shipping label when shipping is 0', () => {
    const freeShippingOrder = { ...SAMPLE_ORDER, estimatedShipping: 0 }
    const { html, text } = buildPaymentLinkEmail(freeShippingOrder, CHECKOUT_URL, APP_URL)
    expect(html).toContain('Free')
    expect(text).toContain('Free')
  })
})
