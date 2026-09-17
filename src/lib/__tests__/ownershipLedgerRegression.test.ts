// 26B: privacy and scope-discipline regression proofs. Structural (source-
// inspection), matching this codebase's established convention (see
// marketVariantRegression.test.ts / marketEvidenceRegression.test.ts).
//
// Privacy: acquisition cost, legacy ambiguous price, proceeds, realized gain,
// and disposal history are all PRIVATE financial data — they must never reach
// community/showcase/public payloads or gain new admin exposure.
//
// Scope: 26B is explicitly NOT Holding Performance/Average Recorded Cost
// (26C), NOT a dedicated Sold/History UI, NOT Portfolio History (1M/3M/1Y/
// ALL chart), and NOT auto-adding buyer purchases to Collection.
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const root = path.resolve(__dirname, '../../..')
function readSrc(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf-8')
}
function exists(rel: string): boolean {
  return fs.existsSync(path.join(root, rel))
}
function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? walk(full) : [full]
  })
}

const LEDGER_TERMS = /acquisitionLot|collectionDisposal|unitRecordedCostCents|legacyRecordedPriceCents|netProceedsCents|grossProceedsCents|recordedRealizedGainLossCents|ownershipLedger/i

describe('26B privacy: ownership-ledger fields never reach community/showcase surfaces', () => {
  const communityQuerySrc = readSrc('src/lib/communityLeaderboardsQuery.ts')

  it('communityLeaderboardsQuery.ts never selects any ledger table/field', () => {
    expect(communityQuerySrc).not.toMatch(LEDGER_TERMS)
  })

  it('communityLeaderboardsQuery.ts does not import ownershipLedger.ts or portfolioQuery.ts', () => {
    expect(communityQuerySrc).not.toMatch(/from ['"]@\/lib\/ownershipLedger['"]/)
    expect(communityQuerySrc).not.toMatch(/from ['"]@\/lib\/portfolioQuery['"]/)
  })

  it('no file under the public community route tree references ledger internals', () => {
    for (const f of walk(path.join(root, 'src/app/(store)/community'))) {
      const content = fs.readFileSync(f, 'utf-8')
      expect(content).not.toMatch(LEDGER_TERMS)
    }
  })

  it('no file under the public catalog route tree references ledger internals (public catalog/market pages stay financial-data-free)', () => {
    for (const f of walk(path.join(root, 'src/app/(store)/catalog'))) {
      const content = fs.readFileSync(f, 'utf-8')
      expect(content).not.toMatch(LEDGER_TERMS)
    }
  })
})

describe('26B privacy: no new admin exposure of ownership-ledger financial data', () => {
  it('no admin route directory for acquisition lots or disposals was introduced', () => {
    expect(exists('src/app/(admin)/admin/acquisition-lots')).toBe(false)
    expect(exists('src/app/(admin)/admin/collection-disposals')).toBe(false)
    expect(exists('src/app/(admin)/admin/ownership-ledger')).toBe(false)
  })

  it('no admin source file references the ledger tables/fields (operationally unnecessary for 26B\'s scope)', () => {
    const adminDir = path.join(root, 'src/app/(admin)')
    for (const f of walk(adminDir)) {
      const content = fs.readFileSync(f, 'utf-8')
      expect(content).not.toMatch(LEDGER_TERMS)
    }
  })
})

describe('26B scope: Holding Performance / Average Recorded Cost (26C) explicitly deferred', () => {
  const portfolioQuerySrc = readSrc('src/lib/portfolioQuery.ts')
  const collectionSrc = readSrc('src/app/(store)/account/collection/page.tsx')

  it('portfolioQuery.ts computes no Average Recorded Cost / Holding Performance metric', () => {
    expect(portfolioQuerySrc).not.toMatch(/averageRecordedCost|holdingPerformance|annualizedReturn|CAGR/i)
  })

  it('the Collection page never renders "Holding Performance" or "Average Recorded Cost" language', () => {
    expect(collectionSrc).not.toMatch(/Holding Performance|Average Recorded Cost/i)
  })
})

describe('26B scope: no dedicated Sold/History UI', () => {
  it('no new /account/collection/sold or /history route exists', () => {
    expect(exists('src/app/(store)/account/collection/sold')).toBe(false)
    expect(exists('src/app/(store)/account/collection/history')).toBe(false)
  })

  it('no new /account/collection/[id]/history detail route exists', () => {
    expect(exists('src/app/(store)/account/collection/[id]/history')).toBe(false)
  })
})

describe('26B scope: no Portfolio History (1M/3M/1Y/ALL) chart', () => {
  const collectionSrc = readSrc('src/app/(store)/account/collection/page.tsx')

  it('the Collection page has no chart/time-range selector language', () => {
    expect(collectionSrc).not.toMatch(/\b1M\b|\b3M\b|\b1Y\b|portfolioHistory|PortfolioChart/i)
  })

  it('portfolioQuery.ts exposes no time-series/history function', () => {
    const portfolioQuerySrc = readSrc('src/lib/portfolioQuery.ts')
    expect(portfolioQuerySrc).not.toMatch(/getPortfolioHistory|portfolioHistory|priceHistory/i)
  })
})

describe('26B scope: buyer purchases are NOT auto-added to Collection', () => {
  it('orders.ts never creates a CollectionItem or AcquisitionLot from a completed order — only disposal reconciliation for SELLER-side items', () => {
    const ordersSrc = readSrc('src/lib/actions/orders.ts')
    expect(ordersSrc).not.toMatch(/collectionItem\.create/)
    expect(ordersSrc).not.toContain('createAcquisitionLot')
  })

  it('orders.ts only imports the disposal reconciliation trigger from the ledger, never the acquisition side', () => {
    const ordersSrc = readSrc('src/lib/actions/orders.ts')
    expect(ordersSrc).toContain('reconcileCollectionDisposalsForCompletedOrder')
    expect(ordersSrc).not.toMatch(/from ['"]@\/lib\/ownershipLedger['"]/)
  })
})

describe('26B scope: marketplace_purchase acquisition source stays schema-compatible but unimplemented', () => {
  it('AcquisitionSource type does not include marketplace_purchase yet — auto-add is explicitly deferred', () => {
    const src = readSrc('src/lib/ownershipLedger.ts')
    const idx = src.indexOf('export type AcquisitionSource')
    const line = src.slice(idx, src.indexOf('\n', idx))
    expect(line).not.toContain('marketplace_purchase')
  })

  it('the AcquisitionSource union is exactly the five 26B sources — manual, i_own_it, quick_capture, legacy_backfill, correction', () => {
    const src = readSrc('src/lib/ownershipLedger.ts')
    const idx = src.indexOf('export type AcquisitionSource')
    const line = src.slice(idx, src.indexOf('\n', idx))
    expect(line).toContain("'manual'")
    expect(line).toContain("'i_own_it'")
    expect(line).toContain("'quick_capture'")
    expect(line).toContain("'legacy_backfill'")
    expect(line).toContain("'correction'")
  })
})

describe('26B scope: buyout finality is conversion-time, not agreement acceptance / payout-paid / resale', () => {
  it('the buyout disposal trigger lives in intakeConversion.ts (conversion time), not sellerAgreements.ts (acceptance) or sellerPayouts.ts (paid)', () => {
    expect(readSrc('src/lib/intakeConversion.ts')).toContain('createDisposal')
    expect(readSrc('src/lib/actions/sellerAgreements.ts')).not.toContain('createDisposal')
    expect(readSrc('src/lib/actions/sellerPayouts.ts')).not.toContain('createDisposal')
  })
})

describe('26B scope: DB constraints stay Prisma-native — no raw SQL CHECK constraint introduced', () => {
  it('the ownership-ledger migration has no CHECK constraint (matches this repo\'s zero prior precedent)', () => {
    const migrationDirs = fs.readdirSync(path.join(root, 'prisma/migrations')).filter((d) => d.includes('add_ownership_ledger'))
    expect(migrationDirs.length).toBe(1)
    const sql = readSrc(`prisma/migrations/${migrationDirs[0]}/migration.sql`)
    expect(sql).not.toMatch(/CHECK\s*\(/i)
  })
})

describe('26B scope: no new npm package was introduced for the ledger', () => {
  it('ownershipLedger.ts imports only from this repo (relative/@/ alias) or @prisma/client', () => {
    const src = readSrc('src/lib/ownershipLedger.ts')
    const imports = [...src.matchAll(/from ['"]([^'"]+)['"]/g)].map((m) => m[1])
    for (const imp of imports) {
      expect(imp === '@prisma/client' || imp.startsWith('@/') || imp.startsWith('.')).toBe(true)
    }
  })
})

// ── Final Gate §3/§4: FK delete semantics + no hard disposal delete ────────

describe('Final Gate §3: allocation FK onDelete semantics — history can never disappear via a parent delete', () => {
  function migrationSql(): string {
    const migrationDirs = fs.readdirSync(path.join(root, 'prisma/migrations')).filter((d) => d.includes('add_ownership_ledger'))
    return readSrc(`prisma/migrations/${migrationDirs[0]}/migration.sql`)
  }
  function modelBlock(name: string): string {
    const schema = readSrc('prisma/schema.prisma')
    const start = schema.indexOf(`model ${name} {`)
    const end = schema.indexOf('\nmodel ', start + 1)
    return schema.slice(start, end === -1 ? undefined : end)
  }

  it('AcquisitionLot.collectionItem is Restrict — a ledgered CollectionItem cannot be casually deleted', () => {
    expect(modelBlock('AcquisitionLot')).toMatch(/collectionItem\s+CollectionItem\s+@relation\([^)]*onDelete:\s*Restrict/)
  })

  it('CollectionDisposal.collectionItem is Restrict', () => {
    expect(modelBlock('CollectionDisposal')).toMatch(/collectionItem\s+CollectionItem\s+@relation\([^)]*onDelete:\s*Restrict/)
  })

  it('CollectionDisposalAllocation.acquisitionLot is Restrict — an allocated lot cannot be hard-deleted', () => {
    expect(modelBlock('CollectionDisposalAllocation')).toMatch(/acquisitionLot\s+AcquisitionLot\s+@relation\([^)]*onDelete:\s*Restrict/)
  })

  it('CollectionDisposalAllocation.disposal is Restrict, NOT Cascade — a disposal with allocation history cannot be hard-deleted, and allocations can never vanish via a disposal delete', () => {
    const block = modelBlock('CollectionDisposalAllocation')
    expect(block).toMatch(/disposal\s+CollectionDisposal\s+@relation\([^)]*onDelete:\s*Restrict/)
    expect(block).not.toMatch(/disposal\s+CollectionDisposal\s+@relation\([^)]*onDelete:\s*Cascade/)
  })

  it('the migration SQL matches the schema: all four ledger FKs are ON DELETE RESTRICT, none is CASCADE', () => {
    const sql = migrationSql()
    expect(sql).toContain('ALTER TABLE "AcquisitionLot" ADD CONSTRAINT "AcquisitionLot_collectionItemId_fkey" FOREIGN KEY ("collectionItemId") REFERENCES "CollectionItem"("id") ON DELETE RESTRICT')
    expect(sql).toContain('ALTER TABLE "CollectionDisposal" ADD CONSTRAINT "CollectionDisposal_collectionItemId_fkey" FOREIGN KEY ("collectionItemId") REFERENCES "CollectionItem"("id") ON DELETE RESTRICT')
    expect(sql).toContain('ALTER TABLE "CollectionDisposalAllocation" ADD CONSTRAINT "CollectionDisposalAllocation_disposalId_fkey" FOREIGN KEY ("disposalId") REFERENCES "CollectionDisposal"("id") ON DELETE RESTRICT')
    expect(sql).toContain('ALTER TABLE "CollectionDisposalAllocation" ADD CONSTRAINT "CollectionDisposalAllocation_acquisitionLotId_fkey" FOREIGN KEY ("acquisitionLotId") REFERENCES "AcquisitionLot"("id") ON DELETE RESTRICT')
    expect(sql).not.toMatch(/ON DELETE CASCADE/)
  })

  it('CollectionDisposal.allocations and AcquisitionLot.allocations Cascade-on-delete relations do not exist on the "one" side — only the child FK direction is declared, matching Prisma\'s implicit-relation convention (no explicit onDelete on the reverse list field)', () => {
    // Prisma only accepts onDelete on the @relation side that owns the FK
    // (the "many" side here) — this just documents that no stray, redundant
    // onDelete annotation was added to the reverse `allocations` list fields.
    expect(modelBlock('CollectionDisposal')).not.toMatch(/allocations\s+CollectionDisposalAllocation\[\]\s*@relation\([^)]*onDelete/)
    expect(modelBlock('AcquisitionLot')).not.toMatch(/allocations\s+CollectionDisposalAllocation\[\]\s*@relation\([^)]*onDelete/)
  })
})

describe('Final Gate §4: no production code path hard-deletes a finalized disposal or its allocations', () => {
  function walkTs(dir: string): string[] {
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) return walkTs(full)
      return entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') ? [full] : []
    })
  }

  it('no production file calls collectionDisposal.delete or collectionDisposal.deleteMany', () => {
    for (const f of [...walkTs(path.join(root, 'src')), ...walkTs(path.join(root, 'scripts'))]) {
      const content = fs.readFileSync(f, 'utf-8')
      expect(content).not.toMatch(/collectionDisposal\.delete(Many)?\(/)
    }
  })

  it('no production file calls collectionDisposalAllocation.delete or .deleteMany', () => {
    for (const f of [...walkTs(path.join(root, 'src')), ...walkTs(path.join(root, 'scripts'))]) {
      const content = fs.readFileSync(f, 'utf-8')
      expect(content).not.toMatch(/collectionDisposalAllocation\.delete(Many)?\(/)
    }
  })

  it('the only acquisitionLot.deleteMany call in all of src/ is the guarded mistaken-entry path in deleteCollectionItem (zero allocation/disposal history)', () => {
    const matches: string[] = []
    for (const f of walkTs(path.join(root, 'src'))) {
      if (f.includes('__tests__')) continue
      const content = fs.readFileSync(f, 'utf-8')
      if (/acquisitionLot\.delete(Many)?\(/.test(content)) matches.push(f)
    }
    expect(matches).toEqual([path.join(root, 'src/lib/actions/collectionItems.ts')])
  })

  it('deleteCollectionItem only reaches acquisitionLot.deleteMany after the disposal-history and allocated-lot guard has already redirected away', () => {
    const src = readSrc('src/lib/actions/collectionItems.ts')
    const guardIdx = src.indexOf('if (hasDisposalHistory || hasAllocatedLot)')
    const deleteIdx = src.indexOf('tx.acquisitionLot.deleteMany')
    expect(guardIdx).toBeGreaterThan(-1)
    expect(deleteIdx).toBeGreaterThan(guardIdx)
  })

  it('reversal (reverseDisposal) never deletes — it only ever calls updateMany/update, never delete', () => {
    const src = readSrc('src/lib/ownershipLedger.ts')
    const idx = src.indexOf('export async function reverseDisposal')
    const end = src.indexOf('\n// ── Recorded Realized', idx)
    const block = src.slice(idx, end === -1 ? undefined : end)
    expect(block).not.toMatch(/\.delete\(/)
    expect(block).not.toMatch(/\.deleteMany\(/)
  })
})
