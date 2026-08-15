// 15H Part H — global admin search. Read-only, bounded, DB-side filtered. Every
// branch below is capped at RESULTS_PER_GROUP and queried in parallel — no full-
// table scan, no unbounded `contains` over history/notes fields (Part H section 27).
//
// Privacy (section 28): buyer PII (email/phone/address) is never selected or
// matched here. Order search only matches the order id itself — buyer-email lookup
// stays on the specialized Orders page, which already has that capability.

import { prisma } from '@/lib/prisma'

export const MIN_QUERY_LENGTH = 2
const RESULTS_PER_GROUP = 5

export type AdminSearchGroup = 'items' | 'catalog' | 'sellers' | 'portfolios' | 'shipments' | 'orders' | 'listings'

export type AdminSearchResult = {
  group: AdminSearchGroup
  id: string
  label: string
  sublabel?: string
  href: string
}

export type AdminSearchResults = { group: AdminSearchGroup; groupLabel: string; results: AdminSearchResult[] }[]

const GROUP_LABELS: Record<AdminSearchGroup, string> = {
  items: 'Items',
  catalog: 'Catalog',
  sellers: 'Sellers',
  portfolios: 'Portfolios',
  shipments: 'Shipments',
  orders: 'Orders',
  listings: 'Listings',
}

export async function searchAdmin(rawQuery: string): Promise<AdminSearchResults> {
  const q = rawQuery.trim()
  if (q.length < MIN_QUERY_LENGTH) return []

  const insensitive = { contains: q, mode: 'insensitive' as const }

  const [items, catalog, sellers, portfolios, shipments, orders, listings] = await Promise.all([
    prisma.itemInstance.findMany({
      where: { sku: insensitive },
      take: RESULTS_PER_GROUP,
      select: { id: true, sku: true, catalog: { select: { brand: true, name: true } } },
    }),
    prisma.catalogModel.findMany({
      where: { OR: [{ brand: insensitive }, { name: insensitive }] },
      take: RESULTS_PER_GROUP,
      select: { id: true, brand: true, name: true, year: true },
    }),
    prisma.sellerProfile.findMany({
      where: { displayName: insensitive },
      take: RESULTS_PER_GROUP,
      select: { id: true, displayName: true, status: true },
    }),
    prisma.sellerPortfolio.findMany({
      where: { name: insensitive },
      take: RESULTS_PER_GROUP,
      select: { id: true, name: true, status: true, sellerProfile: { select: { displayName: true } } },
    }),
    prisma.sellerInboundShipment.findMany({
      where: { trackingNumber: insensitive },
      take: RESULTS_PER_GROUP,
      select: { id: true, trackingNumber: true, status: true, sellerSubmissionId: true },
    }),
    // Order: id prefix match only — never buyer email/phone/address (section 28).
    prisma.order.findMany({
      where: { id: { startsWith: q } },
      take: RESULTS_PER_GROUP,
      select: { id: true, status: true },
    }),
    prisma.listing.findMany({
      where: { title: insensitive },
      take: RESULTS_PER_GROUP,
      select: { id: true, title: true, status: true },
    }),
  ])

  const out: AdminSearchResults = []

  if (items.length > 0) {
    out.push({
      group: 'items', groupLabel: GROUP_LABELS.items,
      results: items.map((i) => ({
        group: 'items', id: i.id, label: i.sku,
        sublabel: `${i.catalog.brand} ${i.catalog.name}`,
        href: `/admin/items/${i.id}`,
      })),
    })
  }
  if (catalog.length > 0) {
    out.push({
      group: 'catalog', groupLabel: GROUP_LABELS.catalog,
      results: catalog.map((c) => ({
        group: 'catalog', id: c.id, label: `${c.brand} ${c.name}`,
        sublabel: c.year ? String(c.year) : undefined,
        href: `/admin/catalog/${c.id}/edit`,
      })),
    })
  }
  if (sellers.length > 0) {
    out.push({
      group: 'sellers', groupLabel: GROUP_LABELS.sellers,
      results: sellers.map((s) => ({
        group: 'sellers', id: s.id, label: s.displayName ?? s.id,
        sublabel: s.status,
        href: `/admin/seller-profiles/${s.id}`,
      })),
    })
  }
  if (portfolios.length > 0) {
    out.push({
      group: 'portfolios', groupLabel: GROUP_LABELS.portfolios,
      results: portfolios.map((p) => ({
        group: 'portfolios', id: p.id, label: p.name ?? p.id,
        sublabel: p.sellerProfile?.displayName ?? undefined,
        href: `/admin/seller-portfolios/${p.id}`,
      })),
    })
  }
  if (shipments.length > 0) {
    out.push({
      group: 'shipments', groupLabel: GROUP_LABELS.shipments,
      results: shipments.map((s) => ({
        group: 'shipments', id: s.id, label: s.trackingNumber ?? s.id,
        sublabel: s.status,
        href: (s.status === 'received' || s.status === 'issue')
          ? `/admin/intake/workbench/${s.id}`
          : s.sellerSubmissionId
          ? `/admin/seller-submissions/${s.sellerSubmissionId}`
          : '/admin/intake/inbound',
      })),
    })
  }
  if (orders.length > 0) {
    out.push({
      group: 'orders', groupLabel: GROUP_LABELS.orders,
      results: orders.map((o) => ({
        group: 'orders', id: o.id, label: o.id,
        sublabel: o.status,
        href: `/admin/orders/${o.id}`,
      })),
    })
  }
  if (listings.length > 0) {
    out.push({
      group: 'listings', groupLabel: GROUP_LABELS.listings,
      results: listings.map((l) => ({
        group: 'listings', id: l.id, label: l.title,
        sublabel: l.status,
        href: `/admin/listings/${l.id}/edit`,
      })),
    })
  }

  return out
}
