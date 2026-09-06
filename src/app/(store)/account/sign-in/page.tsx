import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getBuyerSession } from '@/lib/buyerSession'
import { isSafeAccountReturnTo } from '@/lib/customerModelIntent'
import { CustomerSignInPanel } from '@/components/store/CustomerSignInPanel'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Sign In | CollectNTrades',
  robots: { index: false, follow: false },
}

// 19A: the dedicated sign-in destination — password + magic-link + create
// account, all in one place. Already-authenticated visitors are simply sent on
// to their destination; this page has nothing further to offer them.
export default async function SignInPage({
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
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Sign In</h1>
      <p className="text-sm text-gray-500 mb-8">Sign in to your CollectNTrades account.</p>
      <CustomerSignInPanel returnTo={safeReturnTo ?? undefined} />
    </div>
  )
}
