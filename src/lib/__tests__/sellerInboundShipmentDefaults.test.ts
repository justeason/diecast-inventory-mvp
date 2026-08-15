// 15I: behavioral coverage for saveShipmentDefaults (Part B) — validation, explicit
// clear semantics (null vs undefined), and that this is genuinely a prefill-only
// write (SellerInboundShipment.default*), never touching IntakeDraft/ItemInstance.
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/adminAuth', () => ({ isAdminAuthenticated: vi.fn().mockResolvedValue(true) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/buyerSession', () => ({ getBuyerSession: vi.fn() }))
vi.mock('@/lib/actions/sellerLifecycle', () => ({ ensureSellerLifecycleEvent: vi.fn() }))
vi.mock('@/lib/prisma', () => ({
  prisma: {
    sellerInboundShipment: { findUnique: vi.fn(), update: vi.fn() },
    storageLocation: { findUnique: vi.fn() },
  },
}))

import { prisma } from '@/lib/prisma'
import { isAdminAuthenticated } from '@/lib/adminAuth'
import { saveShipmentDefaults } from '@/lib/actions/sellerInboundShipment'

function mockUpdatedRow(overrides: Record<string, unknown> = {}) {
  return {
    defaultStorageLocationId: null, defaultCondition: null, defaultCardedOrLoose: null,
    defaultStorageLocation: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  ;(isAdminAuthenticated as Mock).mockResolvedValue(true)
  ;(prisma.sellerInboundShipment.findUnique as Mock).mockResolvedValue({ id: 'ship1' })
})

describe('saveShipmentDefaults — auth', () => {
  it('rejects when not admin-authenticated', async () => {
    ;(isAdminAuthenticated as Mock).mockResolvedValue(false)
    const result = await saveShipmentDefaults('ship1', { condition: 'mint' })
    expect(result).toEqual({ ok: false, error: 'Admin authentication required.' })
    expect(prisma.sellerInboundShipment.update).not.toHaveBeenCalled()
  })
})

describe('saveShipmentDefaults — validation (section 6)', () => {
  it('rejects an unknown shipment', async () => {
    ;(prisma.sellerInboundShipment.findUnique as Mock).mockResolvedValue(null)
    const result = await saveShipmentDefaults('missing', { condition: 'mint' })
    expect(result).toEqual({ ok: false, error: 'Shipment not found.' })
  })

  it('invalid storage location can never become a saved default', async () => {
    ;(prisma.storageLocation.findUnique as Mock).mockResolvedValue(null)
    const result = await saveShipmentDefaults('ship1', { storageLocationId: 'bad-loc' })
    expect(result.ok).toBe(false)
    expect(prisma.sellerInboundShipment.update).not.toHaveBeenCalled()
  })

  it('rejects an invalid condition enum value', async () => {
    const result = await saveShipmentDefaults('ship1', { condition: 'mint-plus' })
    expect(result.ok).toBe(false)
    expect(prisma.sellerInboundShipment.update).not.toHaveBeenCalled()
  })

  it('rejects an invalid cardedOrLoose value', async () => {
    const result = await saveShipmentDefaults('ship1', { cardedOrLoose: 'boxed' })
    expect(result.ok).toBe(false)
    expect(prisma.sellerInboundShipment.update).not.toHaveBeenCalled()
  })
})

describe('saveShipmentDefaults — set vs clear semantics (section 7)', () => {
  it('a valid storage default is saved after re-validating the location', async () => {
    ;(prisma.storageLocation.findUnique as Mock).mockResolvedValue({ id: 'loc1' })
    ;(prisma.sellerInboundShipment.update as Mock).mockResolvedValue(
      mockUpdatedRow({ defaultStorageLocationId: 'loc1', defaultStorageLocation: { label: 'B-14-03' } }),
    )
    const result = await saveShipmentDefaults('ship1', { storageLocationId: 'loc1' })
    expect(result).toEqual({ ok: true, defaults: { storageLocationId: 'loc1', storageLabel: 'B-14-03', condition: null, cardedOrLoose: null } })
    expect(prisma.sellerInboundShipment.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'ship1' }, data: { defaultStorageLocationId: 'loc1' },
    }))
  })

  it('passing null explicitly clears the storage default — distinct from omitting the field', async () => {
    ;(prisma.sellerInboundShipment.update as Mock).mockResolvedValue(mockUpdatedRow())
    await saveShipmentDefaults('ship1', { storageLocationId: null })
    expect(prisma.sellerInboundShipment.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { defaultStorageLocationId: null },
    }))
    // Clearing storage never re-validates a "location" since there is none to check.
    expect(prisma.storageLocation.findUnique).not.toHaveBeenCalled()
  })

  it('omitting a field leaves it untouched in the update payload (undefined key never sent)', async () => {
    ;(prisma.sellerInboundShipment.update as Mock).mockResolvedValue(mockUpdatedRow({ defaultCondition: 'mint' }))
    await saveShipmentDefaults('ship1', { condition: 'mint' })
    const call = (prisma.sellerInboundShipment.update as Mock).mock.calls[0][0]
    expect(call.data).toEqual({ defaultCondition: 'mint' })
    expect('defaultStorageLocationId' in call.data).toBe(false)
    expect('defaultCardedOrLoose' in call.data).toBe(false)
  })

  it('clearing condition and cardedOrLoose together', async () => {
    ;(prisma.sellerInboundShipment.update as Mock).mockResolvedValue(mockUpdatedRow())
    await saveShipmentDefaults('ship1', { condition: null, cardedOrLoose: null })
    expect(prisma.sellerInboundShipment.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { defaultCondition: null, defaultCardedOrLoose: null },
    }))
  })
})

describe('saveShipmentDefaults — scope (Part D section 4/5)', () => {
  it('only ever writes SellerInboundShipment fields — no IntakeDraft/ItemInstance/Listing/Payout mutation', async () => {
    ;(prisma.sellerInboundShipment.update as Mock).mockResolvedValue(mockUpdatedRow())
    await saveShipmentDefaults('ship1', { condition: 'mint' })
    expect(prisma.sellerInboundShipment.update).toHaveBeenCalledTimes(1)
    // The mocked prisma client only exposes sellerInboundShipment/storageLocation
    // (see the vi.mock factory above) — if this action ever touched another table
    // it would throw here (undefined method call), not silently succeed.
  })
})
