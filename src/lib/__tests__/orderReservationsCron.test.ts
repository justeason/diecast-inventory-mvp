// 39B: CRON_SECRET auth + delegation coverage for
// src/app/api/cron/order-reservations/route.ts — mirrors the established
// buyer-alerts cron test pattern.
import { it, expect, vi, beforeEach } from 'vitest'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/orderReservation', () => ({
  releaseExpiredReservations: vi.fn(),
}))
vi.mock('@/lib/serverLogger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { releaseExpiredReservations } from '@/lib/orderReservation'
import { GET } from '@/app/api/cron/order-reservations/route'

beforeEach(() => {
  vi.resetAllMocks()
  delete process.env.CRON_SECRET
})

it('rejects with 401 when CRON_SECRET is not configured', async () => {
  const req = new Request('https://example.com/api/cron/order-reservations')
  const res = await GET(req)
  expect(res.status).toBe(401)
  expect(releaseExpiredReservations).not.toHaveBeenCalled()
})

it('rejects with 401 on a wrong bearer token', async () => {
  process.env.CRON_SECRET = 'super-secret'
  const req = new Request('https://example.com/api/cron/order-reservations', { headers: { authorization: 'Bearer wrong' } })
  const res = await GET(req)
  expect(res.status).toBe(401)
  expect(releaseExpiredReservations).not.toHaveBeenCalled()
})

it('runs the release job and returns its result on a valid bearer token', async () => {
  process.env.CRON_SECRET = 'super-secret'
  ;(releaseExpiredReservations as Mock).mockResolvedValue({ checked: 3, released: 1, retained: 2, reconciledPaid: 0 })
  const req = new Request('https://example.com/api/cron/order-reservations', { headers: { authorization: 'Bearer super-secret' } })

  const res = await GET(req)
  const body = await res.json()

  expect(res.status).toBe(200)
  expect(releaseExpiredReservations).toHaveBeenCalledTimes(1)
  expect(body).toEqual({ ok: true, result: { checked: 3, released: 1, retained: 2, reconciledPaid: 0 } })
})
