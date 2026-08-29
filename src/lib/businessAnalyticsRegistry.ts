// 14B: Centralized metric definitions. Displayed KPI names/tooltips in the admin UI
// are sourced from here — the formula shown always matches what the code computes.

export type MetricType = 'flow' | 'snapshot' | 'cohort'

export type MetricDefinition = {
  key: string
  name: string
  description: string
  metricType: MetricType
  timestampBasis: string
  numerator?: string
  denominator?: string
}

export const METRIC_REGISTRY: MetricDefinition[] = [
  {
    key: 'gmv',
    name: 'GMV',
    description: 'Gross merchandise value — buyer-facing sale price of all completed marketplace order items. Gross: refunds/reversals are not tracked in this schema.',
    metricType: 'flow',
    timestampBasis: 'Order.completedAt',
    numerator: 'sum(OrderItem.price) where Order.status = complete',
  },
  {
    key: 'marketplace_revenue',
    name: 'Marketplace revenue',
    description: 'Not available from current data model. Recognized net revenue would require tracking payment-processing fees and an explicit accounting treatment of what counts as revenue vs. cost of goods — neither is persisted here. See "Gross spread" and "Gross margin" for the closest defensible figures.',
    metricType: 'flow',
    timestampBasis: 'n/a — not calculated',
  },
  {
    key: 'gross_spread',
    name: 'Gross spread (consignment)',
    description: 'grossSalePrice − SellerPayoutLine.netAmount for consignment sales — the amount withheld from the seller. This is commission + fixed fee actually recorded, not audited net revenue: payment-processing fees, refunds, and other operating costs are not deducted.',
    metricType: 'flow',
    timestampBasis: 'Order.completedAt',
    numerator: 'sum(grossSalePrice − netAmount) over consignment order items with a matching payout line',
  },
  {
    key: 'gross_margin',
    name: 'Gross margin (buyout/company-owned)',
    description: 'OrderItem.price − ItemInstance.purchasePrice for buyout/company-owned sales (ItemInstance.sourceType in [buyout, company_owned] — the same allowlist as 15N Financial Position). This is gross margin (sale price minus cost of goods), not audited net revenue. Items with no purchasePrice recorded are excluded, not treated as zero cost. Items with an unrecognized/missing sourceType are excluded entirely — never counted as owned.',
    metricType: 'flow',
    timestampBasis: 'Order.completedAt',
    numerator: 'sum(price − purchasePrice) over buyout/company-owned order items with a recorded purchasePrice',
  },
  {
    key: 'units_sold',
    name: 'Units sold',
    description: 'Count of OrderItem rows on completed orders.',
    metricType: 'flow',
    timestampBasis: 'Order.completedAt',
  },
  {
    key: 'completed_orders',
    name: 'Completed orders',
    description: 'Count of Order rows with status = complete.',
    metricType: 'flow',
    timestampBasis: 'Order.completedAt',
  },
  {
    key: 'active_inventory',
    name: 'Active inventory',
    description: 'Physical items currently available or reserved (not yet sold).',
    metricType: 'snapshot',
    timestampBasis: 'as of request time (asOf)',
  },
  {
    key: 'sell_through',
    name: 'Sell-through',
    description: 'Cohort of units that entered sellable inventory in the period and have since sold, divided by the cohort size. Sale window is truncated at asOf — units may still sell after the report is generated.',
    metricType: 'cohort',
    timestampBasis: 'ItemInstance.createdAt (intake) cohort; sale via Order.completedAt',
    numerator: 'cohort units with status = sold',
    denominator: 'cohort units (ItemInstance.createdAt in period)',
  },
  {
    key: 'listing_to_sale_conversion',
    name: 'Listing-to-sale conversion',
    description: 'Listings created in the period that eventually completed a sale, divided by listings created in the period. Sale window truncated at asOf.',
    metricType: 'cohort',
    timestampBasis: 'Listing.createdAt cohort; sale via Order.completedAt',
    numerator: 'cohort listings with a completed sale',
    denominator: 'listings created in period',
  },
  {
    key: 'order_completion_rate',
    name: 'Order completion rate',
    description: 'Orders that reached status = complete, divided by all orders created in the period (any status).',
    metricType: 'flow',
    timestampBasis: 'Order.createdAt',
    numerator: 'orders created in period with status = complete',
    denominator: 'orders created in period',
  },
  {
    key: 'payout_liability',
    name: 'Unpaid seller liability',
    description: 'sum(SellerPayoutLine.netAmount) for lines not voided and not yet part of a paid SellerPayout.',
    metricType: 'snapshot',
    timestampBasis: 'as of request time (asOf)',
  },
  {
    key: 'seller_proceeds',
    name: 'Seller proceeds',
    description: 'sum(SellerPayoutLine.netAmount), excluding voided lines.',
    metricType: 'flow',
    timestampBasis: 'SellerPayoutLine.eligibleAt',
  },
  {
    key: 'median_days_to_sell',
    name: 'Median days to sell',
    description: 'Median of (Order.completedAt − ItemInstance.createdAt) for sold units in the period, in whole days. Negative durations (data error) are excluded.',
    metricType: 'flow',
    timestampBasis: 'Order.completedAt',
  },
]

export function getMetricDefinition(key: string): MetricDefinition | undefined {
  return METRIC_REGISTRY.find(m => m.key === key)
}
