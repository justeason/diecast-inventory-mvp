import { vi, describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    catalogModel: {
      findMany: vi.fn(),
    },
  },
}))

import { searchCatalogModels } from '@/lib/catalogSearch'
import { prisma } from '@/lib/prisma'

type DBRow = {
  id: string
  brand: string
  name: string
  series: string | null
  year: number | null
  color: string | null
  scale: string | null
}

function row(brand: string, name: string, i: number): DBRow {
  return { id: `${i}`, brand, name, series: null, year: null, color: null, scale: null }
}

describe('searchCatalogModels', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns [] without hitting DB when query is empty', async () => {
    const result = await searchCatalogModels('')
    expect(result).toHaveLength(0)
    expect(prisma.catalogModel.findMany).not.toHaveBeenCalled()
  })

  it('returns [] without hitting DB when query is shorter than 2 characters', async () => {
    const result = await searchCatalogModels('a')
    expect(result).toHaveLength(0)
    expect(prisma.catalogModel.findMany).not.toHaveBeenCalled()
  })

  it('caps returned results to at most 20 even when DB returns 25 matching candidates', async () => {
    const twentyFive: DBRow[] = Array.from({ length: 25 }, (_, i) =>
      row('Hot Wheels', `Model ${i}`, i)
    )
    ;(prisma.catalogModel.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce(twentyFive)

    const result = await searchCatalogModels('Hot Wheels')

    expect(result.length).toBeLessThanOrEqual(20)
    expect(result).toHaveLength(20)
  })
})

describe('row lock ordering', () => {
  it('adminLinkSubmissionCatalog and convertDraft both acquire FOR UPDATE lock on SellerSubmission', () => {
    const intakeSrc = readFileSync(join(process.cwd(), 'src/lib/actions/intake.ts'), 'utf-8')
    const submissionsSrc = readFileSync(
      join(process.cwd(), 'src/lib/actions/sellerSubmissions.ts'),
      'utf-8'
    )
    // Both must lock the same table so concurrent relink and conversion serialize correctly:
    // whichever commits first wins; the other sees committed state and fails or proceeds correctly.
    expect(intakeSrc).toContain('"SellerSubmission"')
    expect(intakeSrc).toContain('FOR UPDATE')
    expect(submissionsSrc).toContain('"SellerSubmission"')
    expect(submissionsSrc).toContain('FOR UPDATE')
  })
})
