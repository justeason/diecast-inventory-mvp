'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import {
  uploadCatalogPhoto,
  deleteCatalogPhoto,
  type CatalogPhotoActionState,
} from '@/lib/actions/catalogPhotos'

type Photo = { id: string; url: string; altText: string | null }

type Props = {
  catalogId: string
  photo: Photo | null
}

function UploadButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
    >
      {pending ? 'Uploading…' : 'Upload reference image'}
    </button>
  )
}

export function CatalogPhotoUpload({ catalogId, photo }: Props) {
  const uploadAction = uploadCatalogPhoto.bind(null, catalogId)
  const [uploadState, uploadFormAction] = useActionState<CatalogPhotoActionState, FormData>(
    uploadAction,
    null
  )

  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-semibold text-gray-900">Reference image (public)</p>
        <p className="text-xs text-gray-500 mt-0.5">
          This is a generic catalog reference image, not a photo of a specific inventory item or a
          private collection photo.
        </p>
      </div>

      {photo ? (
        <div className="space-y-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={photo.url}
            alt={photo.altText ?? 'Catalog reference image'}
            className="max-w-xs max-h-48 rounded-md border border-gray-200 object-contain bg-gray-50"
          />
          {photo.altText && (
            <p className="text-xs text-gray-500">Alt text: {photo.altText}</p>
          )}
          <p className="text-xs text-gray-400">
            MVP: one reference image per catalog model. Delete to upload a different image.
          </p>
          <form action={deleteCatalogPhoto.bind(null, catalogId, photo.id)}>
            <button
              type="submit"
              className="rounded-md border border-red-200 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 transition-colors"
            >
              Delete reference image
            </button>
          </form>
        </div>
      ) : (
        <form action={uploadFormAction} className="space-y-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="catalog-photo-file" className="text-sm font-medium text-gray-700">
              Choose file
            </label>
            <input
              id="catalog-photo-file"
              type="file"
              name="photo"
              accept="image/jpeg,image/png,image/webp"
              className="text-sm text-gray-600 file:mr-2 file:rounded-md file:border-0 file:bg-gray-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-gray-700 hover:file:bg-gray-200 cursor-pointer"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="catalog-photo-alt" className="text-sm font-medium text-gray-700">
              Alt text{' '}
              <span className="font-normal text-gray-400">(optional — max 200 characters)</span>
            </label>
            <input
              id="catalog-photo-alt"
              type="text"
              name="altText"
              maxLength={200}
              placeholder="e.g. Hot Wheels Ferrari 308 GTS red carded"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
            />
          </div>

          <p className="text-xs text-gray-400">JPEG, PNG, or WebP · max 5 MB</p>

          {uploadState?.error && (
            <p className="text-sm text-red-600">{uploadState.error}</p>
          )}

          <UploadButton />
        </form>
      )}
    </div>
  )
}
