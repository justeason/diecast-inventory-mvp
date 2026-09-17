// 26B: structural coverage for scripts/backfillOwnershipLedger.ts. The script
// performs live DB I/O via its own PrismaClient and calls main() unconditionally
// at module scope, so it is not imported directly (that would attempt a real
// connection) — matching this codebase's established convention for one-time
// backfill scripts (see normalizeHistoricalSalesScript.test.ts, 21C precedent).
// Behavioral coverage of the cost-resolution rules themselves lives in
// ownershipLedger.test.ts (resolveLegacyCostKnowledge).
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const root = path.resolve(__dirname, '../../..')
const src = fs.readFileSync(path.join(root, 'scripts/backfillOwnershipLedger.ts'), 'utf-8')

describe('backfillOwnershipLedger.ts — dry-run/apply safety', () => {
  it('defaults to dry run — apply is only true when --apply is explicitly passed', () => {
    expect(src).toContain("const apply = process.argv.includes('--apply')")
  })

  it('every write (transaction + createAcquisitionLot call) is gated behind `if (apply)`', () => {
    const idx = src.indexOf('if (apply) {')
    expect(idx).toBeGreaterThan(-1)
    const block = src.slice(idx, src.indexOf('\n      }\n', idx))
    expect(block).toContain('prisma.$transaction')
    expect(block).toContain('createAcquisitionLot')
  })

  it('a dry run still counts and classifies every row (coverage report reflects reality even with no writes)', () => {
    const applyIdx = src.indexOf('if (apply) {')
    const beforeApply = src.slice(0, applyIdx)
    expect(beforeApply).toContain('resolveLegacyCostKnowledge')
    expect(beforeApply).toMatch(/counts\.(knownCost|ambiguousLegacyCost|unknownCost)\+\+/)
  })

  it('logs a clear dry-run notice with no writes performed', () => {
    expect(src).toContain('Dry run only — no rows were written')
  })

  it('is not referenced from package.json build/deploy scripts', () => {
    const pkg = fs.readFileSync(path.join(root, 'package.json'), 'utf-8')
    expect(pkg).not.toContain('backfillOwnershipLedger')
  })
})

describe('backfillOwnershipLedger.ts — cutover resolution', () => {
  it('reads finished_at from _prisma_migrations by the exact 26B migration name — never hardcodes a date', () => {
    expect(src).toContain('_prisma_migrations')
    expect(src).toContain('finished_at')
    expect(src).toContain('LEDGER_MIGRATION_NAME')
    expect(src).toContain("'20260914000000_add_ownership_ledger'")
    expect(src).not.toMatch(/new Date\('2026-09/)
  })

  it('throws (aborts) when the migration row or finished_at is missing — never guesses a wall-clock boundary', () => {
    const idx = src.indexOf('async function resolveCutover')
    const block = src.slice(idx, src.indexOf('\n}', idx))
    expect(block).toMatch(/if \(!row \|\| !row\.finished_at\)/)
    expect(block).toContain('throw new Error')
  })

  it('a thrown error propagates to a non-zero exit code, never silently swallowed', () => {
    expect(src).toContain('process.exitCode = 1')
  })

  it('the SAME resolved cutover Date feeds every row\'s ledgerEffectiveAt computation — not a fresh new Date() per row', () => {
    const loopIdx = src.indexOf('for (const item of page)')
    const loopEnd = src.indexOf('\n    }\n  }', loopIdx)
    const loopBody = src.slice(loopIdx, loopEnd)
    expect(loopBody).toContain('resolveLedgerEffectiveAt(cutover, item.createdAt)')
    expect(loopBody).not.toMatch(/ledgerEffectiveAt:\s*new Date\(\)/)
  })

  it('ledgerEffectiveAt is resolved via the shared, directly-testable resolveLedgerEffectiveAt helper (ownershipLedger.ts) — not a duplicated inline ternary', () => {
    expect(src).toContain("import { resolveLegacyCostKnowledge, resolveLedgerEffectiveAt, createAcquisitionLot } from '../src/lib/ownershipLedger'")
  })

  it('the CollectionItem query selects createdAt, needed for the max(cutover, createdAt) computation', () => {
    const findManyIdx = src.indexOf('prisma.collectionItem.findMany')
    const block = src.slice(findManyIdx, findManyIdx + 300)
    expect(block).toContain('createdAt: true')
  })
})

describe('backfillOwnershipLedger.ts — pagination, no N+1', () => {
  it('uses cursor/keyset pagination with a bounded page size', () => {
    expect(src).toMatch(/const PAGE_SIZE = \d+/)
    expect(src).toContain("orderBy: { id: 'asc' }")
    expect(src).toContain('cursor: { id: cursor }')
  })

  it('terminates when a page comes back empty', () => {
    expect(src).toContain('if (page.length === 0) break')
  })
})

describe('backfillOwnershipLedger.ts — idempotency and coverage of ALL items, including freeform', () => {
  it('sourceKey is exactly legacy-backfill:<collectionItemId> — matches the 26B spec\'s exact idempotency key', () => {
    expect(src).toContain('const sourceKey = `legacy-backfill:${item.id}`')
  })

  it('checks for an existing lot by sourceKey before ever attempting a write — a second run performs zero additional writes', () => {
    const idx = src.indexOf('const existing = await prisma.acquisitionLot.findUnique')
    expect(idx).toBeGreaterThan(-1)
    expect(src.slice(idx, idx + 200)).toContain('where: { sourceKey }')
    expect(src.slice(idx, idx + 300)).toContain('counts.alreadyLedgered++')
  })

  it('never filters on catalogId — freeform (catalogId=null) CollectionItems are scanned identically to catalog-backed ones', () => {
    const findManyIdx = src.indexOf('prisma.collectionItem.findMany')
    const block = src.slice(findManyIdx, findManyIdx + 400)
    expect(block).not.toMatch(/catalogId/)
  })

  it('skips (never fabricates) an invalid legacy quantity rather than inventing a plausible one', () => {
    expect(src).toMatch(/!Number\.isInteger\(item\.quantity\)\s*\|\|\s*item\.quantity\s*<\s*1/)
    expect(src).toContain('counts.skippedInvalidQuantity++')
  })
})

describe('backfillOwnershipLedger.ts — never mutates legacy fields or the quantity cache', () => {
  it('the founding lot is created with syncCollectionItemQuantity: false — CollectionItem.quantity is never double-counted', () => {
    const idx = src.indexOf('createAcquisitionLot(tx, {')
    const block = src.slice(idx, src.indexOf('\n          }),', idx))
    expect(block).toContain('syncCollectionItemQuantity: false')
  })

  it('acquiredAt is the item\'s existing purchaseDate verbatim, never fabricated from purchasePrice or today\'s date', () => {
    const idx = src.indexOf('createAcquisitionLot(tx, {')
    const block = src.slice(idx, src.indexOf('\n          }),', idx))
    expect(block).toContain('acquiredAt: item.purchaseDate')
  })

  it('never writes to CollectionItem.purchasePrice or CollectionItem.purchaseDate — those remain legacy/edit-compatibility fields', () => {
    expect(src).not.toMatch(/collectionItem\.update/)
  })

  it('source is legacy_backfill — never manual/i_own_it/quick_capture/correction (those are for live customer flows only)', () => {
    expect(src).toContain("source: 'legacy_backfill'")
  })
})

describe('backfillOwnershipLedger.ts — cost-classification counters exhaustively cover resolveLegacyCostKnowledge\'s three outcomes', () => {
  it('increments exactly one of knownCost/ambiguousLegacyCost/unknownCost per scanned row', () => {
    const idx = src.indexOf('const resolution = resolveLegacyCostKnowledge')
    const block = src.slice(idx, idx + 400)
    expect(block).toContain("if (resolution.costKnowledge === 'known') counts.knownCost++")
    expect(block).toContain("else if (resolution.costKnowledge === 'ambiguous_legacy') counts.ambiguousLegacyCost++")
    expect(block).toContain('else counts.unknownCost++')
  })
})
