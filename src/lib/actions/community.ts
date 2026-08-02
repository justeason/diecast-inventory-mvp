'use server'

import { updateTag } from 'next/cache'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { getBuyerSession } from '@/lib/buyerSession'
import {
  trimInput,
  normalizeHandle,
  validateNoControlChars,
  validateHandle,
  validateDisplayName,
  validateBio,
} from '@/lib/communityLeaderboards'

export type CommunityProfileState = {
  errors?: {
    handle?: string[]
    displayName?: string[]
    bio?: string[]
    _form?: string[]
  }
  success?: boolean
} | null

export async function saveCommunityProfile(
  _prev: CommunityProfileState,
  formData: FormData,
): Promise<CommunityProfileState> {
  const session = await getBuyerSession()
  if (!session) return { errors: { _form: ['You must be signed in.'] } }

  const rawHandle = trimInput(formData.get('handle')?.toString() ?? '')
  const rawDisplayName = trimInput(formData.get('displayName')?.toString() ?? '')
  const rawBio = trimInput(formData.get('bio')?.toString() ?? '')
  const isPublic = formData.get('isPublic') === 'true'
  const showOnLeaderboards = formData.get('showOnLeaderboards') === 'true'

  // Detect control characters before any normalization
  const errors: NonNullable<CommunityProfileState>['errors'] = {}
  const ctrlErr = 'Input contains invalid characters. Please remove any special or control characters.'
  if (validateNoControlChars(rawHandle)) errors.handle = [ctrlErr]
  if (validateNoControlChars(rawDisplayName)) errors.displayName = [ctrlErr]
  if (rawBio && validateNoControlChars(rawBio)) errors.bio = [ctrlErr]
  if (Object.keys(errors).length > 0) return { errors }

  const handle = normalizeHandle(rawHandle)
  const displayName = rawDisplayName
  const bio = rawBio

  const handleError = validateHandle(handle)
  if (handleError) errors.handle = [handleError]
  const displayNameError = validateDisplayName(displayName)
  if (displayNameError) errors.displayName = [displayNameError]
  const bioError = validateBio(bio)
  if (bioError) errors.bio = [bioError]
  if (Object.keys(errors).length > 0) return { errors }

  const existing = await prisma.customerCommunityProfile.findUnique({
    where: { handle },
    select: { profileId: true },
  })
  if (existing && existing.profileId !== session.profileId) {
    return { errors: { handle: ['This handle is already taken.'] } }
  }

  try {
    await prisma.customerCommunityProfile.upsert({
      where: { profileId: session.profileId },
      create: {
        profileId: session.profileId,
        handle,
        displayName,
        bio: bio || null,
        isPublic,
        showOnLeaderboards,
      },
      update: {
        handle,
        displayName,
        bio: bio || null,
        isPublic,
        showOnLeaderboards,
      },
    })
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return { errors: { handle: ['This handle is already taken.'] } }
    }
    throw e
  }

  updateTag('community-leaderboards')
  return { success: true }
}
