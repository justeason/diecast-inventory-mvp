import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { isAdminAuthenticated } from '@/lib/adminAuth'
import { prisma } from '@/lib/prisma'
import { getApprovalDetail, getApprovalStaleness } from '@/lib/riskPolicyQuery'
import { RiskApprovalDecisionForm } from '@/components/admin/RiskApprovalDecisionForm'
import { ADMIN_CONFIDENCE_LABELS } from '@/lib/adminPricingDisplay'
import type { PricingEvidence } from '@/lib/riskPolicy'

export const dynamic = 'force-dynamic'

const NOTE_REQUIRED_ACTIONS = new Set(['agreement_commission_override', 'seller_commission_override', 'item_catalog_reassignment', 'catalog_model_merge'])

function catalogLabel(m: { brand: string; name: string; year: number | null } | null): string {
  if (!m) return '(deleted)'
  return [m.brand, m.name, m.year ? `(${m.year})` : null].filter(Boolean).join(' ')
}

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

const SPECIFICITY_LABELS: Record<string, string> = {
  model_variant_condition: 'Exact packaging + condition',
  model_variant: 'Packaging-level',
  model: 'Model-level',
}

// 32C §35/§36: canonical (pricingContextVersion === 2) pricing summary, shared
// across listing_activation/listing_price_change/item_catalog_reassignment —
// display-only, never invents Recommended/Target/Fair-Value language (§39).
// Legacy (pre-V2) decisionContext shapes are never reinterpreted through this
// path — they fall through to the raw-JSON section below unchanged (§37/§38).
type PricingSummary = { proposedPriceCents: number | null; oldPriceCents: number | null; evidence: PricingEvidence }

function buildPricingSummary(decisionContext: Record<string, unknown>): PricingSummary | null {
  if (decisionContext.pricingContextVersion !== 2) return null
  return {
    proposedPriceCents: typeof decisionContext.proposedPriceCents === 'number' ? decisionContext.proposedPriceCents : null,
    oldPriceCents: typeof decisionContext.oldPriceCents === 'number' ? decisionContext.oldPriceCents : null,
    evidence: (decisionContext.pricingEvidence as PricingEvidence | undefined) ?? null,
  }
}

export default async function ApprovalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdminAuthenticated())) redirect('/admin/login')
  const { id } = await params

  const detail = await getApprovalDetail(id)
  if (!detail) notFound()

  const staleness = await getApprovalStaleness(detail)

  // 15F-review (catalog-merge pass) section 10: explain the batch impact clearly —
  // brand/model labels, never raw ids alone, no buyer/seller PII (a catalog merge
  // context never contains any).
  let mergeSummary: { sourceLabel: string; canonicalLabel: string } | null = null
  if (detail.action === 'catalog_model_merge') {
    const sourceId = detail.decisionContext.sourceCatalogModelId as string | undefined
    const canonicalId = detail.decisionContext.canonicalCatalogModelId as string | undefined
    const [source, canonical] = await Promise.all([
      sourceId ? prisma.catalogModel.findUnique({ where: { id: sourceId }, select: { brand: true, name: true, year: true } }) : null,
      canonicalId ? prisma.catalogModel.findUnique({ where: { id: canonicalId }, select: { brand: true, name: true, year: true } }) : null,
    ])
    mergeSummary = { sourceLabel: catalogLabel(source), canonicalLabel: catalogLabel(canonical) }
  }

  const pricingSummary = buildPricingSummary(detail.decisionContext)

  return (
    <div className="max-w-3xl">
      <Link href="/admin/approvals" className="text-sm text-blue-600 hover:underline">← Back to approvals</Link>

      <h1 className="mt-2 text-lg font-semibold text-gray-900">
        {detail.action}
        <span className="ml-2 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">{detail.status}</span>
        <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">{detail.riskLevel} risk</span>
      </h1>
      <p className="text-sm text-gray-500">Target: {detail.targetType} · {detail.targetId}</p>
      <p className="text-xs text-gray-400">Requested by {detail.requestedBy} at {detail.requestedAt.toLocaleString()}</p>

      {staleness.checked && staleness.stale && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          Stale — the target has changed since this request was made (current: {staleness.currentValueLabel}). This
          request can no longer be consumed even if approved. Cancel it and request a fresh approval.
        </div>
      )}

      {mergeSummary && (
        <div className="mt-4 rounded-md border border-gray-200 bg-white p-4 text-sm">
          <p className="text-xs text-gray-500 mb-1">Source (duplicate — will be deleted)</p>
          <p className="text-gray-900 mb-3">{mergeSummary.sourceLabel}</p>
          <p className="text-xs text-gray-500 mb-1">Canonical (kept)</p>
          <p className="text-gray-900 mb-3">{mergeSummary.canonicalLabel}</p>
          <p className="text-xs text-gray-500 mb-1">Affected inventory</p>
          <p className="text-gray-900">{String(detail.decisionContext.affectedItemCount ?? '—')} physical item(s)</p>
          <p className="text-xs text-gray-500 mb-1 mt-2">Historical sold items</p>
          <p className="text-gray-900">{String(detail.decisionContext.soldItemCount ?? '—')}</p>
          <Link href="/admin/catalog/duplicates" className="mt-3 inline-block text-blue-600 hover:underline">
            View catalog duplicates queue →
          </Link>
        </div>
      )}

      {pricingSummary && (
        <div className="mt-4 rounded-md border border-gray-200 bg-white p-4 text-sm">
          <p className="text-xs text-gray-500 mb-2">Pricing summary</p>
          <dl className="space-y-1.5">
            {pricingSummary.proposedPriceCents != null && (
              <div className="flex gap-3"><dt className="text-gray-500 w-48 shrink-0">Proposed Listing Price</dt><dd className="text-gray-900">{usd(pricingSummary.proposedPriceCents)}</dd></div>
            )}
            {pricingSummary.oldPriceCents != null && (
              <div className="flex gap-3"><dt className="text-gray-500 w-48 shrink-0">Previous Listing Price</dt><dd className="text-gray-900">{usd(pricingSummary.oldPriceCents)}</dd></div>
            )}
            {pricingSummary.evidence ? (
              <>
                <div className="flex gap-3"><dt className="text-gray-500 w-48 shrink-0">Estimated Market Value</dt><dd className="text-gray-900">{usd(pricingSummary.evidence.estimatedValueCents)}</dd></div>
                {pricingSummary.evidence.marketRangeLowCents != null && pricingSummary.evidence.marketRangeHighCents != null && (
                  <div className="flex gap-3"><dt className="text-gray-500 w-48 shrink-0">Market Range</dt><dd className="text-gray-900">{usd(pricingSummary.evidence.marketRangeLowCents)}–{usd(pricingSummary.evidence.marketRangeHighCents)}</dd></div>
                )}
                <div className="flex gap-3"><dt className="text-gray-500 w-48 shrink-0">Confidence</dt><dd className="text-gray-900">{ADMIN_CONFIDENCE_LABELS[pricingSummary.evidence.confidence]}</dd></div>
                <div className="flex gap-3"><dt className="text-gray-500 w-48 shrink-0">Pricing Evidence</dt><dd className="text-gray-900">{pricingSummary.evidence.usedSampleCount} used ({pricingSummary.evidence.rawSampleCount} raw, {pricingSummary.evidence.excludedOutlierCount} excluded)</dd></div>
                <div className="flex gap-3"><dt className="text-gray-500 w-48 shrink-0">Requested Specificity</dt><dd className="text-gray-900">{SPECIFICITY_LABELS[pricingSummary.evidence.requestedSpecificity]}</dd></div>
                <div className="flex gap-3"><dt className="text-gray-500 w-48 shrink-0">Used Specificity</dt><dd className="text-gray-900">{SPECIFICITY_LABELS[pricingSummary.evidence.resolvedSpecificity]}</dd></div>
                {pricingSummary.evidence.extendedHistoryUsed && (
                  <div className="flex gap-3"><dt className="text-gray-500 w-48 shrink-0">Extended History</dt><dd className="text-gray-900">Includes older sales beyond the recent window.</dd></div>
                )}
              </>
            ) : (
              <p className="text-gray-500">No canonical pricing evidence was available at request time.</p>
            )}
          </dl>
        </div>
      )}

      <div className="mt-4 rounded-md border border-gray-200 bg-white p-4 text-sm">
        <p className="text-xs text-gray-500 mb-1">Policy rule</p>
        <p className="text-gray-900 mb-3">{detail.policyCode} (policy version {detail.policyVersion})</p>
        <p className="text-xs text-gray-500 mb-1">Why approval was required</p>
        <ul className="list-disc list-inside text-gray-800 space-y-1">
          {detail.reasons.map((r, i) => <li key={i}>{r}</li>)}
        </ul>
      </div>

      <div className="mt-4 rounded-md border border-gray-200 bg-white p-4 text-sm">
        <p className="text-xs text-gray-500 mb-2">Requested change (exact context this approval is bound to)</p>
        <pre className="whitespace-pre-wrap break-words text-xs text-gray-700 bg-gray-50 rounded p-3">
          {JSON.stringify(detail.decisionContext, null, 2)}
        </pre>
      </div>

      {(detail.status === 'approved' || detail.status === 'rejected' || detail.status === 'consumed') && (
        <div className="mt-4 rounded-md border border-gray-200 bg-white p-4 text-sm">
          <p className="text-xs text-gray-500 mb-1">Decision</p>
          {detail.approvedBy && <p className="text-gray-900">Approved by {detail.approvedBy} at {detail.approvedAt?.toLocaleString()}</p>}
          {detail.rejectedBy && <p className="text-gray-900">Rejected by {detail.rejectedBy} at {detail.rejectedAt?.toLocaleString()}</p>}
          {detail.decisionNote && <p className="text-gray-600 mt-1">&ldquo;{detail.decisionNote}&rdquo;</p>}
          {detail.consumedAt && <p className="text-gray-600 mt-1">Consumed (business action executed) at {detail.consumedAt.toLocaleString()}.</p>}
          {detail.expiresAt && <p className="text-xs text-gray-400 mt-1">Expires {detail.expiresAt.toLocaleString()}.</p>}
        </div>
      )}

      {detail.status === 'pending' && (
        <div className="mt-6">
          <RiskApprovalDecisionForm id={detail.id} noteRequired={detail.riskLevel === 'high' || NOTE_REQUIRED_ACTIONS.has(detail.action)} />
        </div>
      )}

      {detail.status === 'approved' && !staleness.stale && (
        <p className="mt-6 text-sm text-gray-600">
          Approved. Return to the original workflow and resume the action — it will be consumed automatically.
        </p>
      )}
    </div>
  )
}
