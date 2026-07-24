'use server'

import crypto from 'crypto'
import { del } from '@vercel/blob'
import { prisma } from '@/lib/prisma'
import { getBuyerSession } from '@/lib/buyerSession'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { ALLOWED_MIME, validateBlobFile, uploadToBlob } from '@/lib/blobUpload'

const MAX_SELLER_SUBMISSION_PHOTOS = 5
const EDITABLE_PHOTO_STATUSES = ['submitted', 'needs_info']

export type SellerSubmissionPhotoActionState = { error: string } | null

export async function uploadSellerSubmissionPhoto(
  submissionId: string,
  _prev: SellerSubmissionPhotoActionState,
  formData: FormData
): Promise<SellerSubmissionPhotoActionState> {
  const session = await getBuyerSession()
  if (!session) return { error: 'You must be signed in to upload photos.' }

  const submission = await prisma.sellerSubmission.findFirst({
    where: { id: submissionId, profileId: session.profileId },
    select: {
      id: true,
      status: true,
      _count: { select: { photos: true } },
    },
  })
  if (!submission) return { error: 'Sell request not found.' }

  if (!EDITABLE_PHOTO_STATUSES.includes(submission.status)) {
    return { error: 'Photos can no longer be changed for this sell request.' }
  }

  if (submission._count.photos >= MAX_SELLER_SUBMISSION_PHOTOS) {
    return { error: 'Maximum of 5 photos reached.' }
  }

  const file = formData.get('photo')
  if (!(file instanceof File) || file.size === 0) return { error: 'No file selected.' }

  const validation = validateBlobFile(file)
  if (!validation.valid) return { error: validation.error }

  const ext = ALLOWED_MIME[file.type]
  const random = crypto.randomBytes(8).toString('hex')
  const pathname = `seller-submissions/${submissionId}/${Date.now()}-${random}.${ext}`

  const url = await uploadToBlob(pathname, file)
  if (!url) return { error: 'Upload failed. Please try again.' }

  await prisma.sellerSubmissionPhoto.create({
    data: {
      submissionId,
      url,
      sortOrder: submission._count.photos,
    },
  })

  revalidatePath(`/account/sell/${submissionId}`)
  revalidatePath(`/admin/seller-submissions/${submissionId}`)
  redirect(`/account/sell/${submissionId}`)
}

export async function deleteSellerSubmissionPhoto(photoId: string): Promise<void> {
  const session = await getBuyerSession()
  if (!session) redirect('/account/sell')

  const photo = await prisma.sellerSubmissionPhoto.findFirst({
    where: {
      id: photoId,
      submission: { profileId: session.profileId },
    },
    select: {
      id: true,
      url: true,
      submissionId: true,
      submission: { select: { status: true } },
    },
  })
  if (!photo) redirect('/account/sell')

  if (!EDITABLE_PHOTO_STATUSES.includes(photo.submission.status)) {
    redirect(`/account/sell/${photo.submissionId}`)
  }

  await prisma.sellerSubmissionPhoto.delete({ where: { id: photo.id } })

  try {
    await del(photo.url)
  } catch (err) {
    console.error(
      '[deleteSellerSubmissionPhoto] Failed to delete blob for photo',
      photo.id,
      ':',
      err instanceof Error ? err.message : 'UnknownError'
    )
  }

  revalidatePath(`/account/sell/${photo.submissionId}`)
  revalidatePath(`/admin/seller-submissions/${photo.submissionId}`)
  redirect(`/account/sell/${photo.submissionId}`)
}
