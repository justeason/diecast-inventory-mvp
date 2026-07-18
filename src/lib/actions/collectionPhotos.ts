'use server'

import crypto from 'crypto'
import { del } from '@vercel/blob'
import { prisma } from '@/lib/prisma'
import { getBuyerSession } from '@/lib/buyerSession'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { ALLOWED_MIME, validateBlobFile, uploadToBlob } from '@/lib/blobUpload'

// Collection photos are for the user's own item/condition evidence.
// Catalog/reference photos should live on CatalogModel in a later milestone,
// not be duplicated into CollectionItemPhoto.
const MAX_COLLECTION_PHOTOS = 3
const VALID_PHOTO_TYPES   = ['front', 'back', 'detail', 'other'] as const

export type CollectionPhotoActionState = { error: string } | null

export async function uploadCollectionPhoto(
  itemId: string,
  _prev: CollectionPhotoActionState,
  formData: FormData
): Promise<CollectionPhotoActionState> {
  const session = await getBuyerSession()
  if (!session) return { error: 'You must be signed in to upload photos.' }

  // Verify the collection item exists and belongs to this session's profile
  const item = await prisma.collectionItem.findFirst({
    where: { id: itemId, profileId: session.profileId },
    select: { id: true, _count: { select: { photos: true } } },
  })
  if (!item) return { error: 'Collection item not found.' }

  // Enforce photo limit
  if (item._count.photos >= MAX_COLLECTION_PHOTOS) {
    return { error: 'You can upload up to 3 photos per collection item.' }
  }

  // Validate file
  const file = formData.get('photo')
  if (!(file instanceof File) || file.size === 0) return { error: 'No file selected.' }

  const validation = validateBlobFile(file)
  if (!validation.valid) return { error: validation.error }

  // Validate and normalise photo type
  const typeRaw  = (formData.get('type') as string | null)?.trim() ?? 'other'
  const type     = (VALID_PHOTO_TYPES as readonly string[]).includes(typeRaw) ? typeRaw : 'other'

  // Build a non-guessable blob path scoped to this owner and item
  const ext      = ALLOWED_MIME[file.type]
  const random   = crypto.randomBytes(8).toString('hex')
  const pathname = `collection/${session.profileId}/${itemId}/${Date.now()}-${random}-${type}.${ext}`

  const url = await uploadToBlob(pathname, file)
  if (!url) return { error: 'Upload failed. Please try again.' }

  await prisma.collectionItemPhoto.create({
    data: {
      itemId,
      url,
      type,
      sortOrder: item._count.photos, // append after existing photos
    },
  })

  revalidatePath(`/account/collection/${itemId}`)
  redirect(`/account/collection/${itemId}`)
}

export async function deleteCollectionPhoto(photoId: string): Promise<void> {
  const session = await getBuyerSession()
  if (!session) redirect('/account/orders')

  // Verify ownership through the relation — only the item owner can delete photos
  const photo = await prisma.collectionItemPhoto.findFirst({
    where: {
      id:   photoId,
      item: { profileId: session.profileId },
    },
    select: { id: true, url: true, itemId: true },
  })
  if (!photo) redirect('/account/collection')

  // Delete DB row first
  await prisma.collectionItemPhoto.delete({ where: { id: photo.id } })

  // Best-effort blob deletion — consistent with admin intake pattern: log on failure, don't crash
  try {
    await del(photo.url)
  } catch (err) {
    console.error(
      '[deleteCollectionPhoto] Failed to delete blob for photo',
      photo.id,
      ':',
      err instanceof Error ? err.message : 'UnknownError'
    )
  }

  revalidatePath(`/account/collection/${photo.itemId}`)
  redirect(`/account/collection/${photo.itemId}`)
}
