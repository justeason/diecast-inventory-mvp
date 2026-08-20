// 16A: cross-cutting structural safety checks for the customer-navigation
// simplification pass — proves the SOURCE never contains the prohibited surface
// area and that every previously-linked route still exists on disk.
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const root = path.resolve(__dirname, '../../..')
function readSrc(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf-8')
}
function exists(rel: string): boolean {
  return fs.existsSync(path.join(root, rel))
}

const navSrc = readSrc('src/lib/customerNav.ts')
const headerSrc = readSrc('src/components/store/CustomerHeader.tsx')
const layoutSrc = readSrc('src/app/(store)/layout.tsx')
const adminNavSrc = readSrc('src/components/admin/AdminNav.tsx')

describe('Part 30 — route/deep-link preservation: every route file still exists', () => {
  const routes: [string, string][] = [
    ['My Orders', 'src/app/(store)/account/orders/page.tsx'],
    ['My Collection', 'src/app/(store)/account/collection/page.tsx'],
    ['Wanted', 'src/app/(store)/account/wanted/page.tsx'],
    ['Alerts', 'src/app/(store)/account/alerts/page.tsx'],
    ['Selling / Sell requests', 'src/app/(store)/account/sell/page.tsx'],
    ['Quick Capture', 'src/app/(store)/account/capture/page.tsx'],
    ['Sell-flavored Quick Capture', 'src/app/(store)/account/sell/capture/page.tsx'],
    ['Community (public)', 'src/app/(store)/community/page.tsx'],
    ['Community profile settings', 'src/app/(store)/account/community/page.tsx'],
    ['Order Status', 'src/app/(store)/order-status/page.tsx'],
    ['Browse (Shop)', 'src/app/(store)/browse/page.tsx'],
    ['Marketplace', 'src/app/(store)/market/page.tsx'],
    ['Portfolios', 'src/app/(store)/account/portfolios/page.tsx'],
    ['Cart', 'src/app/(store)/cart/page.tsx'],
  ]
  for (const [label, file] of routes) {
    it(`${label} route file still exists (${file})`, () => {
      expect(exists(file)).toBe(true)
    })
  }
})

describe('Part 2/12/13 — personal destinations no longer compete as top-level links in layout.tsx', () => {
  it('layout.tsx no longer hardcodes any customer nav Links directly — delegated to CustomerHeader', () => {
    expect(layoutSrc).not.toMatch(/<Link\s/)
  })

  it('layout.tsx renders CustomerHeader with server-resolved auth props', () => {
    expect(layoutSrc).toContain('<CustomerHeader')
    expect(layoutSrc).toContain('isAuthenticated={!!session}')
    expect(layoutSrc).toContain('unreadAlerts={unreadAlerts}')
  })
})

describe('Part 23 — authentication state: server-resolved only, no client-trusted auth', () => {
  it('CustomerHeader never calls getBuyerSession or any session-reading function itself — auth comes in as props', () => {
    expect(headerSrc).not.toMatch(/getBuyerSession\(/)
    expect(headerSrc).toContain('isAuthenticated: boolean')
  })

  it('layout.tsx resolves the session server-side (await getBuyerSession()) before rendering the header', () => {
    expect(layoutSrc).toContain('await getBuyerSession()')
  })
})

describe('Part 24 — no buyer PII in the header', () => {
  it('CustomerHeader never selects/renders email, phone, or address', () => {
    for (const src of [headerSrc, navSrc, layoutSrc]) {
      expect(src).not.toMatch(/\.email\b|\.phone\b|\.address\b/)
    }
  })
})

describe('Part 25 — accessibility', () => {
  it('the Account dropdown trigger uses aria-haspopup/aria-expanded and a real <button>, never hover-only', () => {
    expect(headerSrc).toContain('aria-haspopup="menu"')
    expect(headerSrc).toContain('aria-expanded={accountOpen}')
    expect(headerSrc).not.toMatch(/onMouseEnter/)
  })

  it('the account menu closes on Escape', () => {
    expect(headerSrc).toMatch(/key === 'Escape'/)
  })

  it('menu items use role="menu"/"menuitem"', () => {
    expect(headerSrc).toContain('role="menu"')
    expect(headerSrc).toContain('role="menuitem"')
  })

  it('the mobile toggle button has an accessible label and aria-expanded/controls', () => {
    expect(headerSrc).toContain('aria-label="Toggle menu"')
    expect(headerSrc).toContain('aria-expanded={mobileOpen}')
    expect(headerSrc).toContain('aria-controls="customer-mobile-menu"')
  })
})

describe('Part 16/32 — mobile menu stays bounded, personal links nested not first-level', () => {
  it('the mobile panel renders CUSTOMER_PRIMARY_NAV (4 items) at the top level, and Account links only inside the nested mobile-account panel', () => {
    const mobilePanelStart = headerSrc.indexOf('id="customer-mobile-menu"')
    const nestedStart = headerSrc.indexOf('id="customer-mobile-account"')
    expect(mobilePanelStart).toBeGreaterThan(-1)
    expect(nestedStart).toBeGreaterThan(mobilePanelStart)
    // CUSTOMER_ACCOUNT_LINKS.map must appear only after the nested panel id, not
    // before it — i.e. personal destinations are not first-level mobile items.
    const accountLinksMapIdx = headerSrc.indexOf('CUSTOMER_ACCOUNT_LINKS.map', mobilePanelStart)
    expect(accountLinksMapIdx).toBeGreaterThan(nestedStart)
  })
})

describe('Part 19/20/21 — scope discipline: no premature 16F/16N work (16A snapshot)', () => {
  // 16B intentionally adds /account/page.tsx (the unified account hub) — see
  // accountOverview.test.ts / accountOverviewSafety.test.ts for its own scope-
  // discipline checks (compact overview only, no analytics dashboard).

  it('no catalog-card action verbs (Want/I Own This/Sell One/Buy) were added to ListingCard', () => {
    const listingCardSrc = readSrc('src/components/store/ListingCard.tsx')
    expect(listingCardSrc).not.toMatch(/I Own This|Sell One|>Want</)
  })

  it('no new anonymous-intent-to-signup workflow was added to CaptureWizard or BuyerOrderAccessForm', () => {
    const wizardSrc = readSrc('src/components/store/CaptureWizard.tsx')
    expect(wizardSrc).not.toMatch(/anonymous.*sign ?up/i)
  })
})

describe('Focused-review: Sell vs Selling now represent distinct customer intents', () => {
  it('no new public Sell page was introduced — /sell does not exist as a top-level customer route', () => {
    expect(exists('src/app/(store)/sell/page.tsx')).toBe(false)
  })

  it('customerNav.ts sends Sell and Account > Selling to different hrefs', () => {
    expect(navSrc).toMatch(/key:\s*'sell',\s*label:\s*'Sell',\s*href:\s*'\/account\/sell'/)
    expect(navSrc).toMatch(/key:\s*'selling',\s*label:\s*'Selling',\s*href:\s*'\/account\/portfolios'/)
  })

  it('the existing seller-portfolio management page (Account > Selling target) still exists and still gates on session — 16A did not weaken it or build a new dashboard in its place', () => {
    expect(exists('src/app/(store)/account/portfolios/page.tsx')).toBe(true)
    expect(readSrc('src/app/(store)/account/portfolios/page.tsx')).toContain('getBuyerSession')
  })

  it('the anonymous Sell gate (/account/sell email-access form) is unchanged by this pass — file untouched, still session-gated', () => {
    const sellSrc = readSrc('src/app/(store)/account/sell/page.tsx')
    expect(sellSrc).toContain('getBuyerSession')
    expect(sellSrc).toContain('BuyerOrderAccessForm')
  })

  it('Quick Capture routes are unaffected by this pass', () => {
    expect(exists('src/app/(store)/account/capture/page.tsx')).toBe(true)
    expect(exists('src/app/(store)/account/sell/capture/page.tsx')).toBe(true)
  })
})

describe('Part 34 — admin navigation is untouched', () => {
  it('AdminNav.tsx was not modified to reference customerNav concepts', () => {
    expect(adminNavSrc).not.toContain('customerNav')
    expect(adminNavSrc).not.toContain('CustomerHeader')
  })
})

describe('Part 5/6/33 — public destinations remain public, private stays private', () => {
  it('Order Status page performs no buyer-session gate (still a public guest lookup)', () => {
    const orderStatusSrc = readSrc('src/app/(store)/order-status/page.tsx')
    expect(orderStatusSrc).not.toMatch(/if \(!session\) (notFound|redirect)/)
  })

  it('Community (public) page does not require getBuyerSession to render its main feed', () => {
    const communitySrc = readSrc('src/app/(store)/community/page.tsx')
    expect(communitySrc).not.toContain('getBuyerSession')
  })

  it('private account pages (orders/collection/wanted/alerts/sell/portfolios) still each independently gate on session — 16A did not centralize or weaken auth checks', () => {
    for (const file of [
      'src/app/(store)/account/orders/page.tsx',
      'src/app/(store)/account/collection/page.tsx',
      'src/app/(store)/account/wanted/page.tsx',
      'src/app/(store)/account/alerts/page.tsx',
      'src/app/(store)/account/sell/page.tsx',
      'src/app/(store)/account/portfolios/page.tsx',
    ]) {
      expect(readSrc(file)).toContain('getBuyerSession')
    }
  })
})
