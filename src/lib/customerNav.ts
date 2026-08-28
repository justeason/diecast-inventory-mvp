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
//   Sell         -> /account/sell ("Sell Requests" — the "start selling" entry
//                    point; no separate public start-selling page exists yet, and
//                    16A does not build one (that is 16R scope). For an anonymous
//                    visitor it already renders the existing email-access form
//                    (BuyerOrderAccessForm), exactly as before — 16A does not add or
//                    change that gate. Distinct from Account > Selling below, which
//                    is for tracking selling ALREADY in progress.)
//   Community    -> /community (public; distinct from /account/community, which is
//                    a private community PROFILE SETTINGS page, not the public feed)
//   Order Status -> /order-status (unchanged, already public)
export const CUSTOMER_PRIMARY_NAV: CustomerNavItem[] = [
  { key: 'shop', label: 'Shop', href: '/browse' },
  { key: 'sell', label: 'Sell', href: '/account/sell' },
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
// subtree (/account/sell/*, including its /new and /capture children) is checked
// FIRST and short-circuits, so it is the one deliberate exception; every other
// /account/* route (including the bare /account overview) resolves to Account.
const SECTION_PREFIXES: { key: CustomerNavKey; prefixes: string[] }[] = [
  { key: 'sell', prefixes: ['/account/sell'] },
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
