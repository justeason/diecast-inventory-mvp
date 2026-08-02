export const dynamic = 'force-dynamic'

import Link from 'next/link'
import {
  detectReconciliationIssues,
  type Category,
  type Severity,
  type ReconciliationIssue,
} from '@/lib/operationalReconciliation'
import { ReconciliationRepairForm } from '@/components/admin/ReconciliationRepairForm'

const PAGE_SIZE = 50

const SEVERITY_LABELS: Record<Severity, string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
}

const SEVERITY_BADGE_COLORS: Record<Severity, string> = {
  critical: 'bg-red-100 text-red-700',
  warning: 'bg-amber-100 text-amber-700',
  info: 'bg-gray-100 text-gray-600',
}

const SECTION_STYLES: Record<Severity, { border: string; bg: string; heading: string }> = {
  critical: { border: 'border-red-200', bg: 'bg-red-50', heading: 'text-red-800' },
  warning: { border: 'border-amber-200', bg: 'bg-amber-50', heading: 'text-amber-800' },
  info: { border: 'border-gray-200', bg: 'bg-gray-50', heading: 'text-gray-700' },
}

const ENTITY_ADMIN_PATHS: Record<string, (id: string) => string> = {
  SellerSubmission: (id) => `/admin/seller-submissions/${id}`,
  SellerAgreement: (id) => `/admin/seller-submissions?agreementId=${id}`,
  ItemInstance: (id) => `/admin/items/${id}/edit`,
  IntakeDraft: (id) => `/admin/intake/${id}/edit`,
  Listing: (id) => `/admin/listings/${id}/edit`,
  OrderItem: () => `/admin/orders`,
  Order: (id) => `/admin/orders/${id}`,
  SellerPayout: (id) => `/admin/seller-payouts/${id}`,
  SellerPayoutLine: () => `/admin/seller-payouts`,
  SellerInboundShipment: () => `/admin/seller-submissions`,
  SellerLifecycleCase: (id) => `/admin/seller-cases/${id}`,
}

const RELATED_ID_LABELS: Record<string, string> = {
  submissionId: 'Submission',
  agreementId: 'Agreement',
  listingId: 'Listing',
  itemId: 'Item',
  orderId: 'Order',
  payoutId: 'Payout',
  intakeDraftId: 'Intake Draft',
  payoutLineId: 'Payout Line',
  caseId: 'Case',
}

const RELATED_ID_PATHS: Record<string, (id: string) => string> = {
  submissionId: (id) => `/admin/seller-submissions/${id}`,
  agreementId: (id) => `/admin/seller-submissions?agreementId=${id}`,
  listingId: (id) => `/admin/listings/${id}/edit`,
  itemId: (id) => `/admin/items/${id}/edit`,
  orderId: (id) => `/admin/orders/${id}`,
  payoutId: (id) => `/admin/seller-payouts/${id}`,
  intakeDraftId: (id) => `/admin/intake/${id}/edit`,
  caseId: (id) => `/admin/seller-cases/${id}`,
}

function buildExtraFields(issue: ReconciliationIssue): Record<string, string> {
  const fields: Record<string, string> = {}
  switch (issue.repairType) {
    case 'generate_buyout_payout_line':
      if (issue.relatedIds.agreementId) fields.agreementId = issue.relatedIds.agreementId
      if (issue.relatedIds.submissionId) fields.submissionId = issue.relatedIds.submissionId
      break
    case 'generate_consignment_payout_line':
      if (issue.relatedIds.orderId) fields.orderId = issue.relatedIds.orderId
      break
    case 'archive_active_listing':
      fields.listingId = issue.relatedIds.listingId ?? issue.entityId
      break
    case 'recalculate_payout_total':
      fields.payoutId = issue.relatedIds.payoutId ?? issue.entityId
      break
    case 'open_lifecycle_case':
      if (issue.relatedIds.submissionId) fields.submissionId = issue.relatedIds.submissionId
      fields.caseType = 'other'
      break
    case 'hold_payout_line':
      fields.lineId = issue.entityId
      if (issue.relatedIds.caseId) fields.caseId = issue.relatedIds.caseId
      break
  }
  return fields
}

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function ReconciliationPage({ searchParams }: PageProps) {
  const sp = await searchParams
  const str = (key: string) => (typeof sp[key] === 'string' ? (sp[key] as string).trim() : undefined)

  const category = str('category') as Category | undefined
  const severity = str('severity') as Severity | undefined
  const sellerName = str('seller')
  const entityId = str('entityId')
  const repairableOnly = sp['repairableOnly'] === 'true' || sp['repairableOnly'] === '1'
  const page = Math.max(1, parseInt(str('page') ?? '1', 10))

  const allIssues = await detectReconciliationIssues({
    category,
    severity,
    sellerName,
    entityId,
    repairableOnly,
  })

  const totalCount = allIssues.length
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const pageIssues = allIssues.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)

  const critical = pageIssues.filter((i) => i.severity === 'critical')
  const warning = pageIssues.filter((i) => i.severity === 'warning')
  const info = pageIssues.filter((i) => i.severity === 'info')

  const hasFilters = !!(category || severity || sellerName || entityId || repairableOnly)

  function buildHref(overrides: Record<string, string | number | boolean | undefined>) {
    const params = new URLSearchParams()
    const merged: Record<string, string | number | undefined> = {
      category,
      severity,
      seller: sellerName,
      entityId,
      repairableOnly: repairableOnly ? 'true' : undefined,
      page: currentPage,
    }
    for (const [k, v] of Object.entries(overrides)) {
      merged[k] = v === false ? undefined : v === true ? 'true' : v
    }
    for (const [k, v] of Object.entries(merged)) {
      if (v !== undefined && v !== '') {
        params.set(k, String(v))
      }
    }
    const qs = params.toString()
    return `/admin/reconciliation${qs ? `?${qs}` : ''}`
  }

  return (
    <div>
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Operational Reconciliation</h1>
          <p className="text-sm text-gray-500 mt-1">
            {totalCount === 0 ? 'No issues detected.' : `${totalCount} issue${totalCount !== 1 ? 's' : ''} detected.`}
          </p>
        </div>
      </div>

      {/* Filter form */}
      <form
        method="GET"
        action="/admin/reconciliation"
        className="mb-6 flex flex-wrap items-end gap-3 bg-white border border-gray-200 rounded-lg px-4 py-3"
      >
        <div>
          <label className="block text-xs text-gray-500 mb-1">Category</label>
          <select
            name="category"
            defaultValue={category ?? ''}
            className="text-sm border border-gray-300 rounded px-2 py-1"
          >
            <option value="">All</option>
            {(['seller', 'shipping', 'intake', 'inventory', 'listing', 'order', 'payout', 'lifecycle'] as Category[]).map(
              (c) => (
                <option key={c} value={c}>
                  {c.charAt(0).toUpperCase() + c.slice(1)}
                </option>
              ),
            )}
          </select>
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">Severity</label>
          <select
            name="severity"
            defaultValue={severity ?? ''}
            className="text-sm border border-gray-300 rounded px-2 py-1"
          >
            <option value="">All</option>
            <option value="critical">Critical</option>
            <option value="warning">Warning</option>
            <option value="info">Info</option>
          </select>
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">Seller name</label>
          <input
            type="text"
            name="seller"
            defaultValue={sellerName ?? ''}
            placeholder="Filter by seller"
            className="text-sm border border-gray-300 rounded px-2 py-1 w-40"
          />
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">Entity ID</label>
          <input
            type="text"
            name="entityId"
            defaultValue={entityId ?? ''}
            placeholder="Entity or related ID"
            className="text-sm border border-gray-300 rounded px-2 py-1 w-48 font-mono"
          />
        </div>

        <div className="flex items-center gap-1.5 mt-4">
          <input
            type="checkbox"
            id="repairableOnly"
            name="repairableOnly"
            value="true"
            defaultChecked={repairableOnly}
            className="h-4 w-4 text-indigo-600 rounded border-gray-300"
          />
          <label htmlFor="repairableOnly" className="text-sm text-gray-700">
            Repairable only
          </label>
        </div>

        <button
          type="submit"
          className="text-sm bg-gray-800 text-white rounded px-3 py-1.5 hover:bg-gray-700"
        >
          Filter
        </button>

        {hasFilters && (
          <Link
            href="/admin/reconciliation"
            className="text-sm text-gray-500 hover:text-gray-800 underline"
          >
            Clear
          </Link>
        )}
      </form>

      {totalCount === 0 ? (
        <div className="rounded-lg border border-green-200 bg-green-50 px-6 py-8 text-center text-green-700">
          No reconciliation issues found.
        </div>
      ) : (
        <>
          {[
            { label: 'Critical', items: critical, severity: 'critical' as Severity },
            { label: 'Needs Attention', items: warning, severity: 'warning' as Severity },
            { label: 'Informational', items: info, severity: 'info' as Severity },
          ]
            .filter((s) => s.items.length > 0)
            .map((section) => {
              const style = SECTION_STYLES[section.severity]
              return (
                <section key={section.severity} className="mb-8">
                  <h2 className={`text-base font-semibold mb-3 ${style.heading}`}>
                    {section.label} ({section.items.length})
                  </h2>
                  <div className="space-y-3">
                    {section.items.map((issue) => {
                      const entityPath = ENTITY_ADMIN_PATHS[issue.entityType]?.(issue.entityId)
                      const extraFields = issue.repairType ? buildExtraFields(issue) : {}
                      return (
                        <div
                          key={issue.key}
                          className={`rounded-lg border ${style.border} ${style.bg} px-4 py-3`}
                        >
                          <div className="flex items-start gap-3 flex-wrap">
                            <span
                              className={`mt-0.5 shrink-0 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${SEVERITY_BADGE_COLORS[issue.severity]}`}
                            >
                              {SEVERITY_LABELS[issue.severity]}
                            </span>
                            <div className="flex-1 min-w-0">
                              <p className="font-medium text-sm text-gray-900">{issue.title}</p>
                              <p className="text-xs text-gray-600 mt-0.5">{issue.description}</p>

                              <div className="mt-1.5 flex flex-wrap items-center gap-3 text-xs">
                                <span className="text-gray-500">
                                  {issue.entityType}:{' '}
                                  {entityPath ? (
                                    <Link
                                      href={entityPath}
                                      className="font-mono text-blue-600 hover:underline"
                                    >
                                      {issue.entityId}
                                    </Link>
                                  ) : (
                                    <span className="font-mono">{issue.entityId}</span>
                                  )}
                                </span>

                                {issue.sellerDisplayName && (
                                  <span className="text-gray-500">
                                    Seller: <span className="text-gray-700">{issue.sellerDisplayName}</span>
                                  </span>
                                )}
                              </div>

                              {/* Related IDs */}
                              {Object.keys(issue.relatedIds).length > 0 && (
                                <div className="mt-1 flex flex-wrap gap-2 text-xs">
                                  {Object.entries(issue.relatedIds).map(([k, v]) => {
                                    const label = RELATED_ID_LABELS[k] ?? k
                                    const path = RELATED_ID_PATHS[k]?.(v)
                                    return (
                                      <span key={k} className="text-gray-500">
                                        {label}:{' '}
                                        {path ? (
                                          <Link href={path} className="font-mono text-blue-600 hover:underline">
                                            {v}
                                          </Link>
                                        ) : (
                                          <span className="font-mono">{v}</span>
                                        )}
                                      </span>
                                    )
                                  })}
                                </div>
                              )}

                              <p className="mt-1.5 text-xs text-gray-600 italic">
                                {issue.suggestedAction}
                              </p>

                              {issue.repairType && (
                                <ReconciliationRepairForm
                                  issueKey={issue.key}
                                  repairType={issue.repairType}
                                  entityType={issue.entityType}
                                  entityId={issue.entityId}
                                  extraFields={extraFields}
                                />
                              )}
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </section>
              )
            })}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center gap-4 mt-6">
              {currentPage > 1 ? (
                <Link
                  href={buildHref({ page: currentPage - 1 })}
                  className="text-sm text-blue-600 hover:underline"
                >
                  ← Previous
                </Link>
              ) : (
                <span className="text-sm text-gray-400">← Previous</span>
              )}
              <span className="text-sm text-gray-600">
                Page {currentPage} of {totalPages}
              </span>
              {currentPage < totalPages ? (
                <Link
                  href={buildHref({ page: currentPage + 1 })}
                  className="text-sm text-blue-600 hover:underline"
                >
                  Next →
                </Link>
              ) : (
                <span className="text-sm text-gray-400">Next →</span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
