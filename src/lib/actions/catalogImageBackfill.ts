'use server'

import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { isAdminAuthenticated } from '@/lib/adminAuth'
import { computeImageFingerprint, ALGORITHM_VERSION } from '@/lib/catalogImageFingerprint'
import { fetchTrustedBlobImage, isTrustedBlobUrl } from '@/lib/catalogTrustedFetch'

const BATCH_SIZE = 25

export type BackfillState = {
  processed:  number
  succeeded:  number
  failed:     number
  skipped:    number
  hasMore:    boolean
  errors:     string[]
} | null

export async function generateFingerprintBatch(): Promise<BackfillState> {
  if (!await isAdminAuthenticated()) {
    return { processed: 0, succeeded: 0, failed: 0, skipped: 0, hasMore: false, errors: ['Unauthorized'] }
  }

  // Always process photos missing a fingerprint for the current algorithm version.
  // After each batch, processed photos have fingerprints and won't reappear.
  const photos = await prisma.catalogModelPhoto.findMany({
    where: {
      NOT: { fingerprints: { some: { algorithmVersion: ALGORITHM_VERSION } } },
    },
    orderBy: { id: 'asc' },
    take: BATCH_SIZE + 1,
    select: { id: true, catalogId: true, url: true },
  })

  const hasMore = photos.length > BATCH_SIZE
  const batch   = photos.slice(0, BATCH_SIZE)

  if (batch.length === 0) {
    return { processed: 0, succeeded: 0, failed: 0, skipped: 0, hasMore: false, errors: [] }
  }

  let succeeded = 0, failed = 0, skipped = 0
  const errors: string[] = []

  for (const photo of batch) {
    if (!isTrustedBlobUrl(photo.url)) {
      skipped++
      errors.push(`Photo ${photo.id}: URL not from trusted origin — skipped`)
      continue
    }

    try {
      const { buffer, mimeType } = await fetchTrustedBlobImage(photo.url)
      const fp = await computeImageFingerprint(buffer, mimeType)

      await prisma.catalogPhotoFingerprint.upsert({
        where: {
          catalogPhotoId_algorithmVersion: {
            catalogPhotoId:   photo.id,
            algorithmVersion: fp.algorithmVersion,
          },
        },
        create: {
          catalogModelId: photo.catalogId,
          catalogPhotoId: photo.id,
          ...fp,
        },
        update: { ...fp },
      })
      succeeded++
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        succeeded++ // concurrent duplicate — already written
      } else {
        failed++
        errors.push(`Photo ${photo.id}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  return {
    processed: batch.length,
    succeeded,
    failed,
    skipped,
    hasMore,
    errors: errors.slice(0, 20),
  }
}
