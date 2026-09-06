import Link from 'next/link'
import { PasswordSignInForm } from '@/components/store/PasswordSignInForm'
import { BuyerOrderAccessForm } from '@/components/store/BuyerOrderAccessForm'

// 19A: the one compact, reusable auth-access panel — password sign-in, the
// existing magic-link request form as "Forgot password?", and a Create Account
// link, all sharing the same optional `returnTo` so every signed-out surface
// (dedicated /account/sign-in page, /account/continue's intent-preserving
// landing) offers password login without duplicating any auth logic. Server
// Component — both child forms are the ones that carry 'use client'.
export function CustomerSignInPanel({ returnTo }: { returnTo?: string } = {}) {
  return (
    <div className="space-y-8">
      <PasswordSignInForm returnTo={returnTo} />

      <div>
        <p className="text-sm font-medium text-gray-700 mb-2">Forgot password?</p>
        <BuyerOrderAccessForm returnTo={returnTo} />
      </div>

      <p className="text-sm text-gray-500">
        New to CollectNTrades?{' '}
        <Link href="/account/create-account" className="font-medium text-gray-900 underline underline-offset-2">
          Create account
        </Link>
      </p>
    </div>
  )
}
