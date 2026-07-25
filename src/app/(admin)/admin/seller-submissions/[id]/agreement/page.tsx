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
        },
        orderBy: { createdAt: 'desc' },
      },
    },
  })
  if (!submission) notFound()

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

          <div className="pt-6 border-t border-gray-200">
            <h3 className="text-sm font-semibold text-gray-700 mb-1">Cancel</h3>
            <p className="text-xs text-gray-500 mb-3">
              Cancellation is blocked if a linked intake has already been converted to inventory.
            </p>
            <CancelAgreementForm action={cancelAction} />
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

