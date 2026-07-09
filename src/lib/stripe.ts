import Stripe from 'stripe'

const globalForStripe = globalThis as unknown as { stripe: Stripe | undefined }

export function getStripe(): Stripe {
  if (globalForStripe.stripe) return globalForStripe.stripe

  const key = process.env.STRIPE_SECRET_KEY
  if (!key) {
    throw new Error('STRIPE_SECRET_KEY is not configured')
  }

  const client = new Stripe(key, { typescript: true })

  if (process.env.NODE_ENV !== 'production') {
    globalForStripe.stripe = client
  }

  return client
}
