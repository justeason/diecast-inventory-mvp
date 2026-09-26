// Checkout reservation integrity hotfix (28A follow-up): the pre-existing
// unconditional `itemInstance.update({status:'reserved'})` allowed two
// concurrent createOrder transactions to both reserve the same physical
// ItemInstance. Fixed by making reservation a conditional
// updateMany(available -> reserved) + count===1 check — the DB write itself
// is the only real concurrency guard, never the earlier findMany read alone.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({
  prisma: {
    listing: { findMany: vi.fn() },
    customerProfile: { upsert: vi.fn().mockResolvedValue({ id: 'prof1' }) },
    $transaction: vi.fn(),
  },
}))
vi.mock('@/lib/stripe', () => ({ getStripe: vi.fn() }))
vi.mock('@/lib/buyerSession', () => ({ getBuyerSession: vi.fn().mockResolvedValue(null) }))
vi.mock('@/lib/actions/sellerPayouts', () => ({ ensureConsignmentPayoutLinesForCompletedOrder: vi.fn() }))
vi.mock('@/lib/actions/sellerLifecycle', () => ({ ensureSellerLifecycleEvent: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: vi.fn(() => { throw new Error('REDIRECT') }) }))

import { prisma } from '@/lib/prisma'
import { getBuyerSession } from '@/lib/buyerSession'
import { createOrder } from '@/lib/actions/orders'

function listingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'listing1',
    itemId: 'item1',
    price: 10,
    item: { catalogId: 'cat1', marketVariantId: 'variant1', cardedOrLoose: 'carded', condition: 'mint' },
    ...overrides,
  }
}

function makeTx(overrides: Record<string, unknown> = {}) {
  return {
    order: { create: vi.fn().mockResolvedValue({ id: 'order1' }) },
    orderItem: { create: vi.fn().mockResolvedValue({}) },
    itemInstance: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    ...overrides,
  }
}

function mockTransaction(tx: ReturnType<typeof makeTx>) {
  ;(prisma.$transaction as Mock).mockImplementationOnce(async (cb: (tx: unknown) => unknown) => cb(tx))
}

function singleItemFormData(): FormData {
  const fd = new FormData()
  fd.set('listingIds', 'listing1')
  fd.set('buyerName', 'Jane Buyer')
  fd.set('buyerEmail', 'jane@example.com')
  return fd
}

function twoItemFormData(): FormData {
  const fd = new FormData()
  fd.append('listingIds', 'listing1')
  fd.append('listingIds', 'listing2')
  fd.set('buyerName', 'Jane Buyer')
  fd.set('buyerEmail', 'jane@example.com')
  return fd
}

beforeEach(() => {
  vi.resetAllMocks()
  ;(prisma.customerProfile.upsert as Mock).mockResolvedValue({ id: 'prof1' })
  ;(getBuyerSession as Mock).mockResolvedValue(null)
})

describe('A. available item — conditional reservation count=1 — order succeeds', () => {
  it('reserves via a conditional available->reserved updateMany, then succeeds', async () => {
    ;(prisma.listing.findMany as Mock).mockResolvedValue([listingRow()])
    const tx = makeTx()
    mockTransaction(tx)

    await expect(createOrder(null, singleItemFormData())).resolves.toEqual({ success: true, orderId: 'order1' })

    expect(tx.itemInstance.updateMany).toHaveBeenCalledWith({
      where: { id: 'item1', status: 'available' },
      data: { status: 'reserved' },
    })
    expect(tx.order.create).toHaveBeenCalledTimes(1)
    expect(tx.orderItem.create).toHaveBeenCalledTimes(1)
  })

  it('reservation happens BEFORE Order/OrderItem creation (call ordering)', async () => {
    ;(prisma.listing.findMany as Mock).mockResolvedValue([listingRow()])
    const tx = makeTx()
    mockTransaction(tx)
    const calls: string[] = []
    ;(tx.itemInstance.updateMany as Mock).mockImplementation(async () => {
      calls.push('reserve')
      return { count: 1 }
    })
    ;(tx.order.create as Mock).mockImplementation(async () => {
      calls.push('order')
      return { id: 'order1' }
    })
    ;(tx.orderItem.create as Mock).mockImplementation(async () => {
      calls.push('orderItem')
      return {}
    })

    await createOrder(null, singleItemFormData())

    expect(calls).toEqual(['reserve', 'order', 'orderItem'])
  })
})

describe('B. reservation count=0 (lost the race after the availability read) — order fails, no success result', () => {
  it('returns the existing honest "no longer available" checkout error, never a raw/DB error', async () => {
    ;(prisma.listing.findMany as Mock).mockResolvedValue([listingRow()])
    const tx = makeTx({ itemInstance: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) } })
    mockTransaction(tx)

    const result = await createOrder(null, singleItemFormData())

    expect(result).toEqual({
      errors: { form: ['One or more items are no longer available. Please review your cart and try again.'] },
    })
  })

  it('no Order or OrderItem is created when the reservation loses the race', async () => {
    ;(prisma.listing.findMany as Mock).mockResolvedValue([listingRow()])
    const tx = makeTx({ itemInstance: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) } })
    mockTransaction(tx)

    await createOrder(null, singleItemFormData())

    expect(tx.order.create).not.toHaveBeenCalled()
    expect(tx.orderItem.create).not.toHaveBeenCalled()
  })

  it('an unrelated transaction error is never swallowed as a false "unavailable" message', async () => {
    ;(prisma.listing.findMany as Mock).mockResolvedValue([listingRow()])
    ;(prisma.$transaction as Mock).mockImplementationOnce(async () => {
      throw new Error('connection reset')
    })

    await expect(createOrder(null, singleItemFormData())).rejects.toThrow('connection reset')
  })
})

describe('C. multi-item cart: first reservation succeeds, second loses the race — full rollback, no partial order', () => {
  it('throws inside the transaction and returns the unavailable error, never a partial success', async () => {
    ;(prisma.listing.findMany as Mock).mockResolvedValue([
      listingRow({ id: 'listing1', itemId: 'item1' }),
      listingRow({ id: 'listing2', itemId: 'item2' }),
    ])
    const updateMany = vi.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })
    const tx = makeTx({ itemInstance: { updateMany } })
    mockTransaction(tx)

    const result = await createOrder(null, twoItemFormData())

    expect(result).toEqual({
      errors: { form: ['One or more items are no longer available. Please review your cart and try again.'] },
    })
    expect(updateMany).toHaveBeenCalledTimes(2)
  })

  it('Order/OrderItem are never created when any reservation in the cart fails — the whole attempt rolls back together', async () => {
    ;(prisma.listing.findMany as Mock).mockResolvedValue([
      listingRow({ id: 'listing1', itemId: 'item1' }),
      listingRow({ id: 'listing2', itemId: 'item2' }),
    ])
    const updateMany = vi.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })
    const tx = makeTx({ itemInstance: { updateMany } })
    mockTransaction(tx)

    await createOrder(null, twoItemFormData())

    // The first item's reservation "succeeded" only inside the doomed transaction —
    // since the whole tx throws and Prisma rolls back, no Order/OrderItem for
    // EITHER item is ever persisted (interactive $transaction semantics: any
    // thrown error inside the callback rolls back everything the callback did).
    expect(tx.order.create).not.toHaveBeenCalled()
    expect(tx.orderItem.create).not.toHaveBeenCalled()
  })

  it('a cart where BOTH items reserve successfully creates exactly one Order and one OrderItem per listing', async () => {
    ;(prisma.listing.findMany as Mock).mockResolvedValue([
      listingRow({ id: 'listing1', itemId: 'item1' }),
      listingRow({ id: 'listing2', itemId: 'item2' }),
    ])
    const tx = makeTx()
    mockTransaction(tx)

    await expect(createOrder(null, twoItemFormData())).resolves.toEqual({ success: true, orderId: 'order1' })

    expect(tx.itemInstance.updateMany).toHaveBeenCalledTimes(2)
    expect(tx.order.create).toHaveBeenCalledTimes(1)
    expect(tx.orderItem.create).toHaveBeenCalledTimes(2)
  })
})

describe('D. no production reservation path uses a plain, unguarded itemInstance.update for the available->reserved transition', () => {
  const ordersSrc = fs.readFileSync(path.join(process.cwd(), 'src/lib/actions/orders.ts'), 'utf-8')

  it('createOrder uses updateMany with a status:"available" guard, never a plain update-by-id for reservation', () => {
    const idx = ordersSrc.indexOf('for (const listing of listings) {')
    const block = ordersSrc.slice(idx, ordersSrc.indexOf('if (reserved.count !== 1)', idx))
    expect(block).toContain('tx.itemInstance.updateMany({')
    expect(block).toContain("status: 'available'")
    expect(block).toContain("status: 'reserved'")
  })

  it('the reservation count is checked (count !== 1) and a failure throws — never silently ignored', () => {
    expect(ordersSrc).toContain('if (reserved.count !== 1)')
    expect(ordersSrc).toContain('throw new ListingUnavailableError()')
  })

  it('no bare `itemInstance.update(` call exists anywhere in orders.ts (the old racy call site is fully removed)', () => {
    expect(ordersSrc).not.toMatch(/tx\.itemInstance\.update\(/)
  })

  it('reservation happens inside the same prisma.$transaction as Order/OrderItem creation — one atomic operation', () => {
    const txIdx = ordersSrc.indexOf('await prisma.$transaction(async (tx) => {')
    const reserveIdx = ordersSrc.indexOf('tx.itemInstance.updateMany(')
    const orderCreateIdx = ordersSrc.indexOf('await tx.order.create(')
    expect(txIdx).toBeGreaterThan(-1)
    expect(reserveIdx).toBeGreaterThan(txIdx)
    expect(orderCreateIdx).toBeGreaterThan(reserveIdx)
  })
})

describe('E. duplicate listing id in the same cart — already rejected by the existing length check, no new code needed', () => {
  it('a duplicate listingId collapses to one matching row (SQL IN never returns a row twice), tripping the pre-existing listings.length !== listingIds.length guard', async () => {
    const fd = new FormData()
    fd.append('listingIds', 'listing1')
    fd.append('listingIds', 'listing1') // same listing submitted twice
    fd.set('buyerName', 'Jane Buyer')
    fd.set('buyerEmail', 'jane@example.com')

    // Prisma's `id: { in: [...] }` returns each matching row at most once —
    // simulate that faithfully: 2 requested ids, only 1 distinct row returned.
    ;(prisma.listing.findMany as Mock).mockResolvedValue([listingRow()])

    const result = await createOrder(null, fd)

    expect(result).toEqual({
      errors: { form: ['One or more items are no longer available. Please review your cart and try again.'] },
    })
    // Never even reaches the transaction — rejected at the pre-existing length check.
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })
})

describe('F. normal single-order checkout behavior is unchanged', () => {
  it('single-item happy path still returns { success: true, orderId }', async () => {
    ;(prisma.listing.findMany as Mock).mockResolvedValue([listingRow()])
    const tx = makeTx()
    mockTransaction(tx)
    await expect(createOrder(null, singleItemFormData())).resolves.toEqual({ success: true, orderId: 'order1' })
  })

  it('cancellation/completion (updateOrderStatus) is untouched by this hotfix — still uses its own pre-existing guarded updateMany transitions', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/actions/orders.ts'), 'utf-8')
    expect(src).toContain("where: { id: { in: itemIds }, status: 'reserved' },\n        data: { status: 'available' },")
    expect(src).toContain("where: { id: { in: itemIds }, status: 'reserved' },\n        data: { status: 'sold' },")
  })
})
