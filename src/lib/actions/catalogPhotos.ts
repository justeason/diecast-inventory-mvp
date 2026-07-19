'use server'

import crypto from 'crypto'
import { del } from '@vercel/blob'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { ALLOWED_MIME, validateBlobFile, uploadToBlob } from '@/lib/blobUpload'

// Admin catalog photo actions rely on the (admin) route group middleware for auth,
// consistent with all other admin server actions in this repo (catalog.ts, adminCatalogSuggestions.ts, etc.).

const MAX_CATALOG_PHOTOS = 1 // MVP: one reference image per catalog model

export type CatalogPhotoActionState = { error: string } | null

export async function uploadCatalogPhoto(
  catalogId: string,
  _prev: CatalogPhotoActionState,
  formData: FormData
): Promise<CatalogPhotoActionState> {
  const catalog = await prisma.catalogModel.findUnique({
    where: { id: catalogId },
    select: { id: true, _count: { select: { photos: true } } },
  })
  if (!catalog) return { error: 'Catalog model not found.' }

  if (catalog._count.photos >= MAX_CATALOG_PHOTOS) {
    return { error: 'This model already has a reference image. Delete the existing image before uploading a new one.' }
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

  await prisma.catalogModelPhoto.create({
    data: { catalogId, url, altText, sortOrder: 0 },
  })

  revalidatePath('/admin/catalog')
  revalidatePath(`/admin/catalog/${catalogId}/edit`)
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

  revalidatePath('/admin/catalog')
  revalidatePath(`/admin/catalog/${catalogId}/edit`)
  redirect(`/admin/catalog/${catalogId}/edit`)
}
