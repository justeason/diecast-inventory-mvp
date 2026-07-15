'use client'

import { useActionState } from 'react'
import Link from 'next/link'
import type { CustomerProfile, SellerProfile } from '@prisma/client'
import {
  createSellerProfile,
  updateSellerProfile,
  type SellerProfileActionState,
} from '@/lib/actions/sellerProfiles'
import { Button } from '@/components/admin/ui/Button'
import { Input } from '@/components/admin/ui/Input'
import { Select } from '@/components/admin/ui/Select'

const STATUS_OPTIONS = [
  { value: 'pending',   label: 'Pending' },
  { value: 'active',    label: 'Active' },
  { value: 'suspended', label: 'Suspended' },
]

type CreateProps = {
  mode: 'create'
  eligibleProfiles: Pick<CustomerProfile, 'id' | 'email' | 'name'>[]
}

type EditProps = {
  mode: 'edit'
  sellerProfile: SellerProfile
  customerProfile: Pick<CustomerProfile, 'id' | 'email' | 'name'>
}

type Props = CreateProps | EditProps

export function SellerProfileForm(props: Props) {
  const isCreate = props.mode === 'create'

  const action = isCreate
    ? createSellerProfile
    : updateSellerProfile.bind(null, (props as EditProps).sellerProfile.id)

  const [state, formAction, isPending] = useActionState<SellerProfileActionState, FormData>(
    action,
    null
  )

  const errors = state?.errors ?? {}
  const sp     = isCreate ? null : (props as EditProps).sellerProfile

  const profileOptions = isCreate
    ? (props as CreateProps).eligibleProfiles.map((p) => ({
        value: p.id,
        label: p.name ? `${p.name} — ${p.email}` : p.email,
      }))
    : []

  return (
    <form action={formAction} className="space-y-4 max-w-lg">
      {/* Customer profile select — create only */}
      {isCreate && (
        <Select
          label="Customer Profile"
          name="profileId"
          required
          options={profileOptions}
          placeholder="Select a customer…"
          error={errors.profileId?.[0]}
        />
      )}

      <Input
        label="Display Name"
        name="displayName"
        defaultValue={sp?.displayName ?? ''}
        placeholder="e.g. JohnDiecast"
        error={errors.displayName?.[0]}
      />

      <Select
        label="Status"
        name="status"
        required
        options={STATUS_OPTIONS}
        defaultValue={sp?.status ?? 'pending'}
        error={errors.status?.[0]}
      />

      <Input
        label="Commission Rate"
        name="commissionRate"
        required
        type="number"
        step="0.01"
        min="0"
        max="1"
        defaultValue={sp ? String(sp.commissionRate) : '0.20'}
        placeholder="0.20"
        error={errors.commissionRate?.[0]}
      />
      <p className="text-xs text-gray-500 -mt-2">
        Enter as a decimal between 0 and 1. Example: 0.20 = 20%.
      </p>

      <Input
        label="Payout Method"
        name="payoutMethod"
        defaultValue={sp?.payoutMethod ?? ''}
        placeholder="e.g. venmo, paypal, check"
        error={errors.payoutMethod?.[0]}
      />

      <Input
        label="Payout Handle"
        name="payoutHandle"
        defaultValue={sp?.payoutHandle ?? ''}
        placeholder="e.g. @username or email"
        error={errors.payoutHandle?.[0]}
      />

      <Input
        label="Notes"
        name="notes"
        defaultValue={sp?.notes ?? ''}
        error={errors.notes?.[0]}
      />

      <div className="flex gap-3 pt-2">
        <Button type="submit" disabled={isPending}>
          {isPending ? 'Saving…' : isCreate ? 'Create Seller Profile' : 'Update Seller Profile'}
        </Button>
        <Link href="/admin/seller-profiles">
          <Button type="button" variant="secondary">Cancel</Button>
        </Link>
      </div>
    </form>
  )
}
