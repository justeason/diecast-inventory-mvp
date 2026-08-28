'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/prisma'
import { getBuyerSession } from '@/lib/buyerSession'

export type CustomerAccountInfoState = {
  errors?: {
    name?: string[]
    phone?: string[]
    _form?: string[]
  }
  success?: boolean
} | null

const MAX_NAME_LENGTH = 100
const MAX_PHONE_LENGTH = 30
// No phone-validation convention exists elsewhere in the app (checkout accepts
// any optional string) — this is intentionally light-touch: digits plus the
// separators/punctuation phone numbers commonly use, not a full E.164 validator.
const PHONE_RE = /^[0-9+()\-.\s]*$/

function trimOrNull(v: string): string | null {
  const t = v.trim()
  return t || null
}

// Login email is deliberately not accepted here — it is read-only in this form
// (no change-email workflow yet). Only name/phone are buyer-editable.
export async function updateCustomerAccountInfo(
  _prev: CustomerAccountInfoState,
  formData: FormData,
): Promise<CustomerAccountInfoState> {
  const session = await getBuyerSession()
  if (!session) return { errors: { _form: ['You must be signed in.'] } }

  const rawName = (formData.get('name')?.toString() ?? '').trim()
  const rawPhone = (formData.get('phone')?.toString() ?? '').trim()

  const errors: NonNullable<CustomerAccountInfoState>['errors'] = {}
  if (rawName.length > MAX_NAME_LENGTH) errors.name = [`Name must be ${MAX_NAME_LENGTH} characters or fewer.`]
  if (/[\x00-\x1F\x7F]/.test(rawName)) errors.name = ['Name contains invalid characters.']
  if (rawPhone.length > MAX_PHONE_LENGTH) errors.phone = [`Phone must be ${MAX_PHONE_LENGTH} characters or fewer.`]
  if (rawPhone && !PHONE_RE.test(rawPhone)) errors.phone = ['Enter a valid phone number.']
  if (Object.keys(errors).length > 0) return { errors }

  // Optimistic concurrency — same expectedUpdatedAt + updateMany pattern as
  // updateCollectionItem (collectionItems.ts), the established precedent for a
  // buyer editing their own record.
  const expectedUpdatedAtRaw = formData.get('expectedUpdatedAt')?.toString() ?? ''
  if (!expectedUpdatedAtRaw) return { errors: { _form: ['Please refresh the page and try again.'] } }
  const expectedUpdatedAt = new Date(expectedUpdatedAtRaw)
  if (isNaN(expectedUpdatedAt.getTime())) return { errors: { _form: ['Please refresh the page and try again.'] } }

  const result = await prisma.customerProfile.updateMany({
    where: { id: session.profileId, updatedAt: expectedUpdatedAt },
    data: { name: trimOrNull(rawName), phone: trimOrNull(rawPhone) },
  })

  if (result.count === 0) {
    return { errors: { _form: ['Your account was updated elsewhere. Refresh and try again.'] } }
  }

  // 16N: only /account/profile itself displays name/phone — /account (overview)
  // reads only getAccountOverview(profileId) (orders/collection/wanted/selling
  // counts, no identity fields) and /account/community reads only
  // CustomerCommunityProfile, never CustomerProfile.name/phone — so neither
  // needs revalidation here.
  revalidatePath('/account/profile')
  return { success: true }
}
