import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getBuyerSession } from '@/lib/buyerSession'
import { isSafeAccountReturnTo } from '@/lib/customerModelIntent'
import { BuyerOrderAccessForm } from '@/components/store/BuyerOrderAccessForm'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Create Account | CollectNTrades',
  robots: { index: false, follow: false },
}

// 19A section 15/17: email-only, verification-first signup. No password field
// here at all — a password can only ever be set from an already-AUTHENTICATED
// session (see customerCredential.ts's setPassword), never before email
// ownership is proven. This reuses the existing magic-link request action
// unchanged, with postVerify='setup_password' so verification lands the new
// customer directly on the Password setup section instead of /account/orders.
//
// 19C section 5: a guest seller may choose Create Account from the claim
// sign-in surface — returnTo is re-validated here (never trust the query
// string as-is) and passed through alongside postVerify. verifyBuyerLoginToken's
// existing precedence (returnTo wins over postVerify) means the new customer
// still lands on /account/sell/claim to recover their saved batch, without
// forcing password setup first — that can happen later from /account/profile.
export default async function CreateAccountPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string }>
}) {
  const { returnTo } = await searchParams
  const safeReturnTo = isSafeAccountReturnTo(returnTo)

  const session = await getBuyerSession()
  if (session) redirect(safeReturnTo ?? '/account')

  return (
    <div className="max-w-md">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Create Account</h1>
      <p className="text-sm text-gray-500 mb-8">
        We&rsquo;ll email you a secure link to verify your account. After verification, you
        can set your password.
      </p>
      <BuyerOrderAccessForm returnTo={safeReturnTo ?? undefined} postVerify="setup_password" />
      <p className="mt-6 text-sm text-gray-500">
        Already have an account?{' '}
        <Link href="/account/sign-in" className="font-medium text-gray-900 underline underline-offset-2">
          Sign in
        </Link>
      </p>
    </div>
  )
}
