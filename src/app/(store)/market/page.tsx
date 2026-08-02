import type { Metadata } from 'next'
import Link from 'next/link'
import { getMerchandisingData } from '@/lib/marketplaceMerchandisingQuery'
import { ListingCard } from '@/components/store/ListingCard'
import { SoldCard } from '@/components/store/SoldCard'
import { CatalogSummaryCard } from '@/components/store/CatalogSummaryCard'
import type { TrendingModel, FastMoverModel, PriceMoverModel } from '@/lib/marketplaceMerchandising'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Marketplace | CollectNTrades',
  description: 'Trending, recently listed, fast movers, and top price movers from the CollectNTrades marketplace.',
}

function SectionHeader({ title, viewAllHref }: { title: string; viewAllHref?: string }) {
  return (
    <div className="flex items-baseline justify-between mb-4">
      <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
      {viewAllHref && (
        <Link href={viewAllHref} className="text-sm text-gray-500 hover:text-gray-900 transition-colors">
          View all →
        </Link>
      )}
    </div>
  )
}

function HorizontalGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-4">
      {children}
    </div>
  )
}

export default async function MarketPage() {
  const data = await getMerchandisingData()

  const hasAnySection =
    data.trendingModels.length > 0 ||
    data.recentlyListed.length > 0 ||
    data.fastMovers.length > 0 ||
    data.highValue.length > 0 ||
    data.recentlySold.length > 0 ||
    data.topPriceMovers.length > 0

  return (
    <div className="space-y-12">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Marketplace</h1>
        <p className="text-sm text-gray-500 mt-1">Rankings based on real CollectNTrades activity.</p>
      </div>

      {!hasAnySection && (
        <div className="py-16 text-center">
          <p className="text-sm text-gray-500">No marketplace data yet — check back soon.</p>
          <Link href="/browse" className="mt-3 inline-block text-sm text-gray-700 underline underline-offset-2">
            Browse all listings →
          </Link>
        </div>
      )}

      {/* 1. Trending now */}
      {data.trendingModels.length > 0 && (
        <section>
          <SectionHeader title="Trending now" />
          <HorizontalGrid>
            {data.trendingModels.map((m: TrendingModel) => (
              <CatalogSummaryCard
                key={m.catalogModelId}
                catalogBrand={m.catalogBrand}
                catalogName={m.catalogName}
                catalogYear={m.catalogYear}
                catalogSeries={m.catalogSeries}
                photoUrl={m.photoUrl}
                primaryMetric={{
                  label: m.saleCount === 1 ? 'sale in 30 days' : 'sales in 30 days',
                  value: `${m.saleCount}`,
                }}
                secondaryMetric={
                  m.activeListingCount > 0
                    ? {
                        label: m.activeListingCount === 1 ? 'listing available' : 'listings available',
                        value: `${m.activeListingCount}`,
                      }
                    : undefined
                }
              />
            ))}
          </HorizontalGrid>
        </section>
      )}

      {/* 2. Recently listed */}
      {data.recentlyListed.length > 0 && (
        <section>
          <SectionHeader title="Recently listed" viewAllHref="/browse?sort=newest" />
          <HorizontalGrid>
            {data.recentlyListed.map((item) => (
              <ListingCard
                key={item.id}
                listing={item}
                photoUrl={item.photoUrl}
                imageSource={item.imageSource}
              />
            ))}
          </HorizontalGrid>
        </section>
      )}

      {/* 3. Fast movers */}
      {data.fastMovers.length > 0 && (
        <section>
          <SectionHeader title="Fast movers" />
          <p className="text-xs text-gray-400 mb-4">Models with the shortest median days from listing to sold.</p>
          <HorizontalGrid>
            {data.fastMovers.map((m: FastMoverModel) => (
              <CatalogSummaryCard
                key={m.catalogModelId}
                catalogBrand={m.catalogBrand}
                catalogName={m.catalogName}
                catalogYear={m.catalogYear}
                catalogSeries={m.catalogSeries}
                photoUrl={m.photoUrl}
                primaryMetric={{
                  label: 'median days to sell',
                  value:
                    m.medianDaysToSell === 0
                      ? 'Same day'
                      : m.medianDaysToSell === 1
                        ? '1 day'
                        : `${m.medianDaysToSell} days`,
                }}
                secondaryMetric={{
                  label: m.saleCount === 1 ? 'sale' : 'sales',
                  value: `${m.saleCount}`,
                }}
              />
            ))}
          </HorizontalGrid>
        </section>
      )}

      {/* 4. High value */}
      {data.highValue.length > 0 && (
        <section>
          <SectionHeader title="High value" viewAllHref="/browse?sort=price_high" />
          <HorizontalGrid>
            {data.highValue.map((item) => (
              <ListingCard
                key={item.id}
                listing={item}
                photoUrl={item.photoUrl}
                imageSource={item.imageSource}
              />
            ))}
          </HorizontalGrid>
        </section>
      )}

      {/* 5. Recently sold */}
      {data.recentlySold.length > 0 && (
        <section>
          <SectionHeader title="Recently sold" />
          <HorizontalGrid>
            {data.recentlySold.map((item) => (
              <SoldCard key={item.id} item={item} />
            ))}
          </HorizontalGrid>
        </section>
      )}

      {/* 6. Top price movers */}
      {data.topPriceMovers.length > 0 && (
        <section>
          <SectionHeader title="Top price movers" />
          <p className="text-xs text-gray-400 mb-4">
            Models whose median sold price rose the most vs. the prior 90-day window. Requires 3+ sales in each period.
          </p>
          <HorizontalGrid>
            {data.topPriceMovers.map((m: PriceMoverModel) => (
              <CatalogSummaryCard
                key={m.catalogModelId}
                catalogBrand={m.catalogBrand}
                catalogName={m.catalogName}
                catalogYear={m.catalogYear}
                catalogSeries={m.catalogSeries}
                photoUrl={m.photoUrl}
                primaryMetric={{
                  label: 'price increase',
                  value: `+${m.pctChange.toFixed(1)}%`,
                }}
                secondaryMetric={{
                  label: 'recent median',
                  value: `$${(m.recentMedianCents / 100).toFixed(2)}`,
                }}
              />
            ))}
          </HorizontalGrid>
        </section>
      )}
    </div>
  )
}
