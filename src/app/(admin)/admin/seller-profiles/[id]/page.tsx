import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { SellerProfileForm } from '@/components/admin/SellerProfileForm'

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

      {/* Timestamps */}
      <div className="mt-8 text-xs text-gray-400 space-y-0.5">
        <p>Created {sp.createdAt.toLocaleString()}</p>
        <p>Updated {sp.updatedAt.toLocaleString()}</p>
      </div>
    </>
  )
}
