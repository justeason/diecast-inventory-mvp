export const dynamic = 'force-dynamic'

import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { toCsv } from '@/lib/csv'
import { isAdminAuthenticated } from '@/lib/adminAuth'

function csvResponse(filename: string, csv: string) {
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ type: string }> }
) {
  if (!await isAdminAuthenticated()) {
    return new Response('Unauthorized', { status: 401 })
  }

  const { type } = await params

  switch (type) {
    case 'catalog': {
      const rows = await prisma.catalogModel.findMany({ orderBy: { createdAt: 'asc' } })
      const headers = ['id', 'brand', 'name', 'series', 'year', 'color', 'scale', 'notes', 'createdAt', 'updatedAt']
      const data = rows.map((r) => [r.id, r.brand, r.name, r.series, r.year, r.color, r.scale, r.notes, r.createdAt.toISOString(), r.updatedAt.toISOString()])
      return csvResponse('catalog.csv', toCsv(headers, data))
    }

    case 'locations': {
      const rows = await prisma.storageLocation.findMany({ orderBy: { createdAt: 'asc' } })
      const headers = ['id', 'label', 'notes', 'createdAt', 'updatedAt']
      const data = rows.map((r) => [r.id, r.label, r.notes, r.createdAt.toISOString(), r.updatedAt.toISOString()])
      return csvResponse('locations.csv', toCsv(headers, data))
    }

    case 'items': {
      const rows = await prisma.itemInstance.findMany({
        orderBy: { createdAt: 'asc' },
        include: {
          catalog: true,
          location: true,
        },
      })
      const headers = [
        'id', 'sku',
        'catalogBrand', 'catalogName', 'catalogYear', 'catalogSeries', 'catalogColor', 'catalogScale',
        'cardedOrLoose', 'condition', 'conditionNotes', 'status',
        'locationLabel', 'purchasePrice', 'listPrice', 'notes',
        'createdAt', 'updatedAt',
      ]
      const data = rows.map((r) => [
        r.id, r.sku,
        r.catalog.brand, r.catalog.name, r.catalog.year, r.catalog.series, r.catalog.color, r.catalog.scale,
        r.cardedOrLoose, r.condition, r.conditionNotes, r.status,
        r.location?.label, r.purchasePrice, r.listPrice, r.notes,
        r.createdAt.toISOString(), r.updatedAt.toISOString(),
      ])
      return csvResponse('items.csv', toCsv(headers, data))
    }

    case 'listings': {
      const rows = await prisma.listing.findMany({
        orderBy: { createdAt: 'asc' },
        include: {
          item: { include: { catalog: true } },
        },
      })
      const headers = [
        'id', 'title', 'price', 'status',
        'itemSku', 'catalogBrand', 'catalogName', 'catalogYear', 'catalogSeries', 'catalogColor',
        'createdAt', 'updatedAt',
      ]
      const data = rows.map((r) => [
        r.id, r.title, r.price, r.status,
        r.item.sku, r.item.catalog.brand, r.item.catalog.name, r.item.catalog.year, r.item.catalog.series, r.item.catalog.color,
        r.createdAt.toISOString(), r.updatedAt.toISOString(),
      ])
      return csvResponse('listings.csv', toCsv(headers, data))
    }

    case 'orders': {
      const rows = await prisma.order.findMany({
        orderBy: { createdAt: 'asc' },
        include: { orderItems: { select: { price: true } } },
      })
      const headers = [
        'id', 'buyerName', 'buyerEmail', 'buyerPhone', 'status', 'notes',
        'itemCount', 'subtotal', 'createdAt', 'updatedAt',
      ]
      const data = rows.map((r) => {
        const subtotal = r.orderItems.reduce((sum, i) => sum + i.price, 0)
        return [
          r.id, r.buyerName, r.buyerEmail, r.buyerPhone, r.status, r.notes,
          r.orderItems.length, subtotal.toFixed(2),
          r.createdAt.toISOString(), r.updatedAt.toISOString(),
        ]
      })
      return csvResponse('orders.csv', toCsv(headers, data))
    }

    case 'order-items': {
      const rows = await prisma.orderItem.findMany({
        orderBy: { createdAt: 'asc' },
        include: {
          order: { select: { buyerName: true, buyerEmail: true } },
          listing: { select: { title: true } },
          item: { include: { catalog: true } },
        },
      })
      const headers = [
        'id', 'orderId', 'buyerName', 'buyerEmail',
        'listingTitle', 'itemSku', 'catalogBrand', 'catalogName',
        'price', 'createdAt',
      ]
      const data = rows.map((r) => [
        r.id, r.orderId, r.order.buyerName, r.order.buyerEmail,
        r.listing.title, r.item.sku, r.item.catalog.brand, r.item.catalog.name,
        r.price.toFixed(2), r.createdAt.toISOString(),
      ])
      return csvResponse('order-items.csv', toCsv(headers, data))
    }

    case 'intake': {
      const rows = await prisma.intakeDraft.findMany({ orderBy: { createdAt: 'asc' } })
      const headers = [
        'id', 'status', 'brand', 'name', 'year', 'series', 'color', 'scale',
        'cardedOrLoose', 'condition', 'conditionNotes', 'listPrice', 'storageLocation', 'notes',
        'frontPhotoUrl', 'backPhotoUrl',
        'aiExtractionConfidence', 'aiExtractionNotes',
        'createdAt', 'updatedAt',
      ]
      const data = rows.map((r) => [
        r.id, r.status, r.brand, r.name, r.year, r.series, r.color, r.scale,
        r.cardedOrLoose, r.condition, r.conditionNotes, r.listPrice, r.storageLocation, r.notes,
        r.frontPhotoUrl, r.backPhotoUrl,
        r.aiExtractionConfidence, r.aiExtractionNotes,
        r.createdAt.toISOString(), r.updatedAt.toISOString(),
      ])
      return csvResponse('intake.csv', toCsv(headers, data))
    }

    case 'photos': {
      const rows = await prisma.photo.findMany({
        orderBy: { createdAt: 'asc' },
        include: { item: { select: { sku: true } } },
      })
      const headers = ['id', 'itemSku', 'type', 'url', 'sortOrder', 'createdAt']
      const data = rows.map((r) => [r.id, r.item.sku, r.type, r.url, r.sortOrder, r.createdAt.toISOString()])
      return csvResponse('photos.csv', toCsv(headers, data))
    }

    default:
      return new Response('Unknown export type', { status: 404 })
  }
}
