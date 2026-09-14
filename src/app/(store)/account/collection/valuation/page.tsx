import { redirect } from 'next/navigation'

// 25B: retired as a standalone page — Portfolio (Estimated Portfolio Value,
// Recorded Cost, Unrealized Gain/Loss, coverage) is now inline at the top of
// /account/collection. A server-side redirect (never a 404) preserves any
// bookmarked link to this route.
export default function CollectionValuationRedirectPage() {
  redirect('/account/collection')
}
