'use server'

import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { redirect } from 'next/navigation'

const LocationSchema = z.object({
  label: z.string().min(1, 'Label is required'),
  notes: z.string().optional(),
})

export type LocationActionState = { errors: Record<string, string[]> } | null

export async function createStorageLocation(
  _prev: LocationActionState,
  formData: FormData
): Promise<LocationActionState> {
  const result = LocationSchema.safeParse(Object.fromEntries(formData))
  if (!result.success) return { errors: result.error.flatten().fieldErrors as Record<string, string[]> }

  await prisma.storageLocation.create({
    data: { label: result.data.label, notes: result.data.notes || undefined },
  })
  redirect('/admin/locations')
}

export async function updateStorageLocation(
  id: string,
  _prev: LocationActionState,
  formData: FormData
): Promise<LocationActionState> {
  const result = LocationSchema.safeParse(Object.fromEntries(formData))
  if (!result.success) return { errors: result.error.flatten().fieldErrors as Record<string, string[]> }

  await prisma.storageLocation.update({
    where: { id },
    data: { label: result.data.label, notes: result.data.notes || undefined },
  })
  redirect('/admin/locations')
}
