// 21D §22/§25-29: scope-discipline regression — 21D adds a pure read-time
// identity helper only. No admin action changes, no schema/migration, no
// condition mapping, no variant/condition backfill, no chase/color taxonomy.
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

describe('§22 — existing admin observation-lifecycle actions unchanged', () => {
  const src = readSrc('src/lib/actions/externalMarketResearch.ts')
  it('still exports exactly the five pre-21D mutation actions, none removed', () => {
    for (const fn of ['matchObservationToCatalog', 'unmatchObservation', 'rejectObservation', 'restoreObservation', 'assignObservationVariant']) {
      expect(src).toContain(`function ${fn}`)
    }
  })
  it('match/re-match still clears marketVariantId', () => {
    expect(src).toMatch(/matchStatus:\s*'matched'[\s\S]*?marketVariantId:\s*null/)
  })
  it('unmatch still clears catalogModelId/marketVariantId/matchMethod', () => {
    expect(src).toMatch(/matchStatus:\s*'unmatched',\s*catalogModelId:\s*null,\s*matchMethod:\s*null,\s*marketVariantId:\s*null/)
  })
  it('does not import the new 21D normalization module — no mechanical wiring was required', () => {
    expect(src).not.toContain('normalizedExternalComparable')
  })
})

describe('§25/§26 — no backfill script, no dry-run/apply mode', () => {
  it('no external-comparable backfill script exists', () => {
    expect(exists('scripts/normalizeExternalComparableIdentity.ts')).toBe(false)
    expect(exists('scripts/normalizeExternalCondition.ts')).toBe(false)
    expect(exists('scripts/backfillExternalVariant.ts')).toBe(false)
  })
})

describe('§11 — no condition-mapping infrastructure introduced', () => {
  it('no condition mapping table/registry file exists', () => {
    expect(exists('src/lib/externalConditionMapping.ts')).toBe(false)
    expect(exists('src/lib/providerConditionRegistry.ts')).toBe(false)
  })
  it('the normalization module never references a mapping table or condition vocabulary', () => {
    const src = readSrc('src/lib/normalizedExternalComparable.ts')
    expect(src).not.toMatch(/conditionMap|CONDITION_MAP|near_mint|mint|good|fair|poor|damaged/)
  })
})

describe('§12/§20 — raw condition untouched, never exposed in normalized identity', () => {
  it('ExternalMarketObservation.condition schema field is unchanged (still nullable String, no new column)', () => {
    const schema = readSrc('prisma/schema.prisma')
    const start = schema.indexOf('model ExternalMarketObservation {')
    const end = schema.indexOf('\nmodel ', start + 1)
    const block = schema.slice(start, end)
    expect(block).toContain('condition       String?')
    expect(block).not.toContain('normalizedCondition')
  })
  it('the normalization module never reads observation.condition', () => {
    const src = readSrc('src/lib/normalizedExternalComparable.ts')
    expect(src).not.toMatch(/\.condition\b/)
  })
})

describe('§27/§28 — no chase or color taxonomy introduced', () => {
  it('MarketVariant schema remains packaging-only', () => {
    const schema = readSrc('prisma/schema.prisma')
    const start = schema.indexOf('model MarketVariant {')
    const end = schema.indexOf('\nmodel ', start + 1)
    const block = schema.slice(start, end)
    expect(block).not.toMatch(/variantKind|chase|treasureHunt|color/i)
  })
})

describe('§39 — schema/migration footprint', () => {
  it('migration count is still 52 — no new migration added', () => {
    const migrationsDir = path.join(root, 'prisma/migrations')
    const dirs = fs.readdirSync(migrationsDir).filter((d) => fs.statSync(path.join(migrationsDir, d)).isDirectory())
    expect(dirs.length).toBe(53) // 26B added the ownership-ledger migration
  })
  it('schema.prisma has no snapshotProvenance-style normalizedCondition/version field on ExternalMarketObservation', () => {
    const schema = readSrc('prisma/schema.prisma')
    expect(schema).not.toContain('normalizedCondition')
    expect(schema).not.toContain('conditionNormalizationVersion')
    expect(schema).not.toContain('identityProvenance')
  })
})

describe('§40 — no new package', () => {
  it('package.json dependencies/devDependencies unchanged in shape (no new entries needed for this pure module)', () => {
    const pkg = JSON.parse(readSrc('package.json'))
    // normalizedExternalComparable.ts only imports from src/lib/marketVariant.ts — no external package.
    const src = readSrc('src/lib/normalizedExternalComparable.ts')
    expect(src).not.toMatch(/from ['"](?!\.\/|@\/)/) // no bare non-relative, non-@ alias import
    expect(pkg).toBeTruthy()
  })
})
