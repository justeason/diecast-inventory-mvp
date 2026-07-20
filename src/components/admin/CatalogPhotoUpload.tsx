'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import {
  uploadCatalogPhoto,
  deleteCatalogPhoto,
  updateCatalogPhotoAltText,
  setPrimaryCatalogPhoto,
  type CatalogPhotoActionState,
} from '@/lib/actions/catalogPhotos'

const MAX_PHOTOS = 3

type CatalogPhoto = { id: string; url: string; altText: string | null; sortOrder: number }

type Props = {
  catalogId: string
  photos: CatalogPhoto[]
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

function SaveAltTextButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
    >
      {pending ? 'Saving…' : 'Save alt text'}
    </button>
  )
}

function SetPrimaryButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
    >
      {pending ? 'Setting…' : 'Set as primary'}
    </button>
  )
}

function CatalogPhotoRow({
  catalogId,
  photo,
  isPrimary,
}: {
  catalogId: string
  photo: CatalogPhoto
  isPrimary: boolean
}) {
  const altTextAction = updateCatalogPhotoAltText.bind(null, catalogId, photo.id)
  const [altTextState, altTextFormAction] = useActionState<CatalogPhotoActionState, FormData>(
    altTextAction,
    null
  )

  return (
    <div className="rounded-md border border-gray-200 p-4 space-y-3">
      <div className="flex items-start gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={photo.url}
          alt={photo.altText ?? 'Catalog reference image'}
          loading="lazy"
          className="max-w-[160px] max-h-40 rounded-md border border-gray-200 object-contain bg-gray-50"
        />
        {isPrimary && (
          <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
            Primary
          </span>
        )}
      </div>

      {!isPrimary && (
        <form action={setPrimaryCatalogPhoto.bind(null, catalogId, photo.id)}>
          <SetPrimaryButton />
        </form>
      )}

      <form action={altTextFormAction} className="flex flex-col gap-1.5">
        <label htmlFor={`catalog-alt-${photo.id}`} className="text-sm font-medium text-gray-700">
          Alt text
        </label>
        <input
          id={`catalog-alt-${photo.id}`}
          type="text"
          name="altText"
          defaultValue={photo.altText ?? ''}
          maxLength={200}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
        />
        <p className="text-xs text-gray-400">
          Optional accessibility text for this public catalog reference image.
        </p>
        {altTextState?.error && (
          <p className="text-sm text-red-600">{altTextState.error}</p>
        )}
        <div>
          <SaveAltTextButton />
        </div>
      </form>

      <form action={deleteCatalogPhoto.bind(null, catalogId, photo.id)}>
        <button
          type="submit"
          className="rounded-md border border-red-200 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 transition-colors"
        >
          Delete reference image
        </button>
      </form>
    </div>
  )
}

export function CatalogPhotoUpload({ catalogId, photos }: Props) {
  const uploadAction = uploadCatalogPhoto.bind(null, catalogId)
  const [uploadState, uploadFormAction] = useActionState<CatalogPhotoActionState, FormData>(
    uploadAction,
    null
  )

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-semibold text-gray-900">Reference images (public)</p>
        <p className="text-xs text-gray-500 mt-0.5">
          These are generic catalog reference images, not photos of a specific inventory item or
          private collection item.
        </p>
        <p className="text-xs text-gray-400 mt-1">
          {photos.length} of {MAX_PHOTOS} reference images
        </p>
      </div>

      {photos.length > 0 && (
        <div className="space-y-3">
          {photos.map((photo, i) => (
            <CatalogPhotoRow
              key={photo.id}
              catalogId={catalogId}
              photo={photo}
              isPrimary={i === 0}
            />
          ))}
        </div>
      )}

      {photos.length < MAX_PHOTOS ? (
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
      ) : (
        <p className="text-sm text-gray-500">Maximum of 3 reference images reached.</p>
      )}
    </div>
  )
}
