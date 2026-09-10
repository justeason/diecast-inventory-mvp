// 16A: the ONE shared definition of customer-facing navigation — primary concepts
// plus the Account grouping. No separate drifting arrays for desktop/mobile/
// authenticated/anonymous (Part 26/27); CustomerHeader.tsx renders all of it.

export type CustomerNavKey = 'shop' | 'sell' | 'community' | 'orderStatus' | 'account'

export type CustomerNavItem = { key: CustomerNavKey; label: string; href: string }

// Part 2/3/4/5/6: exactly five stable customer goals. Personal destinations (My
// Orders, My Collection, Wanted, Alerts, Selling, Quick Capture) no longer compete
// here — see CUSTOMER_ACCOUNT_LINKS below for where they live now.
//
// Route choices (Part A inspection):
//   Shop         -> /browse   (the actual search/filter/buy page; CategoryNav's
//                    brand/category links already exclusively target /browse — the
//                    canonical shopping entry point. /market is a secondary
//                    merchandising/discovery page, left reachable by direct link,
//                    not primary nav; its domain logic is untouched.)
//   Sell         -> /sell (19C: the camera-first, no-login-required start-selling
//                    entry point — anonymous visitors build a batch immediately,
//                    no login wall. /account/sell remains a SEPARATE, distinct
//                    route: authenticated selling activity/history, not
//                    repurposed and not linked from primary nav. Distinct from
//                    Account > Selling below, which is for tracking selling
//                    ALREADY in progress via SellerPortfolio.)
//   Community    -> /community (public; distinct from /account/community, which is
//                    a private community PROFILE SETTINGS page, not the public feed)
//   Order Status -> /order-status (unchanged, already public)
export const CUSTOMER_PRIMARY_NAV: CustomerNavItem[] = [
  { key: 'shop', label: 'Shop', href: '/browse' },
  { key: 'sell', label: 'Sell', href: '/sell' },
  { key: 'community', label: 'Community', href: '/community' },
  { key: 'orderStatus', label: 'Order Status', href: '/order-status' },
]

// Part 8/9/10/12/13 (16A) + Part C/D/S (16B): authenticated personal destinations,
// collapsed under Account. This SAME array drives both the header Account dropdown
// (CustomerHeader.tsx) AND the /account/* sub-navigation tabs (AccountNav.tsx) —
// one source of truth, never a second drifting list (Part 36). `badgeKey` marks the
// item carrying the existing unread-alerts count.
//
// Selling -> /account/portfolios: deliberately NOT /account/sell — that route is
// the top-level "Sell" start-selling entry point above. "Selling" here means
// "manage/track selling I already have in progress" — SellerPortfolio already
// aggregates agreement/shipment/payout/lifecycle status for exactly that.
//
// settings/"Profile" -> /account/profile (16N): the canonical PRIVATE account/
// contact identity page (email read-only, name/phone editable — CustomerProfile).
// Deliberately NOT /account/community — that route is the separate PUBLIC
// collector persona (handle/displayName/bio/visibility — CustomerCommunityProfile).
// The two identities never write into each other; /account/community links to
// /account/profile contextually but is not itself the "Profile" nav destination.
export type CustomerAccountLink = { key: string; label: string; href: string; badge?: 'unreadAlerts' }

export const CUSTOMER_ACCOUNT_LINKS: CustomerAccountLink[] = [
  { key: 'overview', label: 'Overview', href: '/account' },
  { key: 'orders', label: 'Orders', href: '/account/orders' },
  { key: 'collection', label: 'Collection', href: '/account/collection' },
  { key: 'wanted', label: 'Wanted & Alerts', href: '/account/wanted', badge: 'unreadAlerts' },
  { key: 'selling', label: 'Selling', href: '/account/portfolios' },
  { key: 'settings', label: 'Profile', href: '/account/profile' },
]

// Part B/2 (16B): /account now exists as the customer home — anonymous "Account"
// leads there directly (it renders the existing sign-in/access form itself), rather
// than to /account/orders as a workaround.
export const CUSTOMER_ACCOUNT_ANONYMOUS_HREF = '/account'

// Part 17 (16A) / Part D/9 (16B) — active-primary-section resolution. Sell's own
// subtree (/sell and /account/sell/*, including its /new and /capture children)
// is checked FIRST and short-circuits, so it is the one deliberate exception;
// every other /account/* route (including the bare /account overview) resolves
// to Account. 19C: /account/sell/* still resolves to 'sell' too (bookmarked
// links into the authenticated history route should still highlight the same
// tab), even though primary nav's own Sell link now points at /sell.
const SECTION_PREFIXES: { key: CustomerNavKey; prefixes: string[] }[] = [
  { key: 'sell', prefixes: ['/sell', '/account/sell'] },
  { key: 'account', prefixes: ['/account'] },
  { key: 'shop', prefixes: ['/browse', '/market'] },
  { key: 'community', prefixes: ['/community'] },
  { key: 'orderStatus', prefixes: ['/order-status'] },
]

export function getCustomerPrimarySection(pathname: string): CustomerNavKey | null {
  for (const { key, prefixes } of SECTION_PREFIXES) {
    if (prefixes.some((p) => pathname === p || pathname.startsWith(p + '/'))) return key
  }
  return null
}
