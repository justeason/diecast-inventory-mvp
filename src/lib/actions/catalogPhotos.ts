'use server'

import crypto from 'crypto'
import { del } from '@vercel/blob'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { ALLOWED_MIME, validateBlobFile, uploadToBlob } from '@/lib/blobUpload'

// Admin catalog photo actions rely on the (admin) route group middleware for auth,
// consistent with all other admin server actions in this repo (catalog.ts, adminCatalogSuggestions.ts, etc.).

const MAX_CATALOG_PHOTOS = 3

export type CatalogPhotoActionState = { error: string } | null

export async function uploadCatalogPhoto(
  catalogId: string,
  _prev: CatalogPhotoActionState,
  formData: FormData
): Promise<CatalogPhotoActionState> {
  const catalog = await prisma.catalogModel.findUnique({
    where: { id: catalogId },
    select: { id: true },
  })
  if (!catalog) return { error: 'Catalog model not found.' }

  // Fetch existing photos to check count and determine next sortOrder
  const existingPhotos = await prisma.catalogModelPhoto.findMany({
    where: { catalogId },
    orderBy: { sortOrder: 'desc' },
    select: { sortOrder: true },
  })

  if (existingPhotos.length >= MAX_CATALOG_PHOTOS) {
    return { error: 'This model already has the maximum of 3 reference images.' }
  }

  const file = formData.get('photo')
  if (!(file instanceof File) || file.size === 0) return { error: 'No file selected.' }

  const validation = validateBlobFile(file)
  if (!validation.valid) return { error: validation.error }

  const altTextRaw = (formData.get('altText') as string | null)?.trim() ?? ''
  const altText = altTextRaw.slice(0, 200) || null

  const ext = ALLOWED_MIME[file.type]
  const random = crypto.randomBytes(8).toString('hex')
  const pathname = `catalog/${catalogId}/${Date.now()}-${random}.${ext}`

  const url = await uploadToBlob(pathname, file)
  if (!url) return { error: 'Upload failed. Please try again.' }

  const nextSortOrder = existingPhotos.length > 0 ? existingPhotos[0].sortOrder + 1 : 0

  await prisma.catalogModelPhoto.create({
    data: { catalogId, url, altText, sortOrder: nextSortOrder },
  })

  revalidatePath('/admin/catalog')
  revalidatePath(`/admin/catalog/${catalogId}/edit`)
  redirect(`/admin/catalog/${catalogId}/edit`)
}

export async function updateCatalogPhotoAltText(
  catalogId: string,
  photoId: string,
  _prev: CatalogPhotoActionState,
  formData: FormData
): Promise<CatalogPhotoActionState> {
  const photo = await prisma.catalogModelPhoto.findFirst({
    where: { id: photoId, catalogId },
    select: { id: true },
  })
  if (!photo) return { error: 'Photo not found.' }

  const raw = (formData.get('altText') as string | null)?.trim() ?? ''
  const altText = raw.slice(0, 200) || null

  await prisma.catalogModelPhoto.update({
    where: { id: photo.id },
    data: { altText },
  })

  revalidatePath('/admin/catalog')
  revalidatePath(`/admin/catalog/${catalogId}/edit`)
  redirect(`/admin/catalog/${catalogId}/edit`)
}

export async function setPrimaryCatalogPhoto(catalogId: string, photoId: string): Promise<void> {
  const photo = await prisma.catalogModelPhoto.findFirst({
    where: { id: photoId, catalogId },
    select: { id: true },
  })
  if (!photo) {
    redirect(`/admin/catalog/${catalogId}/edit`)
  }

  const allPhotos = await prisma.catalogModelPhoto.findMany({
    where: { catalogId },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    select: { id: true },
  })

  // Selected photo gets sortOrder 0; remaining keep their relative order
  const reordered = [
    allPhotos.find((p) => p.id === photo.id)!,
    ...allPhotos.filter((p) => p.id !== photo.id),
  ]

  await prisma.$transaction(
    reordered.map((p, i) =>
      prisma.catalogModelPhoto.update({ where: { id: p.id }, data: { sortOrder: i } })
    )
  )

  revalidatePath('/admin/catalog')
  revalidatePath(`/admin/catalog/${catalogId}/edit`)
  revalidatePath('/account/collection')
  revalidatePath('/browse')
  redirect(`/admin/catalog/${catalogId}/edit`)
}

export async function deleteCatalogPhoto(catalogId: string, photoId: string): Promise<void> {
  const photo = await prisma.catalogModelPhoto.findFirst({
    where: { id: photoId, catalogId },
    select: { id: true, url: true },
  })
  if (!photo) {
    redirect(`/admin/catalog/${catalogId}/edit`)
  }

  await prisma.catalogModelPhoto.delete({ where: { id: photo.id } })

  try {
    await del(photo.url)
  } catch (err) {
    console.error(
      '[deleteCatalogPhoto] Failed to delete blob for photo',
      photo.id,
      ':',
      err instanceof Error ? err.message : 'UnknownError'
    )
  }

  // Compact sortOrder so remaining photos stay at 0, 1, 2 with no gaps
  const remaining = await prisma.catalogModelPhoto.findMany({
    where: { catalogId },
    orderBy: { sortOrder: 'asc' },
    select: { id: true },
  })
  for (let i = 0; i < remaining.length; i++) {
    await prisma.catalogModelPhoto.update({
      where: { id: remaining[i].id },
      data: { sortOrder: i },
    })
  }

  revalidatePath('/admin/catalog')
  revalidatePath(`/admin/catalog/${catalogId}/edit`)
  revalidatePath('/account/collection')
  revalidatePath('/browse')
  redirect(`/admin/catalog/${catalogId}/edit`)
}
