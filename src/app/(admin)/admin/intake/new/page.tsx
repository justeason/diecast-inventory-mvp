import Link from 'next/link'
import { IntakeDraftForm } from '@/components/admin/IntakeDraftForm'
import { createIntakeDraft } from '@/lib/actions/intake'

export default function NewIntakeDraftPage() {
  return (
    <>
      <div className="mb-6">
        <Link href="/admin/intake" className="text-sm text-gray-500 hover:text-gray-900">
          ← Back to Intake
        </Link>
      </div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">New Intake Draft</h1>
      <div className="max-w-2xl">
        <IntakeDraftForm action={createIntakeDraft} submitLabel="Create Draft" />
      </div>
    </>
  )
}
