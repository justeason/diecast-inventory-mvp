import { describe, it, expect } from 'vitest'
import { buildMagicLinkEmail } from '@/lib/email/magicLinkEmail'

const BASE_INPUT = {
  verifyUrl: 'https://www.collectntrades.com/account/orders/verify?token=abc123',
  appUrl: 'https://www.collectntrades.com',
}

describe('buildMagicLinkEmail', () => {
  it('returns the correct subject', () => {
    const { subject } = buildMagicLinkEmail(BASE_INPUT)
    expect(subject).toBe('Sign in to view your CollectNTrades orders')
  })

  it('html contains the verifyUrl', () => {
    const { html } = buildMagicLinkEmail(BASE_INPUT)
    expect(html).toContain(BASE_INPUT.verifyUrl)
  })

  it('text contains the verifyUrl', () => {
    const { text } = buildMagicLinkEmail(BASE_INPUT)
    expect(text).toContain(BASE_INPUT.verifyUrl)
  })

  it('text contains the appUrl', () => {
    const { text } = buildMagicLinkEmail(BASE_INPUT)
    expect(text).toContain(BASE_INPUT.appUrl)
  })

  it('html uses buyer name in greeting when provided', () => {
    const { html } = buildMagicLinkEmail({ ...BASE_INPUT, name: 'Alice' })
    expect(html).toContain('Hi Alice,')
  })

  it('html uses generic greeting when name is null', () => {
    const { html } = buildMagicLinkEmail({ ...BASE_INPUT, name: null })
    expect(html).toContain('Hi there,')
  })

  it('html uses generic greeting when name is omitted', () => {
    const { html } = buildMagicLinkEmail(BASE_INPUT)
    expect(html).toContain('Hi there,')
  })

  it('escapes < in name', () => {
    const { html } = buildMagicLinkEmail({ ...BASE_INPUT, name: '<script>' })
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
  })

  it('escapes & in name', () => {
    const { html } = buildMagicLinkEmail({ ...BASE_INPUT, name: 'Tom & Jerry' })
    expect(html).toContain('Tom &amp; Jerry')
    expect(html).not.toContain('Tom & Jerry')
  })

  it('does not contain order-detail or internal fields', () => {
    const { html, text } = buildMagicLinkEmail(BASE_INPUT)
    for (const forbidden of ['Order ID', 'Subtotal', 'Stripe', 'PaymentIntent', 'customerProfileId']) {
      expect(html).not.toContain(forbidden)
      expect(text).not.toContain(forbidden)
    }
  })
})
