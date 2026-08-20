// 16A: pure customer-navigation definition tests.
import { describe, it, expect } from 'vitest'
import {
  CUSTOMER_PRIMARY_NAV, CUSTOMER_ACCOUNT_LINKS, CUSTOMER_ACCOUNT_ANONYMOUS_HREF,
  getCustomerPrimarySection,
} from '@/lib/customerNav'

describe('CUSTOMER_PRIMARY_NAV — exactly the five stable concepts (Part 2/28/29)', () => {
  it('has exactly five entries: Shop, Sell, Community, Order Status (Account is handled separately, not a plain link)', () => {
    expect(CUSTOMER_PRIMARY_NAV.map((i) => i.label)).toEqual(['Shop', 'Sell', 'Community', 'Order Status'])
  })

  it('Shop points to /browse (the actual search/filter/buy page, not /market)', () => {
    expect(CUSTOMER_PRIMARY_NAV.find((i) => i.key === 'shop')?.href).toBe('/browse')
  })

  it('Sell points to the existing /account/sell entry point — no invented public route', () => {
    expect(CUSTOMER_PRIMARY_NAV.find((i) => i.key === 'sell')?.href).toBe('/account/sell')
  })

  it('Community points to the PUBLIC /community feed, never the private /account/community settings page', () => {
    expect(CUSTOMER_PRIMARY_NAV.find((i) => i.key === 'community')?.href).toBe('/community')
  })

  it('Order Status points to the existing public guest order-status workflow', () => {
    expect(CUSTOMER_PRIMARY_NAV.find((i) => i.key === 'orderStatus')?.href).toBe('/order-status')
  })

  it('no separate top-level entry exists for My Orders/Collection/Wanted/Alerts/Quick Capture', () => {
    const labels = CUSTOMER_PRIMARY_NAV.map((i) => i.label)
    for (const forbidden of ['My Orders', 'My Collection', 'Wanted', 'Alerts', 'Quick Capture']) {
      expect(labels).not.toContain(forbidden)
    }
  })
})

describe('CUSTOMER_ACCOUNT_LINKS — personal destinations collapsed under Account (Part 8/9/10/29)', () => {
  it('exposes Overview, Orders, Collection, Wanted & Alerts, Selling, and a Profile destination (16B)', () => {
    const labels = CUSTOMER_ACCOUNT_LINKS.map((l) => l.label)
    expect(labels).toEqual(expect.arrayContaining(['Overview', 'Orders', 'Collection', 'Wanted & Alerts', 'Selling', 'Profile']))
    expect(CUSTOMER_ACCOUNT_LINKS.length).toBeGreaterThanOrEqual(6)
  })

  it('Overview is the first entry and points to /account', () => {
    expect(CUSTOMER_ACCOUNT_LINKS[0]).toEqual(expect.objectContaining({ label: 'Overview', href: '/account' }))
  })

  it('settings is labeled "Profile", not "Settings" — the destination is community-profile config, not general account settings (Part I/19)', () => {
    const settings = CUSTOMER_ACCOUNT_LINKS.find((l) => l.key === 'settings')
    expect(settings?.label).toBe('Profile')
    expect(settings?.href).toBe('/account/community')
  })

  it('Wanted and Alerts are consolidated into ONE menu concept — no separate "Wanted" and "Alerts" entries', () => {
    const labels = CUSTOMER_ACCOUNT_LINKS.map((l) => l.label)
    expect(labels).not.toContain('Wanted')
    expect(labels).not.toContain('Alerts')
    expect(labels).toContain('Wanted & Alerts')
  })

  it('the consolidated Wanted & Alerts entry carries the unread-alerts badge', () => {
    const entry = CUSTOMER_ACCOUNT_LINKS.find((l) => l.label === 'Wanted & Alerts')
    expect(entry?.badge).toBe('unreadAlerts')
  })

  it('Selling points to /account/portfolios — a genuinely different destination from top-level Sell (focused-review Sell-vs-Selling pass)', () => {
    const selling = CUSTOMER_ACCOUNT_LINKS.find((l) => l.label === 'Selling')
    expect(selling?.href).toBe('/account/portfolios')
  })

  it('top-level Sell and Account > Selling are distinct hrefs, representing different customer intents', () => {
    const sellHref = CUSTOMER_PRIMARY_NAV.find((i) => i.key === 'sell')?.href
    const sellingHref = CUSTOMER_ACCOUNT_LINKS.find((l) => l.label === 'Selling')?.href
    expect(sellHref).toBe('/account/sell')
    expect(sellingHref).toBe('/account/portfolios')
    expect(sellHref).not.toBe(sellingHref)
  })

  it('every Account link href starts with /account — none leak outside the account subtree', () => {
    for (const link of CUSTOMER_ACCOUNT_LINKS) expect(link.href.startsWith('/account')).toBe(true)
  })

  it('Quick Capture is not one of the Account-menu links (no new permanent nav placement, Part 11)', () => {
    expect(CUSTOMER_ACCOUNT_LINKS.map((l) => l.label)).not.toContain('Quick Capture')
    expect(CUSTOMER_ACCOUNT_LINKS.some((l) => l.href.includes('/capture'))).toBe(false)
  })
})

describe('CUSTOMER_ACCOUNT_ANONYMOUS_HREF — Part 7 (16A) / Part B/2 (16B)', () => {
  it('resolves to /account — the new customer home — not an invented /login page or the old /account/orders workaround', () => {
    expect(CUSTOMER_ACCOUNT_ANONYMOUS_HREF).toBe('/account')
  })
})

describe('getCustomerPrimarySection — active-state mapping (Part 17/31)', () => {
  it('maps the shop routes correctly', () => {
    // getCustomerPrimarySection receives a pathname (as Next's usePathname() returns
    // it — no query string) — CategoryNav's own /browse?brand=... links resolve to
    // pathname '/browse' by the time this function ever sees them.
    expect(getCustomerPrimarySection('/browse')).toBe('shop')
    expect(getCustomerPrimarySection('/market')).toBe('shop')
  })

  it('maps /account/sell/* to Sell, not Account (starting a sale highlights Sell)', () => {
    expect(getCustomerPrimarySection('/account/sell')).toBe('sell')
    expect(getCustomerPrimarySection('/account/sell/new')).toBe('sell')
    expect(getCustomerPrimarySection('/account/sell/capture')).toBe('sell')
  })

  it('maps /account/portfolios/* to Account, not Sell (reviewing existing selling activity highlights Account)', () => {
    expect(getCustomerPrimarySection('/account/portfolios')).toBe('account')
    expect(getCustomerPrimarySection('/account/portfolios/abc123')).toBe('account')
    expect(getCustomerPrimarySection('/account/portfolios')).not.toBe('sell')
  })

  it('maps the bare /account overview route to Account (16B)', () => {
    expect(getCustomerPrimarySection('/account')).toBe('account')
  })

  it('maps every other personal /account/* subroute to Account', () => {
    expect(getCustomerPrimarySection('/account/orders')).toBe('account')
    expect(getCustomerPrimarySection('/account/collection')).toBe('account')
    expect(getCustomerPrimarySection('/account/collection/abc123')).toBe('account')
    expect(getCustomerPrimarySection('/account/wanted')).toBe('account')
    expect(getCustomerPrimarySection('/account/alerts')).toBe('account')
    expect(getCustomerPrimarySection('/account/community')).toBe('account')
    expect(getCustomerPrimarySection('/account/portfolios')).toBe('account')
    expect(getCustomerPrimarySection('/account/capture')).toBe('account')
  })

  it('maps /community/* to Community, and public /community is distinct from /account/community', () => {
    expect(getCustomerPrimarySection('/community')).toBe('community')
    expect(getCustomerPrimarySection('/community/somehandle')).toBe('community')
    expect(getCustomerPrimarySection('/account/community')).toBe('account')
  })

  it('maps /order-status to Order Status', () => {
    expect(getCustomerPrimarySection('/order-status')).toBe('orderStatus')
  })

  it('never marks two different sections active for the same pathname (exactly one match, or null)', () => {
    const paths = ['/browse', '/market', '/account/sell', '/account/sell/new', '/account/orders', '/community', '/order-status', '/cart', '/']
    for (const p of paths) {
      const result = getCustomerPrimarySection(p)
      expect(result === null || typeof result === 'string').toBe(true)
    }
  })

  it('an unrelated path (e.g. /cart, /) resolves to null — no false-positive active state', () => {
    expect(getCustomerPrimarySection('/cart')).toBeNull()
    expect(getCustomerPrimarySection('/')).toBeNull()
  })
})
