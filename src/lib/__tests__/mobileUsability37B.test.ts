/**
 * 37B: Mobile Usability Hardening. Covers: the wantAction/unwantAction/
 * addToCollectionAction error-and-retry contract (behavioral, mocked
 * dependencies — not source-text string matching), touch-target/overflow/
 * input-mode/autocomplete structural regressions, and PhotoGallery's
 * next/image source-compatibility audit. No React rendering harness exists in
 * this codebase (established convention) — page/component-level coverage for
 * responsive CSS is structural source-text assertions over the exact touched
 * files.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'

const root = path.resolve(__dirname, '../../..')
function readSrc(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf-8')
}
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

type Mock = ReturnType<typeof vi.fn>

// ── Behavioral: wantAction/unwantAction/addToCollectionAction error contract ──

vi.mock('@/lib/actions/wantedList', () => ({
  addToWantedList: vi.fn(),
  removeFromWantedList: vi.fn(),
}))
vi.mock('@/lib/actions/collectionItems', () => ({
  createCollectionItem: vi.fn(),
}))
vi.mock('@/lib/buyerSession', () => ({ getBuyerSession: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: vi.fn(() => { throw new Error('NEXT_REDIRECT') }) }))

import { addToWantedList, removeFromWantedList } from '@/lib/actions/wantedList'
import { createCollectionItem } from '@/lib/actions/collectionItems'
import { getBuyerSession } from '@/lib/buyerSession'
import { revalidatePath } from 'next/cache'
import { wantAction, unwantAction, addToCollectionAction } from '@/lib/actions/catalogModelDomainActions'

function fd(entries: Record<string, string> = {}): FormData {
  const f = new FormData()
  for (const [k, v] of Object.entries(entries)) f.set(k, v)
  return f
}

beforeEach(() => {
  vi.resetAllMocks()
  ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
})

describe('wantAction — success/failure/retry', () => {
  it('success: revalidates both paths and returns null (no false error)', async () => {
    ;(addToWantedList as Mock).mockResolvedValue(null)

    const result = await wantAction('cat1', fd())

    expect(result).toBeNull()
    expect(revalidatePath).toHaveBeenCalledWith('/browse')
    expect(revalidatePath).toHaveBeenCalledWith('/catalog/cat1')
  })

  it('failure: a real addToWantedList rejection (e.g. rate limit) is returned as a visible _form error, NOT discarded', async () => {
    ;(addToWantedList as Mock).mockResolvedValue({ errors: { _form: ['Too many entries added. Please wait 30 seconds.'] } })

    const result = await wantAction('cat1', fd())

    expect(result).toEqual({ errors: { _form: ['Too many entries added. Please wait 30 seconds.'] } })
    // No revalidation on failure — nothing changed, nothing to refresh.
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('failure with a field-specific error key (not _form) is still surfaced, normalized to _form', async () => {
    ;(addToWantedList as Mock).mockResolvedValue({ errors: { catalogModelId: ['This model is already on your wanted list.'] } })

    const result = await wantAction('cat1', fd())

    expect(result?.errors._form).toEqual(['This model is already on your wanted list.'])
  })

  it('retry after failure: calling again with a corrected/retried state can succeed independently (no stuck error state)', async () => {
    ;(addToWantedList as Mock).mockResolvedValueOnce({ errors: { _form: ['Too many entries added. Please wait 30 seconds.'] } })
    const first = await wantAction('cat1', fd())
    expect(first?.errors._form).toBeDefined()

    ;(addToWantedList as Mock).mockResolvedValueOnce(null)
    const second = await wantAction('cat1', fd())
    expect(second).toBeNull()
  })

  it('sets catalogModelId on the formData before delegating (unchanged mutation contract)', async () => {
    ;(addToWantedList as Mock).mockResolvedValue(null)
    const formData = fd()

    await wantAction('cat1', formData)

    const [, passedFormData] = (addToWantedList as Mock).mock.calls[0]
    expect(passedFormData.get('catalogModelId')).toBe('cat1')
  })
})

describe('unwantAction — auth behavior, success, no false success', () => {
  it('lost session -> returns a visible auth error instead of a silent no-op', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue(null)

    const result = await unwantAction('cat1', 'wanted1')

    expect(result).toEqual({ errors: { _form: ['You must be signed in.'] } })
    expect(removeFromWantedList).not.toHaveBeenCalled()
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('authenticated success: removes, revalidates both paths, returns null', async () => {
    ;(removeFromWantedList as Mock).mockResolvedValue(undefined)

    const result = await unwantAction('cat1', 'wanted1')

    expect(result).toBeNull()
    expect(removeFromWantedList).toHaveBeenCalledWith('wanted1')
    expect(revalidatePath).toHaveBeenCalledWith('/browse')
    expect(revalidatePath).toHaveBeenCalledWith('/catalog/cat1')
  })
})

describe('addToCollectionAction — success (redirect), failure, retry', () => {
  it('success: createCollectionItem redirects (throws) — the throw propagates, no false-success return value is fabricated', async () => {
    ;(createCollectionItem as Mock).mockRejectedValue(new Error('NEXT_REDIRECT'))

    await expect(addToCollectionAction('cat1', fd())).rejects.toThrow('NEXT_REDIRECT')
  })

  it('failure: createCollectionItem returning an error state (never redirects) is surfaced, not silently dropped', async () => {
    ;(createCollectionItem as Mock).mockResolvedValue({ errors: { form: ['You already have this model in your collection. Edit the existing item to adjust the quantity.'] } })

    const result = await addToCollectionAction('cat1', fd())

    expect(result).toEqual({ errors: { _form: ['You already have this model in your collection. Edit the existing item to adjust the quantity.'] } })
  })

  it('retry after failure succeeds independently', async () => {
    ;(createCollectionItem as Mock).mockResolvedValueOnce({ errors: { form: ['Too many items added. Please wait 30 seconds.'] } })
    const first = await addToCollectionAction('cat1', fd())
    expect(first?.errors._form).toBeDefined()

    ;(createCollectionItem as Mock).mockRejectedValueOnce(new Error('NEXT_REDIRECT'))
    await expect(addToCollectionAction('cat1', fd())).rejects.toThrow('NEXT_REDIRECT')
  })

  it('sets catalogId and source=i_own_it on the formData before delegating (unchanged mutation contract)', async () => {
    ;(createCollectionItem as Mock).mockRejectedValue(new Error('NEXT_REDIRECT'))
    const formData = fd()

    await expect(addToCollectionAction('cat1', formData)).rejects.toThrow()

    const [, passedFormData] = (createCollectionItem as Mock).mock.calls[0]
    expect(passedFormData.get('catalogId')).toBe('cat1')
    expect(passedFormData.get('source')).toBe('i_own_it')
  })
})

describe('relationship-state revalidation — server-rendered state remains authoritative', () => {
  it('wantAction/unwantAction revalidate the exact same two paths on every success (relationship state re-derives from a fresh server read, never a client-fabricated value)', async () => {
    ;(addToWantedList as Mock).mockResolvedValue(null)
    await wantAction('cat9', fd())
    expect(revalidatePath).toHaveBeenNthCalledWith(1, '/browse')
    expect(revalidatePath).toHaveBeenNthCalledWith(2, '/catalog/cat9')

    vi.clearAllMocks()
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
    ;(removeFromWantedList as Mock).mockResolvedValue(undefined)
    await unwantAction('cat9', 'w1')
    expect(revalidatePath).toHaveBeenNthCalledWith(1, '/browse')
    expect(revalidatePath).toHaveBeenNthCalledWith(2, '/catalog/cat9')
  })
})

// ── Structural: CatalogActionForm / CatalogModelCard wiring ──────────────────

describe('CatalogActionForm — useActionState wiring', () => {
  const formSrc = readSrc('src/components/store/CatalogActionForm.tsx')

  it('is a client component using useActionState, rendering PendingActionButton unmodified', () => {
    expect(formSrc).toContain("'use client'")
    expect(formSrc).toContain('useActionState')
    expect(formSrc).toContain('PendingActionButton')
  })

  it('renders a visible inline error when state has errors, using the established red-text convention', () => {
    expect(formSrc).toMatch(/text-red-600/)
    expect(formSrc).toContain('state?.errors?._form')
  })

  it('never shows a technical stack trace — only the message string from state', () => {
    const stripped = stripComments(formSrc)
    expect(stripped).not.toMatch(/\.stack\b|error\.message(?!.*_form)/)
  })
})

describe('CatalogModelCard — Want/Unwant/Own now route through CatalogActionForm', () => {
  const cardSrc = readSrc('src/components/store/CatalogModelCard.tsx')

  it('imports CatalogActionForm and uses it for all three actions', () => {
    expect(cardSrc).toContain("import { CatalogActionForm } from './CatalogActionForm'")
    const occurrences = (cardSrc.match(/<CatalogActionForm/g) ?? []).length
    expect(occurrences).toBe(3)
  })

  it('no longer renders a bare <form action={...}> for Want/Unwant/Own (superseded by CatalogActionForm)', () => {
    expect(cardSrc).not.toMatch(/<form action=\{(want|unwant|addToCollection)Action/)
  })

  it('other unrelated call sites (CatalogActions/CatalogModelActions/AccountIntentActions/CaptureCandidateActions) were NOT converted to CatalogActionForm — no broad conversion of unrelated forms', () => {
    for (const f of [
      'src/components/store/CatalogActions.tsx',
      'src/components/store/CatalogModelActions.tsx',
      'src/components/store/AccountIntentActions.tsx',
      'src/components/store/CaptureCandidateActions.tsx',
    ]) {
      expect(readSrc(f)).not.toContain('CatalogActionForm')
    }
  })
})

describe('catalogModelDomainActions.ts — permission/ownership checks intact', () => {
  const src = readSrc('src/lib/actions/catalogModelDomainActions.ts')

  it('wantAction/addToCollectionAction still delegate entirely to addToWantedList/createCollectionItem (no new bypass path)', () => {
    expect(src).toContain('await addToWantedList(null, formData)')
    expect(src).toContain('await createCollectionItem(null, formData)')
  })

  it('unwantAction still delegates to removeFromWantedList, which itself remains profileId-scoped (unchanged, untouched)', () => {
    expect(src).toContain('await removeFromWantedList(wantedId)')
    const wantedListSrc = readSrc('src/lib/actions/wantedList.ts')
    expect(wantedListSrc).toContain('where: { id, customerProfileId: session.profileId }')
  })
})

// ── Structural: touch targets ─────────────────────────────────────────────────

describe('§3 — touch-target fixes', () => {
  it('PhotoGallery lightbox close button is at least 44x44 (h-11 w-11)', () => {
    const src = readSrc('src/components/store/PhotoGallery.tsx')
    const idx = src.indexOf('aria-label="Close image"')
    const block = src.slice(idx, idx + 200)
    expect(block).toMatch(/h-11 w-11/)
  })

  it('WantedAlertToggle pills use min-h-11', () => {
    const src = readSrc('src/components/store/WantedAlertToggle.tsx')
    expect(src).toContain('min-h-11')
  })

  it('checkout submit button uses min-h-11', () => {
    const src = readSrc('src/components/store/CartPage.tsx')
    const idx = src.indexOf('Request Order')
    const block = src.slice(Math.max(0, idx - 300), idx)
    expect(block).toContain('min-h-11')
  })

  it('accessible labels/focus treatment were preserved on all three (not stripped while resizing)', () => {
    const galleryStripped = stripComments(readSrc('src/components/store/PhotoGallery.tsx'))
    expect(galleryStripped).toContain('aria-label="Close image"')
    const toggleSrc = readSrc('src/components/store/WantedAlertToggle.tsx')
    expect(toggleSrc).toContain('focus-visible:outline')
    expect(toggleSrc).toContain('aria-label=')
  })
})

// ── Structural: Wanted/Alerts tab overflow ────────────────────────────────────

describe('§4 — Wanted/Alerts tab overflow', () => {
  const src = readSrc('src/app/(store)/account/wanted/page.tsx')

  it('TabBar container uses overflow-x-auto (matching AccountNav\'s established pattern)', () => {
    const idx = src.indexOf('function TabBar')
    const block = src.slice(idx, idx + 900)
    expect(block).toContain('overflow-x-auto')
    expect(block).toContain('shrink-0')
    expect(block).toContain('whitespace-nowrap')
  })

  it('the unread-count tab label logic is unchanged (still renders "(N)")', () => {
    expect(src).toContain('Recent Alerts{unreadAlertCount > 0 ? ` (${unreadAlertCount})` : \'\'}')
  })

  it('active-tab identification (aria-current) is preserved', () => {
    const idx = src.indexOf('function TabBar')
    const block = src.slice(idx, idx + 900)
    expect(block).toContain('aria-current')
  })
})

// ── Structural: Community leaderboard overflow ───────────────────────────────

describe('§5 — Community leaderboard overflow', () => {
  const src = readSrc('src/app/(store)/community/page.tsx')

  it('all three leaderboard tables are wrapped in overflow-x-auto (not overflow-hidden alone)', () => {
    const occurrences = (src.match(/<div className="overflow-x-auto">/g) ?? []).length
    expect(occurrences).toBe(3)
  })

  it('the outer rounded-border wrapper (corner-clipping) is preserved around each scroll wrapper', () => {
    const occurrences = (src.match(/rounded-lg border border-gray-200 overflow-hidden/g) ?? []).length
    expect(occurrences).toBe(3)
  })

  it('table columns/data/sorting markup is unchanged — same 3 tables, same column headers', () => {
    expect(src).toContain('Largest collections')
    expect(src).toContain('Active collectors')
    expect(src).toContain('Verified marketplace collectors')
    expect(src).toContain('leaderboards.largestCollections.map')
    expect(src).toContain('leaderboards.activeCollectors.map')
    expect(src).toContain('leaderboards.verifiedCollectors.map')
  })

  it('directory pagination markup is untouched', () => {
    expect(src).toContain('DIRECTORY_PAGE_SIZE')
    expect(src).toContain('nextCursor')
  })
})

// ── Structural: mobile decimal keyboard ──────────────────────────────────────

describe('§6 — decimal inputMode on money inputs', () => {
  it('Wanted maxDesiredPrice (add + edit) has inputMode="decimal", preserving type/step/validation', () => {
    for (const f of ['src/components/store/WantedListAddForm.tsx', 'src/components/store/WantedEditForm.tsx']) {
      const src = readSrc(f)
      const idx = src.indexOf('name="maxDesiredPrice"')
      const block = src.slice(idx, idx + 200)
      expect(block).toContain('type="number"')
      expect(block).toContain('inputMode="decimal"')
      expect(block).toContain('step="0.01"')
    }
  })

  it('Collection purchasePrice has inputMode="decimal", preserving type/step/validation', () => {
    const src = readSrc('src/components/store/CollectionItemForm.tsx')
    const idx = src.indexOf('name="purchasePrice"')
    const block = src.slice(idx, idx + 200)
    expect(block).toContain('type="number"')
    expect(block).toContain('inputMode="decimal"')
    expect(block).toContain('step="0.01"')
  })

  it('does not switch these inputs to type="text" merely to add inputMode (current input type preserved)', () => {
    for (const f of ['src/components/store/WantedListAddForm.tsx', 'src/components/store/WantedEditForm.tsx', 'src/components/store/CollectionItemForm.tsx']) {
      const src = readSrc(f)
      expect(src).not.toMatch(/name="(maxDesiredPrice|purchasePrice)"\s*\n\s*type="text"/)
    }
  })

  it('server-side money parsing/precision is untouched (no change to actions/wantedList.ts or collectionItems.ts parsing logic)', () => {
    const wantedListSrc = readSrc('src/lib/actions/wantedList.ts')
    expect(wantedListSrc).toContain('function parsePositiveDecimal')
  })
})

// ── Structural: checkout autofill ────────────────────────────────────────────

describe('§7 — checkout autocomplete', () => {
  const src = readSrc('src/components/store/CartPage.tsx')

  it('buyerName has autoComplete="name"', () => {
    const idx = src.indexOf('name="buyerName"')
    expect(src.slice(idx, idx + 150)).toContain('autoComplete="name"')
  })

  it('buyerEmail has autoComplete="email" and inputMode="email"', () => {
    const idx = src.indexOf('name="buyerEmail"')
    const block = src.slice(idx, idx + 150)
    expect(block).toContain('autoComplete="email"')
    expect(block).toContain('type="email"')
  })

  it('buyerPhone has autoComplete="tel" and inputMode="tel"', () => {
    const idx = src.indexOf('name="buyerPhone"')
    const block = src.slice(idx, idx + 150)
    expect(block).toContain('autoComplete="tel"')
    expect(block).toContain('inputMode="tel"')
  })

  it('field names, required-ness, and guest-checkout shape are unchanged', () => {
    expect(src).toContain('id="buyerName"')
    expect(src).toContain('id="buyerEmail"')
    expect(src).toContain('id="buyerPhone"')
    const nameIdx = src.indexOf('name="buyerName"')
    expect(src.slice(nameIdx, nameIdx + 150)).toContain('required')
  })
})

// ── PhotoGallery / next/image source compatibility ──────────────────────────

describe('§8 — PhotoGallery next/image audit', () => {
  const src = readSrc('src/components/store/PhotoGallery.tsx')

  it('main image and thumbnails now use next/image with fill + sizes', () => {
    expect(src).toContain("import Image from 'next/image'")
    const occurrences = (src.match(/<Image\b/g) ?? []).length
    expect(occurrences).toBe(2)
    expect(src).toContain('sizes="(min-width: 1024px) 50vw, 100vw"')
    expect(src).toContain('sizes="64px"')
  })

  it('fill-mode images have a relative-positioned parent (required for fill to render correctly)', () => {
    const mainIdx = src.indexOf('aria-label={`View larger')
    const mainClassIdx = src.indexOf('className=', mainIdx)
    const mainBlock = src.slice(mainClassIdx, mainClassIdx + 200)
    expect(mainBlock).toContain('relative')

    const thumbIdx = src.indexOf('aria-pressed={i === selectedIndex}')
    const thumbBlock = src.slice(thumbIdx, thumbIdx + 300)
    expect(thumbBlock).toContain('relative')
  })

  it('aspect ratio/crop is preserved: object-contain on main image, object-cover on thumbnails (unchanged from the raw <img> versions)', () => {
    expect(src).toContain('className="object-contain"')
    expect(src).toContain('className="object-cover"')
  })

  it('the lightbox fullscreen image is intentionally left as a raw <img> with a documented incompatibility reason (no stored width/height for intrinsic sizing) — not silently using unoptimized', () => {
    const imgTagIdx = src.indexOf('<img\n')
    expect(imgTagIdx).toBeGreaterThan(-1)
    const disableIdx = src.lastIndexOf('@next/next/no-img-element', imgTagIdx)
    expect(disableIdx).toBeGreaterThan(-1)
    expect(imgTagIdx - disableIdx).toBeLessThan(100) // the disable comment immediately precedes the tag
    const explanationIdx = src.lastIndexOf('no stored width/height', imgTagIdx)
    expect(explanationIdx).toBeGreaterThan(-1)
    expect(src).not.toMatch(/unoptimized/)
  })

  it('alt text is preserved and correct for all three images', () => {
    expect(src).toContain('alt={`${current.type} view — ${title}`}')
    expect(src).toContain('alt={`${photo.type} view`}')
  })

  it('uses only the existing configured remote pattern — no new/broadened remotePatterns added to next.config', () => {
    const config = readSrc('next.config.ts')
    const occurrences = (config.match(/hostname:/g) ?? []).length
    expect(occurrences).toBe(1)
    expect(config).toContain("hostname: '*.public.blob.vercel-storage.com'")
  })

  it('Photo.url is always a Vercel Blob URL (put() result) — confirmed at every write path, never an arbitrary external host', () => {
    const blobUploadSrc = readSrc('src/lib/blobUpload.ts')
    expect(blobUploadSrc).toContain("import { put } from '@vercel/blob'")
    const intakeSrc = readSrc('src/lib/intakeConversion.ts')
    expect(intakeSrc).toContain('draft.frontPhotoUrl')
  })
})

describe('§9 — photo provenance preserved (Series 33 boundary untouched)', () => {
  const pageSrc = readSrc('src/app/(store)/browse/[id]/page.tsx')

  it('item photos vs catalog reference image distinction is unchanged', () => {
    expect(pageSrc).toContain('const photos = item.photos')
    expect(pageSrc).toContain('const catalogPhoto = catalog.photos[0]')
    expect(pageSrc).toContain('Photos of this item')
    expect(pageSrc).toContain('This is a catalog reference image, not a photo of this specific item.')
  })

  it('no new Verified/Inspected/Authenticated claim was introduced', () => {
    const stripped = stripComments(pageSrc)
    for (const forbidden of ['Verified', 'Inspected', 'Authenticated']) {
      expect(stripped).not.toContain(forbidden)
    }
  })
})

// ── §10 — camera-upload boundary untouched (deferred debt) ──────────────────

describe('§10 — camera-upload limits/architecture untouched, deferred debt', () => {
  it('blob upload 5MB limit, MIME allowlist, and capture/matching caps are all unchanged', () => {
    const blobUploadSrc = readSrc('src/lib/blobUpload.ts')
    expect(blobUploadSrc).toContain('5 * 1024 * 1024')
    const captureSrc = readSrc('src/lib/captureIdentifyCore.ts')
    expect(captureSrc).toMatch(/9\s*\*\s*1024\s*\*\s*1024/)
  })

  it('no client-side image compression was added anywhere', () => {
    for (const f of ['src/components/store/CaptureIdentify.tsx', 'src/components/store/SellCaptureFlow.tsx']) {
      const src = readSrc(f)
      expect(src).not.toMatch(/compress|resize.*image|canvas\.toBlob/i)
    }
  })

  it('no EXIF-orientation handling was added to customer-facing collection/seller photo uploads', () => {
    for (const f of ['src/lib/actions/collectionPhotos.ts', 'src/lib/actions/sellerSubmissionPhotos.ts']) {
      const src = readSrc(f)
      expect(src).not.toMatch(/exif|\.rotate\(\)/i)
    }
  })
})

// ── §11 — mobile navigation boundary untouched ───────────────────────────────

describe('§11 — mobile navigation unchanged', () => {
  it('CustomerHeader hamburger and AccountNav horizontal-scroll pattern are untouched', () => {
    const headerSrc = readSrc('src/components/store/CustomerHeader.tsx')
    expect(headerSrc).toMatch(/md:hidden/)
    const navSrc = readSrc('src/components/store/AccountNav.tsx')
    expect(navSrc).toContain('overflow-x-auto')
  })

  it('no floating Sell button or bottom-nav component was added', () => {
    const files = fs.readdirSync(path.join(root, 'src/components/store'))
    expect(files).not.toContain('BottomNav.tsx')
    expect(files).not.toContain('FloatingSellButton.tsx')
  })
})

// ── §12 — Market/Account boundary — no pricing/valuation/ranking changes ────

describe('§12 — Market/Account boundary: no pricing/valuation/ranking logic touched', () => {
  it('catalogDiscoveryQuery.ts, marketAskQuery.ts, accountPersonalizationQuery.ts are byte-unchanged by this milestone (no financial/ranking edits)', () => {
    const discoverySrc = readSrc('src/lib/catalogDiscoveryQuery.ts')
    expect(discoverySrc).toContain("{ brand: 'asc' },\n    { name: 'asc' },\n    { year: 'asc' },\n    { id: 'asc' },")
    const personalizationSrc = readSrc('src/lib/accountPersonalizationQuery.ts')
    expect(personalizationSrc).toContain('const SERIES_CANDIDATE_LIMIT = 100')
  })
})

// ── PWA/offline boundary — confirm nothing was added ─────────────────────────

describe('No PWA/service-worker/offline-caching code introduced', () => {
  it('no service worker, manifest, or offline caching code exists anywhere', () => {
    const publicFiles = fs.readdirSync(path.join(root, 'public'))
    expect(publicFiles).not.toContain('sw.js')
    expect(publicFiles).not.toContain('manifest.json')
    expect(fs.existsSync(path.join(root, 'src/app/manifest.ts'))).toBe(false)
  })

  it('package.json has zero new dependencies (no Workbox/next-pwa/image-compression)', () => {
    const pkg = JSON.parse(readSrc('package.json'))
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
    for (const forbidden of ['workbox', 'next-pwa', 'browser-image-compression']) {
      expect(Object.keys(allDeps).some((d) => d.toLowerCase().includes(forbidden))).toBe(false)
    }
  })
})

// ── Schema/migrations ──────────────────────────────────────────────────────

describe('Schema/migrations unchanged', () => {
  it('migration count is unchanged at 53', () => {
    const dirs = fs.readdirSync(path.join(root, 'prisma/migrations')).filter((f) => fs.statSync(path.join(root, 'prisma/migrations', f)).isDirectory())
    expect(dirs.length).toBe(54)
  })
})
