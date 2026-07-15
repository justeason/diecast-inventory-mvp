'use server'

import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'

const VALID_STATUSES = ['pending', 'active', 'suspended'] as const

function isValidCommissionRate(v: string | undefined): boolean {
  if (!v || !v.trim()) return false
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 && n <= 1
}

const CreateSchema = z.object({
  profileId:      z.string().min(1, 'Customer profile is required'),
  displayName:    z.string().optional(),
  status:         z.enum(VALID_STATUSES, { error: 'Status must be pending, active, or suspended' }),
  commissionRate: z.string().refine(isValidCommissionRate, 'Must be a number between 0 and 1 (e.g. 0.20 for 20%)'),
  payoutMethod:   z.string().optional(),
  payoutHandle:   z.string().optional(),
  notes:          z.string().optional(),
})

const UpdateSchema = z.object({
  displayName:    z.string().optional(),
  status:         z.enum(VALID_STATUSES, { error: 'Status must be pending, active, or suspended' }),
  commissionRate: z.string().refine(isValidCommissionRate, 'Must be a number between 0 and 1 (e.g. 0.20 for 20%)'),
  payoutMethod:   z.string().optional(),
  payoutHandle:   z.string().optional(),
  notes:          z.string().optional(),
})

export type SellerProfileActionState = { errors: Record<string, string[]> } | null

export async function createSellerProfile(
  _prev: SellerProfileActionState,
  formData: FormData
): Promise<SellerProfileActionState> {
  const result = CreateSchema.safeParse(Object.fromEntries(formData))
  if (!result.success) return { errors: result.error.flatten().fieldErrors as Record<string, string[]> }

  const { profileId, displayName, status, commissionRate, payoutMethod, payoutHandle, notes } = result.data

  const customerProfile = await prisma.customerProfile.findUnique({ where: { id: profileId } })
  if (!customerProfile) {
    return { errors: { profileId: ['Customer profile not found.'] } }
  }

  const existing = await prisma.sellerProfile.findUnique({ where: { profileId } })
  if (existing) {
    return { errors: { profileId: ['This customer already has a seller profile.'] } }
  }

  const sp = await prisma.sellerProfile.create({
    data: {
      profileId,
      displayName:    displayName    || undefined,
      status,
      commissionRate: Number(commissionRate),
      payoutMethod:   payoutMethod   || undefined,
      payoutHandle:   payoutHandle   || undefined,
      notes:          notes          || undefined,
    },
  })

  redirect(`/admin/seller-profiles/${sp.id}`)
}

export async function updateSellerProfile(
  id: string,
  _prev: SellerProfileActionState,
  formData: FormData
): Promise<SellerProfileActionState> {
  const result = UpdateSchema.safeParse(Object.fromEntries(formData))
  if (!result.success) return { errors: result.error.flatten().fieldErrors as Record<string, string[]> }

  const { displayName, status, commissionRate, payoutMethod, payoutHandle, notes } = result.data

  await prisma.sellerProfile.update({
    where: { id },
    data: {
      displayName:    displayName    || null,
      status,
      commissionRate: Number(commissionRate),
      payoutMethod:   payoutMethod   || null,
      payoutHandle:   payoutHandle   || null,
      notes:          notes          || null,
    },
  })

  revalidatePath(`/admin/seller-profiles/${id}`)
  revalidatePath('/admin/seller-profiles')
  redirect(`/admin/seller-profiles/${id}`)
}
