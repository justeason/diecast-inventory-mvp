// 15H Part O section 43 — the search server action must check admin auth itself,
// not rely solely on middleware (same pattern as every other admin action).
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/adminAuth', () => ({ isAdminAuthenticated: vi.fn() }))
vi.mock('@/lib/adminSearchQuery', () => ({ searchAdmin: vi.fn() }))

import { isAdminAuthenticated } from '@/lib/adminAuth'
import { searchAdmin } from '@/lib/adminSearchQuery'
import { searchAdminAction } from '@/lib/actions/adminSearch'

describe('searchAdminAction', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns [] without querying when not authenticated as admin', async () => {
    ;(isAdminAuthenticated as Mock).mockResolvedValue(false)
    const result = await searchAdminAction('porsche')
    expect(result).toEqual([])
    expect(searchAdmin).not.toHaveBeenCalled()
  })

  it('delegates to searchAdmin once authenticated', async () => {
    ;(isAdminAuthenticated as Mock).mockResolvedValue(true)
    ;(searchAdmin as Mock).mockResolvedValue([{ group: 'items', groupLabel: 'Items', results: [] }])
    const result = await searchAdminAction('porsche')
    expect(searchAdmin).toHaveBeenCalledWith('porsche')
    expect(result).toEqual([{ group: 'items', groupLabel: 'Items', results: [] }])
  })
})
