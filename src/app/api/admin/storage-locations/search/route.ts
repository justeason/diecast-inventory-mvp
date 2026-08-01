import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get('q')?.trim() ?? ''

  const locations = await prisma.storageLocation.findMany({
    where: q
      ? { label: { contains: q, mode: 'insensitive' } }
      : undefined,
    select: { id: true, label: true },
    orderBy: { label: 'asc' },
    take: 20,
  })

  return NextResponse.json(locations)
}
