import Link from 'next/link'
import { IntakeDraftForm } from '@/components/admin/IntakeDraftForm'
import { createIntakeDraft } from '@/lib/actions/intake'

export default async function NewIntakeDraftPage({
  searchParams,
}: {
  searchParams: Promise<{ created?: string }>
}) {
  const { created } = await searchParams

  return (
    <>
      <div className="mb-6">
        <Link href="/admin/intake" className="text-sm text-gray-500 hover:text-gray-900">
          ← Back to Intake
        </Link>
      </div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">New Intake Draft</h1>

      {created === '1' && (
        <div className="mb-6 rounded-md bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-800">
          Draft saved. Add another.
        </div>
      )}

      <div className="max-w-2xl">
        <IntakeDraftForm
          action={createIntakeDraft}
          submitLabel="Create Draft"
          showCreateAnother
          showPhotoInputs
        />
      </div>
    </>
  )
}
