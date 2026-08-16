// 15K (execution-snapshot pass, Part 1): getExternalMarketSummaries' client param.
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({ prisma: { externalMarketObservation: { findMany: vi.fn() } } }))

import { prisma } from '@/lib/prisma'
import { getExternalMarketSummaries } from '@/lib/externalMarketResearch'

beforeEach(() => vi.resetAllMocks())

describe('getExternalMarketSummaries — client threading', () => {
  it('defaults to the global prisma client when none is supplied', async () => {
    ;(prisma.externalMarketObservation.findMany as Mock).mockResolvedValueOnce([])
    await getExternalMarketSummaries(['cat1'], new Date())
    expect(prisma.externalMarketObservation.findMany).toHaveBeenCalledTimes(1)
  })

  it('a supplied client (e.g. an open transaction) is used instead of the global client', async () => {
    const tx = { externalMarketObservation: { findMany: vi.fn().mockResolvedValue([]) } }
    await getExternalMarketSummaries(['cat1'], new Date(), tx as never)
    expect(prisma.externalMarketObservation.findMany).not.toHaveBeenCalled()
    expect(tx.externalMarketObservation.findMany).toHaveBeenCalledTimes(1)
  })
})
