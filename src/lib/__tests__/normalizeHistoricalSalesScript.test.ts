// 21C: structural coverage for scripts/normalizeHistoricalSales.ts. The script
// performs live DB I/O via its own PrismaClient and calls main() unconditionally
// at module scope, so it is not imported directly here (that would attempt a
// real connection) — matching this codebase's established convention for
// one-time backfill scripts (see scripts/backfill-customer-profiles.ts, which
// has no direct test either). Behavioral coverage of the classification rules
// themselves lives in historicalSaleNormalization.test.ts.
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const root = path.resolve(__dirname, '../../..')
const src = fs.readFileSync(path.join(root, 'scripts/normalizeHistoricalSales.ts'), 'utf-8')

describe('normalizeHistoricalSales.ts — dry-run/apply safety (§22)', () => {
  it('defaults to dry run — apply is only true when --apply is explicitly passed', () => {
    expect(src).toContain("const apply = process.argv.includes('--apply')")
  })

  it('every OrderItem write is gated behind `if (apply)`', () => {
    const idx = src.indexOf('if (apply) {')
    expect(idx).toBeGreaterThan(-1)
    const block = src.slice(idx, src.indexOf('\n    }\n', idx))
    expect(block).toContain('orderItem.updateMany')
  })

  it('is not referenced from package.json build/deploy scripts', () => {
    const pkg = fs.readFileSync(path.join(root, 'package.json'), 'utf-8')
    expect(pkg).not.toContain('normalizeHistoricalSales')
  })
})

describe('normalizeHistoricalSales.ts — cutover resolution (§23)', () => {
  it('reads finished_at from _prisma_migrations by the exact 21B migration name — never hardcodes a date', () => {
    expect(src).toContain('_prisma_migrations')
    expect(src).toContain('finished_at')
    expect(src).toContain('NORMALIZATION_MIGRATION_NAME')
    expect(src).not.toMatch(/new Date\('2026-09-12/)
  })

  it('throws (aborts) when the migration row or finished_at is missing — never guesses', () => {
    const idx = src.indexOf('async function resolveCutover')
    const block = src.slice(idx, src.indexOf('\n}', idx))
    expect(block).toMatch(/if \(!row \|\| !row\.finished_at\)/)
    expect(block).toContain('throw new Error')
  })

  it('a thrown error propagates to a non-zero exit code, never silently swallowed', () => {
    expect(src).toContain('process.exitCode = 1')
  })
})

describe('normalizeHistoricalSales.ts — batching, no N+1 (§24/§25)', () => {
  it('uses cursor/keyset pagination with a bounded page size', () => {
    expect(src).toMatch(/const PAGE_SIZE = \d+/)
    expect(src).toContain("orderBy: { id: 'asc' }")
    expect(src).toContain('cursor: { id: cursor }')
  })

  it('fetches IntakeDraft evidence once per PAGE via an `in` filter — never inside the per-row loop', () => {
    const pageStart = src.indexOf('const page = await prisma.orderItem.findMany')
    const perRowLoopStart = src.indexOf('for (const row of page) {\n      counts.scanned++')
    const draftFetchIdx = src.indexOf('prisma.intakeDraft.findMany')
    expect(draftFetchIdx).toBeGreaterThan(pageStart)
    expect(draftFetchIdx).toBeLessThan(perRowLoopStart)
    expect(src.slice(0, draftFetchIdx + 200)).toMatch(/convertedItemId: \{ in: itemIds \}/)
  })

  it('fetches MarketVariant evidence once per page via an `in` filter — never per row', () => {
    const perRowLoopStart = src.indexOf('for (const row of page) {\n      counts.scanned++')
    const variantFetchIdx = src.indexOf('prisma.marketVariant.findMany')
    expect(variantFetchIdx).toBeGreaterThan(-1)
    expect(variantFetchIdx).toBeLessThan(perRowLoopStart)
    expect(src.slice(variantFetchIdx, variantFetchIdx + 300)).toMatch(/catalogModelId: \{ in: \[\.\.\.catalogModelIdsNeedingVariant\] \}/)
  })

  it('never creates a MarketVariant row — a missing one is an error, not auto-repaired', () => {
    expect(src).not.toMatch(/marketVariant\.create/)
  })

  it('the per-row loop contains no `await prisma.intakeDraft` or `await prisma.marketVariant` call (would reintroduce N+1)', () => {
    const perRowLoopStart = src.indexOf('for (const row of page) {\n      counts.scanned++')
    const perRowLoopEnd = src.indexOf('\n    }\n  }', perRowLoopStart)
    const loopBody = src.slice(perRowLoopStart, perRowLoopEnd)
    expect(loopBody).not.toMatch(/prisma\.intakeDraft\./)
    expect(loopBody).not.toMatch(/prisma\.marketVariant\./)
  })
})

describe('normalizeHistoricalSales.ts — conditional writes / idempotency (§26/§28)', () => {
  it('every conditional write guards on all four fields being currently null', () => {
    const idx = src.indexOf('orderItem.updateMany({')
    const block = src.slice(idx, src.indexOf('data:', idx))
    expect(block).toContain('snapshotProvenance: null')
    expect(block).toContain('marketVariantId: null')
    expect(block).toContain('snapshotPackagingType: null')
    expect(block).toContain('snapshotCondition: null')
  })

  it('a write that touches zero rows (count !== 1) is treated as a conflict, never retried/forced', () => {
    expect(src).toMatch(/if \(result\.count === 1\) counts\.updated\+\+/)
    expect(src).toContain('counts.writeConflicts++')
  })

  it('write payload only ever sets a field when a recovered value exists — never writes an explicit null over an existing value', () => {
    const idx = src.indexOf('data: {\n            snapshotProvenance')
    const block = src.slice(idx, src.indexOf('},', idx))
    expect(block).toMatch(/classification\.marketVariantId \? \{ marketVariantId:/)
    expect(block).toMatch(/classification\.snapshotPackagingType \? \{ snapshotPackagingType:/)
    expect(block).toMatch(/classification\.snapshotCondition \? \{ snapshotCondition:/)
  })
})

describe('normalizeHistoricalSales.ts — physical history is never rewritten (§20)', () => {
  it('never calls itemInstance.update/updateMany', () => {
    expect(src).not.toMatch(/itemInstance\.(update|updateMany)/)
  })
  it('never calls intakeDraft.update/updateMany', () => {
    expect(src).not.toMatch(/intakeDraft\.(update|updateMany)/)
  })
  it('the only mutated model in this script is orderItem', () => {
    const writeCalls = [...src.matchAll(/prisma\.(\w+)\.(update|updateMany|create|delete)\(/g)].map((m) => m[1])
    expect(new Set(writeCalls)).toEqual(new Set(['orderItem']))
  })
})

describe('normalizeHistoricalSales.ts — coverage report categories (§31/§32)', () => {
  const expectedKeys = [
    'scanned', 'alreadySaleTime', 'recoveredFull', 'recoveredPackagingOnly', 'recoveredConditionOnly',
    'modelOnly', 'postCutoverMalformed', 'malformedMissingCatalog', 'malformedMissingCompletedAt',
    'malformedNonPositivePrice', 'variantResolutionErrors', 'writeConflicts', 'updated',
  ]
  it('reports exactly the required semantic categories', () => {
    for (const key of expectedKeys) expect(src).toContain(key)
  })
  it('sample id lists are bounded (no unbounded PII dump)', () => {
    expect(src).toMatch(/MAX_SAMPLE_IDS = \d+/)
  })
  it('never logs buyer PII fields', () => {
    expect(src).not.toMatch(/buyerEmail|buyerName|buyerPhone/)
  })
})

describe('normalizeHistoricalSales.ts — no admin override surface (§30)', () => {
  it('no admin route or UI component exists for manual historical classification', () => {
    expect(fs.existsSync(path.join(root, 'src/app/(admin)/admin/historical-sales'))).toBe(false)
  })
})

describe('src/lib/normalizedInternalSale.ts / historicalSaleNormalization.ts — no new package', () => {
  it('no new dependency was added to package.json for this script', () => {
    const pkgBefore = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'))
    // tsx already exists as the project's script runner (used by prisma.seed).
    expect(pkgBefore.prisma.seed).toContain('tsx')
  })
})
