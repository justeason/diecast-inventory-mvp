'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import type { UploadActionState } from '@/lib/actions/intake'

type Props = {
  label: string
  currentUrl: string | null
  action: (prev: UploadActionState, formData: FormData) => Promise<UploadActionState>
}

function UploadButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="shrink-0 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
    >
      {pending ? 'Uploading…' : 'Upload'}
    </button>
  )
}

export function IntakePhotoUpload({ label, currentUrl, action }: Props) {
  const [state, formAction] = useActionState<UploadActionState, FormData>(action, null)
  const error = state && 'error' in state ? state.error : null

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium text-gray-700">{label}</p>

      {/* Preview */}
      {currentUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={currentUrl}
          alt={label}
          className="max-h-48 w-auto rounded-md border border-gray-200 object-contain bg-gray-50"
        />
      ) : (
        <div className="flex h-32 items-center justify-center rounded-md border-2 border-dashed border-gray-200 bg-gray-50">
          <p className="text-xs text-gray-400">No photo yet</p>
        </div>
      )}

      {/* Upload form */}
      <form action={formAction} className="flex items-center gap-2">
        <input
          type="file"
          name="photo"
          accept="image/jpeg,image/png,image/webp"
          capture="environment"
          className="text-sm text-gray-600 file:mr-2 file:rounded-md file:border-0 file:bg-gray-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-gray-700 hover:file:bg-gray-200 cursor-pointer"
        />
        <UploadButton />
      </form>

      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  )
}
