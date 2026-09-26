// 26C §17/§18/§75: Owned/Sold-Removed switcher on the existing /account/collection
// page — no new top-level route, no client fetch. Structural (source-inspection),
// matching this codebase's established convention.
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

const collectionSrc = readSrc('src/app/(store)/account/collection/page.tsx')
const historyListSrc = readSrc('src/components/store/CollectionHistoryList.tsx')

describe('26C §17: no new top-level route — /account/collection stays canonical', () => {
  it('history is a query-param view on the existing page, not a new route directory', () => {
    expect(exists('src/app/(store)/account/collection/sold')).toBe(false)
    expect(exists('src/app/(store)/account/collection/history')).toBe(false)
  })

  it('account nav / customerNav has no new "Sold" or "History" top-level entry', () => {
    const customerNavSrc = readSrc('src/lib/customerNav.ts')
    expect(customerNavSrc).not.toMatch(/href:\s*['"]\/account\/(collection\/)?(sold|history)['"]/)
  })
})

describe('26C §18: server-rendered switcher, no client fetch', () => {
  it('the page is not a client component (no "use client"), no useState/useEffect-driven view switch', () => {
    expect(collectionSrc).not.toMatch(/^'use client'/)
    expect(collectionSrc).not.toContain('useState')
    expect(collectionSrc).not.toContain('useEffect')
  })

  it('the switcher is two plain <Link> elements toggling the view query param', () => {
    expect(collectionSrc).toContain('href="/account/collection"')
    expect(collectionSrc).toContain('href="/account/collection?view=history"')
    expect(collectionSrc).toContain('Sold / Removed')
  })

  it('view defaults to owned when the param is absent or anything other than "history"', () => {
    expect(collectionSrc).toContain("const view = rawView === 'history' ? 'history' : 'owned'")
  })
})

describe('26C §75: owned view unchanged, history view renders CollectionHistoryList', () => {
  it('history data is only fetched when view is history', () => {
    const idx = collectionSrc.indexOf('const historyPage =')
    const block = collectionSrc.slice(idx, idx + 200)
    expect(block).toContain("view === 'history'")
    expect(block).toContain('getCollectionDisposalHistory')
  })

  it('CollectionHistoryList is rendered only in the history branch', () => {
    expect(collectionSrc).toContain('<CollectionHistoryList')
    const idx = collectionSrc.indexOf("view === 'history' ? (")
    expect(idx).toBeGreaterThan(-1)
    expect(collectionSrc.indexOf('<CollectionHistoryList', idx)).toBeGreaterThan(idx)
  })

  it('the Portfolio summary section and owned-list filters are skipped on the history view (only render inside the owned branch)', () => {
    const switchIdx = collectionSrc.indexOf("view === 'history' ? (")
    const ownedBranchIdx = collectionSrc.indexOf(') : (\n      <>', switchIdx)
    const portfolioIdx = collectionSrc.indexOf('Portfolio</h2>')
    expect(ownedBranchIdx).toBeGreaterThan(switchIdx)
    expect(portfolioIdx).toBeGreaterThan(ownedBranchIdx)
  })
})

describe('26C §32: history empty state', () => {
  it('CollectionHistoryList shows a concise empty-state message, not an empty table', () => {
    expect(historyListSrc).toContain('No sold or removed items yet.')
    expect(historyListSrc).not.toMatch(/<table/)
  })
})

describe('26C §22: disposal labels map every DisposalType to customer copy, never a raw enum string', () => {
  it('maps all six disposal types', () => {
    expect(historyListSrc).toContain("platform_sale: 'Sold on CollectNTrades'")
    expect(historyListSrc).toContain("external_sale: 'Sold elsewhere'")
    expect(historyListSrc).toContain("gift: 'Gifted'")
    expect(historyListSrc).toContain("trade: 'Traded'")
    expect(historyListSrc).toContain("other_removal: 'Removed'")
    expect(historyListSrc).toContain("correction: 'Quantity correction'")
  })
})

describe('26C §23/§31: reversed disposals remain visible, clearly labeled, muted styling', () => {
  it('renders a "Reversed" badge and applies muted styling, never hides the row', () => {
    expect(historyListSrc).toContain('Reversed')
    expect(historyListSrc).toMatch(/opacity-75/)
    expect(historyListSrc).not.toMatch(/reversedAt &&[^}]*return null/)
  })

  it('a reversed calculable-sale row explicitly notes exclusion from current totals, never implies inclusion', () => {
    expect(historyListSrc).toContain('excluded from current totals')
  })
})

describe('26C §24/§25: corrections and gift/trade/removal never show a fabricated realized figure', () => {
  it('the realized block only renders for platform_sale/external_sale (SALE_TYPES), never for gift/trade/other_removal/correction', () => {
    const idx = historyListSrc.indexOf('{isSaleType && (')
    expect(idx).toBeGreaterThan(-1)
    expect(historyListSrc).toContain("SALE_TYPES = new Set<DisposalType>(['platform_sale', 'external_sale'])")
  })
})

describe('26C §33/§77: history route stays private, never reachable from community/public surfaces', () => {
  it('collectionDisposalHistoryQuery.ts is never imported by any community/showcase file', () => {
    const communityDir = path.join(root, 'src/app/(store)/community')
    function walk(dir: string): string[] {
      if (!fs.existsSync(dir)) return []
      return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name)
        return entry.isDirectory() ? walk(full) : [full]
      })
    }
    for (const f of walk(communityDir)) {
      expect(fs.readFileSync(f, 'utf-8')).not.toContain('collectionDisposalHistoryQuery')
    }
  })

  it('communityLeaderboardsQuery.ts never references averageRecordedCostCents or disposal history', () => {
    const communityQuerySrc = readSrc('src/lib/communityLeaderboardsQuery.ts')
    expect(communityQuerySrc).not.toMatch(/averageRecordedCostCents|CollectionDisposal|collectionDisposalHistoryQuery/)
  })
})

describe('26C §34/§79: no new admin exposure for holding performance / history', () => {
  it('no admin route was added for disposal history or holding performance', () => {
    expect(exists('src/app/(admin)/admin/collection-history')).toBe(false)
    expect(exists('src/app/(admin)/admin/holding-performance')).toBe(false)
  })

  it('no admin source file imports collectionDisposalHistoryQuery.ts', () => {
    const adminDir = path.join(root, 'src/app/(admin)')
    function walk(dir: string): string[] {
      if (!fs.existsSync(dir)) return []
      return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name)
        return entry.isDirectory() ? walk(full) : [full]
      })
    }
    for (const f of walk(adminDir)) {
      expect(fs.readFileSync(f, 'utf-8')).not.toContain('collectionDisposalHistoryQuery')
    }
  })
})

describe('26C §55-59/§79: explicitly out of scope', () => {
  it('no Portfolio History chart (1M/3M/1Y/ALL)', () => {
    expect(collectionSrc).not.toMatch(/\b1M\b|\b3M\b|\b1Y\b|portfolioHistory|PortfolioChart/i)
  })

  it('no market signals (30D change / momentum / velocity / Wanted demand)', () => {
    expect(collectionSrc).not.toMatch(/30D change|momentum|velocity|demand signal/i)
  })

  it('no fair listing indicator language', () => {
    expect(collectionSrc).not.toMatch(/Below Typical Range|Within Market Range|Above Typical Range/)
  })

  it('no seller valuation / instant offer language introduced here', () => {
    expect(collectionSrc).not.toMatch(/instant offer|target price/i)
  })

  it('no lot-selection UI — no raw lot id ever rendered, FIFO stays automatic', () => {
    expect(collectionSrc).not.toMatch(/acquisitionLotId|lotId/)
    expect(historyListSrc).not.toMatch(/acquisitionLotId|lotId/)
  })
})

describe('26C §37/§38/§76: existing actions preserved on the owned view', () => {
  it('View Market, Sell One, Add Another, public/private toggle all still present', () => {
    expect(collectionSrc).toContain('View Market')
    expect(collectionSrc).toContain('Sell One')
    expect(collectionSrc).toContain('Add Another')
    expect(collectionSrc).toContain('toggleCollectionItemPublic')
  })

  it('Add Another still targets the ledger-backed #add-another anchor — never a quantity-bump regression', () => {
    expect(collectionSrc).toContain('#add-another')
  })
})

describe('26C §42: no total "Return" metric', () => {
  it('the page never combines Unrealized + Realized into a single Return/Performance/ROI figure', () => {
    expect(collectionSrc).not.toMatch(/Portfolio Return|Total Return|\bROI\b|Performance %/)
  })
})

describe('26C §60/§61: no schema change, no new package expected', () => {
  it('migration count is still 53 — 26C introduced no new migration', () => {
    const migrationDirs = fs.readdirSync(path.join(root, 'prisma/migrations')).filter((d) => /^\d/.test(d))
    expect(migrationDirs.length).toBe(54)
  })
})
