// 16B: cross-cutting structural safety checks for the unified My Account hub.
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

function stripComments(src: string): string {
  return src.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n')
}

const querySrc = readSrc('src/lib/accountOverviewQuery.ts')
const queryCode = stripComments(querySrc)
const pageSrc = readSrc('src/app/(store)/account/page.tsx')
const accountNavSrc = readSrc('src/components/store/AccountNav.tsx')
const navSrc = readSrc('src/lib/customerNav.ts')
const headerSrc = readSrc('src/components/store/CustomerHeader.tsx')

const MUTATION_RE = /\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/

describe('Part R/35, Part 46 — /account overview is fully read-only', () => {
  it('accountOverviewQuery.ts contains no mutation call', () => {
    expect(querySrc).not.toMatch(MUTATION_RE)
  })

  it('/account/page.tsx contains no mutation call, no <form>, no server-action import', () => {
    expect(pageSrc).not.toMatch(MUTATION_RE)
    expect(pageSrc).not.toMatch(/<form/)
    expect(pageSrc).not.toMatch(/from '@\/lib\/actions\//)
  })

  it('AccountNav.tsx is presentation-only — no mutation, no data fetching of its own', () => {
    expect(accountNavSrc).not.toMatch(MUTATION_RE)
    expect(accountNavSrc).not.toMatch(/prisma\./)
  })
})

describe('Part M/26, Part Z/45 — query performance', () => {
  it('the recent-orders preview findMany is explicitly bounded with take: 3', () => {
    const idx = querySrc.indexOf('order.findMany')
    expect(idx).toBeGreaterThan(-1)
    const window = querySrc.slice(idx, idx + 300)
    expect(window).toContain('take: 3')
  })

  it('collection/wanted reads are DB-side counts/groups only, never a full row load', () => {
    expect(querySrc).not.toMatch(/collectionItem\.findMany/) // count + groupBy only, no row load at all
    expect(querySrc).not.toMatch(/wantedCatalogModel\.findMany/) // count only, no row load at all
    expect(querySrc).toContain('wantedCatalogModel.count(')
  })

  it('no per-item 14C pricing/valuation call anywhere in the overview query or page', () => {
    for (const src of [querySrc, pageSrc]) {
      expect(src).not.toMatch(/getPricingIntelligence\(|getCatalogValuation\(|getCollectionValuation\(/)
    }
  })

  it('collection/wanted summaries never call .findMany without a where clause (no full-table scope)', () => {
    expect(querySrc).not.toMatch(/\.findMany\(\{\s*\}\)/)
  })

  it('the four summaries are fetched via one Promise.all — parallel, not sequential', () => {
    const fnSrc = querySrc.slice(querySrc.indexOf('export async function getAccountOverview'))
    expect(fnSrc).toContain('await Promise.all([')
  })
})

describe('Part N/27, Part 28 — identity/auth', () => {
  it('getAccountOverview takes profileId as its only parameter — never reads it from request/query input itself', () => {
    expect(querySrc).toContain('export async function getAccountOverview(profileId: string)')
  })

  it('/account/page.tsx resolves the session server-side before calling getAccountOverview, and never calls it in the anonymous branch', () => {
    expect(pageSrc).toContain('await getBuyerSession()')
    const anonBranchEnd = pageSrc.indexOf('const overview = await getAccountOverview')
    const sessionCheckIdx = pageSrc.indexOf('if (!session)')
    expect(sessionCheckIdx).toBeGreaterThan(-1)
    expect(anonBranchEnd).toBeGreaterThan(sessionCheckIdx)
  })
})

describe('Part O/29 — privacy', () => {
  it('no buyer PII field appears in the overview query or page', () => {
    for (const src of [querySrc, pageSrc]) {
      expect(src).not.toMatch(/\.email\b|\.phone\b|\.address\b|paymentMethod|paymentReference/)
    }
  })
})

describe('Part P/30 — empty states link to real existing routes', () => {
  it('every empty-state action href is an existing route', () => {
    const hrefs = [...pageSrc.matchAll(/actionHref="([^"]+)"/g)].map((m) => m[1])
    expect(hrefs.length).toBeGreaterThanOrEqual(3)
    const routeFiles: Record<string, string> = {
      '/browse': 'src/app/(store)/browse/page.tsx',
      '/account/collection/new': 'src/app/(store)/account/collection/new/page.tsx',
      '/account/sell': 'src/app/(store)/account/sell/page.tsx',
    }
    for (const href of hrefs) {
      if (routeFiles[href]) expect(exists(routeFiles[href])).toBe(true)
    }
  })
})

describe('Part C/5, Part 41 — account sub-navigation present on every personal page', () => {
  const pages = [
    'src/app/(store)/account/orders/page.tsx',
    'src/app/(store)/account/collection/page.tsx',
    'src/app/(store)/account/wanted/page.tsx',
    'src/app/(store)/account/alerts/page.tsx',
    'src/app/(store)/account/portfolios/page.tsx',
    'src/app/(store)/account/community/page.tsx',
  ]
  for (const file of pages) {
    it(`${file} renders <AccountNav />`, () => {
      const src = readSrc(file)
      expect(src).toContain('<AccountNav')
      expect(src).toMatch(/from '@\/components\/store\/AccountNav'/)
    })
  }

  it('AccountNav renders CUSTOMER_ACCOUNT_LINKS — the SAME array the header dropdown uses, never a second tab list', () => {
    expect(accountNavSrc).toContain('CUSTOMER_ACCOUNT_LINKS')
    expect(accountNavSrc).toMatch(/from '@\/lib\/customerNav'/)
  })

  it('existing page titles (My Orders, My Collection, etc.) are preserved, not replaced by a generic account header', () => {
    expect(readSrc('src/app/(store)/account/orders/page.tsx')).toContain('My Orders')
    expect(readSrc('src/app/(store)/account/collection/page.tsx')).toContain('My Collection')
  })
})

describe('Part 36 — 16A nav source of truth updated for /account', () => {
  it('anonymous Account resolves to /account, not /account/orders', () => {
    expect(navSrc).toContain("export const CUSTOMER_ACCOUNT_ANONYMOUS_HREF = '/account'")
  })

  it('the Account dropdown/menu list starts with an Overview entry pointing to /account', () => {
    const idx = navSrc.indexOf('CUSTOMER_ACCOUNT_LINKS: CustomerAccountLink[] = [')
    const firstEntry = navSrc.slice(idx, navSrc.indexOf('\n', idx + 1) + 200)
    expect(firstEntry).toMatch(/key:\s*'overview',\s*label:\s*'Overview',\s*href:\s*'\/account'/)
  })

  it('CustomerHeader.tsx did not duplicate the account-links array — it still imports CUSTOMER_ACCOUNT_LINKS from customerNav.ts', () => {
    expect(headerSrc).toContain('CUSTOMER_ACCOUNT_LINKS')
    expect(headerSrc).toMatch(/from '@\/lib\/customerNav'/)
  })
})

describe('Part 19 scope discipline (16B) — no premature analytics/dashboard buildout', () => {
  it('/account/page.tsx does not import business-analytics or admin-only modules', () => {
    expect(pageSrc).not.toMatch(/businessAnalytics|adminOperationsQuery|financialPosition/)
  })

  it('/account/page.tsx does not implement its own collection valuation or seller-admin operational views', () => {
    expect(pageSrc).not.toMatch(/getCollectionValuation|riskApprovalRequest|RiskPolicyConfig/)
  })
})

describe('16B Final Lightweight-Overview Pass — no uncapped domain-list hydration or candidate scan behind any Overview total', () => {
  it('the only `take:` in accountOverviewQuery.ts belongs to the explicitly-bounded recent-orders preview', () => {
    const codeOnly = querySrc
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n')
    const takeMatches = [...codeOnly.matchAll(/take:\s*\d+/g)]
    expect(takeMatches.length).toBe(1)
    expect(takeMatches[0][0]).toBe('take: 3')
  })

  it('accountOverviewQuery.ts never imports or calls listMySellerPortfolios (uncapped SellerPortfolio hydration)', () => {
    expect(queryCode).not.toMatch(/listMySellerPortfolios/)
  })

  it('accountOverviewQuery.ts never imports or calls matchWantedList (full Wanted candidate scan)', () => {
    expect(queryCode).not.toMatch(/matchWantedList/)
  })

  it('accountOverviewQuery.ts never imports or calls countActiveSellerPortfolios or any derivePortfolioStage-based helper', () => {
    expect(queryCode).not.toMatch(/countActiveSellerPortfolios|derivePortfolioStage/)
  })

  it('the Selling summary type has no numeric portfolio-count field', () => {
    const idx = querySrc.indexOf('export type SellingSummary')
    const line = querySrc.slice(idx, querySrc.indexOf('\n', idx))
    expect(line).not.toMatch(/PortfolioCount|portfolioCount/)
  })

  it('the Wanted summary type has no numeric match-count field', () => {
    const idx = querySrc.indexOf('export type WantedSummary')
    const line = querySrc.slice(idx, querySrc.indexOf('\n', idx))
    expect(line).not.toMatch(/MatchCount|matchCount/)
  })

  it('outstanding payout liability reuses the shared outstandingPayoutLineWhere predicate, not a hand-copied where-shape', () => {
    expect(querySrc).toContain('outstandingPayoutLineWhere(profileId)')
    expect(querySrc).toContain("from '@/lib/businessAnalyticsQuery'")
  })

  it('wantedCount is a DB-side count, not a findMany row load', () => {
    expect(querySrc).toContain('wantedCatalogModel.count(')
    expect(querySrc).not.toMatch(/wantedCatalogModel\.findMany/)
  })
})

describe('16B Final Lightweight-Overview Pass — omitted metrics are not shown as zero', () => {
  it('/account/page.tsx never renders "0 active portfolios" or "0 matches" literals', () => {
    expect(pageSrc).not.toMatch(/0 active portfolio/i)
    expect(pageSrc).not.toMatch(/0 (available )?match/i)
  })

  it('the Selling card offers a "Check Matches"/"View Selling" style action, not a bare numeric portfolio count', () => {
    expect(pageSrc).not.toMatch(/activePortfolioCount/)
  })

  it('the Wanted card offers a "Check available matches" action instead of an availableMatchCount number', () => {
    expect(pageSrc).toMatch(/Check available matches/)
    expect(pageSrc).not.toMatch(/availableMatchCount/)
  })
})

describe('16B Final Lightweight-Overview Pass — seller-portfolio helper API stays bounded-only', () => {
  it('listMySellerPortfolios never accepts a null/uncapped limit', () => {
    const src = readSrc('src/lib/sellerPortfolioQuery.ts')
    expect(src).not.toMatch(/limit:\s*number\s*\|\s*null/)
    expect(src).not.toMatch(/export async function countActiveSellerPortfolios/)
  })
})

describe('Part J/K, Part 44 — Quick Capture stays contextual, not a primary account tab', () => {
  it('Quick Capture is not one of the CUSTOMER_ACCOUNT_LINKS tabs (still true after 16B)', () => {
    expect(navSrc).not.toMatch(/label:\s*'Quick Capture'/)
  })

  it('/account/page.tsx links to Quick Capture only as a Quick Action, not an AccountNav tab', () => {
    const quickActionsIdx = pageSrc.indexOf('Quick Actions')
    const captureIdx = pageSrc.indexOf('/account/capture')
    expect(quickActionsIdx).toBeGreaterThan(-1)
    expect(captureIdx).toBeGreaterThan(quickActionsIdx)
  })

  it('the Quick Capture route itself is untouched by this pass', () => {
    expect(exists('src/app/(store)/account/capture/page.tsx')).toBe(true)
  })
})
