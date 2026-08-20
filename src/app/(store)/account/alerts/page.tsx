import { notFound, redirect } from 'next/navigation'
import { getBuyerSession } from '@/lib/buyerSession'

export const dynamic = 'force-dynamic'

// 16D: Alerts is now part of the unified Wanted & Alerts experience at
// /account/wanted — this route is preserved (not deleted) purely so existing
// bookmarks/links keep working, and still independently gates on session like
// every other private account page. `cursor` was the only query parameter the
// old /account/alerts page ever supported (keyset pagination) — carried through
// so a bookmarked/paginated deep link still lands on the same page of history,
// not silently reset to page 1.
export default async function AlertsRedirectPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>
}) {
  const session = await getBuyerSession()
  if (!session) notFound()
  const { cursor } = await searchParams
  redirect(`/account/wanted?view=alerts${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
}
