'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import {
  uploadCollectionPhoto,
  type CollectionPhotoActionState,
} from '@/lib/actions/collectionPhotos'

const PHOTO_TYPE_OPTIONS = [
  { value: 'front',  label: 'Front' },
  { value: 'back',   label: 'Back' },
  { value: 'detail', label: 'Detail' },
  { value: 'other',  label: 'Other' },
]

type Props = { itemId: string }

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
    >
      {pending ? 'Uploading…' : 'Upload photo'}
    </button>
  )
}

export function CollectionPhotoUpload({ itemId }: Props) {
  const action = uploadCollectionPhoto.bind(null, itemId)
  const [state, formAction] = useActionState<CollectionPhotoActionState, FormData>(action, null)

  return (
    <form action={formAction} className="space-y-3">
      <div className="flex flex-wrap gap-3 items-end">
        <div className="flex flex-col gap-1">
          <label htmlFor="photo-type" className="text-sm font-medium text-gray-700">
            Photo type
          </label>
          <select
            id="photo-type"
            name="type"
            className="rounded-md border border-gray-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-gray-900"
          >
            {PHOTO_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1 flex-1 min-w-0">
          <label htmlFor="photo-file" className="text-sm font-medium text-gray-700">
            Choose file
          </label>
          {/* No capture attribute — lets the OS show both camera and gallery on mobile */}
          <input
            id="photo-file"
            type="file"
            name="photo"
            accept="image/jpeg,image/png,image/webp"
            className="text-sm text-gray-600 file:mr-2 file:rounded-md file:border-0 file:bg-gray-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-gray-700 hover:file:bg-gray-200 cursor-pointer"
          />
        </div>
      </div>

      <p className="text-xs text-gray-400">JPEG, PNG, or WebP · max 5 MB · up to 3 photos</p>

      {state?.error && (
        <p className="text-sm text-red-600">{state.error}</p>
      )}

      <SubmitButton />
    </form>
  )
}
