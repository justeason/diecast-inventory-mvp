// Placeholder for future provider integrations.
// Currently only csv_manual import is supported.
// Future live providers (API feeds, etc.) would implement ProviderObservation.

export type ProviderObservationType = 'sold' | 'active_ask'

export type ProviderObservation = {
  provider: string
  externalId: string | null
  observationType: ProviderObservationType
  title: string
  sourceUrl: string | null
  currency: string
  price: number
  shippingPrice: number | null
  totalPrice: number
  soldAt: Date | null
  listedAt: Date | null
  observedAt: Date
  condition: string | null
  locationText: string | null
  rawSnapshot: Record<string, unknown> | null
}
