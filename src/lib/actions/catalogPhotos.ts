'use server'

import crypto from 'crypto'
import { del } from '@vercel/blob'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { ALLOWED_MIME, validateBlobFile, uploadToBlob } from '@/lib/blobUpload'
import { computeImageFingerprint } from '@/lib/catalogImageFingerprint'
import { isAdminAuthenticated } from '@/lib/adminAuth'

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

  // Compute fingerprint from buffer before uploading. If it fails, the photo still saves.
  const fileBuffer = Buffer.from(await file.arrayBuffer())
  let fingerprintData: Awaited<ReturnType<typeof computeImageFingerprint>> | null = null
  try {
    fingerprintData = await computeImageFingerprint(fileBuffer, file.type)
  } catch (e) {
    console.error('[uploadCatalogPhoto] Fingerprint failed:', e instanceof Error ? e.message : e)
  }

  const url = await uploadToBlob(pathname, new File([fileBuffer], file.name, { type: file.type }))
  if (!url) return { error: 'Upload failed. Please try again.' }

  const nextSortOrder = existingPhotos.length > 0 ? existingPhotos[0].sortOrder + 1 : 0

  try {
    await prisma.$transaction(async tx => {
      const photo = await tx.catalogModelPhoto.create({
        data: { catalogId, url, altText, sortOrder: nextSortOrder },
      })
      if (fingerprintData) {
        try {
          await tx.catalogPhotoFingerprint.create({
            data: { catalogModelId: catalogId, catalogPhotoId: photo.id, ...fingerprintData },
          })
        } catch (e) {
          if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e
          // P2002: fingerprint for this photo/version already exists — safe to ignore
        }
      }
    })
  } catch (txErr) {
    // Transaction failed — remove the orphaned blob so storage stays consistent.
    try { await del(url) } catch { /* best-effort; blob may not exist */ }
    console.error('[uploadCatalogPhoto] Transaction failed:', txErr instanceof Error ? txErr.message : txErr)
    return { error: 'Failed to save photo. Please try again.' }
  }

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

export async function setPrimaryCatalogPhoto(catalogId: string, photoId: string, formData: FormData): Promise<void> {
  if (!await isAdminAuthenticated()) redirect('/admin/login')

  // Parse expected photo order from the form submission for stale-state detection.
  type PhotoOrder = { id: string; sortOrder: number }
  let expectedOrder: PhotoOrder[] | null = null
  const expectedRaw = formData.get('expectedPhotoOrder') as string | null
  if (expectedRaw) {
    try { expectedOrder = JSON.parse(expectedRaw) } catch { /* skip stale check */ }
  }

  try {
    await prisma.$transaction(async (tx) => {
      // 1. Lock CatalogModel FOR UPDATE before touching any photos
      await tx.$queryRaw`SELECT id FROM "CatalogModel" WHERE id = ${catalogId} FOR UPDATE`

      const modelExists = await tx.catalogModel.findUnique({ where: { id: catalogId }, select: { id: true } })
      if (!modelExists) throw new Error('ABORT')

      // 2. Enumerate all photos, then lock each in stable ID order (prevents deadlock with concurrent reorders)
      const photoIdRows = await tx.catalogModelPhoto.findMany({
        where:   { catalogId },
        select:  { id: true },
        orderBy: { id: 'asc' },
      })
      for (const p of photoIdRows) {
        await tx.$queryRaw`SELECT id FROM "CatalogModelPhoto" WHERE id = ${p.id} FOR UPDATE`
      }

      // 3. Verify the target photo still belongs to this model after acquiring locks
      if (!photoIdRows.find(p => p.id === photoId)) throw new Error('ABORT')

      // 4. Re-read ordering after locks to reflect committed state
      const currentPhotos = await tx.catalogModelPhoto.findMany({
        where:   { catalogId },
        select:  { id: true, sortOrder: true },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      })

      // 5. Stale-state check: reject if photo order changed since the form was rendered
      if (expectedOrder) {
        const currentSorted  = [...currentPhotos].sort((a, b) => a.id < b.id ? -1 : 1)
        const expectedSorted = [...expectedOrder].sort((a, b) => a.id < b.id ? -1 : 1)
        const stale =
          currentSorted.length !== expectedSorted.length ||
          currentSorted.some((p, i) => p.id !== expectedSorted[i].id || p.sortOrder !== expectedSorted[i].sortOrder)
        if (stale) throw new Error('STALE_PHOTO_ORDER')
      }

      const beforeOrder = currentPhotos.map(p => ({ id: p.id, sortOrder: p.sortOrder }))
      const reordered   = [
        currentPhotos.find(p => p.id === photoId)!,
        ...currentPhotos.filter(p => p.id !== photoId),
      ]

      // 6. Two-phase reorder: shift to guaranteed-unused temp positions, then write final 0..n-1.
      //    tempOffset = max(existing sortOrders) + n + 1 so temp values cannot collide with
      //    any existing sortOrder (including malformed values like 0, 10000, 20000) or with
      //    the final 0..n-1 positions.
      const maxSortOrder = currentPhotos.reduce((m, p) => Math.max(m, p.sortOrder), 0)
      const tempOffset   = maxSortOrder + currentPhotos.length + 1
      for (const [idx, p] of currentPhotos.entries()) {
        await tx.catalogModelPhoto.update({ where: { id: p.id }, data: { sortOrder: tempOffset + idx } })
      }
      for (const [i, p] of reordered.entries()) {
        await tx.catalogModelPhoto.update({ where: { id: p.id }, data: { sortOrder: i } })
      }

      // 7. Write audit record in the same TX (atomic with the reorder)
      await tx.catalogDataQualityAudit.create({
        data: {
          issueKey:       `set_primary_photo:${photoId}`,
          action:         'set_primary_photo',
          catalogModelId: catalogId,
          beforeSnapshot: { photoOrder: beforeOrder, selectedPhotoId: photoId } as object,
          afterSnapshot:  { photoOrder: reordered.map((p, i) => ({ id: p.id, sortOrder: i })), selectedPhotoId: photoId } as object,
        },
      })
    })
  } catch (e) {
    if ((e as Error).message === 'ABORT') redirect(`/admin/catalog/${catalogId}/edit`)
    if ((e as Error).message === 'STALE_PHOTO_ORDER') redirect(`/admin/catalog/${catalogId}/edit`)
    throw e
  }

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
