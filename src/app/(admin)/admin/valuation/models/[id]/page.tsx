import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { isAdminAuthenticated } from '@/lib/adminAuth'
import { prisma } from '@/lib/prisma'
import { safeGetAdminPricingContext } from '@/lib/adminPricingContext'
import { formatCatalogResult } from '@/lib/catalogFormat'
import { AdminPricingContextPanel } from '@/components/admin/AdminPricingContext'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Model Pricing | Admin' }

export default async function AdminValuationModelPage({ params }: { params: Promise<{ id: string }> }) {
  if (!await isAdminAuthenticated()) redirect('/admin/login')
  const { id } = await params

  const model = await prisma.catalogModel.findUnique({
    where: { id },
    select: { id: true, brand: true, name: true, series: true, year: true, color: true, scale: true },
  })

  if (!model) {
    return (
      <div className="max-w-3xl">
        <Link href="/admin/valuation" className="text-sm text-gray-500 hover:text-gray-900">← Market Pricing</Link>
        <p className="text-sm text-red-600 mt-4">Catalog model not found.</p>
      </div>
    )
  }

  // §33: no variant/condition selector exists on this page — requests the
  // strongest available specificity, which for a bare CatalogModel is
  // model-level only (§11's "if variant unavailable: CatalogModel only").
  // Follow-up §1/§7: isolated — a technical failure here renders the model
  // identity/page shell with a neutral unavailable panel, never a crash; the
  // `!model` notFound-equivalent check above already returned, so a missing
  // model can never be misreported as merely "pricing unavailable".
  const context = await safeGetAdminPricingContext(
    { catalogModelId: model.id, asOf: new Date(), includeSignals: true },
    { route: '/admin/valuation/models/[id]', catalogModelId: model.id },
  )

  return (
    <div className="max-w-4xl space-y-6">
      <Link href="/admin/valuation" className="text-sm text-gray-500 hover:text-gray-900">← Market Pricing</Link>
      <h1 className="text-2xl font-bold text-gray-900">{formatCatalogResult(model)}</h1>
      <AdminPricingContextPanel context={context} heading="Market Pricing" />
      <p className="text-xs text-gray-400">Advisory only — pricing is never changed automatically.</p>
    </div>
  )
}
