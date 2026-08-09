import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { isAdminAuthenticated } from '@/lib/adminAuth'
import { prisma } from '@/lib/prisma'
import { getPricingIntelligence } from '@/lib/pricingIntelligenceQuery'
import { formatCatalogResult } from '@/lib/catalogFormat'
import { PricingIntelligencePanel } from '@/components/admin/PricingIntelligencePanel'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Model Valuation | Admin' }

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
        <Link href="/admin/valuation" className="text-sm text-gray-500 hover:text-gray-900">← Valuation</Link>
        <p className="text-sm text-red-600 mt-4">Catalog model not found.</p>
      </div>
    )
  }

  const result = await getPricingIntelligence(model.id)

  return (
    <div className="max-w-4xl space-y-6">
      <Link href="/admin/valuation" className="text-sm text-gray-500 hover:text-gray-900">← Valuation</Link>
      <h1 className="text-2xl font-bold text-gray-900">{formatCatalogResult(model)}</h1>
      {result
        ? <PricingIntelligencePanel result={result} modelLabel={formatCatalogResult(model)} />
        : <p className="text-sm text-gray-500">No valuation data available.</p>}
    </div>
  )
}
