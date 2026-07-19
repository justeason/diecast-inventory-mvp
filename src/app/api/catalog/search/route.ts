import { NextRequest, NextResponse } from 'next/server'
import { searchCatalogModels } from '@/lib/catalogSearch'

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get('q') ?? ''
  const results = await searchCatalogModels(q)
  return NextResponse.json(results)
}
