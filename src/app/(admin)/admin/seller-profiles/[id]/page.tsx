import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { SellerProfileForm } from '@/components/admin/SellerProfileForm'
import { CreateSellerOverrideForm, EndSellerOverrideForm } from '@/components/admin/CommissionOverrideForm'
import { listSellerCommissionOverrides } from '@/lib/commissionPolicyQuery'

export const dynamic = 'force-dynamic'

const STATUS_COLORS: Record<string, string> = {
  pending:   'bg-yellow-100 text-yellow-700',
  active:    'bg-green-100 text-green-700',
  suspended: 'bg-red-100 text-red-700',
}

const STATUS_LABELS: Record<string, string> = {
  pending:   'Pending',
  active:    'Active',
  suspended: 'Suspended',
}

export default async function SellerProfileDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  const sp = await prisma.sellerProfile.findUnique({
    where: { id },
    include: { profile: { select: { id: true, name: true, email: true, phone: true } } },
  })

  if (!sp) notFound()

  const overrides = await listSellerCommissionOverrides(sp.id)

  return (
    <>
      <div className="mb-6">
        <Link href="/admin/seller-profiles" className="text-sm text-gray-500 hover:text-gray-900">
          ← Back to Seller Profiles
        </Link>
      </div>

      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            {sp.displayName ?? sp.profile.name ?? sp.profile.email}
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Seller profile · created {sp.createdAt.toLocaleDateString()}
          </p>
        </div>
        <span
          className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-medium ${STATUS_COLORS[sp.status] ?? 'bg-gray-100 text-gray-600'}`}
        >
          {STATUS_LABELS[sp.status] ?? sp.status}
        </span>
      </div>

      {/* Linked customer info */}
      <div className="mb-8 rounded-md border border-gray-200 bg-gray-50 p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-gray-900">Linked Customer</h2>
          <Link
            href={`/admin/customers/${sp.profile.id}`}
            className="text-xs text-gray-500 hover:text-gray-900"
          >
            View customer →
          </Link>
        </div>
        <dl className="space-y-1.5 text-sm">
          <div className="flex gap-3">
            <dt className="text-gray-500 w-16 shrink-0">Name</dt>
            <dd className="text-gray-900">{sp.profile.name ?? '—'}</dd>
          </div>
          <div className="flex gap-3">
            <dt className="text-gray-500 w-16 shrink-0">Email</dt>
            <dd className="text-gray-900">{sp.profile.email}</dd>
          </div>
          <div className="flex gap-3">
            <dt className="text-gray-500 w-16 shrink-0">Phone</dt>
            <dd className="text-gray-900">{sp.profile.phone ?? '—'}</dd>
          </div>
        </dl>
      </div>

      {/* Edit form */}
      <h2 className="text-lg font-semibold text-gray-900 mb-4">Edit Seller Profile</h2>
      <SellerProfileForm
        mode="edit"
        sellerProfile={sp}
        customerProfile={sp.profile}
      />

      {/* 15A: Commission overrides — exceptional, auditable per-seller rate overrides */}
      <div className="mt-10">
        <h2 className="text-lg font-semibold text-gray-900 mb-1">Commission overrides</h2>
        <p className="text-xs text-gray-500 mb-4">
          Bypasses the active commission policy for this seller. Keep exceptional — most sellers
          need no override at all.
        </p>
        {overrides.length > 0 && (
          <div className="mb-4 space-y-2">
            {overrides.map(o => {
              const now = new Date()
              const isActive = o.effectiveFrom <= now && (o.effectiveTo === null || o.effectiveTo > now)
              return (
                <div key={o.id} className="rounded-md border border-gray-200 bg-white p-3 text-xs flex items-center justify-between gap-4">
                  <div>
                    <p className="text-gray-900">
                      {o.commissionBps !== null && <>{(o.commissionBps / 100).toFixed(o.commissionBps % 100 === 0 ? 0 : 2)}% </>}
                      {o.minimumFeeCents !== null && <>min ${(o.minimumFeeCents / 100).toFixed(2)}/item</>}
                      {isActive && <span className="ml-2 rounded-full bg-green-100 px-2 py-0.5 text-green-700">Active</span>}
                    </p>
                    <p className="text-gray-500 mt-0.5">{o.reason}</p>
                    <p className="text-gray-400 mt-0.5">
                      From {o.effectiveFrom.toLocaleDateString()}
                      {o.effectiveTo && <> to {o.effectiveTo.toLocaleDateString()}</>}
                    </p>
                  </div>
                  {isActive && <EndSellerOverrideForm overrideId={o.id} sellerProfileId={sp.id} />}
                </div>
              )
            })}
          </div>
        )}
        <CreateSellerOverrideForm sellerProfileId={sp.id} />
      </div>

      {/* Timestamps */}
      <div className="mt-8 text-xs text-gray-400 space-y-0.5">
        <p>Created {sp.createdAt.toLocaleString()}</p>
        <p>Updated {sp.updatedAt.toLocaleString()}</p>
      </div>
    </>
  )
}
