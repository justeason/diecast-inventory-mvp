import Link from 'next/link'
import { StorageLocationForm } from '@/components/admin/StorageLocationForm'

export default function NewLocationPage() {
  return (
    <>
      <div className="mb-6">
        <Link href="/admin/locations" className="text-sm text-gray-500 hover:text-gray-900">
          ← Back to Locations
        </Link>
        <h1 className="text-2xl font-bold text-gray-900 mt-2">New Storage Location</h1>
      </div>
      <StorageLocationForm />
    </>
  )
}
