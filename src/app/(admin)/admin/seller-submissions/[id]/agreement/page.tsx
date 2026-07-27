import type { ReactNode } from 'react'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import {
  createSellerAgreement,
  updateSellerAgreement,
  proposeSellerAgreement,
  recordSellerAgreementAcceptance,
  cancelSellerAgreement,
} from '@/lib/actions/sellerAgreements'
import {
  AGREEMENT_TYPE_LABELS,
  AGREEMENT_STATUS_LABELS,
  AGREEMENT_STATUS_COLORS,
  ACCEPTANCE_METHOD_LABELS,
  formatAmount,
  formatCommissionDisplay,
  storedCommissionToInputValue,
} from '@/lib/sellerAgreementDisplay'
import { SellerAgreementForm } from '@/components/admin/SellerAgreementForm'
import {
  ProposeAgreementForm,
  RecordAcceptanceForm,
  CancelAgreementForm,
} from '@/components/admin/SellerAgreementActions'
import { GenerateBuyoutEligibilityForm } from '@/components/admin/SellerPayoutForms'
import { derivePayoutLineDisplayStatus } from '@/lib/sellerPayoutCalculation'
import {
  deriveSellerLifecycleSummary,
  findLifecycleFinancialWarnings,
} from '@/lib/sellerLifecycle'
import {
  adminCaseTypeLabel,
  adminCaseStatusLabel,
  ADMIN_CASE_STATUS_COLORS,
  isOpenCaseStatus,
} from '@/lib/adminLifecycleDisplay'

export const dynamic = 'force-dynamic'

export default async function SellerAgreementPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  const submission = await prisma.sellerSubmission.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      brand: true,
      name: true,
      profile: { select: { id: true, name: true, email: true } },
      pricingPreference: {
        select: {
          strategy: true,
          selectedTargetPrice: true,
          customDesiredPrice: true,
          suggestedFastPrice: true,
          suggestedMaxPrice: true,
          estimatedDaysToSell: true,
          estimatedSellerProceeds: true,
          confidence: true,
          matchLevel: true,
          comparableCount: true,
          capturedAt: true,
        },
      },
      agreements: {
        select: {
          id: true,
          type: true,
          status: true,
          agreedBuyoutAmount: true,
          commissionPercent: true,
          fixedFee: true,
          minimumSellerPayout: true,
          agreedListPrice: true,
          sellerTermsSummary: true,
          adminNotes: true,
          proposedAt: true,
          acceptedAt: true,
          acceptanceMethod: true,
          cancelledAt: true,
          createdAt: true,
          items: {
            select: {
              id: true,
              sku: true,
              status: true,
              sourceType: true,
              catalog: { select: { brand: true, name: true } },
              listing: { select: { id: true, status: true } },
            },
            orderBy: { createdAt: 'asc' as const },
          },
          payoutLines: {
            select: {
              id: true,
              lineType: true,
              status: true,
              netAmount: true,
              eligibleAt: true,
              agreedBuyoutAmount: true,
              payout: { select: { id: true, status: true, approvedAt: true, paidAt: true } },
              orderItem: { select: { order: { select: { id: true } } } },
            },
            orderBy: { eligibleAt: 'asc' as const },
          },
        },
        orderBy: { createdAt: 'desc' },
      },
    },
  })
  if (!submission) notFound()

  // ─── Lifecycle context ───────────────────────────────────────────────────────
  const [lifecycleCases, intakeDrafts] = await Promise.all([
    prisma.sellerLifecycleCase.findMany({
      where: { sellerSubmissionId: id },
      select: {
        id: true,
        caseType: true,
        status: true,
        returnedAt: true,
        itemInstanceId: true,
        listingId: true,
        orderItemId: true,
        openedAt: true,
        sellerVisible: true,
      },
      orderBy: { openedAt: 'desc' as const },
    }),
    prisma.intakeDraft.findMany({
      where: { sellerSubmissionId: id },
      select: { status: true, convertedItemId: true },
    }),
  ])

  const allAgreementItems = submission.agreements.flatMap((a) => a.items)
  const allPayoutLines = submission.agreements.flatMap((a) =>
    a.payoutLines.map((l) => ({
      id: l.id,
      status: l.status,
      payoutId: l.payout?.id ?? null,
      orderItemId: l.orderItem ? undefined : undefined,
      payout: l.payout ? { status: l.payout.status } : null,
    })),
  )

  const lifecycleSummary = deriveSellerLifecycleSummary({
    submission: { status: submission.status },
    agreements: submission.agreements.map((a) => ({ id: a.id, type: a.type, status: a.status })),
    intakeDrafts,
    items: allAgreementItems.map((i) => ({
      status: i.status,
      sourceType: i.sourceType,
      listing: i.listing ? { status: i.listing.status } : null,
    })),
    payoutLines: allPayoutLines,
    openCases: lifecycleCases
      .filter((c) => isOpenCaseStatus(c.status))
      .map((c) => ({ caseType: c.caseType, status: c.status })),
  })

  const financialWarnings = findLifecycleFinancialWarnings({
    cases: lifecycleCases,
    payoutLines: allPayoutLines,
    items: allAgreementItems.map((i) => ({
      id: i.id,
      status: i.status,
      listing: i.listing ? { status: i.listing.status } : null,
    })),
    intakeDrafts,
  })

  const openCases = lifecycleCases.filter((c) => isOpenCaseStatus(c.status))

  const activeAgreement = submission.agreements.find((a) => a.status !== 'cancelled') ?? null
  const cancelledAgreements = submission.agreements.filter((a) => a.status === 'cancelled')

  const itemTitle =
    [submission.brand, submission.name].filter(Boolean).join(' ') || 'Untitled item'

  const createAction = createSellerAgreement.bind(null, id)
  const updateAction = activeAgreement
    ? updateSellerAgreement.bind(null, activeAgreement.id)
    : null
  const proposeAction = activeAgreement
    ? proposeSellerAgreement.bind(null, activeAgreement.id)
    : null
  const acceptAction = activeAgreement
    ? recordSellerAgreementAcceptance.bind(null, activeAgreement.id)
    : null
  const cancelAction = activeAgreement
    ? cancelSellerAgreement.bind(null, activeAgreement.id)
    : null

  const defaultValues = activeAgreement
    ? {
        type: activeAgreement.type,
        agreedBuyoutAmount: activeAgreement.agreedBuyoutAmount?.toFixed(2) ?? '',
        commissionPercent: storedCommissionToInputValue(
          activeAgreement.commissionPercent?.toString(),
        ),
        fixedFee: activeAgreement.fixedFee?.toFixed(2) ?? '',
        minimumSellerPayout: activeAgreement.minimumSellerPayout?.toFixed(2) ?? '',
        agreedListPrice: activeAgreement.agreedListPrice?.toFixed(2) ?? '',
        sellerTermsSummary: activeAgreement.sellerTermsSummary ?? '',
        adminNotes: activeAgreement.adminNotes ?? '',
      }
    : undefined

  return (
    <div className="max-w-2xl">
      {/* Breadcrumb */}
      <div className="mb-6 flex items-center gap-2 text-sm text-gray-500">
        <Link href="/admin/seller-submissions" className="hover:text-gray-900">
          Sell Requests
        </Link>
        <span>›</span>
        <Link
          href={`/admin/seller-submissions/${id}`}
          className="hover:text-gray-900"
        >
          {itemTitle}
        </Link>
        <span>›</span>
        <span className="text-gray-900">Agreement</span>
      </div>

      <h1 className="text-2xl font-bold text-gray-900 mb-1">Commercial agreement</h1>
      <p className="text-sm text-gray-500 mb-6">
        Seller:{' '}
        <Link
          href={`/admin/customers/${submission.profile.id}`}
          className="hover:underline text-gray-700"
        >
          {submission.profile.name ?? submission.profile.email}
        </Link>
      </p>

      {/* Non-binding note */}
      <div className="mb-8 rounded-md border border-gray-200 bg-gray-50 px-4 py-3 text-xs text-gray-500">
        Agreement terms are recorded for admin reference. They do not automatically create inventory,
        listings, payouts, or seller profiles. The accepted agreement must be honoured manually.
      </div>

      {/* Lifecycle */}
      <section className="mb-8">
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Lifecycle</h2>
        <div className="rounded-md border border-gray-200 bg-white p-4 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-gray-500">Stage:</span>
            <span className="text-sm font-medium text-gray-900">{lifecycleSummary.label}</span>
            {lifecycleSummary.attention !== 'none' && (
              <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
                Needs attention
              </span>
            )}
          </div>

          {/* Payout-impact / reconciliation warnings */}
          {financialWarnings.length > 0 && (
            <div className="space-y-2">
              {financialWarnings.map((w) => (
                <div
                  key={w.code}
                  className={`rounded-md border px-3 py-2 text-xs ${
                    w.severity === 'critical'
                      ? 'border-red-300 bg-red-50 text-red-800'
                      : 'border-amber-200 bg-amber-50 text-amber-800'
                  }`}
                >
                  {w.severity === 'critical' && <span className="font-semibold">Critical: </span>}
                  {w.message}
                </div>
              ))}
            </div>
          )}

          {/* Open lifecycle cases */}
          <div>
            <p className="text-xs font-medium text-gray-700 mb-2">Open cases</p>
            {openCases.length === 0 ? (
              <p className="text-xs text-gray-400">No open lifecycle cases.</p>
            ) : (
              <div className="space-y-2">
                {openCases.map((c) => (
                  <div
                    key={c.id}
                    className="flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs"
                  >
                    <span className="font-medium text-gray-700">{adminCaseTypeLabel(c.caseType)}</span>
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 font-medium ${
                        ADMIN_CASE_STATUS_COLORS[c.status] ?? 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      {adminCaseStatusLabel(c.status)}
                    </span>
                    {c.returnedAt && (
                      <span className="text-gray-500">
                        Returned {c.returnedAt.toLocaleDateString()}
                      </span>
                    )}
                    <Link
                      href={`/admin/seller-cases/${c.id}`}
                      className="ml-auto text-blue-600 hover:underline"
                    >
                      View case →
                    </Link>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* No active agreement */}
      {!activeAgreement && (
        <section className="mb-10">
          <h2 className="text-sm font-semibold text-gray-900 mb-4">Create agreement</h2>
          <SellerAgreementForm action={createAction} submitLabel="Create draft" />
        </section>
      )}

      {/* Draft */}
      {activeAgreement?.status === 'draft' && updateAction && proposeAction && cancelAction && (
        <section className="mb-10 space-y-8">
          <div>
            <div className="flex items-center gap-3 mb-4">
              <h2 className="text-sm font-semibold text-gray-900">Agreement draft</h2>
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                  AGREEMENT_STATUS_COLORS['draft']
                }`}
              >
                {AGREEMENT_STATUS_LABELS['draft']}
              </span>
            </div>
            <SellerAgreementForm
              action={updateAction}
              defaultValues={defaultValues}
              submitLabel="Save changes"
            />
          </div>

          <div className="pt-6 border-t border-gray-200 space-y-4">
            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-1">Propose to seller</h3>
              <p className="text-xs text-gray-500 mb-3">
                Marks the agreement as proposed so the seller can see the terms. Requires a seller
                terms summary. The agreement can still be cancelled after proposal.
              </p>
              <ProposeAgreementForm action={proposeAction} />
            </div>

            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-1">Cancel</h3>
              <CancelAgreementForm action={cancelAction} />
            </div>
          </div>
        </section>
      )}

      {/* Proposed */}
      {activeAgreement?.status === 'proposed' && acceptAction && cancelAction && (
        <section className="mb-10 space-y-6">
          <div>
            <div className="flex items-center gap-3 mb-4">
              <h2 className="text-sm font-semibold text-gray-900">Agreement terms</h2>
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                  AGREEMENT_STATUS_COLORS['proposed']
                }`}
              >
                {AGREEMENT_STATUS_LABELS['proposed']}
              </span>
            </div>
            <AgreementReadOnly agreement={activeAgreement} showAdminNotes />
          </div>

          <div className="pt-6 border-t border-gray-200 space-y-6">
            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-1">Record acceptance</h3>
              <p className="text-xs text-gray-500 mb-3">
                Record that the seller has accepted these terms. Select how acceptance was confirmed.
              </p>
              <RecordAcceptanceForm action={acceptAction} />
            </div>

            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-1">Cancel</h3>
              <CancelAgreementForm action={cancelAction} />
            </div>
          </div>
        </section>
      )}

      {/* Accepted */}
      {activeAgreement?.status === 'accepted' && cancelAction && (
        <section className="mb-10 space-y-6">
          <div>
            <div className="flex items-center gap-3 mb-4">
              <h2 className="text-sm font-semibold text-gray-900">Agreement terms</h2>
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                  AGREEMENT_STATUS_COLORS['accepted']
                }`}
              >
                {AGREEMENT_STATUS_LABELS['accepted']}
              </span>
            </div>
            <div className="mb-3 rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
              This agreement has been accepted by the seller
              {activeAgreement.acceptanceMethod && (
                <>
                  {' '}via{' '}
                  {ACCEPTANCE_METHOD_LABELS[activeAgreement.acceptanceMethod] ??
                    activeAgreement.acceptanceMethod}
                </>
              )}
              {activeAgreement.acceptedAt && (
                <> on {activeAgreement.acceptedAt.toLocaleDateString()}</>
              )}
              .
            </div>
            <AgreementReadOnly agreement={activeAgreement} showAdminNotes />
          </div>

          {/* Linked inventory */}
          {activeAgreement.items.length > 0 && (
            <div className="pt-6 border-t border-gray-200">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Linked inventory</h3>
              <div className="space-y-2">
                {activeAgreement.items.map((item) => (
                  <div
                    key={item.id}
                    className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm rounded-md border border-gray-200 bg-gray-50 px-3 py-2"
                  >
                    <Link
                      href={`/admin/items/${item.id}/edit`}
                      className="font-mono text-xs text-indigo-700 hover:underline"
                    >
                      {item.sku}
                    </Link>
                    <span className="text-gray-700">
                      {item.catalog.brand} {item.catalog.name}
                    </span>
                    <span className="text-xs text-gray-400">{item.status}</span>
                    {item.listing && (
                      <Link
                        href={`/admin/listings/${item.listing.id}/edit`}
                        className="text-xs text-blue-600 hover:underline ml-auto"
                      >
                        View listing →
                      </Link>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Seller payment and payout history */}
          {activeAgreement.payoutLines.length > 0 || activeAgreement.type === 'buyout' ? (
            <div className="pt-6 border-t border-gray-200">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">Seller payment and payout history</h3>
              {activeAgreement.payoutLines.length === 0 &&
               activeAgreement.type === 'buyout' &&
               activeAgreement.items.length > 0 && (
                <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-3 text-xs text-amber-800 space-y-2">
                  <p className="font-medium">Linked buyout inventory is missing its seller payment eligibility record.</p>
                  <p>This is normally created automatically when inventory is converted via intake. Use the action below to generate it.</p>
                  <GenerateBuyoutEligibilityForm agreementId={activeAgreement.id} />
                </div>
              )}
              {activeAgreement.payoutLines.length > 0 && (
                <div className="space-y-2">
                  {activeAgreement.payoutLines.map((line) => {
                    const displayStatus = derivePayoutLineDisplayStatus(line.status, line.payout ?? null)
                    return (
                      <div key={line.id} className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs space-y-1">
                        <div className="flex items-center justify-between">
                          <span className="capitalize font-medium text-gray-700">{line.lineType}</span>
                          <span className="font-mono font-medium text-gray-900">
                            ${parseFloat(line.netAmount.toString()).toFixed(2)}
                          </span>
                        </div>
                        <div className="flex flex-wrap gap-x-4 text-gray-500">
                          <span>Status: <span className="text-gray-700">{displayStatus}</span></span>
                          <span>Eligible: {line.eligibleAt.toLocaleDateString()}</span>
                          {line.payout?.approvedAt && (
                            <span>Approved: {line.payout.approvedAt.toLocaleDateString()}</span>
                          )}
                          {line.payout?.paidAt && (
                            <span>Paid: {line.payout.paidAt.toLocaleDateString()}</span>
                          )}
                        </div>
                        {line.payout && (
                          <Link href={`/admin/seller-payouts/${line.payout.id}`} className="text-blue-600 hover:underline">
                            View payout →
                          </Link>
                        )}
                        {line.orderItem?.order && (
                          <Link href={`/admin/orders/${line.orderItem.order.id}`} className="ml-4 text-blue-600 hover:underline">
                            View order →
                          </Link>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          ) : null}

          <div className="pt-6 border-t border-gray-200">
            <h3 className="text-sm font-semibold text-gray-700 mb-1">Cancel</h3>
            <p className="text-xs text-gray-500 mb-3">
              Cancellation is blocked if this agreement is linked to inventory, or if a linked
              intake has been converted to inventory.
            </p>
            <CancelAgreementForm action={cancelAction} />
          </div>
        </section>
      )}

      {/* Seller pricing preference */}
      {submission.pricingPreference && (
        <section className="mb-8 pt-6 border-t border-gray-200">
          <h2 className="text-sm font-semibold text-gray-900 mb-3">Seller pricing preference</h2>
          <div className="rounded-md border border-gray-200 bg-gray-50 p-4 text-xs text-gray-600 space-y-1">
            <p className="text-xs text-amber-700 mb-2">
              Advisory only — estimates are based on prior CollectNTrades sales and are not guaranteed.
            </p>
            <dl className="space-y-1">
              <div className="flex gap-3">
                <dt className="text-gray-500 w-40 shrink-0">Strategy</dt>
                <dd>
                  {submission.pricingPreference.strategy === 'sell_fast'
                    ? 'Sell faster'
                    : submission.pricingPreference.strategy === 'maximize_proceeds'
                      ? 'Maximize proceeds'
                      : 'Custom price'}
                </dd>
              </div>
              <div className="flex gap-3">
                <dt className="text-gray-500 w-40 shrink-0">Selected target price</dt>
                <dd className="font-semibold text-gray-900">
                  ${parseFloat(submission.pricingPreference.selectedTargetPrice.toString()).toFixed(2)}
                </dd>
              </div>
              {submission.pricingPreference.customDesiredPrice && (
                <div className="flex gap-3">
                  <dt className="text-gray-500 w-40 shrink-0">Custom desired price</dt>
                  <dd>${parseFloat(submission.pricingPreference.customDesiredPrice.toString()).toFixed(2)}</dd>
                </div>
              )}
              {submission.pricingPreference.suggestedFastPrice && (
                <div className="flex gap-3">
                  <dt className="text-gray-500 w-40 shrink-0">Suggested fast price</dt>
                  <dd>${parseFloat(submission.pricingPreference.suggestedFastPrice.toString()).toFixed(2)}</dd>
                </div>
              )}
              {submission.pricingPreference.suggestedMaxPrice && (
                <div className="flex gap-3">
                  <dt className="text-gray-500 w-40 shrink-0">Suggested max price</dt>
                  <dd>${parseFloat(submission.pricingPreference.suggestedMaxPrice.toString()).toFixed(2)}</dd>
                </div>
              )}
              {submission.pricingPreference.estimatedDaysToSell !== null && (
                <div className="flex gap-3">
                  <dt className="text-gray-500 w-40 shrink-0">Est. days to sell</dt>
                  <dd>~{submission.pricingPreference.estimatedDaysToSell}d</dd>
                </div>
              )}
              {submission.pricingPreference.estimatedSellerProceeds && (
                <div className="flex gap-3">
                  <dt className="text-gray-500 w-40 shrink-0">Est. seller proceeds</dt>
                  <dd>${parseFloat(submission.pricingPreference.estimatedSellerProceeds.toString()).toFixed(2)}</dd>
                </div>
              )}
              <div className="flex gap-3">
                <dt className="text-gray-500 w-40 shrink-0">Confidence</dt>
                <dd>{submission.pricingPreference.confidence}</dd>
              </div>
              <div className="flex gap-3">
                <dt className="text-gray-500 w-40 shrink-0">Match level</dt>
                <dd>{submission.pricingPreference.matchLevel}</dd>
              </div>
              <div className="flex gap-3">
                <dt className="text-gray-500 w-40 shrink-0">Comparable count</dt>
                <dd>{submission.pricingPreference.comparableCount}</dd>
              </div>
              <div className="flex gap-3">
                <dt className="text-gray-500 w-40 shrink-0">Captured</dt>
                <dd>{submission.pricingPreference.capturedAt.toLocaleDateString()}</dd>
              </div>
            </dl>
          </div>
        </section>
      )}

      {/* Cancelled history */}
      {cancelledAgreements.length > 0 && (
        <section className="pt-6 border-t border-gray-200">
          <h2 className="text-sm font-semibold text-gray-900 mb-3">Cancelled agreements</h2>
          <div className="space-y-3">
            {cancelledAgreements.map((a) => (
              <div key={a.id} className="rounded-md border border-gray-200 bg-gray-50 p-3 text-sm">
                <div className="flex items-center gap-2 mb-1">
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${AGREEMENT_STATUS_COLORS['cancelled']}`}
                  >
                    {AGREEMENT_STATUS_LABELS['cancelled']}
                  </span>
                  <span className="text-gray-600">
                    {AGREEMENT_TYPE_LABELS[a.type] ?? a.type}
                  </span>
                  {a.cancelledAt && (
                    <span className="text-xs text-gray-400">
                      · {a.cancelledAt.toLocaleDateString()}
                    </span>
                  )}
                </div>
                <div className="text-xs text-gray-500">
                  Created {a.createdAt.toLocaleDateString()}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

type AgreementData = {
  type: string
  agreedBuyoutAmount: { toFixed(dp: number): string } | null
  commissionPercent: { toString(): string } | null
  fixedFee: { toFixed(dp: number): string } | null
  minimumSellerPayout: { toFixed(dp: number): string } | null
  agreedListPrice: { toFixed(dp: number): string } | null
  sellerTermsSummary: string | null
  adminNotes: string | null
  proposedAt: Date | null
}

function AgreementReadOnly({
  agreement,
  showAdminNotes,
}: {
  agreement: AgreementData
  showAdminNotes?: boolean
}) {
  const isBuyout = agreement.type === 'buyout'

  return (
    <div className="rounded-md border border-gray-200 bg-gray-50 p-4 text-sm space-y-2">
      <Row label="Type">{AGREEMENT_TYPE_LABELS[agreement.type] ?? agreement.type}</Row>

      {isBuyout && (
        <Row label="Buyout amount">
          {formatAmount(agreement.agreedBuyoutAmount?.toFixed(2))}
        </Row>
      )}

      {!isBuyout && (
        <>
          <Row label="Commission">
            {formatCommissionDisplay(agreement.commissionPercent?.toString())}
          </Row>
          {agreement.fixedFee && (
            <Row label="Fixed fee">{formatAmount(agreement.fixedFee.toFixed(2))}</Row>
          )}
          {agreement.minimumSellerPayout && (
            <Row label="Min. seller payout">
              {formatAmount(agreement.minimumSellerPayout.toFixed(2))}
            </Row>
          )}
        </>
      )}

      {agreement.agreedListPrice && (
        <Row label="Agreed list price">
          {formatAmount(agreement.agreedListPrice.toFixed(2))}
        </Row>
      )}

      {agreement.sellerTermsSummary && (
        <Row label="Terms summary">
          <span className="whitespace-pre-wrap">{agreement.sellerTermsSummary}</span>
        </Row>
      )}

      {showAdminNotes && agreement.adminNotes && (
        <Row label="Admin notes">
          <span className="whitespace-pre-wrap text-gray-600">{agreement.adminNotes}</span>
        </Row>
      )}

      {agreement.proposedAt && (
        <Row label="Proposed">{agreement.proposedAt.toLocaleDateString()}</Row>
      )}
    </div>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="text-gray-500 w-36 shrink-0">{label}</dt>
      <dd className="text-gray-900">{children}</dd>
    </div>
  )
}

