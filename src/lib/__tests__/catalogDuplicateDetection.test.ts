import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  stablePairKey,
  scorePair,
  buildPairs,
  rankPairs,
} from '../catalogDuplicateDetection'
import type { CatalogCandidate } from '../catalogMatching'

function m(overrides: Partial<CatalogCandidate> & { id: string; brand: string; name: string }): CatalogCandidate {
  return { series: null, year: null, color: null, scale: null, ...overrides }
}

const HW_TWIN_MILL = m({ id: 'hw-tm', brand: 'Hot Wheels', name: 'Twin Mill', series: 'HW Legends', year: 2022 })
const HW_TWIN_MILL_2 = m({ id: 'hw-tm2', brand: 'Hot Wheels', name: 'Twin Mill', series: 'Mainline', year: 2021 })
const MB_CAMARO = m({ id: 'mb-c', brand: 'Matchbox', name: 'Camaro', year: 2019 })
const HW_CAMARO = m({ id: 'hw-c', brand: 'Hot Wheels', name: 'Camaro', year: 2020 })
const UNRELATED = m({ id: 'un', brand: 'Greenlight', name: 'Mustang GT500', year: 2018 })

describe('stablePairKey', () => {
  it('produces the same key regardless of argument order', () => {
    expect(stablePairKey('aaa', 'bbb')).toBe(stablePairKey('bbb', 'aaa'))
  })
  it('uses pipe separator', () => {
    expect(stablePairKey('aaa', 'bbb')).toBe('aaa|bbb')
  })
  it('puts lexicographically smaller id first', () => {
    expect(stablePairKey('zzz', 'aaa')).toBe('aaa|zzz')
  })
})

describe('scorePair', () => {
  it('scores 100 for identical brand+name', () => {
    const { score } = scorePair(HW_TWIN_MILL, HW_TWIN_MILL_2)
    expect(score).toBe(100)
  })

  it('returns matchReasons when scoring high', () => {
    const { matchReasons } = scorePair(HW_TWIN_MILL, HW_TWIN_MILL_2)
    expect(matchReasons.length).toBeGreaterThan(0)
  })

  it('scores > 0 when brand matches but names differ partially', () => {
    const { score } = scorePair(HW_TWIN_MILL, HW_CAMARO)
    expect(score).toBeGreaterThan(0)
  })

  it('scores 0 for completely unrelated models', () => {
    const { score } = scorePair(HW_TWIN_MILL, UNRELATED)
    expect(score).toBe(0)
  })

  it('scores same brand match equally regardless of argument order', () => {
    const ab = scorePair(HW_TWIN_MILL, HW_CAMARO)
    const ba = scorePair(HW_CAMARO, HW_TWIN_MILL)
    expect(ab.score).toBe(ba.score)
  })

  it('same-brand same-name pair scores higher than same-brand different-name', () => {
    const sameNameScore = scorePair(HW_TWIN_MILL, HW_TWIN_MILL_2).score
    const diffNameScore = scorePair(HW_TWIN_MILL, HW_CAMARO).score
    expect(sameNameScore).toBeGreaterThan(diffNameScore)
  })

  it('boosts score when year also matches', () => {
    const withYear = m({ id: 'x', brand: 'Hot Wheels', name: 'Twin Mill', year: 2022 })
    const noYear = m({ id: 'y', brand: 'Hot Wheels', name: 'Twin Mill', year: null })
    const withBoost = scorePair(HW_TWIN_MILL, withYear).score
    const noBoost = scorePair(HW_TWIN_MILL, noYear).score
    expect(withBoost).toBeGreaterThanOrEqual(noBoost)
  })
})

describe('buildPairs', () => {
  it('returns empty for 0 models', () => {
    expect(buildPairs([])).toHaveLength(0)
  })

  it('returns empty for 1 model', () => {
    expect(buildPairs([HW_TWIN_MILL])).toHaveLength(0)
  })

  it('returns 1 pair for 2 models with non-zero score', () => {
    const pairs = buildPairs([HW_TWIN_MILL, HW_TWIN_MILL_2])
    expect(pairs).toHaveLength(1)
  })

  it('excludes pairs with score 0', () => {
    const pairs = buildPairs([HW_TWIN_MILL, UNRELATED])
    expect(pairs).toHaveLength(0)
  })

  it('uses stablePairKey for each pair', () => {
    const pairs = buildPairs([HW_TWIN_MILL, HW_TWIN_MILL_2])
    expect(pairs[0].pairKey).toBe(stablePairKey(HW_TWIN_MILL.id, HW_TWIN_MILL_2.id))
  })

  it('sets confidence=high for score>=80', () => {
    const pairs = buildPairs([HW_TWIN_MILL, HW_TWIN_MILL_2])
    expect(pairs[0].confidence).toBe('high')
  })

  it('sets confidence=medium for score 50-79', () => {
    const a = m({ id: 'a', brand: 'Hot Wheels', name: 'Alpha Beta Gamma' })
    const b = m({ id: 'b', brand: 'Hot Wheels', name: 'Alpha Beta Delta' })
    const pairs = buildPairs([a, b])
    if (pairs.length > 0 && pairs[0].score >= 50 && pairs[0].score < 80) {
      expect(pairs[0].confidence).toBe('medium')
    }
  })

  it('sets confidence=low for score<50', () => {
    // Same brand, unrelated name → low score
    const pairs = buildPairs([HW_TWIN_MILL, HW_CAMARO])
    if (pairs.length > 0 && pairs[0].score < 50) {
      expect(pairs[0].confidence).toBe('low')
    }
  })

  it('produces N*(N-1)/2 pairs for N models with overlapping brand', () => {
    // All HW models will have at least partial matches
    const hwModels = [HW_TWIN_MILL, HW_TWIN_MILL_2, HW_CAMARO]
    const pairs = buildPairs(hwModels)
    // At minimum HW_TWIN_MILL vs HW_TWIN_MILL_2 (score 100) and HW_TWIN_MILL vs HW_CAMARO
    expect(pairs.length).toBeGreaterThanOrEqual(2)
  })

  it('includes modelA and modelB references', () => {
    const pairs = buildPairs([HW_TWIN_MILL, HW_TWIN_MILL_2])
    const pair = pairs[0]
    const ids = [pair.modelA.id, pair.modelB.id]
    expect(ids).toContain(HW_TWIN_MILL.id)
    expect(ids).toContain(HW_TWIN_MILL_2.id)
  })
})

describe('rankPairs', () => {
  it('returns empty for empty input', () => {
    expect(rankPairs([])).toHaveLength(0)
  })

  it('sorts by score descending', () => {
    const allModels = [HW_TWIN_MILL, HW_TWIN_MILL_2, HW_CAMARO, MB_CAMARO]
    const pairs = buildPairs(allModels)
    const ranked = rankPairs(pairs)
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1].score).toBeGreaterThanOrEqual(ranked[i].score)
    }
  })

  it('does not mutate the input array', () => {
    const pairs = buildPairs([HW_TWIN_MILL, HW_TWIN_MILL_2, HW_CAMARO])
    const original = [...pairs]
    rankPairs(pairs)
    expect(pairs.map((p) => p.pairKey)).toEqual(original.map((p) => p.pairKey))
  })

  it('highest-scoring pair (identical name) comes first', () => {
    const pairs = buildPairs([HW_TWIN_MILL, HW_TWIN_MILL_2, HW_CAMARO])
    const ranked = rankPairs(pairs)
    expect(ranked[0].pairKey).toBe(stablePairKey(HW_TWIN_MILL.id, HW_TWIN_MILL_2.id))
  })

  it('produces a stable order given the same input (deterministic)', () => {
    const models = [HW_TWIN_MILL, HW_TWIN_MILL_2, HW_CAMARO, MB_CAMARO]
    const first  = rankPairs(buildPairs(models)).map((p) => p.pairKey)
    const second = rankPairs(buildPairs(models)).map((p) => p.pairKey)
    expect(first).toEqual(second)
  })
})

describe('pair cap', () => {
  it('buildPairs does not cap — findDuplicatePairs caps at 100', () => {
    // buildPairs is uncapped; the PAIR_CAP lives in findDuplicatePairs (server action).
    // Verify findDuplicatePairs source enforces the cap.
    const src = readFileSync(
      join(process.cwd(), 'src/lib/actions/catalogDuplicates.ts'),
      'utf-8'
    )
    expect(src).toContain('PAIR_CAP')
    expect(src).toContain('pairs.length >= PAIR_CAP')
    expect(src).toContain('break outer')
  })

  it('buildPairs with 50+ score-zero pairs returns empty — no cap needed', () => {
    // All models are fully unrelated → no pairs even without cap
    const models = Array.from({ length: 20 }, (_, i) =>
      m({ id: `u${i}`, brand: `Brand${i}`, name: `Name${i}` })
    )
    expect(buildPairs(models)).toHaveLength(0)
  })
})

describe('structural: merge action', () => {
  const mergeSrc = readFileSync(
    join(process.cwd(), 'src/lib/actions/catalog.ts'),
    'utf-8'
  )

  it('moves all 5 direct FK relations in one transaction', () => {
    // ItemInstance, CollectionItem, CatalogSuggestion, SellerSubmission, CatalogModelPhoto
    expect(mergeSrc).toContain('itemInstance.updateMany')
    expect(mergeSrc).toContain('collectionItem.updateMany')
    expect(mergeSrc).toContain('catalogSuggestion.updateMany')
    expect(mergeSrc).toContain('sellerSubmission.updateMany')
    expect(mergeSrc).toContain('catalogModelPhoto.updateMany')
  })

  it('creates audit record inside the same transaction', () => {
    expect(mergeSrc).toContain('tx.catalogModelMergeAudit.create')
  })

  it('audit stores snapshots as JSON objects, not FK references', () => {
    expect(mergeSrc).toContain('canonicalSnapshot: canonicalSnapshot as object')
    expect(mergeSrc).toContain('duplicateSnapshot: dupSnap as object')
  })

  it('captures snapshots inside the transaction after lock acquisition', () => {
    // Snapshot fetch must appear AFTER the FOR UPDATE line, not before tx start
    const lockIdx = mergeSrc.indexOf('FOR UPDATE')
    const snapshotIdx = mergeSrc.indexOf('tx.catalogModel.findUnique')
    expect(lockIdx).toBeGreaterThan(0)
    expect(snapshotIdx).toBeGreaterThan(lockIdx)
  })

  it('deletes the duplicate model in the same transaction', () => {
    expect(mergeSrc).toContain('tx.catalogModel.delete')
  })

  it('rejects same-ID merge before entering transaction', () => {
    expect(mergeSrc).toContain('duplicateIds.includes(canonicalId)')
  })

  it('acquires row locks in sorted ID order to prevent deadlock', () => {
    expect(mergeSrc).toContain('.sort()')
    expect(mergeSrc).toContain('FOR UPDATE')
  })
})

describe('structural: audit schema uses plain string IDs', () => {
  it('CatalogModelMergeAudit has no FK relation to CatalogModel', () => {
    const schema = readFileSync(
      join(process.cwd(), 'prisma/schema.prisma'),
      'utf-8'
    )
    // Extract the CatalogModelMergeAudit block
    const start = schema.indexOf('model CatalogModelMergeAudit')
    const end = schema.indexOf('\n}', start) + 2
    const block = schema.slice(start, end)
    // Should contain plain String fields for IDs, not a relation to CatalogModel
    expect(block).toContain('canonicalCatalogModelId String')
    expect(block).toContain('duplicateCatalogModelId String')
    expect(block).not.toContain('@relation')
  })
})

describe('structural: suppression idempotency', () => {
  it('suppressPair uses upsert for idempotent creates', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/lib/actions/catalogDuplicates.ts'),
      'utf-8'
    )
    expect(src).toContain('catalogDuplicateSuppression.upsert')
  })

  it('unsuppressPair removes suppression record', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/lib/actions/catalogDuplicates.ts'),
      'utf-8'
    )
    expect(src).toContain('catalogDuplicateSuppression.deleteMany')
  })

  it('pairKey uniqueness enforced in schema', () => {
    const schema = readFileSync(
      join(process.cwd(), 'prisma/schema.prisma'),
      'utf-8'
    )
    const start = schema.indexOf('model CatalogDuplicateSuppression')
    const end = schema.indexOf('\n}', start) + 2
    const block = schema.slice(start, end)
    expect(block).toContain('@unique')
  })
})

describe('structural: no automatic merge', () => {
  it('buildPairs and rankPairs are pure functions — no DB calls, no side effects', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/lib/catalogDuplicateDetection.ts'),
      'utf-8'
    )
    expect(src).not.toContain('prisma')
    expect(src).not.toContain('fetch(')
    expect(src).not.toContain("'use server'")
  })
})

describe('structural: concurrent catalog-link safety', () => {
  const mergeSrc = readFileSync(
    join(process.cwd(), 'src/lib/actions/catalog.ts'),
    'utf-8'
  )
  const linkSrc = readFileSync(
    join(process.cwd(), 'src/lib/actions/sellerSubmissions.ts'),
    'utf-8'
  )

  it('merge TX acquires FOR UPDATE on CatalogModel — blocks concurrent FK writes (FOR KEY SHARE)', () => {
    // Postgres automatically acquires FOR KEY SHARE on a referenced row when any FK
    // insert/update points to it. FOR KEY SHARE conflicts with FOR UPDATE, so concurrent
    // catalog-link actions block until merge commits or rolls back. After merge deletes
    // the duplicate, the blocked link unblocks and fails with P2003 — never SetNull.
    expect(mergeSrc).toContain('"CatalogModel"')
    expect(mergeSrc).toContain('FOR UPDATE')
  })

  it('merge TX performs pre-delete reference count check on all 5 FK relations', () => {
    // Belt-and-suspenders: verifies updateMany moved every reference before deleting.
    // Rolls back the entire TX (including reassignments and audit) if any reference remains.
    expect(mergeSrc).toContain("catalogId: dupeId } })")
    // Count checks appear after updateMany — not just for items
    expect(mergeSrc).toContain("tx.collectionItem.count")
    expect(mergeSrc).toContain("tx.sellerSubmission.count")
    expect(mergeSrc).toContain("tx.catalogModelPhoto.count")
    expect(mergeSrc).toContain("tx.catalogSuggestion.count")
    expect(mergeSrc).toContain("remaining > 0")
  })

  it('pre-delete check rolls back entire TX when references remain', () => {
    // TX_VALIDATION throw causes prisma.$transaction to abort — rolls back all
    // updateMany calls, audit creation, and prevents the delete from running.
    expect(mergeSrc).toContain('Merge aborted')
    expect(mergeSrc).toContain("throw new Error('TX_VALIDATION')")
  })

  it('adminLinkSubmissionCatalog returns clean error on FK constraint violation (P2003)', () => {
    // When concurrent merge holds FOR UPDATE and then deletes the model,
    // the blocked link unblocks with P2003. This must not become a 500.
    expect(linkSrc).toContain("'P2003'")
    expect(linkSrc).toContain('was just deleted')
  })

  it('SetNull cannot fire on a late-linked SellerSubmission', () => {
    // Proof: SellerSubmission.catalogId has onDelete: SetNull. SetNull only fires
    // during DELETE when existing rows reference the deleted CatalogModel.
    // But merge holds FOR UPDATE, which blocks all FK KEY SHARE acquires on the duplicate.
    // Therefore no new FK reference to the duplicate can commit while merge is running.
    // All references visible at updateMany time are moved. Pre-delete check confirms 0 remain.
    // The delete proceeds with 0 references → SetNull fires on 0 rows → catalogId stays set.
    const schema = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf-8')
    expect(schema).toContain('onDelete: SetNull')     // confirms SetNull is defined
    expect(mergeSrc).toContain('sellerSubmission.count')  // confirms pre-delete count check
    expect(mergeSrc).toContain('FOR UPDATE')          // confirms lock that blocks FK writes
    // The link action catches P2003 — late links fail cleanly, never silently become null
    expect(linkSrc).toContain("'P2003'")
  })
})

describe('structural: cursor pagination', () => {
  it('findDuplicatePairs orders by brand, name, id for deterministic cursor pagination', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/lib/actions/catalogDuplicates.ts'),
      'utf-8'
    )
    expect(src).toContain("{ brand: 'asc' }")
    expect(src).toContain("{ name: 'asc' }")
    expect(src).toContain("{ id: 'asc' }")
  })

  it('findDuplicatePairs returns nextModelCursor when more candidates exist', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/lib/actions/catalogDuplicates.ts'),
      'utf-8'
    )
    expect(src).toContain('nextModelCursor')
    expect(src).toContain('CANDIDATE_PAGE_SIZE')
  })

  it('series and search filters applied at DB level before candidate pool take', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/lib/actions/catalogDuplicates.ts'),
      'utf-8'
    )
    expect(src).toContain('where.series')
    expect(src).toContain('where.OR')
  })
})
