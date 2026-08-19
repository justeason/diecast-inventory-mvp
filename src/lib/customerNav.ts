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

// Part 8/9/10/12/13: authenticated personal destinations, collapsed under Account.
// `badgeKey` marks the item carrying the existing unread-alerts count (previously a
// standalone top-level "Alerts" link) — Wanted and Alerts are consolidated into one
// NAVIGATION concept only; their underlying data/routes are untouched (that is 16D).
//
// Selling -> /account/portfolios (focused-review pass): deliberately NOT
// /account/sell — that route is the top-level "Sell" start-selling entry point
// above. "Selling" here means "manage/track selling I already have in progress" —
// SellerPortfolio already aggregates agreement/shipment/payout/lifecycle status for
// exactly that, the best existing seller-MANAGEMENT landing page. Sell and
// Account > Selling now resolve to genuinely different destinations, matching the
// two different customer intents ("start selling" vs. "track my selling").
export type CustomerAccountLink = { key: string; label: string; href: string; badge?: 'unreadAlerts' }

export const CUSTOMER_ACCOUNT_LINKS: CustomerAccountLink[] = [
  { key: 'orders', label: 'My Orders', href: '/account/orders' },
  { key: 'collection', label: 'My Collection', href: '/account/collection' },
  { key: 'wanted', label: 'Wanted & Alerts', href: '/account/wanted', badge: 'unreadAlerts' },
  { key: 'selling', label: 'Selling', href: '/account/portfolios' },
  { key: 'settings', label: 'Community Profile', href: '/account/community' },
]

// Part 7: no dedicated "/account" or "/login" page exists. Every /account/* page
// already independently falls back to the same email-access sign-in form
// (BuyerOrderAccessForm) when no session exists — this is simply the most general
// existing landing page for that shared gate, not a new auth surface.
export const CUSTOMER_ACCOUNT_ANONYMOUS_HREF = '/account/orders'

// Part 17 — active-primary-section resolution. Sell's own subtree (/account/sell/*,
// including its /new and /capture children) is checked separately from Account's
// other subroutes (including /account/portfolios, where Selling now points) — Sell
// and Account > Selling are genuinely different destinations, so starting a sale
// highlights Sell while reviewing existing selling activity highlights Account.
const SECTION_PREFIXES: { key: CustomerNavKey; prefixes: string[] }[] = [
  { key: 'sell', prefixes: ['/account/sell'] },
  {
    key: 'account',
    prefixes: ['/account/orders', '/account/collection', '/account/wanted', '/account/alerts', '/account/community', '/account/portfolios', '/account/capture'],
  },
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
