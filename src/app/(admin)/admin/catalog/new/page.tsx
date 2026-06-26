import Link from 'next/link'
import { CatalogModelForm } from '@/components/admin/CatalogModelForm'

export default function NewCatalogModelPage() {
  return (
    <>
      <div className="mb-6">
        <Link href="/admin/catalog" className="text-sm text-gray-500 hover:text-gray-900">
          ← Back to Catalog
        </Link>
        <h1 className="text-2xl font-bold text-gray-900 mt-2">New Catalog Model</h1>
      </div>
      <CatalogModelForm />
    </>
  )
}
