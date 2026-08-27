/**
 * 16L: Quick Capture → customer action handoff. Behavioral tests for the new
 * captureRelationship.ts read-after-write wrappers (mocked deps) plus structural/
 * source-regex checks for CaptureCandidateActions.tsx and CaptureIdentify.tsx,
 * mirroring the established 16H/16I/16K test convention.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
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

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/actions/catalogModelDomainActions', () => ({
  wantAction: vi.fn(),
  unwantAction: vi.fn(),
  addToCollectionAction: vi.fn(),
}))
vi.mock('@/lib/buyerSession', () => ({ getBuyerSession: vi.fn() }))
vi.mock('@/lib/catalogRelationshipQuery', () => ({ getCatalogRelationshipState: vi.fn() }))

import { wantAction, unwantAction } from '@/lib/actions/catalogModelDomainActions'
import { getBuyerSession } from '@/lib/buyerSession'
import { getCatalogRelationshipState } from '@/lib/catalogRelationshipQuery'
import { wantFromCapture, unwantFromCapture } from '@/lib/actions/captureRelationship'

beforeEach(() => vi.resetAllMocks())

const wrapperSrc = readSrc('src/lib/actions/captureRelationship.ts')
const wrapperCode = stripComments(wrapperSrc)
const actionsCompSrc = readSrc('src/components/store/CaptureCandidateActions.tsx')
const actionsCompCode = stripComments(actionsCompSrc)
const captureIdentifySrc = readSrc('src/lib/actions/captureIdentify.ts')
const catalogActionsSrc = readSrc('src/components/store/CatalogActions.tsx')
const catalogModelActionsSrc = readSrc('src/components/store/CatalogModelActions.tsx')
const componentSrc = readSrc('src/components/store/CaptureIdentify.tsx')

const fakeEntry = (over: Partial<{ wanted: boolean; wantedId: string | null; collectionItemId: string | null; ownedQuantity: number | null }> = {}) => ({
  wanted: false, wantedId: null, collectionItemId: null, ownedQuantity: null, ...over,
})

// ── Part A: architecture reuse findings ─────────────────────────────────────────

describe('16L: reuse architecture — no duplicated domain actions', () => {
  it('captureRelationship.ts imports wantAction/unwantAction from the shared domain-actions file — never reimplements them', () => {
    expect(wrapperSrc).toContain("import { wantAction, unwantAction } from '@/lib/actions/catalogModelDomainActions'")
  })
  it('captureRelationship.ts contains no direct prisma.wantedCatalogModel/collectionItem mutation of its own', () => {
    expect(wrapperCode).not.toMatch(/prisma\.wantedCatalogModel\.(create|delete)|prisma\.collectionItem\.create/)
  })
  it('CaptureCandidateActions.tsx imports addToCollectionAction from the shared domain-actions file — reused, not duplicated', () => {
    expect(actionsCompSrc).toContain("import { addToCollectionAction } from '@/lib/actions/catalogModelDomainActions'")
  })
  it('CaptureCandidateActions.tsx imports Want/Unwant via the capture-specific wrappers, not the raw actions directly', () => {
    expect(actionsCompSrc).toContain("import { wantFromCapture, unwantFromCapture } from '@/lib/actions/captureRelationship'")
  })
  it('CatalogModelActions.tsx (the /catalog/[id] hub action row) is unchanged and still uses wantAction/unwantAction/addToCollectionAction directly from CatalogActions.tsx', () => {
    expect(catalogModelActionsSrc).toContain("import { wantAction, unwantAction, addToCollectionAction } from './CatalogActions'")
  })
  it('the three domain actions now live in a dedicated module-level "use server" file (required so a Client Component — CaptureCandidateActions.tsx — can invoke them directly; Next.js forbids inline "use server" bodies in a file reachable from a Client Component), and are re-exported unchanged from CatalogActions.tsx for every existing consumer', () => {
    const domainActionsSrc = readSrc('src/lib/actions/catalogModelDomainActions.ts')
    expect(domainActionsSrc.startsWith("'use server'")).toBe(true)
    expect(domainActionsSrc).toContain('export async function wantAction')
    expect(domainActionsSrc).toContain('export async function unwantAction')
    expect(domainActionsSrc).toContain('export async function addToCollectionAction')
    expect(catalogActionsSrc).toContain("import { wantAction, unwantAction, addToCollectionAction } from '@/lib/actions/catalogModelDomainActions'")
    expect(catalogActionsSrc).toContain('export { wantAction, unwantAction, addToCollectionAction }')
  })
})

// ── Part B/AN/AV: recognition remains read-only ─────────────────────────────────

describe('16L: recognition (identifyModelFromPhoto) still performs zero business writes', () => {
  it('no create/update/delete/upsert anywhere in captureIdentify.ts', () => {
    const code = stripComments(captureIdentifySrc)
    expect(code).not.toMatch(/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/)
  })
  it('captureIdentify.ts never imports createCollectionItem/addToWantedList/removeFromWantedList/wantAction/unwantAction/addToCollectionAction — relationship enrichment is READ only, via getCatalogRelationshipState', () => {
    const code = stripComments(captureIdentifySrc)
    expect(code).not.toMatch(/createCollectionItem|addToWantedList|removeFromWantedList|wantAction|unwantAction|addToCollectionAction/)
  })
  it('captureIdentify.ts imports getCatalogRelationshipState (read) but not any mutation wrapper', () => {
    expect(captureIdentifySrc).toContain("import { getCatalogRelationshipState")
  })
})

// ── Part K/L: presentation differs, domain shared ───────────────────────────────

describe('16L: CaptureCandidateActions mirrors CatalogModelActions domain semantics with compact presentation', () => {
  it('same sellHref ternary: owned → /account/collection/[id]/sell, unrecorded → /account/sell/new?catalogId=', () => {
    expect(actionsCompSrc).toContain('/account/collection/${collectionItemId}/sell')
    expect(actionsCompSrc).toContain('/account/sell/new?catalogId=${encodeURIComponent(catalogModelId)}')
  })
  it('owned display uses "✓ Own N" with N from ownedQuantity, same as CatalogModelActions', () => {
    expect(actionsCompSrc).toContain("✓ Own{ownedQuantity !== null ? ` ${ownedQuantity}` : ''}")
  })
  it('uses customer language only — no CatalogModel/CollectionItem/SellerSubmission literal text', () => {
    for (const src of [actionsCompSrc, componentSrc]) {
      expect(src).not.toMatch(/>CatalogModel<|>CollectionItem<|>SellerSubmission</)
    }
  })
  it('CaptureCandidateActions is a Client Component (needs useActionState) — CatalogModelActions remains a Server Component, unchanged, not importable into CaptureIdentify directly', () => {
    expect(actionsCompSrc.startsWith("'use client'")).toBe(true)
    expect(catalogModelActionsSrc.startsWith("'use client'")).toBe(false)
  })
})

// ── Part D/N: strong match vs multiple candidates ───────────────────────────────

describe('16L: every candidate row is independently isolated — same full actions on single or multiple matches', () => {
  it('CaptureIdentify renders CaptureCandidateActions inside the per-candidate .map, keyed by catalogModelId — not a single global action row outside the loop', () => {
    const mapIdx = componentSrc.indexOf('candidates.map((c) =>')
    const actionsIdx = componentSrc.indexOf('<CaptureCandidateActions', mapIdx)
    expect(actionsIdx).toBeGreaterThan(mapIdx)
    expect(componentSrc).toContain('<li key={c.catalogModelId}')
  })
  it('CaptureCandidateActions receives catalogModelId as a per-instance prop — no shared/module-level mutable state', () => {
    expect(actionsCompCode).not.toMatch(/^(?!.*function).*\blet\s+\w+\s*=.*catalogModelId/m)
  })
  it('the design decision (full actions per row, not a "choose this model" reveal step) is documented in source', () => {
    expect(componentSrc).toMatch(/cross-wire|isolat/i)
  })
})

// ── Part E/AD/AW: batched authenticated relationship lookup ────────────────────

describe('16L: authenticated relationship lookup is batched once inside recognition, never per-candidate', () => {
  it('identifyModelFromPhoto calls getCatalogRelationshipState exactly once with the full liveIds array', () => {
    expect(captureIdentifySrc).toContain('getCatalogRelationshipState(session.profileId, liveIds)')
    // Only one call site exists in the whole file.
    const matches = [...captureIdentifySrc.matchAll(/getCatalogRelationshipState\(/g)]
    expect(matches.length).toBe(1)
  })
  it('liveIds is derived from liveTop (already deduped/live-filtered), not a raw unfiltered candidate array', () => {
    expect(captureIdentifySrc).toContain('const liveIds = liveTop.map((c) => c.catalogModelId)')
  })
})

// ── Part F/AM: anonymous behavior ───────────────────────────────────────────────

describe('16L/16M: anonymous candidate actions preserve intent through sign-in, no private query, no mutation attempted', () => {
  it('CaptureCandidateActions renders intent-preserving sign-in links (16M buildAccountIntentHref) for all three actions when relationship is null, not a plain /account dead-end', () => {
    const hrefVars = [...actionsCompSrc.matchAll(/const (\w+) = buildAccountIntentHref\(\{ action: '(want|own|sell)', catalogModelId \}\)/g)]
    expect(hrefVars.length).toBe(3)
    const anonLinkUsages = [...actionsCompSrc.matchAll(/<Link href=\{(wantHref|ownHref|sellIntentHref)\} aria-label=\{`Sign in to/g)]
    expect(anonLinkUsages.length).toBe(3)
    expect(actionsCompSrc).not.toContain('href="/account"')
  })
  it('no ?returnTo=, ?action= query param, or guest-session/pending-action-cookie persistence logic exists', () => {
    for (const src of [actionsCompSrc, componentSrc, captureIdentifySrc]) {
      expect(src).not.toMatch(/returnTo|guestSession|pendingActionCookie|cookies\(\)\.set/)
    }
  })
})

// ── Part G/H: Own — not owned / owned ────────────────────────────────────────────

describe('16L: Add to Collection ("I Own This") reuses createCollectionItem flow unmodified', () => {
  it('not-owned branch submits addToCollectionAction.bind(null, catalogModelId) — same P2002/uniqueness path as /catalog/[id]', () => {
    expect(actionsCompSrc).toContain('addToCollectionAction.bind(null, catalogModelId)')
  })
  it('owned branch renders a Link to Collection detail, never another Add button, never a remove-ownership action', () => {
    const ownedBlockIdx = actionsCompSrc.indexOf('collectionItemId ? (')
    const block = actionsCompSrc.slice(ownedBlockIdx, actionsCompSrc.indexOf(') : (', ownedBlockIdx))
    expect(block).toContain('<Link')
    expect(block).not.toContain('<form')
    expect(block).not.toMatch(/deleteCollectionItem|remove/i)
  })
})

// ── Part I/J: Sell owned vs unrecorded ──────────────────────────────────────────

describe('16L: Sell One never creates SellerSubmission on click — routes to existing Sell entry points only', () => {
  it('Sell One is a plain Link (no form/server action) in both owned and unrecorded branches', () => {
    const sellBlockIdx = actionsCompSrc.indexOf('{/* Sell One */}')
    const sellBlock = actionsCompSrc.slice(sellBlockIdx)
    expect(sellBlock).not.toContain('<form')
  })
  it('no createSellerSubmission/sellerSubmission.create call exists in the capture action layer', () => {
    for (const src of [actionsCompCode, wrapperCode]) {
      expect(src).not.toMatch(/sellerSubmission\.create|createSellerSubmission/i)
    }
  })
})

// ── Part Z/AB/AU: zero-listing model / no Buy in capture ───────────────────────

describe('16L: zero-listing models remain fully actionable; no Buy/AddToCart anywhere in capture', () => {
  it('CaptureCandidateActions has no AddToCartButton/cart import — actions never gated by availableCount', () => {
    expect(actionsCompSrc).not.toMatch(/AddToCartButton|useCart|CartItem/)
  })
  it('CaptureIdentify itself has no AddToCartButton either', () => {
    expect(componentSrc).not.toMatch(/AddToCartButton|useCart|CartItem/)
  })
  it('CaptureCandidateActions renders regardless of availableCount — actions are not conditioned on availability', () => {
    expect(componentSrc).not.toMatch(/availableCount > 0 &&\s*<CaptureCandidateActions/)
  })
})

// ── Part O/AC: no client authoritative state, pending feedback ─────────────────

describe('16L: no persistent client-side relationship truth; explicit pending feedback reused', () => {
  it('no localStorage/sessionStorage write of wanted/owned/collectionItemId', () => {
    expect(actionsCompCode).not.toMatch(/localStorage|sessionStorage/)
  })
  it('reuses the existing PendingActionButton (useFormStatus) for Want/Unwant/Add-to-Collection pending state', () => {
    expect(actionsCompSrc).toContain("import { PendingActionButton } from './PendingActionButton'")
    const matches = [...actionsCompSrc.matchAll(/<PendingActionButton/g)]
    expect(matches.length).toBe(3)
  })
})

// ── Part S/T: no recognition rerun, no image persistence ───────────────────────

describe('16L: mutations never re-trigger recognition or touch image data', () => {
  it('captureRelationship.ts never imports computeImageFingerprint/findCatalogImageMatches', () => {
    expect(wrapperSrc).not.toMatch(/computeImageFingerprint|findCatalogImageMatches/)
  })
  it('CaptureCandidateActions.tsx never imports computeImageFingerprint/findCatalogImageMatches', () => {
    expect(actionsCompSrc).not.toMatch(/computeImageFingerprint|findCatalogImageMatches/)
  })
  it('no Blob/storage import in the mutation-adjacent capture files', () => {
    for (const src of [wrapperSrc, actionsCompSrc]) {
      expect(src).not.toMatch(/@vercel\/blob/)
    }
  })
})

// ── Behavioral: wantFromCapture / unwantFromCapture ─────────────────────────────

describe('16L: wantFromCapture — reuses wantAction, then re-reads relationship for exactly that model', () => {
  it('calls wantAction with the exact catalogModelId and formData passed through', async () => {
    ;(wantAction as Mock).mockResolvedValue(undefined)
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
    ;(getCatalogRelationshipState as Mock).mockResolvedValue(new Map([['cat1', fakeEntry({ wanted: true, wantedId: 'w1' })]]))

    const fd = new FormData()
    const result = await wantFromCapture('cat1', fd)

    expect(wantAction).toHaveBeenCalledWith('cat1', fd)
    expect(getCatalogRelationshipState).toHaveBeenCalledWith('p1', ['cat1'])
    expect(result).toEqual(fakeEntry({ wanted: true, wantedId: 'w1' }))
  })

  it('returns null if session disappears between the mutation and the re-read (no crash, safe fallback)', async () => {
    ;(wantAction as Mock).mockResolvedValue(undefined)
    ;(getBuyerSession as Mock).mockResolvedValue(null)

    const result = await wantFromCapture('cat1', new FormData())
    expect(result).toBeNull()
    expect(getCatalogRelationshipState).not.toHaveBeenCalled()
  })

  it('does not call unwantAction', async () => {
    ;(wantAction as Mock).mockResolvedValue(undefined)
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
    ;(getCatalogRelationshipState as Mock).mockResolvedValue(new Map())
    await wantFromCapture('cat1', new FormData())
    expect(unwantAction).not.toHaveBeenCalled()
  })
})

describe('16L: unwantFromCapture — reuses unwantAction, then re-reads relationship for exactly that model', () => {
  it('calls unwantAction with the exact catalogModelId and wantedId', async () => {
    ;(unwantAction as Mock).mockResolvedValue(undefined)
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
    ;(getCatalogRelationshipState as Mock).mockResolvedValue(new Map([['cat1', fakeEntry()]]))

    const result = await unwantFromCapture('cat1', 'w1')

    expect(unwantAction).toHaveBeenCalledWith('cat1', 'w1')
    expect(getCatalogRelationshipState).toHaveBeenCalledWith('p1', ['cat1'])
    expect(result).toEqual(fakeEntry())
  })

  it('does not call wantAction', async () => {
    ;(unwantAction as Mock).mockResolvedValue(undefined)
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
    ;(getCatalogRelationshipState as Mock).mockResolvedValue(new Map())
    await unwantFromCapture('cat1', 'w1')
    expect(wantAction).not.toHaveBeenCalled()
  })

  it('the re-read after Unwant correctly reflects owned status unaffected by the Want toggle (full entry returned, not just wanted fields)', async () => {
    ;(unwantAction as Mock).mockResolvedValue(undefined)
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
    ;(getCatalogRelationshipState as Mock).mockResolvedValue(
      new Map([['cat1', fakeEntry({ collectionItemId: 'c1', ownedQuantity: 3 })]]),
    )
    const result = await unwantFromCapture('cat1', 'w1')
    expect(result).toEqual(fakeEntry({ collectionItemId: 'c1', ownedQuantity: 3 }))
  })
})

// ── Part AE: duplicate candidate safety ─────────────────────────────────────────

describe('16L: duplicate CatalogModel ids cannot reach relationship enrichment or rendering', () => {
  it('the underlying matching engine (aggregateCandidates) already groups rows into one entry per catalogModelId (Map-keyed) — verified upstream, no additional 16L dedup needed', () => {
    const matchingSrc = readSrc('src/lib/catalogImageMatching.ts')
    expect(matchingSrc).toContain('const byModel = new Map<string, {')
  })
  it('getCatalogRelationshipState itself dedupes its input ids defensively (new Set) — so even a duplicate-id call would stay correct', () => {
    const relQuerySrc = readSrc('src/lib/catalogRelationshipQuery.ts')
    expect(relQuerySrc).toContain('const ids = [...new Set(catalogModelIds)]')
  })
})

// ── Part AF/AG: privacy / response shape ────────────────────────────────────────

describe('16L: relationship response shape is minimal and current-customer-scoped only', () => {
  it('CatalogRelationshipEntry (reused type) exposes only wanted/wantedId/collectionItemId/ownedQuantity — no profileId/email/whole-row', () => {
    const relQuerySrc = readSrc('src/lib/catalogRelationshipQuery.ts')
    const typeBlock = relQuerySrc.slice(relQuerySrc.indexOf('export type CatalogRelationshipEntry = {'), relQuerySrc.indexOf('}', relQuerySrc.indexOf('export type CatalogRelationshipEntry = {')))
    expect(typeBlock).not.toMatch(/profileId|email|customerProfile/i)
  })
  it('getCatalogRelationshipState is scoped by profileId in its own where clause — verified unchanged', () => {
    const relQuerySrc = readSrc('src/lib/catalogRelationshipQuery.ts')
    expect(relQuerySrc).toContain('customerProfileId: profileId')
    expect(relQuerySrc).toContain('profileId, catalogId: { in: ids }')
  })
})

// ── Part AH: accessibility ────────────────────────────────────────────────────────

describe('16L: accessibility of capture candidate actions', () => {
  it('every action has a model-specific aria-label', () => {
    expect(actionsCompSrc).toContain('ariaLabel={`Want ${modelName}`}')
    expect(actionsCompSrc).toContain('ariaLabel={`Remove ${modelName} from Wanted`}')
    expect(actionsCompSrc).toContain('ariaLabel={`Add ${modelName} to Collection`}')
    expect(actionsCompSrc).toContain('aria-label={`View owned ${modelName}`}')
    expect(actionsCompSrc).toContain('aria-label={`Sell one ${modelName}`}')
  })
  it('owned quantity is rendered as readable text, not color-only', () => {
    expect(actionsCompSrc).toMatch(/✓ Own\{ownedQuantity/)
  })
  it('focus-visible styling present on all custom buttons/links', () => {
    expect(actionsCompSrc).toContain('focus-visible:outline')
  })
  it('no nested interactive elements (no <a>/<button> inside another)', () => {
    expect(actionsCompCode).not.toMatch(/<Link[^>]*>[\s\S]*?<button/)
  })
})

// ── Part AI/AJ: mobile/desktop restraint ────────────────────────────────────────

describe('16L: mobile-first, restrained layout — actions wrap, no giant grid', () => {
  it('action row uses flex-wrap so 3 controls can stack on narrow viewports', () => {
    expect(actionsCompSrc).toContain('flex flex-wrap items-center gap-2')
  })
  it('candidate list items stack identity row above the actions row (space-y), not a dense multi-column grid', () => {
    expect(componentSrc).toContain('className="rounded-lg border border-gray-200 bg-white p-4 space-y-3"')
  })
})

// ── Part AY: regression — 16K production behavior preserved ─────────────────────

describe('16L: regression — 16K recognition/production safeguards untouched', () => {
  it('9 MB validation, rate limiting constants, and stale-candidate filtering are all still present verbatim', () => {
    expect(captureIdentifySrc).toContain('const MAX_FILE_BYTES = 9 * 1024 * 1024')
    expect(captureIdentifySrc).toContain('const IDENTIFY_MAX = 5')
    expect(captureIdentifySrc).toContain('const liveTop = top.filter((c) => detailById.has(c.catalogModelId))')
  })
  it('next.config.ts Sharp/libvips outputFileTracingIncludes fix is untouched', () => {
    const configSrc = readSrc('next.config.ts')
    expect(configSrc).toContain("'/capture': [")
    expect(configSrc).toContain('@img/sharp-libvips-linux-x64')
  })
  it('/account/capture, /account/capture/review, /account/sell/capture, admin image intelligence all still exist', () => {
    expect(exists('src/app/(store)/account/capture/page.tsx')).toBe(true)
    expect(exists('src/app/(store)/account/capture/review/page.tsx')).toBe(true)
    expect(exists('src/app/(store)/account/sell/capture/page.tsx')).toBe(true)
    expect(exists('src/app/(admin)/admin/catalog-image-intelligence/page.tsx')).toBe(true)
  })
  it('/catalog, /catalog/[id], /browse, /account/collection, /account/wanted all still exist', () => {
    expect(exists('src/app/(store)/catalog/page.tsx')).toBe(true)
    expect(exists('src/app/(store)/catalog/[id]/page.tsx')).toBe(true)
    expect(exists('src/app/(store)/browse/page.tsx')).toBe(true)
    expect(exists('src/app/(store)/account/collection/page.tsx')).toBe(true)
    expect(exists('src/app/(store)/account/wanted/page.tsx')).toBe(true)
  })
})

// ── Part AZ: no schema changes ────────────────────────────────────────────────────

describe('16L: zero schema/migration changes', () => {
  it('no new Prisma model referencing recognition/capture session/history', () => {
    const schema = readSrc('prisma/schema.prisma')
    expect(schema).not.toMatch(/model CaptureHistory|model RecognitionSession|model SavedScan/)
  })
})

// ── Part BA: scope guard ──────────────────────────────────────────────────────────

describe('16L: scope guard — no 16M+ functionality', () => {
  it('no intent-restoration/guest-session/recognition-history/auto-add keywords', () => {
    for (const src of [wrapperSrc, actionsCompSrc, componentSrc, captureIdentifySrc]) {
      expect(src).not.toMatch(/intent.?restoration|guestSession|recognitionHistory|savedScan|autoAdd|auto-add/i)
    }
  })
  it('no automatic Want/Own mutation triggered merely by rendering results', () => {
    // Already proven structurally above (recognition performs zero writes); this
    // additionally confirms CaptureCandidateActions issues no mutation on mount.
    expect(actionsCompCode).not.toMatch(/useEffect\(\s*\(\)\s*=>\s*\{[^}]*(wantFromCapture|addToCollectionAction)/)
  })
})

// ── Admin untouched ────────────────────────────────────────────────────────────────

describe('16L: admin behavior untouched', () => {
  it('no admin file references CaptureCandidateActions/captureRelationship', () => {
    const adminDir = path.join(root, 'src/app/(admin)')
    function walk(dir: string): string[] {
      return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name)
        return entry.isDirectory() ? walk(full) : [full]
      })
    }
    const adminFiles = walk(adminDir).filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'))
    for (const f of adminFiles) {
      expect(fs.readFileSync(f, 'utf-8')).not.toMatch(/CaptureCandidateActions|captureRelationship/)
    }
  })
})
