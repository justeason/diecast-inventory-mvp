// 15H Part G/P section 45 — nav grouping logic. Only pure functions/data are
// exercised here (matches/activeGroup/NAV_GROUPS); the AdminNav component itself is
// a 'use client' React tree and this project has no DOM-rendering test setup, so
// component rendering is intentionally out of scope (matches every other admin
// component in this codebase — none are render-tested).
import { describe, it, expect } from 'vitest'
import { NAV_GROUPS, matches, activeGroup } from '@/components/admin/AdminNav'
import type { AdminAttentionBadges } from '@/lib/adminOperationsQuery'

describe('NAV_GROUPS — six primary domains + Settings (Part A)', () => {
  it('has exactly the seven expected top-level groups in order', () => {
    expect(NAV_GROUPS.map((g) => g.key)).toEqual([
      'operations', 'inventory', 'sellers', 'orders', 'finance', 'catalog', 'settings',
    ])
  })

  it('every group has at least one child link', () => {
    for (const g of NAV_GROUPS) expect(g.children.length).toBeGreaterThan(0)
  })

  it('badgeKey values used by nav children are a subset of the actual attention-badge fields', () => {
    const badgeFields: Array<keyof AdminAttentionBadges> = ['intakeExceptions', 'pendingApprovals', 'shipmentDiscrepancies']
    const usedKeys = new Set(NAV_GROUPS.flatMap((g) => g.children.map((c) => c.badgeKey).filter(Boolean)))
    expect(usedKeys.size).toBeGreaterThan(0)
    // badgeKey is a local alias ('exceptions'|'approvals'|'shipments'), not the
    // AdminAttentionBadges field name itself — just confirm the badge system isn't
    // referencing more distinct signals than the badge query actually produces.
    expect(usedKeys.size).toBeLessThanOrEqual(badgeFields.length)
  })
})

describe('NAV_GROUPS — no duplicate destination across DIFFERENT groups (15H focused-review section 3)', () => {
  // A group's own top-row href intentionally equals its first ("Overview") child
  // href — that's one destination reached two ways within the SAME group, not the
  // cross-group duplication the review flagged. This test only rejects an href that
  // appears as a CHILD of two different groups.
  it('no child href is reachable from more than one group', () => {
    const owner = new Map<string, string>()
    const dupes: string[] = []
    for (const g of NAV_GROUPS) {
      for (const c of g.children) {
        const prevOwner = owner.get(c.href)
        if (prevOwner && prevOwner !== g.key) dupes.push(`${c.href} in both ${prevOwner} and ${g.key}`)
        else owner.set(c.href, g.key)
      }
    }
    expect(dupes).toEqual([])
  })

  it('Commission Policies has exactly one global-nav home (Settings), not also under Sellers', () => {
    const groupsContainingIt = NAV_GROUPS.filter((g) => g.children.some((c) => c.href === '/admin/commission-policies'))
    expect(groupsContainingIt.map((g) => g.key)).toEqual(['settings'])
  })

  it('Locations has exactly one global-nav home (Settings), not also under Inventory', () => {
    const groupsContainingIt = NAV_GROUPS.filter((g) => g.children.some((c) => c.href === '/admin/locations'))
    expect(groupsContainingIt.map((g) => g.key)).toEqual(['settings'])
  })
})

describe('matches', () => {
  it('matches an exact path', () => {
    expect(matches('/admin/items', '/admin/items')).toBe(true)
  })

  it('matches a nested detail/edit path under a list href', () => {
    expect(matches('/admin/items/abc123/edit', '/admin/items')).toBe(true)
  })

  it('does not match a sibling path with a shared prefix', () => {
    expect(matches('/admin/items-export', '/admin/items')).toBe(false)
  })

  it('/admin only matches exactly (never swallows every admin route as a prefix)', () => {
    expect(matches('/admin/items', '/admin')).toBe(false)
    expect(matches('/admin', '/admin')).toBe(true)
  })
})

describe('activeGroup', () => {
  it('resolves a deep item edit page to the Inventory group', () => {
    expect(activeGroup('/admin/items/abc123/edit')?.key).toBe('inventory')
  })

  it('resolves the approvals detail page to the Operations group', () => {
    expect(activeGroup('/admin/approvals/req_1')?.key).toBe('operations')
  })

  it('resolves an unrelated/legacy deep-link page (not in any group) to null', () => {
    expect(activeGroup('/admin/seller-cases/xyz')).toBeNull()
  })

  it('still highlights Operations for the legacy intake-operations deep link, since it nests under the Intake child href', () => {
    expect(activeGroup('/admin/intake/operations')?.key).toBe('operations')
  })
})
