import type { Metadata } from 'next'
import Link from 'next/link'
import { VerifyBuyerLoginForm } from '@/components/store/VerifyBuyerLoginForm'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Sign In | CollectNTrades',
  robots: { index: false, follow: false },
}

// Raw token produced by crypto.randomBytes(32).toString('hex') — always 64 lowercase hex chars.
// This pattern check is format-only; it does NOT touch the database on GET.
const VALID_TOKEN_RE = /^[0-9a-f]{64}$/

export default async function VerifyOrderAccessPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>
}) {
  const { token } = await searchParams

  // Format check only — do not query or consume the token on GET.
  // Email scanners fetch links but do not submit forms, so the token stays valid
  // until the buyer explicitly clicks the confirmation button below.
  const tokenIsValid = typeof token === 'string' && VALID_TOKEN_RE.test(token)

  if (!tokenIsValid) {
    return (
      <div className="max-w-md">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">Invalid sign-in link</h1>
        <p className="text-sm text-gray-600 mb-6">
          This sign-in link is missing or not valid. Links expire after 15 minutes and
          can only be used once. Please request a new one.
        </p>
        <Link
          href="/account/orders"
          className="text-sm font-medium text-gray-900 hover:underline underline-offset-2"
        >
          ← Back to My Orders
        </Link>
      </div>
    )
  }

  return (
    <div className="max-w-md">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Sign in to CollectNTrades</h1>
      <p className="text-sm text-gray-500 mb-8">
        Click the button below to view your order history.
        This link can only be used once.
      </p>

      {/* Token is passed to the client form as a prop.
          It is placed in a hidden input and submitted via POST (Server Action).
          It is never rendered as visible text. */}
      <VerifyBuyerLoginForm token={token} />

      <p className="mt-6 text-xs text-gray-400">
        Didn&rsquo;t request this?{' '}
        <Link href="/account/orders" className="underline underline-offset-2 hover:text-gray-600">
          Go back
        </Link>{' '}
        — your account is not at risk.
      </p>
    </div>
  )
}
