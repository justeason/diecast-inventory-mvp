import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getItemLifecycleRecord } from '@/lib/itemLifecycleQuery'
import { getItemReadyToListStatus } from '@/lib/readyToListQuery'
import type { ReadyToListOutcome } from '@/lib/readyToList'
import { AGREEMENT_STATUS_LABELS } from '@/lib/sellerAgreementDisplay'
import { PricingIntelligenceSummary, type SerializedPricingIntelligence } from '@/components/store/PricingIntelligenceSummary'

export const dynamic = 'force-dynamic'

// 15C-review section 3: "Paid" — not "Fulfillment" — this schema only proves payment
// was captured, never physical fulfillment (no persisted shipping/fulfillment state).
const STAGE_LABELS: Record<string, string> = {
  processing: 'Processing',
  available: 'Available',
  listed: 'Listed',
  reserved: 'Reserved',
  paid: 'Paid — awaiting fulfillment',
  sold: 'Sold',
  completed: 'Completed',
  inactive: 'Inactive / Not for sale',
  exception: 'Needs attention',
}

const STAGE_COLORS: Record<string, string> = {
  processing: 'bg-gray-100 text-gray-600',
  available: 'bg-green-100 text-green-700',
  listed: 'bg-emerald-100 text-emerald-700',
  reserved: 'bg-yellow-100 text-yellow-700',
  paid: 'bg-blue-100 text-blue-700',
  sold: 'bg-indigo-100 text-indigo-700',
  completed: 'bg-gray-200 text-gray-700',
  inactive: 'bg-gray-100 text-gray-500',
  exception: 'bg-red-100 text-red-700',
}

const SOURCE_LABELS: Record<string, string> = {
  consignment: 'Consignment',
  buyout: 'Buyout',
  company_owned: 'Company-owned',
  unknown: 'Unknown / legacy',
}

const CONDITION_LABELS: Record<string, string> = {
  mint: 'Mint', near_mint: 'Near Mint', good: 'Good', fair: 'Fair', poor: 'Poor', damaged: 'Damaged',
}

function usd(n: number | string | null): string {
  if (n === null) return '—'
  return `$${Number(n).toFixed(2)}`
}

export default async function AdminItemDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const [record, readiness] = await Promise.all([
    getItemLifecycleRecord(id),
    getItemReadyToListStatus(id),
  ])
  if (!record) notFound()

  const { item, location, source, listing, order, financial, pricing, lifecycleStage, contradictions, timeline } = record
  const itemTitle = [item.brand, item.name].filter(Boolean).join(' ') || 'Untitled item'

  return (
    <div className="max-w-4xl">
      <div className="mb-6">
        <Link href="/admin/items" className="text-sm text-gray-500 hover:text-gray-900">← Items</Link>
      </div>

      {/* Header */}
      <div className="mb-2 flex items-start justify-between gap-4">
        <div>
          <p className="font-mono text-xs text-gray-500">{item.sku}</p>
          <h1 className="text-2xl font-bold text-gray-900">{itemTitle}</h1>
        </div>
        <span className={`shrink-0 inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${STAGE_COLORS[lifecycleStage] ?? 'bg-gray-100 text-gray-600'}`}>
          {STAGE_LABELS[lifecycleStage] ?? lifecycleStage}
        </span>
      </div>

      <div className="mb-6 rounded-md border border-gray-200 bg-gray-50 p-4">
        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2 text-sm">
          <Row label="Ownership">{SOURCE_LABELS[source.type]}</Row>
          {source.sellerLabel && (
            <Row label="Seller">
              {source.sellerProfileId ? (
                <Link href={`/admin/seller-profiles/${source.sellerProfileId}`} className="text-blue-600 hover:underline">{source.sellerLabel}</Link>
              ) : source.sellerLabel}
            </Row>
          )}
          {source.portfolioName && source.sellerPortfolioId && (
            <Row label="Portfolio">
              <Link href={`/admin/seller-portfolios/${source.sellerPortfolioId}`} className="text-blue-600 hover:underline">{source.portfolioName}</Link>
            </Row>
          )}
          <Row label="Storage">{location ? <Link href={`/admin/locations/${location.id}`} className="text-blue-600 hover:underline">{location.label}</Link> : '—'}</Row>
          <Row label="Current ask">{listing ? usd(listing.price) : usd(item.listPrice)}</Row>
        </dl>
        <Link href={`/admin/items/${item.id}/edit`} className="mt-3 inline-block text-xs text-blue-600 hover:underline">Edit item →</Link>
      </div>

      {/* 15J — read-only readiness card. The engine only ANSWERS eligibility; the
          actual listing action (and its own 15F listing_activation gate) still lives
          entirely in the existing create/edit listing pages linked below. */}
      {readiness && (
        <ReadyToListCard
          readiness={readiness}
          itemId={item.id}
          listingId={listing?.id ?? null}
          portfolioId={source.sellerPortfolioId}
          catalogId={item.catalogId}
        />
      )}

      {contradictions.length > 0 && (
        <section className="mb-6 space-y-2">
          {contradictions.map((c) => (
            <div key={c.code} className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800">
              <span className="font-semibold">Needs attention: </span>{c.message}
            </div>
          ))}
        </section>
      )}

      {/* Lifecycle / authoritative sub-statuses */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Lifecycle</h2>
        <div className="rounded-md border border-gray-200 bg-white p-4 text-sm">
          <dl className="space-y-1.5">
            <Row label="Display stage">{STAGE_LABELS[lifecycleStage] ?? lifecycleStage}</Row>
            <Row label="Inventory status">{item.status}</Row>
            <Row label="Listing status">{listing?.status ?? '—'}</Row>
            <Row label="Order status">{order?.status ?? '—'}</Row>
            <Row label="Payout status">{financial.payoutStatus ?? 'Not due'}</Row>
            <Row label="Storage">{location?.label ?? '—'}</Row>
          </dl>
          <p className="mt-2 text-xs text-gray-400">
            The display stage is derived from the rows above — it never replaces or hides them.
          </p>
        </div>
      </section>

      {/* Overview */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Overview</h2>
        <div className="rounded-md border border-gray-200 bg-white p-4 text-sm">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5">
            <Row label="Catalog"><Link href={`/admin/catalog/${item.catalogId}/edit`} className="text-blue-600 hover:underline">{item.brand} {item.name}</Link></Row>
            <Row label="Series">{item.series ?? '—'}</Row>
            <Row label="Year">{item.year ?? '—'}</Row>
            <Row label="Color">{item.color ?? '—'}</Row>
            <Row label="Scale">{item.scale ?? '—'}</Row>
            <Row label="Type">{item.cardedOrLoose}</Row>
            <Row label="Condition">{CONDITION_LABELS[item.condition] ?? item.condition}</Row>
            <Row label="Created">{item.createdAt.toLocaleDateString()}</Row>
          </dl>
          {item.conditionNotes && <p className="mt-2 text-xs text-gray-500">{item.conditionNotes}</p>}
          {item.notes && <p className="mt-1 text-xs text-gray-400">{item.notes}</p>}
        </div>
      </section>

      {/* Seller / Source */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Seller / Source</h2>
        <div className="rounded-md border border-gray-200 bg-white p-4 text-sm">
          <dl className="space-y-1.5">
            <Row label="Source">{SOURCE_LABELS[source.type]}</Row>
            {source.type === 'consignment' && (
              <>
                <Row label="Seller">{source.sellerLabel ?? 'Unknown / legacy'}</Row>
                <Row label="Portfolio">{source.portfolioName ? <Link href={`/admin/seller-portfolios/${source.sellerPortfolioId}`} className="text-blue-600 hover:underline">{source.portfolioName}</Link> : 'Unknown / legacy'}</Row>
                <Row label="Agreement">
                  {source.agreementId ? (
                    <>
                      <Link href={`/admin/seller-submissions/${source.submissionId}/agreement`} className="text-blue-600 hover:underline">
                        {source.agreementStatus ? (AGREEMENT_STATUS_LABELS[source.agreementStatus] ?? source.agreementStatus) : 'View'}
                      </Link>
                    </>
                  ) : 'Unknown / legacy'}
                </Row>
                <Row label="Submission">{source.submissionId ? <Link href={`/admin/seller-submissions/${source.submissionId}`} className="text-blue-600 hover:underline">{source.submissionId}</Link> : 'Unknown / legacy'}</Row>
                <Row label="Shipment">
                  {source.inboundShipmentId ? (
                    <span>
                      <Link href={`/admin/seller-submissions/${source.submissionId}`} className="text-blue-600 hover:underline">View shipment →</Link>
                      {source.shipmentLineageExplicit ? (
                        <span className="ml-2 text-xs text-gray-400" title="Set explicitly by the bulk intake workbench at conversion — not inferred.">
                          (authoritative)
                        </span>
                      ) : (
                        // 15D-review section 6: this item predates explicit lineage — the
                        // submission happens to have exactly one non-cancelled shipment, so
                        // this is a best-guess inference, NEVER labeled authoritative/
                        // confirmed. Distinct from the ambiguous (multiple-shipment) case below.
                        <span className="ml-2 text-xs text-amber-600" title="Inferred because the submission has exactly one non-cancelled shipment — not a confirmed per-item link. Pre-dates explicit 15D lineage.">
                          (legacy inferred lineage — not authoritative)
                        </span>
                      )}
                    </span>
                  ) : source.shipmentLineageAmbiguous ? (
                    // 15C-review section 6: the submission has multiple inbound shipments —
                    // this ItemInstance cannot prove which one physically contained it (no
                    // per-item shipment FK exists). Never guessed from seller/timestamp/
                    // order/quantity/portfolio. 15D handoff: intake must capture an explicit
                    // inbound-shipment identity and preserve it on conversion.
                    <span title="Multiple shipments exist for this submission — this item's specific shipment cannot be determined from current data.">
                      Not captured (ambiguous — see submission)
                    </span>
                  ) : (source.submissionId ? '—' : 'Unknown / legacy')}
                </Row>
              </>
            )}
            {source.type === 'buyout' && (
              <>
                <Row label="Seller">{source.sellerLabel ?? 'Unknown / legacy'}</Row>
                <Row label="Agreement">{source.agreementId ? <Link href={`/admin/seller-submissions/${source.submissionId}/agreement`} className="text-blue-600 hover:underline">View</Link> : 'Unknown / legacy'}</Row>
              </>
            )}
            {source.type === 'company_owned' && (
              <p className="text-xs text-gray-500">Company-owned inventory — no seller agreement applies.</p>
            )}
            {source.type === 'unknown' && (
              <p className="text-xs text-gray-500">Legacy record — source type was not captured at creation. Not guessed.</p>
            )}
            <Row label="Intake draft">{source.intakeDraftId ? <Link href={`/admin/intake/${source.intakeDraftId}/edit`} className="text-blue-600 hover:underline">View intake →</Link> : '—'}</Row>
          </dl>
        </div>
      </section>

      {/* Listing */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Listing</h2>
        <div className="rounded-md border border-gray-200 bg-white p-4 text-sm">
          {listing ? (
            <dl className="space-y-1.5">
              <Row label="Status">{listing.status}</Row>
              <Row label="Price">{usd(listing.price)}</Row>
              <Row label="Created">{listing.createdAt.toLocaleDateString()}</Row>
              <Row label="Link"><Link href={`/admin/listings/${listing.id}/edit`} className="text-blue-600 hover:underline">Manage listing →</Link></Row>
            </dl>
          ) : (
            <p className="text-xs text-gray-500">
              No listing yet.{item.status === 'available' && <Link href={`/admin/listings/new?itemId=${item.id}`} className="ml-1 text-blue-600 hover:underline">Create one →</Link>}
            </p>
          )}
        </div>
      </section>

      {/* Order */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Order</h2>
        <div className="rounded-md border border-gray-200 bg-white p-4 text-sm">
          {order ? (
            <dl className="space-y-1.5">
              <Row label="Order">
                <Link href={`/admin/orders/${order.orderId}`} className="text-blue-600 hover:underline">{order.orderId}</Link>
              </Row>
              <Row label="Status">{order.status}</Row>
              <Row label="Sale price">{usd(order.price)}</Row>
              <Row label="Completed">{order.completedAt ? order.completedAt.toLocaleDateString() : '—'}</Row>
              <Row label="Payment">{order.paymentStatus}{order.paidAt ? ` · ${order.paidAt.toLocaleDateString()}` : ''}</Row>
            </dl>
          ) : (
            <p className="text-xs text-gray-500">No order yet.</p>
          )}
          <p className="mt-2 text-xs text-gray-400">Buyer contact details are available on the order page, not shown here.</p>
        </div>
      </section>

      {/* Financial */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Financial</h2>
        <div className="rounded-md border border-gray-200 bg-white p-4 text-sm">
          {source.type === 'consignment' ? (
            <dl className="space-y-1.5">
              <Row label="Gross sale amount">{financial.grossSalePrice ? usd(financial.grossSalePrice.toFixed(2)) : '—'}</Row>
              <Row label="Commission">{financial.commissionAmount ? usd(financial.commissionAmount.toFixed(2)) : '—'}</Row>
              <Row label="Seller proceeds">{financial.sellerProceeds ? usd(financial.sellerProceeds.toFixed(2)) : '—'}</Row>
              <Row label="Payout status">{financial.payoutStatus ?? 'Not due'}</Row>
              <Row label="Payout">{financial.payoutId ? <Link href={`/admin/seller-payouts/${financial.payoutId}`} className="text-blue-600 hover:underline">{financial.payoutId}</Link> : '—'}</Row>
            </dl>
          ) : (
            <dl className="space-y-1.5">
              {/* 15D-review (final approval pass) section 1: a buyout agreement's amount is
                  assigned as this item's cost basis ONLY when the agreement's signed
                  acceptedItemCount is exactly 1 (see intakeConversion.ts) — otherwise
                  individual item cost is unallocated. Never render this as $0 or as a blank
                  "—", which would look like "no cost" rather than "not yet known". */}
              <Row label="Purchase cost">
                {financial.purchasePrice !== null
                  ? usd(financial.purchasePrice)
                  : source.type === 'buyout'
                    ? <span className="text-gray-400">Item-level cost not allocated</span>
                    : '—'}
              </Row>
              <Row label="Sale amount">{financial.grossSalePrice ? usd(financial.grossSalePrice.toFixed(2)) : '—'}</Row>
              <Row label="Gross margin">
                {financial.grossMargin
                  ? usd(financial.grossMargin.toFixed(2))
                  : source.type === 'buyout' && financial.purchasePrice === null
                    ? <span className="text-gray-400">Not available</span>
                    : '—'}
              </Row>
            </dl>
          )}
          <p className="mt-2 text-xs text-gray-400">Admin-only. Gross margin is not profit — operating costs are not deducted.</p>
        </div>
      </section>

      {/* Pricing (14C) */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Pricing</h2>
        {pricing.intelligence ? (
          <PricingIntelligenceSummary result={pricing.intelligence as unknown as SerializedPricingIntelligence} />
        ) : (
          <p className="text-xs text-gray-500">No pricing intelligence available for this catalog model yet.</p>
        )}
        {pricing.listingComparison && (
          <p className="mt-2 text-xs text-gray-500">Listing position: {pricing.listingComparison.classification.replace('_', ' ')}</p>
        )}
        <p className="mt-2 text-xs text-gray-400">Advisory only — pricing is never changed automatically.</p>
      </section>

      {/* Timeline */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Timeline</h2>
        {timeline.length === 0 ? (
          <p className="text-xs text-gray-500">No timeline events recorded.</p>
        ) : (
          <ol className="space-y-2">
            {timeline.map((t, idx) => (
              <li key={idx} className="text-sm border-l-2 border-gray-200 pl-3">
                <p className="text-gray-900">{t.title}</p>
                <p className="text-xs text-gray-400">{t.occurredAt.toLocaleString()}</p>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="text-gray-500 w-32 shrink-0">{label}</dt>
      <dd className="text-gray-900">{children}</dd>
    </div>
  )
}

// 15J — Part J. Every "fix" link below points at an existing authoritative page;
// this card contains no mutation logic of its own (Part O).
const READINESS_STYLES = {
  ready: { badge: 'bg-green-100 text-green-700', border: 'border-green-200 bg-green-50', label: 'Ready to List' },
  review_required: { badge: 'bg-amber-100 text-amber-700', border: 'border-amber-200 bg-amber-50', label: 'Ready — Review Suggested' },
  blocked: { badge: 'bg-red-100 text-red-700', border: 'border-red-200 bg-red-50', label: 'Not Ready to List' },
} as const

const PRICING_LABELS: Record<string, string> = {
  supported: 'Evidence available',
  low_confidence: 'Low confidence',
  no_evidence: 'No evidence',
  not_evaluated: 'Not evaluated',
}

function blockerFixLink(code: string, itemId: string, portfolioId: string | null): { label: string; href: string } | null {
  if (code === 'storage_missing' || code === 'missing_storage_location') {
    return { label: 'Fix storage →', href: `/admin/items/${itemId}/edit` }
  }
  if (code === 'agreement_missing' || code === 'agreement_not_accepted' || code === 'portfolio_agreement_mismatch') {
    return portfolioId ? { label: 'View portfolio / agreement →', href: `/admin/seller-portfolios/${portfolioId}` } : null
  }
  if (code === 'return_case_open') {
    return portfolioId ? { label: 'View portfolio →', href: `/admin/seller-portfolios/${portfolioId}` } : null
  }
  return null
}

function ReadyToListCard({
  readiness, itemId, listingId, portfolioId, catalogId,
}: {
  readiness: ReadyToListOutcome
  itemId: string
  listingId: string | null
  portfolioId: string | null
  catalogId: string
}) {
  const style = READINESS_STYLES[readiness.status]
  const listingHref = readiness.listingPath === 'reactivate' && listingId
    ? `/admin/listings/${listingId}/edit`
    : `/admin/listings/new?itemId=${itemId}`
  const listingLabel = readiness.listingPath === 'reactivate' ? 'Reactivate Listing' : 'Create Listing'

  return (
    <section className={`mb-6 rounded-md border p-4 ${style.border}`}>
      <div className="flex items-center justify-between gap-3 mb-2">
        <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${style.badge}`}>{style.label}</span>
        <span className="text-xs text-gray-500">
          Pricing: {PRICING_LABELS[readiness.pricing.status]}
          {readiness.pricing.isAskOnly && readiness.pricing.status !== 'not_evaluated' ? ' (ask-only)' : ''}
        </span>
      </div>

      {readiness.status === 'blocked' && (
        <ul className="space-y-1.5 mb-3">
          {readiness.blockers.map((b) => {
            const fix = blockerFixLink(b.code, itemId, portfolioId)
            return (
              <li key={b.code} className="text-sm text-red-800">
                • {b.message}
                {fix && <Link href={fix.href} className="ml-2 text-xs text-blue-600 hover:underline">{fix.label}</Link>}
              </li>
            )
          })}
        </ul>
      )}

      {readiness.status === 'review_required' && (
        <ul className="space-y-1.5 mb-3">
          {readiness.reviewReasons.map((r) => (
            <li key={r.code} className="text-sm text-amber-800">
              • {r.message}
              <Link href={`/admin/valuation/models/${catalogId}`} className="ml-2 text-xs text-blue-600 hover:underline">Review valuation →</Link>
            </li>
          ))}
        </ul>
      )}

      {readiness.status !== 'blocked' && (
        <Link
          href={listingHref}
          className="inline-block rounded-md bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-800"
        >
          {listingLabel} →
        </Link>
      )}
    </section>
  )
}
