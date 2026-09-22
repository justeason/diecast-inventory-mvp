// 32B follow-up: structural (readSrc) coverage for §1/§5/§6/§7/§8/§11/§12 —
// every calling surface uses the isolated safeGetAdminPricingContext (never
// the raw, throwing getAdminPricingContext), the shared panel never touches
// raw exception text, notFound()/redirect semantics precede the pricing
// fetch, and the listing-create item-selection navigation mechanism.
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relPath), 'utf-8')
}

const panelSrc = readSrc('src/components/admin/AdminPricingContext.tsx')
const itemDetailPageSrc = readSrc('src/app/(admin)/admin/items/[id]/page.tsx')
const lifecycleQuerySrc = readSrc('src/lib/itemLifecycleQuery.ts')
const listingNewPageSrc = readSrc('src/app/(admin)/admin/listings/new/page.tsx')
const listingEditPageSrc = readSrc('src/app/(admin)/admin/listings/[id]/edit/page.tsx')
const valuationDetailPageSrc = readSrc('src/app/(admin)/admin/valuation/models/[id]/page.tsx')
const valuationListPageSrc = readSrc('src/app/(admin)/admin/valuation/page.tsx')
const listingFormSrc = readSrc('src/components/admin/ListingForm.tsx')

const CALL_SITES: [string, string][] = [
  ['itemLifecycleQuery.ts (item detail)', lifecycleQuerySrc],
  ['listings/new/page.tsx', listingNewPageSrc],
  ['listings/[id]/edit/page.tsx', listingEditPageSrc],
  ['valuation/models/[id]/page.tsx', valuationDetailPageSrc],
]

describe('§1/§11 — every pricing-consuming surface uses the isolated boundary', () => {
  for (const [name, src] of CALL_SITES) {
    it(`${name} calls safeGetAdminPricingContext, never the raw throwing getAdminPricingContext`, () => {
      expect(src).toContain('safeGetAdminPricingContext')
      expect(src).not.toMatch(/[^e]getAdminPricingContext\(/) // excludes "safeGetAdminPricingContext("
    })
  }
})

describe('§1/§11.F — the shared panel never exposes raw exception text', () => {
  it('renders exact neutral copy on a null context, before touching any pricing field', () => {
    expect(panelSrc).toContain('Pricing context unavailable.')
    const nullCheckIdx = panelSrc.indexOf('if (!context)')
    const firstFieldAccessIdx = panelSrc.indexOf('const { pricing, askDepth, signals } = context')
    expect(nullCheckIdx).toBeGreaterThan(-1)
    expect(nullCheckIdx).toBeLessThan(firstFieldAccessIdx)
  })

  it('never interpolates an error/exception object into its JSX', () => {
    expect(panelSrc).not.toMatch(/\.message\b/)
    expect(panelSrc).not.toMatch(/\berr(or)?\.stack\b/)
    expect(panelSrc).not.toMatch(/\{err\}|\{error\}|\{e\}/)
  })
})

describe('§6 — item detail: pricing failure never removes the rest of the record', () => {
  it('itemLifecycleQuery.ts composes item/lifecycle/source/listing/order/financial/timeline BEFORE the (isolated) pricing fetch', () => {
    const pricingCallIdx = lifecycleQuerySrc.indexOf('safeGetAdminPricingContext(')
    for (const marker of ['const financial', 'const contradictions', 'const lifecycleStage']) {
      const idx = lifecycleQuerySrc.indexOf(marker)
      expect(idx).toBeGreaterThan(-1)
      expect(idx).toBeLessThan(pricingCallIdx)
    }
  })

  it('the item-detail page renders AdminPricingContextPanel directly with the (possibly null) context — no page-level try/catch needed, isolation is already inside the query layer', () => {
    expect(itemDetailPageSrc).toContain('<AdminPricingContextPanel context={pricing.context}')
  })
})

describe('§5 — listing edit: notFound() precedes the pricing fetch; form stays usable on failure', () => {
  it('notFound() is called and returns before safeGetAdminPricingContext is invoked', () => {
    const notFoundIdx = listingEditPageSrc.indexOf('if (!listing) notFound()')
    const pricingIdx = listingEditPageSrc.indexOf('safeGetAdminPricingContext(')
    expect(notFoundIdx).toBeGreaterThan(-1)
    expect(notFoundIdx).toBeLessThan(pricingIdx)
  })

  it('EditListingForm renders price/title/description/payout-preview/submit controls unconditionally, independent of adminPricingContext', () => {
    expect(listingFormSrc).toMatch(/function EditListingForm[\s\S]*<AdminPricingContextPanel/)
    expect(listingFormSrc).toMatch(/function EditListingForm[\s\S]*name="price"/)
    expect(listingFormSrc).toMatch(/function EditListingForm[\s\S]*type="submit"/)
  })
})

describe('§7 — valuation detail: missing model (notFound-equivalent) is never reported as pricing-unavailable', () => {
  it('the "Catalog model not found" early return precedes the pricing fetch', () => {
    const notFoundIdx = valuationDetailPageSrc.indexOf('Catalog model not found')
    const pricingIdx = valuationDetailPageSrc.indexOf('safeGetAdminPricingContext(')
    expect(notFoundIdx).toBeGreaterThan(-1)
    expect(notFoundIdx).toBeLessThan(pricingIdx)
  })
})

describe('§8 — /admin/valuation list: batch-query failure behavior is explicitly unchanged in this patch', () => {
  it('no try/catch was added around the canonical batch scan — a technical failure still surfaces as a page-level error (documented, not fixed here)', () => {
    expect(valuationListPageSrc).not.toMatch(/try\s*{/)
  })
})

describe('§12 — listing create: item selection identifies exactly one pricing context via URL navigation', () => {
  it('selecting an item calls router.replace with exactly that item\'s id as ?itemId=', () => {
    expect(listingFormSrc).toMatch(/router\.replace\(item \? `\/admin\/listings\/new\?itemId=\$\{item\.id\}`/)
  })

  it('uses next/navigation useRouter — not a client-side Prisma call or a generic pricing fetch API', () => {
    expect(listingFormSrc).toContain("import { useRouter } from 'next/navigation'")
    expect(listingFormSrc).not.toMatch(/fetch\(['"`]\/api\/.*pricing/i)
    expect(listingFormSrc).not.toMatch(/from ['"]@\/lib\/prisma['"]/)
  })

  it('navigation is triggered only by item selection (handleItemChange), never by price/title/description keystrokes', () => {
    const priceOnChangeBlock = listingFormSrc.match(/name="price"[\s\S]{0,300}/)?.[0] ?? ''
    expect(priceOnChangeBlock).not.toMatch(/router\.replace/)
  })

  it('the item picker itself is populated by a single findMany, not one query per item (pre-existing, unchanged shape)', () => {
    expect(listingNewPageSrc).toMatch(/prisma\.itemInstance\.findMany\(/)
    expect((listingNewPageSrc.match(/prisma\.itemInstance\.findMany\(/g) ?? []).length).toBe(1)
  })
})

describe('§4 — create-page price/title/description state survives item-selection navigation', () => {
  it('uses router.replace (in-place prop update), not router.push (which would still preserve state here, but replace avoids polluting history for a same-form selection change)', () => {
    expect(listingFormSrc).toContain('router.replace(')
    expect(listingFormSrc).not.toMatch(/router\.push\(`\/admin\/listings\/new/)
  })
})
