import { prisma } from '@/lib/prisma'

export const WANTED_PAGE_SIZE = 24

export type WantedListEntry = {
  id: string
  maxDesiredPrice: string | null
  notes: string | null
  createdAt: Date
  catalog: {
    id: string
    brand: string
    name: string
    year: number | null
    series: string | null
    color: string | null
    scale: string | null
    photoUrl: string | null
  }
}

type RawRow = {
  id: string
  maxDesiredPrice: { toString(): string } | null
  notes: string | null
  createdAt: Date
  catalogModel: {
    id: string
    brand: string
    name: string
    year: number | null
    series: string | null
    color: string | null
    scale: string | null
    photos: { url: string }[]
  }
}

function mapRow(r: RawRow): WantedListEntry {
  return {
    id: r.id,
    maxDesiredPrice: r.maxDesiredPrice?.toString() ?? null,
    notes: r.notes,
    createdAt: r.createdAt,
    catalog: {
      id: r.catalogModel.id,
      brand: r.catalogModel.brand,
      name: r.catalogModel.name,
      year: r.catalogModel.year,
      series: r.catalogModel.series,
      color: r.catalogModel.color,
      scale: r.catalogModel.scale,
      photoUrl: r.catalogModel.photos[0]?.url ?? null,
    },
  }
}

const WANTED_SELECT = {
  id: true,
  maxDesiredPrice: true,
  notes: true,
  createdAt: true,
  catalogModel: {
    select: {
      id: true,
      brand: true,
      name: true,
      year: true,
      series: true,
      color: true,
      scale: true,
      photos: { take: 1, orderBy: { sortOrder: 'asc' as const }, select: { url: true } },
    },
  },
}

function paginate(rows: RawRow[]): { items: WantedListEntry[]; nextCursor: string | null } {
  const hasMore = rows.length > WANTED_PAGE_SIZE
  const items = hasMore ? rows.slice(0, WANTED_PAGE_SIZE) : rows
  return { items: items.map(mapRow), nextCursor: hasMore ? items[items.length - 1].id : null }
}

export async function getWantedList(
  profileId: string,
  cursor?: string,
): Promise<{ items: WantedListEntry[]; nextCursor: string | null }> {
  const rows = await prisma.wantedCatalogModel.findMany({
    where: {
      customerProfileId: profileId,
      ...(cursor ? { id: { gt: cursor } } : {}),
    },
    orderBy: { id: 'asc' },
    take: WANTED_PAGE_SIZE + 1,
    select: WANTED_SELECT,
  })
  return paginate(rows as RawRow[])
}

// DB-level availability filter: only entries where the catalog has at least one active+available listing with price > 0.
export async function getAvailableWantedList(
  profileId: string,
  cursor?: string,
): Promise<{ items: WantedListEntry[]; nextCursor: string | null }> {
  const rows = await prisma.wantedCatalogModel.findMany({
    where: {
      customerProfileId: profileId,
      catalogModel: {
        items: {
          some: {
            status: 'available',
            listing: { status: 'active', price: { gt: 0 } },
          },
        },
      },
      ...(cursor ? { id: { gt: cursor } } : {}),
    },
    orderBy: { id: 'asc' },
    take: WANTED_PAGE_SIZE + 1,
    select: WANTED_SELECT,
  })
  return paginate(rows as RawRow[])
}

// DB-level unavailability filter: entries where the catalog has NO active+available listing with price > 0.
export async function getUnavailableWantedList(
  profileId: string,
  cursor?: string,
): Promise<{ items: WantedListEntry[]; nextCursor: string | null }> {
  const rows = await prisma.wantedCatalogModel.findMany({
    where: {
      customerProfileId: profileId,
      NOT: {
        catalogModel: {
          items: {
            some: {
              status: 'available',
              listing: { status: 'active', price: { gt: 0 } },
            },
          },
        },
      },
      ...(cursor ? { id: { gt: cursor } } : {}),
    },
    orderBy: { id: 'asc' },
    take: WANTED_PAGE_SIZE + 1,
    select: WANTED_SELECT,
  })
  return paginate(rows as RawRow[])
}
