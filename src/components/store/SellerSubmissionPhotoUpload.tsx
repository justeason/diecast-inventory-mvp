'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import {
  uploadSellerSubmissionPhoto,
  deleteSellerSubmissionPhoto,
  type SellerSubmissionPhotoActionState,
} from '@/lib/actions/sellerSubmissionPhotos'

type Photo = { id: string; url: string; sortOrder: number }

type Props = {
  submissionId: string
  photos: Photo[]
  editable: boolean
}

const MAX_PHOTOS = 5

function UploadButton() {
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

export function SellerSubmissionPhotoUpload({ submissionId, photos, editable }: Props) {
  const action = uploadSellerSubmissionPhoto.bind(null, submissionId)
  const [state, formAction] = useActionState<SellerSubmissionPhotoActionState, FormData>(
    action,
    null
  )

  return (
    <div className="space-y-4">
      {/* Photo grid */}
      {photos.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {photos.map((photo) => (
            <div
              key={photo.id}
              className="relative group rounded-md border border-gray-200 bg-gray-50 overflow-hidden"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={photo.url}
                alt="Submission photo"
                loading="lazy"
                className="w-full aspect-square object-cover"
              />
              {editable && (
                <div className="absolute top-1 right-1">
                  <form action={deleteSellerSubmissionPhoto.bind(null, photo.id)}>
                    <button
                      type="submit"
                      className="flex items-center justify-center w-6 h-6 rounded-full bg-black/60 text-white text-xs hover:bg-black/80 transition-colors"
                      title="Delete photo"
                    >
                      ✕
                    </button>
                  </form>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Upload form */}
      {editable && photos.length < MAX_PHOTOS && (
        <form action={formAction} className="space-y-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="submission-photo-file" className="text-sm font-medium text-gray-700">
              Add photo
            </label>
            <input
              id="submission-photo-file"
              type="file"
              name="photo"
              accept="image/jpeg,image/png,image/webp"
              className="text-sm text-gray-600 file:mr-2 file:rounded-md file:border-0 file:bg-gray-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-gray-700 hover:file:bg-gray-200 cursor-pointer"
            />
          </div>
          <p className="text-xs text-gray-400">
            JPEG, PNG, or WebP · max 5 MB · up to {MAX_PHOTOS} photos total
          </p>
          {state?.error && <p className="text-sm text-red-600">{state.error}</p>}
          <UploadButton />
        </form>
      )}

      {editable && photos.length >= MAX_PHOTOS && (
        <p className="text-xs text-gray-500">Maximum {MAX_PHOTOS} photos reached.</p>
      )}

      {!editable && photos.length === 0 && (
        <p className="text-xs text-gray-400">No photos uploaded.</p>
      )}

      {!editable && photos.length > 0 && (
        <p className="text-xs text-gray-400">Photos are locked for this request status.</p>
      )}
    </div>
  )
}
