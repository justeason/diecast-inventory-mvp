import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { isAdminAuthenticated } from '@/lib/adminAuth'

export async function GET(request: NextRequest) {
  if (!await isAdminAuthenticated()) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

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
