/**
 * 16F Final Persistence Integrity Pass: submitManualSellRequest has two truthful,
 * non-overlapping modes.
 *
 * MODE A (catalog-context): a valid catalogId was supplied. Identity fields
 * (brand/name/series/year/color/scale) are taken from the re-fetched CatalogModel
 * itself — never from browser-submitted text — so catalogId and identity can
 * never contradict. An invalid/forged/stale catalogId is a hard rejection, never
 * a silent downgrade to freeform.
 *
 * MODE B (freeform): no catalogId was supplied. Identity is exactly what the
 * customer typed, catalogId stays null — unchanged original behavior.
 *
 * No real DB, no real network.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({
  prisma: {
    catalogModel: { findUnique: vi.fn() },
    sellerSubmission: { create: vi.fn() },
  },
}))
vi.mock('@/lib/buyerSession', () => ({ getBuyerSession: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: vi.fn(() => { throw new Error('NEXT_REDIRECT') }) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { prisma } from '@/lib/prisma'
import { getBuyerSession } from '@/lib/buyerSession'
import { submitManualSellRequest } from '@/lib/actions/sellerSubmissions'

beforeEach(() => vi.resetAllMocks())

function baseFormData(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData()
  fd.set('brand', 'Hot Wheels')
  fd.set('name', 'Porsche 911 GT3')
  fd.set('quantity', '1')
  fd.set('saleTypePreference', 'consignment')
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v)
  return fd
}

const CATALOG_X = { id: 'catX', brand: 'Porsche', name: '911 GT3', series: 'Motorsport', year: 2024, color: 'White', scale: '1:64' }
const CATALOG_Y = { id: 'catY', brand: 'Ferrari', name: 'F40', series: null, year: 1987, color: 'Red', scale: '1:64' }

describe('submitManualSellRequest — MODE A: catalog-context (valid catalogId)', () => {
  it('re-fetches the full CatalogModel and persists ITS OWN identity fields, ignoring whatever brand/name/etc the form submitted', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue(CATALOG_X)
    ;(prisma.sellerSubmission.create as Mock).mockResolvedValue({ id: 's1' })

    // Tampered/stale form text disagreeing with the catalog model.
    const fd = baseFormData({ catalogId: 'catX', brand: 'Totally Different Brand', name: 'Totally Different Name' })
    await expect(submitManualSellRequest(null, fd)).rejects.toThrow() // redirect() throws in test env

    expect(prisma.catalogModel.findUnique).toHaveBeenCalledWith({
      where: { id: 'catX' },
      select: { id: true, brand: true, name: true, series: true, year: true, color: true, scale: true },
    })
    const createCall = (prisma.sellerSubmission.create as Mock).mock.calls[0][0]
    expect(createCall.data.catalogId).toBe('catX')
    expect(createCall.data.brand).toBe('Porsche')
    expect(createCall.data.name).toBe('911 GT3')
    expect(createCall.data.series).toBe('Motorsport')
    expect(createCall.data.year).toBe(2024)
    expect(createCall.data.color).toBe('White')
    expect(createCall.data.scale).toBe('1:64')
  })

  it('physical/customer fields (condition, cardedOrLoose, quantity, saleTypePreference, expectedPrice, userNotes) still come from the submitted form — CatalogModel has no opinion on them', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue(CATALOG_X)
    ;(prisma.sellerSubmission.create as Mock).mockResolvedValue({ id: 's1' })

    const fd = baseFormData({
      catalogId: 'catX',
      condition: 'mint',
      cardedOrLoose: 'carded',
      quantity: '3',
      userNotes: 'Bought at a convention',
    })
    await expect(submitManualSellRequest(null, fd)).rejects.toThrow()

    const createCall = (prisma.sellerSubmission.create as Mock).mock.calls[0][0]
    expect(createCall.data.condition).toBe('mint')
    expect(createCall.data.cardedOrLoose).toBe('carded')
    expect(createCall.data.quantity).toBe(3)
    expect(createCall.data.userNotes).toBe('Bought at a convention')
  })

  it('an invalid/forged/nonexistent catalogId is REJECTED — no SellerSubmission is created, never silently downgraded to freeform', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue(null) // does not exist

    const fd = baseFormData({ catalogId: 'does-not-exist' })
    const result = await submitManualSellRequest(null, fd)

    expect(result?.errors.catalogId).toBeDefined()
    expect(prisma.sellerSubmission.create).not.toHaveBeenCalled()
  })

  it('the rejection error message does not leak internal DB details', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue(null)

    const fd = baseFormData({ catalogId: 'does-not-exist' })
    const result = await submitManualSellRequest(null, fd)

    const msg = result?.errors.catalogId?.[0] ?? ''
    expect(msg).not.toMatch(/prisma|sql|constraint|stack|undefined/i)
  })

  it('a valid-but-changed catalogId (X swapped for Y) persists Y consistently — catalogId and identity fields always describe the SAME model, never a mismatch', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
    // The customer's browser is tampered to submit catalogId=Y instead of the
    // originally-displayed X; Y is itself a real, valid CatalogModel.
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue(CATALOG_Y)
    ;(prisma.sellerSubmission.create as Mock).mockResolvedValue({ id: 's1' })

    const fd = baseFormData({ catalogId: 'catY', brand: 'Porsche', name: '911 GT3' }) // stale form text still describes X
    await expect(submitManualSellRequest(null, fd)).rejects.toThrow()

    expect(prisma.catalogModel.findUnique).toHaveBeenCalledWith({
      where: { id: 'catY' },
      select: { id: true, brand: true, name: true, series: true, year: true, color: true, scale: true },
    })
    const createCall = (prisma.sellerSubmission.create as Mock).mock.calls[0][0]
    // Persisted identity is Y's, fully consistent with catalogId=Y — never a
    // catalogId=Y submission that describes X.
    expect(createCall.data.catalogId).toBe('catY')
    expect(createCall.data.brand).toBe('Ferrari')
    expect(createCall.data.name).toBe('F40')
  })

  it('brand/name presence validation (required for freeform) does not apply in catalog-context mode — the catalog match always supplies identity', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
    ;(prisma.catalogModel.findUnique as Mock).mockResolvedValue(CATALOG_X)
    ;(prisma.sellerSubmission.create as Mock).mockResolvedValue({ id: 's1' })

    const fd = new FormData()
    fd.set('catalogId', 'catX')
    fd.set('quantity', '1')
    fd.set('saleTypePreference', 'consignment')
    // No brand/name fields submitted at all.
    await expect(submitManualSellRequest(null, fd)).rejects.toThrow()

    const createCall = (prisma.sellerSubmission.create as Mock).mock.calls[0][0]
    expect(createCall.data.brand).toBe('Porsche')
  })
})

describe('submitManualSellRequest — MODE B: freeform (no catalogId)', () => {
  it('no catalogId submitted still creates catalogId: null and preserves the existing freeform identity behavior', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
    ;(prisma.sellerSubmission.create as Mock).mockResolvedValue({ id: 's1' })

    const fd = baseFormData()
    await expect(submitManualSellRequest(null, fd)).rejects.toThrow()

    expect(prisma.catalogModel.findUnique).not.toHaveBeenCalled()
    const createCall = (prisma.sellerSubmission.create as Mock).mock.calls[0][0]
    expect(createCall.data.catalogId).toBeNull()
    expect(createCall.data.brand).toBe('Hot Wheels')
    expect(createCall.data.name).toBe('Porsche 911 GT3')
  })

  it('freeform mode still requires at least a brand or name — selling an uncatalogued item remains possible without any catalogId', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
    const fd = new FormData()
    fd.set('quantity', '1')
    fd.set('saleTypePreference', 'consignment')
    const result = await submitManualSellRequest(null, fd)
    expect(result?.errors.brandOrName).toBeDefined()
    expect(prisma.sellerSubmission.create).not.toHaveBeenCalled()
  })
})

describe('submitManualSellRequest — no SellerSubmission on render/link click, only explicit submit', () => {
  it('no authenticated session means no SellerSubmission, regardless of catalogId', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue(null)
    const fd = baseFormData({ catalogId: 'catX' })
    const result = await submitManualSellRequest(null, fd)
    expect(result?.errors.form).toBeDefined()
    expect(prisma.catalogModel.findUnique).not.toHaveBeenCalled()
    expect(prisma.sellerSubmission.create).not.toHaveBeenCalled()
  })
})

describe('submitCollectionItemForSale: catalogId already persisted from the CollectionItem (unchanged, pre-existing behavior)', () => {
  it('uses item.catalogId from the re-fetched, ownership-scoped CollectionItem — not a browser-supplied value, not routed through the freeform manual-sell path', () => {
    const src = fs.readFileSync(
      path.join(path.resolve(__dirname, '../../..'), 'src/lib/actions/sellerSubmissions.ts'),
      'utf-8',
    )
    const fnIdx = src.indexOf('export async function submitCollectionItemForSale')
    const fnEnd = src.indexOf('export async function submitManualSellRequest')
    const fnSrc = src.slice(fnIdx, fnEnd)
    expect(fnSrc).toContain('catalogId: item.catalogId ?? null')
    expect(fnSrc).not.toContain('submitManualSellRequest')
  })
})
