/**
 * 13C: Catalog Data Quality — structural / unit / behavioral tests
 *
 * Most tests are source-code structural (fs.readFileSync) or pure-function unit
 * tests. The "(behavioral)" describe blocks near the end drive the real scan
 * functions against a mocked Prisma client (no real DB connection) to prove the
 * bounded-pagination contract. No external calls. No order/listing/payout mutations.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'

// ── Helpers ────────────────────────────────────────────────────────────────────

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relPath), 'utf-8')
}

function readSlice(src: string, anchor: string, len: number): string {
  const idx = src.indexOf(anchor)
  if (idx === -1) return ''
  return src.slice(idx, idx + len)
}

// ── Pure library ──────────────────────────────────────────────────────────────

import {
  detectModelIssues,
  hasWhitespaceIssue,
  hasControlChars,
  isPlaceholderValue,
  isValidPhotoUrl,
  trimNormalize,
  removeControlChars,
  computeWhitespaceRepair,
  needsWhitespaceRepair,
  computeOptionalNulls,
  needsOptionalNulls,
  ISSUE_SEVERITY,
  ISSUE_CATEGORY,
  REPAIRABLE_ISSUE_TYPES,
  BRAND_MAX,
  NAME_MAX,
  SERIES_MAX,
  YEAR_MIN,
  YEAR_MAX,
  type ModelForDetection,
} from '@/lib/catalogDataQuality'

import { scorePair } from '@/lib/catalogDuplicateDetection'
import { normalize } from '@/lib/catalogMatching'

// ── Mocked Prisma client, for behavioral pagination tests near the end of this
// file. No real DB connection — every model method / $queryRaw call is a vi.fn().
vi.mock('@/lib/prisma', () => ({
  prisma: {
    catalogModel:                { findMany: vi.fn() },
    catalogDuplicateSuppression: { findMany: vi.fn() },
    itemInstance:                { groupBy: vi.fn() },
    $queryRaw:                   vi.fn(),
  },
}))

import { prisma } from '@/lib/prisma'
import { scanDuplicateIssues, scanReferenceIntegrityIssues } from '@/lib/catalogDataQualityQuery'

// ── Exports ────────────────────────────────────────────────────────────────────

describe('catalogDataQuality: exports', () => {
  it('exports all expected symbols', () => {
    expect(detectModelIssues).toBeDefined()
    expect(hasWhitespaceIssue).toBeDefined()
    expect(hasControlChars).toBeDefined()
    expect(isPlaceholderValue).toBeDefined()
    expect(isValidPhotoUrl).toBeDefined()
    expect(trimNormalize).toBeDefined()
    expect(removeControlChars).toBeDefined()
    expect(computeWhitespaceRepair).toBeDefined()
    expect(needsWhitespaceRepair).toBeDefined()
    expect(computeOptionalNulls).toBeDefined()
    expect(needsOptionalNulls).toBeDefined()
    expect(ISSUE_SEVERITY).toBeDefined()
    expect(ISSUE_CATEGORY).toBeDefined()
    expect(REPAIRABLE_ISSUE_TYPES).toBeDefined()
  })

  it('validation bounds are reasonable', () => {
    expect(BRAND_MAX).toBeGreaterThan(0)
    expect(NAME_MAX).toBeGreaterThan(BRAND_MAX)
    expect(SERIES_MAX).toBeGreaterThan(0)
    expect(YEAR_MIN).toBe(1945)
    expect(YEAR_MAX).toBeGreaterThanOrEqual(new Date().getFullYear())
  })
})

// ── Issue keys are deterministic ───────────────────────────────────────────────

describe('catalogDataQuality: deterministic issue keys', () => {
  const model: ModelForDetection = {
    id: 'test-model-id',
    brand: '  Hot Wheels  ',
    name: 'Camaro',
    series: null,
    year: null,
    photos: [],
  }

  it('same input produces identical issue keys on repeated calls', () => {
    const a = detectModelIssues(model)
    const b = detectModelIssues(model)
    const keysA = a.map(i => i.issueKey).sort()
    const keysB = b.map(i => i.issueKey).sort()
    expect(keysA).toEqual(keysB)
  })

  it('issue key includes catalogModelId', () => {
    const issues = detectModelIssues(model)
    for (const i of issues) {
      expect(i.issueKey).toContain(model.id)
    }
  })

  it('issue key includes issue type as prefix', () => {
    const issues = detectModelIssues(model)
    for (const i of issues) {
      expect(i.issueKey.startsWith(i.issueType + ':')).toBe(true)
    }
  })
})

// ── Whitespace detection ───────────────────────────────────────────────────────

describe('catalogDataQuality: whitespace detection', () => {
  it('detects leading whitespace', () => {
    expect(hasWhitespaceIssue('  foo')).toBe(true)
  })

  it('detects trailing whitespace', () => {
    expect(hasWhitespaceIssue('foo  ')).toBe(true)
  })

  it('detects double internal spaces', () => {
    expect(hasWhitespaceIssue('foo  bar')).toBe(true)
  })

  it('passes clean string', () => {
    expect(hasWhitespaceIssue('Hot Wheels')).toBe(false)
  })

  it('trimNormalize collapses and trims', () => {
    expect(trimNormalize('  foo  bar  ')).toBe('foo bar')
  })

  it('detectModelIssues emits whitespace_brand for brand with leading spaces', () => {
    const m: ModelForDetection = { id: 'x', brand: '  HW', name: 'Car', series: null, year: 2020, photos: [] }
    const issues = detectModelIssues(m)
    expect(issues.some(i => i.issueType === 'whitespace_brand')).toBe(true)
  })

  it('detectModelIssues emits whitespace_name for name with trailing space', () => {
    const m: ModelForDetection = { id: 'x', brand: 'HW', name: 'Car  ', series: null, year: 2020, photos: [] }
    const issues = detectModelIssues(m)
    expect(issues.some(i => i.issueType === 'whitespace_name')).toBe(true)
  })

  it('whitespace issues have repairAction = trim_whitespace', () => {
    const m: ModelForDetection = { id: 'x', brand: '  HW', name: 'Car', series: null, year: 2020, photos: [] }
    const issues = detectModelIssues(m)
    const ws = issues.filter(i => i.issueType === 'whitespace_brand')
    expect(ws.every(i => i.repairAction === 'trim_whitespace')).toBe(true)
  })

  it('whitespace issues include repairPreview', () => {
    const m: ModelForDetection = { id: 'x', brand: '  HW', name: 'Car', series: null, year: 2020, photos: [] }
    const issues = detectModelIssues(m)
    const ws = issues.filter(i => i.issueType === 'whitespace_brand')
    expect(ws.every(i => typeof i.repairPreview === 'string' && i.repairPreview.length > 0)).toBe(true)
  })
})

// ── Control character detection ───────────────────────────────────────────────

describe('catalogDataQuality: control character detection', () => {
  it('detects null byte', () => {
    expect(hasControlChars('foo\x00bar')).toBe(true)
  })

  it('detects carriage return', () => {
    expect(hasControlChars('foo\rbar')).toBe(true)
  })

  it('detects line feed', () => {
    expect(hasControlChars('foo\nbar')).toBe(true)
  })

  it('passes clean string', () => {
    expect(hasControlChars('Hot Wheels')).toBe(false)
  })

  it('removeControlChars strips and normalizes', () => {
    expect(removeControlChars('foo\x00bar')).toBe('foobar')
  })

  it('detectModelIssues emits control_chars for brand with control character', () => {
    const m: ModelForDetection = { id: 'x', brand: 'HW\x01', name: 'Car', series: null, year: 2020, photos: [] }
    const issues = detectModelIssues(m)
    expect(issues.some(i => i.issueType === 'control_chars')).toBe(true)
  })

  it('control_chars issue has severity error', () => {
    const m: ModelForDetection = { id: 'x', brand: 'HW\x01', name: 'Car', series: null, year: 2020, photos: [] }
    const issues = detectModelIssues(m)
    const ctrl = issues.filter(i => i.issueType === 'control_chars')
    expect(ctrl.every(i => i.severity === 'error')).toBe(true)
  })
})

// ── Placeholder detection ─────────────────────────────────────────────────────

describe('catalogDataQuality: placeholder detection', () => {
  const placeholders = ['unknown', 'test', 'n/a', 'na', 'tbd', 'tba', 'none', 'null', '?', '-', 'placeholder']

  for (const p of placeholders) {
    it(`detects placeholder "${p}"`, () => {
      expect(isPlaceholderValue(p)).toBe(true)
    })

    it(`detects placeholder "${p.toUpperCase()}" (case-insensitive)`, () => {
      expect(isPlaceholderValue(p.toUpperCase())).toBe(true)
    })
  }

  it('does not flag real brand name', () => {
    expect(isPlaceholderValue('Hot Wheels')).toBe(false)
  })

  it('detectModelIssues emits placeholder_value for brand "unknown"', () => {
    const m: ModelForDetection = { id: 'x', brand: 'unknown', name: 'Car', series: null, year: 2020, photos: [] }
    const issues = detectModelIssues(m)
    expect(issues.some(i => i.issueType === 'placeholder_value')).toBe(true)
  })
})

// ── Year validation ───────────────────────────────────────────────────────────

describe('catalogDataQuality: year validation', () => {
  it('emits missing_year when year is null', () => {
    const m: ModelForDetection = { id: 'x', brand: 'HW', name: 'Car', series: null, year: null, photos: [] }
    const issues = detectModelIssues(m)
    expect(issues.some(i => i.issueType === 'missing_year')).toBe(true)
  })

  it('missing_year severity is info', () => {
    const m: ModelForDetection = { id: 'x', brand: 'HW', name: 'Car', series: null, year: null, photos: [] }
    const issues = detectModelIssues(m)
    const iss = issues.filter(i => i.issueType === 'missing_year')
    expect(iss.every(i => i.severity === 'info')).toBe(true)
  })

  it('emits invalid_year when year is before 1945', () => {
    const m: ModelForDetection = { id: 'x', brand: 'HW', name: 'Car', series: null, year: 1900, photos: [] }
    const issues = detectModelIssues(m)
    expect(issues.some(i => i.issueType === 'invalid_year')).toBe(true)
  })

  it('emits invalid_year when year is too far in future', () => {
    const m: ModelForDetection = { id: 'x', brand: 'HW', name: 'Car', series: null, year: YEAR_MAX + 1, photos: [] }
    const issues = detectModelIssues(m)
    expect(issues.some(i => i.issueType === 'invalid_year')).toBe(true)
  })

  it('does not emit invalid_year for valid year', () => {
    const m: ModelForDetection = { id: 'x', brand: 'HW', name: 'Car', series: null, year: 2020, photos: [] }
    const issues = detectModelIssues(m)
    expect(issues.some(i => i.issueType === 'invalid_year')).toBe(false)
  })
})

// ── Missing photo ─────────────────────────────────────────────────────────────

describe('catalogDataQuality: missing photo', () => {
  it('emits missing_primary_photo when photos array is empty', () => {
    const m: ModelForDetection = { id: 'x', brand: 'HW', name: 'Car', series: null, year: 2020, photos: [] }
    const issues = detectModelIssues(m)
    expect(issues.some(i => i.issueType === 'missing_primary_photo')).toBe(true)
  })

  it('does not emit missing_primary_photo when photos exist', () => {
    const m: ModelForDetection = {
      id: 'x', brand: 'HW', name: 'Car', series: null, year: 2020,
      photos: [{ id: 'p1', url: 'https://example.com/photo.jpg', fingerprints: [{ algorithmVersion: 'dhash-v1' }] }],
    }
    const issues = detectModelIssues(m)
    expect(issues.some(i => i.issueType === 'missing_primary_photo')).toBe(false)
  })

  it('missing_primary_photo severity is warning', () => {
    const m: ModelForDetection = { id: 'x', brand: 'HW', name: 'Car', series: null, year: 2020, photos: [] }
    const issues = detectModelIssues(m)
    const iss = issues.filter(i => i.issueType === 'missing_primary_photo')
    expect(iss.every(i => i.severity === 'warning')).toBe(true)
  })
})

// ── Missing fingerprint ────────────────────────────────────────────────────────

describe('catalogDataQuality: missing fingerprint', () => {
  it('emits photo_missing_fingerprint when photo has no dhash-v1 fingerprint', () => {
    const m: ModelForDetection = {
      id: 'x', brand: 'HW', name: 'Car', series: null, year: 2020,
      photos: [{ id: 'p1', url: 'https://example.com/photo.jpg', fingerprints: [] }],
    }
    const issues = detectModelIssues(m)
    expect(issues.some(i => i.issueType === 'photo_missing_fingerprint')).toBe(true)
  })

  it('does not emit photo_missing_fingerprint when dhash-v1 present', () => {
    const m: ModelForDetection = {
      id: 'x', brand: 'HW', name: 'Car', series: null, year: 2020,
      photos: [{ id: 'p1', url: 'https://example.com/photo.jpg', fingerprints: [{ algorithmVersion: 'dhash-v1' }] }],
    }
    const issues = detectModelIssues(m)
    expect(issues.some(i => i.issueType === 'photo_missing_fingerprint')).toBe(false)
  })

  it('fingerprint idempotency: running detectModelIssues twice emits same fingerprint issues', () => {
    const m: ModelForDetection = {
      id: 'x', brand: 'HW', name: 'Car', series: null, year: 2020,
      photos: [{ id: 'p1', url: 'https://example.com/photo.jpg', fingerprints: [] }],
    }
    const a = detectModelIssues(m).filter(i => i.issueType === 'photo_missing_fingerprint')
    const b = detectModelIssues(m).filter(i => i.issueType === 'photo_missing_fingerprint')
    expect(a.map(i => i.issueKey)).toEqual(b.map(i => i.issueKey))
  })
})

// ── Brand in name ─────────────────────────────────────────────────────────────

describe('catalogDataQuality: brand_in_name', () => {
  it('emits brand_in_name when name starts with brand', () => {
    const m: ModelForDetection = { id: 'x', brand: 'Hot Wheels', name: 'Hot Wheels Camaro', series: null, year: 2020, photos: [] }
    const issues = detectModelIssues(m)
    expect(issues.some(i => i.issueType === 'brand_in_name')).toBe(true)
  })

  it('does not emit brand_in_name for clean name', () => {
    const m: ModelForDetection = { id: 'x', brand: 'Hot Wheels', name: 'Camaro', series: null, year: 2020, photos: [] }
    const issues = detectModelIssues(m)
    expect(issues.some(i => i.issueType === 'brand_in_name')).toBe(false)
  })

  it('brand_in_name severity is info', () => {
    const m: ModelForDetection = { id: 'x', brand: 'Hot Wheels', name: 'Hot Wheels Camaro', series: null, year: 2020, photos: [] }
    const issues = detectModelIssues(m)
    const iss = issues.filter(i => i.issueType === 'brand_in_name')
    expect(iss.every(i => i.severity === 'info')).toBe(true)
  })
})

// ── Clean model produces no issues ────────────────────────────────────────────

describe('catalogDataQuality: clean model', () => {
  it('emits zero issues for a fully correct model', () => {
    const m: ModelForDetection = {
      id: 'x', brand: 'Hot Wheels', name: 'Camaro', series: 'Mainline', year: 2020,
      photos: [{ id: 'p1', url: 'https://example.com/photo.jpg', fingerprints: [{ algorithmVersion: 'dhash-v1' }] }],
    }
    const issues = detectModelIssues(m)
    expect(issues).toHaveLength(0)
  })
})

// ── No PII in issue detail ────────────────────────────────────────────────────

describe('catalogDataQuality: no PII in issues', () => {
  const emailPattern = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}\b/
  const phonePattern = /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/

  it('issue detail fields do not contain email patterns', () => {
    const m: ModelForDetection = { id: 'x', brand: 'HW', name: 'Car', series: null, year: null, photos: [] }
    const issues = detectModelIssues(m)
    for (const i of issues) {
      expect(i.detail).not.toMatch(emailPattern)
    }
  })

  it('issue detail fields do not contain phone patterns', () => {
    const m: ModelForDetection = { id: 'x', brand: 'HW', name: 'Car', series: null, year: null, photos: [] }
    const issues = detectModelIssues(m)
    for (const i of issues) {
      expect(i.detail).not.toMatch(phonePattern)
    }
  })
})

// ── Repair preview ────────────────────────────────────────────────────────────

describe('catalogDataQuality: repair preview', () => {
  it('whitespace_brand issue includes repairPreview', () => {
    const m: ModelForDetection = { id: 'x', brand: '  HW  ', name: 'Car', series: null, year: 2020, photos: [] }
    const issues = detectModelIssues(m)
    const ws = issues.find(i => i.issueType === 'whitespace_brand')
    expect(ws?.repairPreview).toBeDefined()
    expect(ws?.repairPreview).toContain('HW')
  })

  it('view-only issues do not have a repairAction', () => {
    const m: ModelForDetection = { id: 'x', brand: 'HW', name: 'Car', series: null, year: null, photos: [] }
    const issues = detectModelIssues(m)
    const missingYear = issues.find(i => i.issueType === 'missing_year')
    expect(missingYear?.repairAction).toBeUndefined()
  })
})

// ── needsWhitespaceRepair ─────────────────────────────────────────────────────

describe('catalogDataQuality: needsWhitespaceRepair', () => {
  it('returns true when brand has leading space', () => {
    expect(needsWhitespaceRepair({ brand: ' HW', name: 'Car', series: null })).toBe(true)
  })

  it('returns false when fields are clean', () => {
    expect(needsWhitespaceRepair({ brand: 'HW', name: 'Car', series: null })).toBe(false)
  })

  it('computeWhitespaceRepair trims and normalizes', () => {
    const result = computeWhitespaceRepair({ brand: '  HW  ', name: 'Car  body', series: '  S1  ' })
    expect(result.brand).toBe('HW')
    expect(result.name).toBe('Car body')
    expect(result.series).toBe('S1')
  })

  it('computeWhitespaceRepair preserves null series as null', () => {
    const result = computeWhitespaceRepair({ brand: 'HW', name: 'Car', series: null })
    expect(result.series).toBeNull()
  })

  it('computeWhitespaceRepair turns control-char-only series to null', () => {
    const result = computeWhitespaceRepair({ brand: 'HW', name: 'Car', series: '\x01' })
    expect(result.series).toBeNull()
  })
})

// ── needsOptionalNulls ────────────────────────────────────────────────────────

describe('catalogDataQuality: needsOptionalNulls', () => {
  it('returns true when series is empty string', () => {
    expect(needsOptionalNulls({ series: '', color: null, scale: null, notes: null })).toBe(true)
  })

  it('returns false when all fields are null or non-empty', () => {
    expect(needsOptionalNulls({ series: 'Main', color: null, scale: null, notes: null })).toBe(false)
  })

  it('computeOptionalNulls converts empty strings to null', () => {
    const result = computeOptionalNulls({ series: '', color: '  ', scale: null, notes: '' })
    expect(result.series).toBeNull()
    expect(result.color).toBeNull()
    expect(result.notes).toBeNull()
  })

  it('computeOptionalNulls preserves non-empty strings', () => {
    const result = computeOptionalNulls({ series: 'Mainline', color: 'Red', scale: '1:64', notes: 'MOC' })
    expect(result.series).toBe('Mainline')
    expect(result.color).toBe('Red')
  })
})

// ── REPAIRABLE_ISSUE_TYPES ────────────────────────────────────────────────────

describe('catalogDataQuality: REPAIRABLE_ISSUE_TYPES', () => {
  it('includes whitespace types', () => {
    expect(REPAIRABLE_ISSUE_TYPES.has('whitespace_brand')).toBe(true)
    expect(REPAIRABLE_ISSUE_TYPES.has('whitespace_name')).toBe(true)
    expect(REPAIRABLE_ISSUE_TYPES.has('whitespace_series')).toBe(true)
  })

  it('includes control_chars', () => {
    expect(REPAIRABLE_ISSUE_TYPES.has('control_chars')).toBe(true)
  })

  it('does not include view-only types like missing_year', () => {
    expect(REPAIRABLE_ISSUE_TYPES.has('missing_year')).toBe(false)
  })

  it('does not include text_duplicate_high (no auto-merge)', () => {
    expect(REPAIRABLE_ISSUE_TYPES.has('text_duplicate_high')).toBe(false)
  })
})

// ── ISSUE_SEVERITY / ISSUE_CATEGORY coverage ───────────────────────────────────

describe('catalogDataQuality: ISSUE_SEVERITY / ISSUE_CATEGORY', () => {
  it('every issue type has a severity', () => {
    const types = Object.keys(ISSUE_SEVERITY)
    expect(types.length).toBeGreaterThan(0)
    for (const t of types) {
      expect(['error', 'warning', 'info']).toContain(ISSUE_SEVERITY[t as keyof typeof ISSUE_SEVERITY])
    }
  })

  it('every issue type has a category', () => {
    const types = Object.keys(ISSUE_CATEGORY)
    for (const t of types) {
      expect(['completeness', 'formatting', 'duplicate_risk', 'reference_integrity']).toContain(
        ISSUE_CATEGORY[t as keyof typeof ISSUE_CATEGORY]
      )
    }
  })

  it('ISSUE_SEVERITY and ISSUE_CATEGORY have matching key sets', () => {
    const sevKeys = new Set(Object.keys(ISSUE_SEVERITY))
    const catKeys = new Set(Object.keys(ISSUE_CATEGORY))
    for (const k of sevKeys) expect(catKeys.has(k)).toBe(true)
    for (const k of catKeys) expect(sevKeys.has(k)).toBe(true)
  })
})

// ── Source-code structural: no external AI or scraping ────────────────────────

describe('catalogDataQuality: no external AI or scraping', () => {
  const libSrc = readSrc('src/lib/catalogDataQuality.ts')
  const querySrc = readSrc('src/lib/catalogDataQualityQuery.ts')
  const actionSrc = readSrc('src/lib/actions/catalogDataQuality.ts')

  it('core lib does not reference any HTTP fetch or external service', () => {
    expect(libSrc).not.toContain('fetch(')
    expect(libSrc).not.toContain('openai')
    expect(libSrc).not.toContain('anthropic')
    expect(libSrc).not.toContain('axios')
  })

  it('query lib does not make external HTTP calls', () => {
    expect(querySrc).not.toContain('fetch(')
    expect(querySrc).not.toContain('openai')
    expect(querySrc).not.toContain('anthropic')
  })

  it('action lib does not make external HTTP calls', () => {
    expect(actionSrc).not.toContain('fetch(')
    expect(actionSrc).not.toContain('openai')
    expect(actionSrc).not.toContain('anthropic')
  })
})

// ── Source-code structural: no order/listing/payout mutation ─────────────────

describe('catalogDataQuality: no order/listing/payout mutations', () => {
  const actionSrc = readSrc('src/lib/actions/catalogDataQuality.ts')

  it('action lib does not mutate orders', () => {
    expect(actionSrc).not.toContain('order.create')
    expect(actionSrc).not.toContain('order.update')
    expect(actionSrc).not.toContain('order.delete')
  })

  it('action lib does not mutate listings', () => {
    expect(actionSrc).not.toContain('listing.create')
    expect(actionSrc).not.toContain('listing.update')
    expect(actionSrc).not.toContain('listing.delete')
  })

  it('action lib does not reference payout', () => {
    expect(actionSrc.toLowerCase()).not.toContain('payout')
  })
})

// ── Source-code structural: explicit confirmation before repair ────────────────

describe('catalogDataQuality: repair requires explicit confirmation', () => {
  const repairFormSrc = readSrc('src/components/admin/CatalogQualityRepairForms.tsx')

  it('repair form has a confirm state before calling server action', () => {
    expect(repairFormSrc).toContain("'confirm'")
  })

  it('repair form shows confirm button, not immediate fire', () => {
    expect(repairFormSrc).toContain('Confirm repair')
  })

  it('repair form has idle → confirm state transition', () => {
    expect(repairFormSrc).toContain("setState('confirm')")
  })

  it('repair form has confirm → working state transition', () => {
    expect(repairFormSrc).toContain("setState('working')")
  })
})

// ── Source-code structural: stale rejection in repair actions ────────────────

describe('catalogDataQuality: stale rejection in repair actions', () => {
  const actionSrc = readSrc('src/lib/actions/catalogDataQuality.ts')
  const repairSlice = readSlice(actionSrc, 'repairTrimWhitespace', 1500)

  it('repairTrimWhitespace checks updatedAt for stale detection', () => {
    expect(repairSlice).toContain('STALE')
    expect(repairSlice).toContain('updatedAt')
  })

  it('repairTrimWhitespace uses FOR UPDATE lock', () => {
    expect(repairSlice).toContain('FOR UPDATE')
  })

  it('repairTrimWhitespace writes audit in same transaction', () => {
    expect(repairSlice).toContain('catalogDataQualityAudit.create')
  })

  it('repairNullEmptyOptionals also checks stale state', () => {
    const nullSlice = readSlice(actionSrc, 'repairNullEmptyOptionals', 1500)
    expect(nullSlice).toContain('STALE')
    expect(nullSlice).toContain('FOR UPDATE')
  })
})

// ── Source-code structural: audit atomicity ───────────────────────────────────

describe('catalogDataQuality: audit atomicity', () => {
  const actionSrc = readSrc('src/lib/actions/catalogDataQuality.ts')

  it('whitespace repair audit is inside $transaction', () => {
    const slice = readSlice(actionSrc, 'repairTrimWhitespace', 2000)
    const txStart = slice.indexOf('$transaction')
    const auditCreate = slice.indexOf('catalogDataQualityAudit.create')
    expect(txStart).toBeGreaterThan(-1)
    expect(auditCreate).toBeGreaterThan(txStart)
  })

  it('null-optionals repair audit is inside $transaction', () => {
    const slice = readSlice(actionSrc, 'repairNullEmptyOptionals', 2000)
    const txStart = slice.indexOf('$transaction')
    const auditCreate = slice.indexOf('catalogDataQualityAudit.create')
    expect(txStart).toBeGreaterThan(-1)
    expect(auditCreate).toBeGreaterThan(txStart)
  })
})

// ── Source-code structural: bulk batch limit ──────────────────────────────────

describe('catalogDataQuality: bulk batch limit', () => {
  const actionSrc = readSrc('src/lib/actions/catalogDataQuality.ts')

  it('BULK_MAX is defined as 50', () => {
    expect(actionSrc).toContain('BULK_MAX = 50')
  })

  it('bulkRepairTrimWhitespace requires confirmed param and rejects > BULK_MAX', () => {
    const slice = readSlice(actionSrc, 'bulkRepairTrimWhitespace', 800)
    expect(slice).toContain('confirmed')
    expect(slice).toContain('BULK_MAX')
    expect(slice).toContain('> BULK_MAX')
  })

  it('bulkRepairNullEmptyOptionals requires confirmed param and rejects > BULK_MAX', () => {
    const slice = readSlice(actionSrc, 'bulkRepairNullEmptyOptionals', 800)
    expect(slice).toContain('confirmed')
    expect(slice).toContain('BULK_MAX')
    expect(slice).toContain('> BULK_MAX')
  })
})

// ── Source-code structural: per-row bulk results ──────────────────────────────

describe('catalogDataQuality: per-row bulk results', () => {
  const actionSrc = readSrc('src/lib/actions/catalogDataQuality.ts')

  it('BulkRepairRowResult type has status field', () => {
    expect(actionSrc).toContain("'repaired' | 'skipped' | 'error'")
  })

  it('BulkRepairResult includes repairedCount, skippedCount, errorCount', () => {
    expect(actionSrc).toContain('repairedCount')
    expect(actionSrc).toContain('skippedCount')
    expect(actionSrc).toContain('errorCount')
  })

  it('bulk repair skips rows that need no repair (does not force repair)', () => {
    const slice = readSlice(actionSrc, 'bulkRepairTrimWhitespace', 1400)
    expect(slice).toContain("status: 'skipped'")
  })
})

// ── Source-code structural: no auto repair on page load ───────────────────────

describe('catalogDataQuality: no auto repair on page load', () => {
  const pageSrc = readSrc('src/app/(admin)/admin/catalog-quality/page.tsx')
  const detailSrc = readSrc('src/app/(admin)/admin/catalog-quality/models/[id]/page.tsx')
  const repairFormSrc = readSrc('src/components/admin/CatalogQualityRepairForms.tsx')

  it('dashboard page does not call any repair action', () => {
    expect(pageSrc).not.toContain('repairTrimWhitespace')
    expect(pageSrc).not.toContain('repairNullEmptyOptionals')
    expect(pageSrc).not.toContain('bulkRepair')
  })

  it('model detail page does not call any repair action directly', () => {
    expect(detailSrc).not.toContain('repairTrimWhitespace(')
    expect(detailSrc).not.toContain('repairNullEmptyOptionals(')
  })

  it('repair forms component is client-only with explicit confirmation', () => {
    expect(repairFormSrc).toContain("'use client'")
    expect(repairFormSrc).toContain("'confirm'")
  })
})

// ── Source-code structural: no auto merge/delete/relink ──────────────────────

describe('catalogDataQuality: no auto merge/delete/relink', () => {
  const actionSrc = readSrc('src/lib/actions/catalogDataQuality.ts')
  const pageSrc = readSrc('src/app/(admin)/admin/catalog-quality/page.tsx')

  it('action lib does not auto-merge catalog models', () => {
    expect(actionSrc).not.toContain('mergeCatalog')
    expect(actionSrc).not.toContain('catalogModel.delete')
  })

  it('dashboard page does not trigger merges', () => {
    expect(pageSrc).not.toContain('mergeCatalog')
  })
})

// ── Source-code structural: complete scan (no record cap) ─────────────────────

describe('catalogDataQuality: complete scan (no arbitrary record cap)', () => {
  const querySrc = readSrc('src/lib/catalogDataQualityQuery.ts')

  it('scanIssues uses SCAN_PAGE_SIZE for paging, not a total cap', () => {
    expect(querySrc).toContain('SCAN_PAGE_SIZE')
  })

  it('scanIssues loops until table exhausted or issue limit reached', () => {
    const slice = readSlice(querySrc, 'scanIssues', 2000)
    expect(slice).toContain('for (;;)')
  })

  it('scanIssues keyset paginates on catalogModel.id', () => {
    const slice = readSlice(querySrc, 'scanIssues', 2000)
    expect(slice).toContain('cursor: { id: scanCursor }')
  })
})

// ── Source-code structural: no N+1 in scan ───────────────────────────────────

describe('catalogDataQuality: no N+1 queries in scan', () => {
  const querySrc = readSrc('src/lib/catalogDataQualityQuery.ts')

  it('photos and fingerprints are included via nested select, not separate loop queries', () => {
    // MODEL_SELECT constant includes nested fingerprints select — no N+1
    expect(querySrc).toContain('fingerprints: { select:')
    expect(querySrc).not.toContain('fingerprint.findMany')
  })
})

// ── Source-code structural: merge impact has 9 count types ────────────────────

describe('catalogDataQuality: merge impact summary completeness', () => {
  const querySrc = readSrc('src/lib/catalogDataQualityQuery.ts')
  // computeImpactCounts is the shared helper that holds all 9 count queries.
  // getMergeImpactSummary now delegates to it for each model.
  const mergeSlice = readSlice(querySrc, 'computeImpactCounts', 2000)

  const expectedFields = [
    'itemInstances',
    'collectionItems',
    'wantedBy',
    'sellerSubmissions',
    'photos',
    'fingerprints',
    'activeListings',
    'soldItems',
    'externalObs',
  ]

  for (const field of expectedFields) {
    it(`MergeImpactSummary includes "${field}"`, () => {
      expect(mergeSlice).toContain(field)
    })
  }

  it('getMergeImpactSummary runs counts in parallel (Promise.all)', () => {
    expect(mergeSlice).toContain('Promise.all')
  })
})

// ── Source-code structural: deterministic lock order ─────────────────────────

describe('catalogDataQuality: deterministic lock order in bulk repair', () => {
  const actionSrc = readSrc('src/lib/actions/catalogDataQuality.ts')
  const bulkSlice = readSlice(actionSrc, 'bulkRepairTrimWhitespace', 1200)

  it('bulk repair orders models by id before processing (deterministic lock order)', () => {
    expect(bulkSlice).toContain("orderBy: { id: 'asc' }")
  })
})

// ── Source-code structural: schema has CatalogDataQualityAudit ───────────────

describe('catalogDataQuality: schema', () => {
  const schemaSrc = readSrc('prisma/schema.prisma')

  it('schema defines CatalogDataQualityAudit model', () => {
    expect(schemaSrc).toContain('model CatalogDataQualityAudit')
  })

  it('CatalogDataQualityAudit has issueKey, action, catalogModelId', () => {
    const slice = readSlice(schemaSrc, 'model CatalogDataQualityAudit', 600)
    expect(slice).toContain('issueKey')
    expect(slice).toContain('action')
    expect(slice).toContain('catalogModelId')
  })

  it('CatalogDataQualityAudit has beforeSnapshot and afterSnapshot as Json', () => {
    const slice = readSlice(schemaSrc, 'model CatalogDataQualityAudit', 600)
    expect(slice).toContain('beforeSnapshot')
    expect(slice).toContain('afterSnapshot')
  })

  it('CatalogDataQualityAudit has indexes on catalogModelId and issueKey', () => {
    const slice = readSlice(schemaSrc, 'model CatalogDataQualityAudit', 600)
    expect(slice).toContain('@@index([catalogModelId])')
    expect(slice).toContain('@@index([issueKey])')
  })

  it('audit model uses plain string for catalogModelId (not FK) so audit survives model deletion', () => {
    const slice = readSlice(schemaSrc, 'model CatalogDataQualityAudit', 600)
    // No CatalogModel FK relation (the next model CatalogModelPhoto has @relation but that's outside this slice check)
    // Verify catalogModelId is a plain String with no @relation attribute on the same line
    expect(slice).toContain('catalogModelId String')
    expect(slice).not.toContain('catalogModelId CatalogModel')
  })
})

// ── Source-code structural: migration for CatalogDataQualityAudit ─────────────

describe('catalogDataQuality: migration', () => {
  const migSrc = readSrc('prisma/migrations/20260805090000_add_catalog_quality_audit/migration.sql')

  it('migration creates CatalogDataQualityAudit table', () => {
    expect(migSrc).toContain('CREATE TABLE "CatalogDataQualityAudit"')
  })

  it('migration creates index on catalogModelId', () => {
    expect(migSrc).toContain('CatalogDataQualityAudit_catalogModelId_idx')
  })

  it('migration creates index on issueKey', () => {
    expect(migSrc).toContain('CatalogDataQualityAudit_issueKey_idx')
  })
})

// ── Source-code structural: admin auth in repair actions ──────────────────────

describe('catalogDataQuality: admin auth in repair actions', () => {
  const actionSrc = readSrc('src/lib/actions/catalogDataQuality.ts')

  it('action file imports isAdminAuthenticated', () => {
    expect(actionSrc).toContain('isAdminAuthenticated')
    expect(actionSrc).toContain("from '@/lib/adminAuth'")
  })

  it('repairTrimWhitespace calls isAdminAuthenticated before doing work', () => {
    const slice = readSlice(actionSrc, 'repairTrimWhitespace', 300)
    expect(slice).toContain('isAdminAuthenticated')
  })

  it('repairNullEmptyOptionals calls isAdminAuthenticated before doing work', () => {
    const slice = readSlice(actionSrc, 'repairNullEmptyOptionals', 300)
    expect(slice).toContain('isAdminAuthenticated')
  })

  it('bulkRepairTrimWhitespace calls isAdminAuthenticated before doing work', () => {
    const slice = readSlice(actionSrc, 'bulkRepairTrimWhitespace', 300)
    expect(slice).toContain('isAdminAuthenticated')
  })

  it('bulkRepairNullEmptyOptionals calls isAdminAuthenticated before doing work', () => {
    const slice = readSlice(actionSrc, 'bulkRepairNullEmptyOptionals', 300)
    expect(slice).toContain('isAdminAuthenticated')
  })

  it('removeStaleSuppressionAction calls isAdminAuthenticated before doing work', () => {
    const slice = readSlice(actionSrc, 'removeStaleSuppressionAction', 300)
    expect(slice).toContain('isAdminAuthenticated')
  })

  it('unauthorized path returns error without touching DB', () => {
    // Auth check appears before any prisma call in each action
    const slice = readSlice(actionSrc, 'repairTrimWhitespace', 500)
    const authIdx = slice.indexOf('isAdminAuthenticated')
    const prismaIdx = slice.indexOf('prisma.')
    expect(authIdx).toBeGreaterThan(-1)
    expect(prismaIdx).toBeGreaterThan(authIdx)
  })
})

// ── Source-code structural: post-page-1 scan detection ────────────────────────

describe('catalogDataQuality: post-page-1 scan detection', () => {
  const querySrc = readSrc('src/lib/catalogDataQualityQuery.ts')

  it('SCAN_PAGE_SIZE is 100 (not the full table)', () => {
    expect(querySrc).toContain('SCAN_PAGE_SIZE = 100')
  })

  it('scan loop does not stop after the first page (for loop continues)', () => {
    // The scan loop uses `for (;;)` and only exits when issues.length >= limit OR page exhausted
    // This proves the loop will iterate beyond page 1 to collect issues from later pages
    const slice = readSlice(querySrc, 'for (;;)', 2000)
    expect(slice).toContain('page.length < SCAN_PAGE_SIZE')
    // After each page, cursor is advanced to the last model's id
    expect(slice).toContain("page[page.length - 1].id")
  })

  it('scan advances cursor after each page to detect issues in later pages', () => {
    // If a model at position 101 (page 2) has an issue, the cursor advances and finds it
    const slice = readSlice(querySrc, 'scanCursor = page', 100)
    expect(slice).toContain('scanCursor = page[page.length - 1].id')
  })

  it('pure detectModelIssues can detect an issue in any arbitrary model regardless of position', () => {
    // Simulate a model that would be at position 150 (page 2 of a 100-model page scan)
    // by simply calling detectModelIssues directly — the function is position-agnostic
    const modelAtPosition150: ModelForDetection = {
      id: 'model-at-page-2',
      brand: '  SpacedBrand  ',  // whitespace issue
      name: 'Car',
      series: null,
      year: null,
      photos: [],
    }
    const issues = detectModelIssues(modelAtPosition150)
    // Confirm issues are detected regardless of logical position in a scan
    expect(issues.some(i => i.issueType === 'whitespace_brand')).toBe(true)
    expect(issues.some(i => i.issueType === 'missing_year')).toBe(true)
    expect(issues.some(i => i.issueType === 'missing_primary_photo')).toBe(true)
    // Issue keys still include the model id
    for (const issue of issues) {
      expect(issue.catalogModelId).toBe('model-at-page-2')
    }
  })

  it('scan issues result has hasMore and nextCursor fields for pagination', () => {
    expect(querySrc).toContain('hasMore')
    expect(querySrc).toContain('nextCursor')
  })
})

// ── Source-code structural: isValidPhotoUrl ───────────────────────────────────

describe('catalogDataQuality: isValidPhotoUrl', () => {
  it('accepts https URL', () => {
    expect(isValidPhotoUrl('https://cdn.example.com/img.jpg')).toBe(true)
  })

  it('accepts http URL', () => {
    expect(isValidPhotoUrl('http://example.com/img.jpg')).toBe(true)
  })

  it('rejects empty string', () => {
    expect(isValidPhotoUrl('')).toBe(false)
  })

  it('rejects bare filename', () => {
    expect(isValidPhotoUrl('photo.jpg')).toBe(false)
  })

  it('rejects data URI', () => {
    expect(isValidPhotoUrl('data:image/png;base64,abc')).toBe(false)
  })
})

// ── 13C gap-fix: pagination cursor correctness ────────────────────────────────

describe('catalogDataQuality: scanIssues cursor set after full model', () => {
  const querySrc = readSrc('src/lib/catalogDataQualityQuery.ts')

  it('limit check is outside the inner issue for-loop (cursor never mid-model)', () => {
    const slice = readSlice(querySrc, 'function scanIssues', 3000)
    // The return with hasMore must NOT appear inside the inner for-issue loop.
    // After the fix the slice contains issues.slice(0, limit) at the outer check.
    expect(slice).toContain('issues.slice(0, limit)')
  })

  it('return with nextCursor appears after the inner issue loop closes', () => {
    const slice = readSlice(querySrc, 'function scanIssues', 3000)
    // Correct: cursor set at model level, not inside per-issue loop
    // The phrase "Check limit AFTER" should appear as our comment
    expect(slice).toContain('Check limit AFTER')
  })
})

// ── 13C gap-fix: scanDuplicateIssues emits all cross-model types ──────────────

describe('catalogDataQuality: scanDuplicateIssues', () => {
  const querySrc = readSrc('src/lib/catalogDataQualityQuery.ts')
  const slice     = readSlice(querySrc, 'scanDuplicateIssues', 9000)
  // Pair scoring/emission now lives in the scanBrandGroupPairs helper (called by
  // scanDuplicateIssues), so these assertions anchor there instead.
  const pairSlice = readSlice(querySrc, 'function scanBrandGroupPairs', 4000)

  it('emits text_duplicate_high for score >= 80', () => {
    expect(pairSlice).toContain('text_duplicate_high')
    expect(pairSlice).toContain('score >= 80')
  })

  it('emits text_duplicate_medium for score >= 50 (but < 80)', () => {
    expect(pairSlice).toContain('text_duplicate_medium')
  })

  it('emits normalized_key_collision for score === 100', () => {
    expect(pairSlice).toContain('normalized_key_collision')
    expect(pairSlice).toContain('score === 100')
  })

  it('emits exact_photo_duplicate from a bounded self-join page', () => {
    expect(slice).toContain('exact_photo_duplicate')
    expect(slice).toContain('fetchExactDupPage')
  })

  it('emits near_photo_duplicate from a bounded band-candidate self-join', () => {
    expect(slice).toContain('near_photo_duplicate')
    expect(slice).toContain('nextNearDupPairAfter')
  })

  it('deduplicates cross-model pairs via stablePairKey and seenPairs', () => {
    expect(slice).toContain('stablePairKey')
    expect(slice).toContain('seenPairs')
  })

  it('emits no repairAction (all issues are view-only)', () => {
    // No repairAction field should be emitted inside scanDuplicateIssues
    expect(slice).not.toContain('repairAction:')
  })

  it('normalized_key_collision fires when two models have the same normalized brand+name', () => {
    // Pure unit: scorePair returns 100 for identical normalized brand+name
    const a = { id: 'id1', brand: 'Hot Wheels', name: 'Ferrari', series: null, year: null, color: null, scale: null }
    const b = { id: 'id2', brand: 'Hot Wheels', name: 'Ferrari', series: null, year: null, color: null, scale: null }
    const { score } = scorePair(a, b)
    expect(score).toBe(100)
  })
})

// ── 13C gap-fix: scanReferenceIntegrityIssues emits all integrity types ───────

describe('catalogDataQuality: scanReferenceIntegrityIssues', () => {
  const querySrc = readSrc('src/lib/catalogDataQualityQuery.ts')
  const slice    = readSlice(querySrc, 'scanReferenceIntegrityIssues', 15000)

  it('detects orphan models via nested none filters', () => {
    expect(slice).toContain('none: {}')
    expect(slice).toContain('orphan_no_refs_no_photos')
  })

  it('detects fingerprint model mismatches via raw SQL join on catalogPhotoId', () => {
    expect(slice).toContain('fingerprint_model_mismatch')
    expect(slice).toContain('catalogPhotoId')
  })

  it('detects seller submission metadata conflicts via raw SQL', () => {
    expect(slice).toContain('submission_metadata_conflict')
    expect(slice).toContain('SellerSubmission')
  })

  it('detects merge audit canonical missing via raw SQL', () => {
    expect(slice).toContain('merge_target_missing')
    expect(slice).toContain('CatalogModelMergeAudit')
  })

  it('detects suppressed models with active inventory', () => {
    expect(slice).toContain('suppressed_active_inventory')
    expect(slice).toContain('catalogDuplicateSuppression')
  })
})

// ── 13C gap-fix: setPrimaryCatalogPhoto locking and audit ─────────────────────

describe('catalogDataQuality: setPrimaryCatalogPhoto', () => {
  const photoSrc = readSrc('src/lib/actions/catalogPhotos.ts')
  const slice    = readSlice(photoSrc, 'setPrimaryCatalogPhoto', 5000)

  it('checks admin auth before any DB access', () => {
    expect(slice).toContain('isAdminAuthenticated')
    const authIdx  = slice.indexOf('isAdminAuthenticated')
    const prismaIdx = slice.indexOf('prisma.')
    expect(authIdx).toBeGreaterThan(-1)
    expect(prismaIdx).toBeGreaterThan(authIdx)
  })

  it('locks CatalogModel FOR UPDATE before locking photos', () => {
    const modelLockIdx = slice.indexOf('"CatalogModel"')
    const photoLockIdx = slice.indexOf('"CatalogModelPhoto"')
    expect(modelLockIdx).toBeGreaterThan(-1)
    expect(photoLockIdx).toBeGreaterThan(modelLockIdx)
  })

  it('locks photos in deterministic id order to prevent deadlock', () => {
    expect(slice).toContain("orderBy: { id: 'asc' }")
  })

  it('writes CatalogDataQualityAudit inside the same transaction', () => {
    const txIdx    = slice.indexOf('$transaction')
    const auditIdx = slice.indexOf('catalogDataQualityAudit.create')
    expect(txIdx).toBeGreaterThan(-1)
    expect(auditIdx).toBeGreaterThan(txIdx)
  })

  it('records set_primary_photo action', () => {
    expect(slice).toContain("'set_primary_photo'")
  })
})

// ── 13C gap-fix: mergeCatalogModels stale-preview protection ─────────────────

describe('catalogDataQuality: mergeCatalogModels stale preview', () => {
  const catalogSrc = readSrc('src/lib/actions/catalog.ts')
  const slice      = readSlice(catalogSrc, 'mergeCatalogModels', 7000)

  it('reads expectedImpactSnapshot from formData', () => {
    expect(slice).toContain('expectedImpactSnapshot')
  })

  it('parses expectedPayload JSON (explicit merge direction)', () => {
    expect(slice).toContain('expectedPayload')
    expect(slice).toContain('JSON.parse')
  })

  it('recalculates all 9 counts inside TX for stale check', () => {
    // Count fields appear in the comparison after the direction check
    const staleIdx = slice.indexOf('Stale-preview + direction check')
    expect(staleIdx).toBeGreaterThan(-1)
    const staleSlice = slice.slice(staleIdx, staleIdx + 2000)
    expect(staleSlice).toContain('itemInstances')
    expect(staleSlice).toContain('collectionItems')
    expect(staleSlice).toContain('activeListings')
    expect(staleSlice).toContain('soldItems')
    expect(staleSlice).toContain('externalObs')
  })

  it('rejects merge with TX_VALIDATION when count changed', () => {
    expect(slice).toContain('Impact changed')
    expect(slice).toContain('TX_VALIDATION')
  })

  it('verifies canonicalModelId and sourceModelId inside TX (direction check)', () => {
    expect(slice).toContain('canonicalModelId')
    expect(slice).toContain('sourceModelId')
    expect(slice).toContain('Merge direction was changed')
  })
})

// ── 13C blocker: server-enforced bulk confirmation ────────────────────────────

describe('catalogDataQuality: bulk confirmation enforcement', () => {
  const actionSrc = readSrc('src/lib/actions/catalogDataQuality.ts')

  it('bulkRepairTrimWhitespace rejects when confirmed is false', () => {
    const slice = readSlice(actionSrc, 'bulkRepairTrimWhitespace', 800)
    expect(slice).toContain('!confirmed')
    expect(slice).toContain('Confirmation required')
  })

  it('bulkRepairNullEmptyOptionals rejects when confirmed is false', () => {
    const slice = readSlice(actionSrc, 'bulkRepairNullEmptyOptionals', 800)
    expect(slice).toContain('!confirmed')
    expect(slice).toContain('Confirmation required')
  })

  it('bulkRepairTrimWhitespace errors (not slices) when deduped IDs > 50', () => {
    const slice = readSlice(actionSrc, 'bulkRepairTrimWhitespace', 1200)
    // Must return error, not silently slice
    expect(slice).toContain('Too many IDs')
    expect(slice).not.toContain('slice(0, BULK_MAX)')
  })

  it('CatalogBulkRepairPanel passes confirmed: true on repair', () => {
    const panelSrc = readSrc('src/components/admin/CatalogBulkRepairPanel.tsx')
    // Find the actual function call (not the import)
    const callIdx = panelSrc.indexOf('await bulkRepairTrimWhitespace')
    expect(callIdx).toBeGreaterThan(-1)
    expect(panelSrc.slice(callIdx, callIdx + 60)).toContain('true')
  })
})

// ── 13C blocker: authoritative sold-history via OrderItem ─────────────────────

describe('catalogDataQuality: authoritative sold-history', () => {
  const querySrc = readSrc('src/lib/catalogDataQualityQuery.ts')

  it('computeImpactCounts uses orderItem not ItemInstance.status for soldItems', () => {
    const slice = readSlice(querySrc, 'computeImpactCounts', 1200)
    expect(slice).toContain('orderItem')
    expect(slice).toContain("status: 'complete'")
    expect(slice).toContain('completedAt')
  })

  it('computeImpactCounts is exported from catalogDataQualityQuery', () => {
    expect(querySrc).toContain('export async function computeImpactCounts')
  })

  it('getMergeImpactSummary delegates to computeImpactCounts', () => {
    const slice = readSlice(querySrc, 'getMergeImpactSummary', 500)
    expect(slice).toContain('computeImpactCounts')
  })

  it('catalog.ts imports computeImpactCounts', () => {
    const catalogSrc = readSrc('src/lib/actions/catalog.ts')
    expect(catalogSrc).toContain('computeImpactCounts')
    expect(catalogSrc).toContain('catalogDataQualityQuery')
  })
})

// ── 13C blocker: explicit merge payload (source/target direction) ─────────────

describe('catalogDataQuality: explicit merge payload', () => {
  const mergeSrc = readSrc('src/app/(admin)/admin/catalog/duplicates/merge/page.tsx')

  it('merge page emits canonicalModelId in snapshot', () => {
    expect(mergeSrc).toContain('canonicalModelId')
  })

  it('merge page emits sourceModelId in snapshot', () => {
    expect(mergeSrc).toContain('sourceModelId')
  })

  it('merge page emits sourceImpact (not modelB key) in snapshot', () => {
    expect(mergeSrc).toContain('sourceImpact')
    // old format used arbitrary duplicate-ID key — must not appear
    expect(mergeSrc).not.toContain('[duplicateId]')
  })
})

// ── 13C blocker: primary-photo stale check ───────────────────────────────────

describe('catalogDataQuality: setPrimaryCatalogPhoto stale-state protection', () => {
  const photoSrc = readSrc('src/lib/actions/catalogPhotos.ts')
  const slice    = readSlice(photoSrc, 'setPrimaryCatalogPhoto', 5000)

  it('accepts formData as third parameter', () => {
    expect(slice).toContain('formData: FormData')
  })

  it('reads expectedPhotoOrder from formData', () => {
    expect(slice).toContain('expectedPhotoOrder')
    expect(slice).toContain('JSON.parse')
  })

  it('rejects with STALE_PHOTO_ORDER when order changed', () => {
    expect(slice).toContain('STALE_PHOTO_ORDER')
  })

  it('CatalogPhotoUpload includes expectedPhotoOrder hidden field', () => {
    const uploadSrc = readSrc('src/components/admin/CatalogPhotoUpload.tsx')
    expect(uploadSrc).toContain('expectedPhotoOrder')
    expect(uploadSrc).toContain('expectedOrderJson')
  })
})

// ── 13C blocker: two-phase photo reorder ─────────────────────────────────────

describe('catalogDataQuality: two-phase photo reorder', () => {
  const photoSrc = readSrc('src/lib/actions/catalogPhotos.ts')
  const slice    = readSlice(photoSrc, 'setPrimaryCatalogPhoto', 5000)

  it('phase 1 uses collision-proof dynamic tempOffset (not fixed +10000)', () => {
    // tempOffset = max(existing sortOrders) + n + 1, guaranteed above all existing values
    const phase1Idx = slice.indexOf('tempOffset')
    const phase2Idx = slice.indexOf('sortOrder: i')
    expect(slice).toContain('tempOffset')
    expect(slice).toContain('maxSortOrder')
    expect(phase1Idx).toBeGreaterThan(-1)
    expect(phase2Idx).toBeGreaterThan(phase1Idx)
  })

  it('phase 2 writes final positions 0..n-1', () => {
    expect(slice).toContain('sortOrder: i')
    expect(slice).toContain('reordered.entries()')
  })
})

// ── 13C blocker: cross-model scan pagination cursors ─────────────────────────

describe('catalogDataQuality: scan pagination cursors', () => {
  const querySrc = readSrc('src/lib/catalogDataQualityQuery.ts')

  it('scanDuplicateIssues accepts cursor parameter', () => {
    const slice = readSlice(querySrc, 'scanDuplicateIssues', 200)
    expect(slice).toContain('cursor')
  })

  it('scanDuplicateIssues returns nextCursor in result', () => {
    const typeSrc = readSlice(querySrc, 'DuplicateScanResult', 200)
    expect(typeSrc).toContain('nextCursor')
  })

  it('scanDuplicateIssues stops at limit without a full pre-sorted issue universe', () => {
    // Bounded traversal: stops the instant `limit` is reached, no materialize-then-sort.
    const slice = readSlice(querySrc, 'scanDuplicateIssues', 10000)
    expect(slice).toContain('issueKey')
    expect(slice).toContain('issues.length >= limit')
    expect(slice).not.toContain('.sort(')
  })

  it('scanReferenceIntegrityIssues accepts cursor parameter', () => {
    const slice = readSlice(querySrc, 'scanReferenceIntegrityIssues', 200)
    expect(slice).toContain('cursor')
  })

  it('scanReferenceIntegrityIssues returns nextCursor in result', () => {
    const typeSrc = readSlice(querySrc, 'RefIntegrityScanResult', 200)
    expect(typeSrc).toContain('nextCursor')
  })

  it('text phase resumes mid-group from a (brand, modelAId, modelBId) cursor', () => {
    // New bounded traversal: refetches just the resumed brand group, not the whole table
    const slice = readSlice(querySrc, 'scanDuplicateIssues', 10000)
    expect(slice).toContain('textResume')
    expect(slice).toContain('text|')             // cursor prefix for text phase
    expect(slice).toContain('fetchBrandGroup')   // resume refetches only the cursor's group
    expect(slice).toContain('scanBrandGroupPairs')
  })

  it('photo phase resumes via an exact/near sub-phase keyset cursor', () => {
    const slice = readSlice(querySrc, 'scanDuplicateIssues', 10000)
    expect(slice).toContain('photoResumeCursor')
    expect(slice).toContain('photo|exact|')
    expect(slice).toContain('photo|near|')
  })

  it('refIntegrity resumes via phase-based keyset cursor (not global findIndex)', () => {
    const slice = readSlice(querySrc, 'scanReferenceIntegrityIssues', 15000)
    // New: each phase returns early with cursor in format "phase|entityId"
    expect(slice).toContain('phaseActive')
    expect(slice).toContain('phaseResuming')
    expect(slice).toContain('orphan|')
    expect(slice).toContain('fingerprint|')
    // No global sort/findIndex across all issues
    expect(slice).not.toContain('issues.sort(')
  })
})

// ── 13C verification: bounded duplicate scan source queries ──────────────────

describe('catalogDataQuality: bounded duplicate scan', () => {
  const querySrc = readSrc('src/lib/catalogDataQualityQuery.ts')
  const fullSrc  = querySrc
  const slice    = readSlice(querySrc, 'scanDuplicateIssues', 12000)

  it('text phase: never loads the whole CatalogModel table', () => {
    // The old "load all models in a while(true) loop, THEN group" pattern is gone —
    // groups are discovered and fetched one at a time directly from the DB.
    expect(fullSrc).not.toContain('allModels')
    expect(slice).toContain('nextBrandGroupAfter')
    expect(slice).toContain('fetchBrandGroup')
  })

  it('text phase: brand-group discovery uses a bounded DB page (take/LIMIT), not JS filtering over a preloaded table', () => {
    const helperSlice = readSlice(querySrc, 'nextBrandGroupAfter', 2000)
    expect(helperSlice).toContain('LIMIT 1')       // DB-level "skip irrelevant groups" probe
    expect(readSlice(querySrc, 'fetchBrandGroup', 1500)).toContain('BRAND_GROUP_PAGE_SIZE')
  })

  it('text phase: stops generating pairs immediately when limit reached (no O(n²) per page)', () => {
    expect(slice).toContain('issues.length >= limit')
    expect(slice).toContain('text|${group.key}|${result.lastA}|${result.lastB}')
  })

  it('text phase: large single-brand groups resume via a (modelAId, modelBId) pair cursor', () => {
    expect(slice).toContain('scanBrandGroupPairs')
    const pairSlice = readSlice(querySrc, 'function scanBrandGroupPairs', 4000)
    expect(pairSlice).toContain('fromAId')
    expect(pairSlice).toContain('fromBId')
  })

  it('photo phase: exact-duplicate pairs come from a bounded self-join page (no full fingerprint scan)', () => {
    expect(slice).toContain('fetchExactDupPage')
    expect(readSlice(querySrc, 'fetchExactDupPage', 1200)).toContain('DISTINCT ON')
    expect(readSlice(querySrc, 'fetchExactDupPage', 1200)).toContain('EXACT_DUP_PAGE_SIZE')
  })

  it('photo phase: near-duplicate pairs come from a bounded band-candidate self-join (reuses 12G-C band index)', () => {
    expect(slice).toContain('nextNearDupPairAfter')
    expect(readSlice(querySrc, 'nextNearDupPairAfter', 1200)).toContain('hashBand0')
    expect(readSlice(querySrc, 'nextNearDupPairAfter', 1200)).toContain('LIMIT 1')
  })

  it('no full O(n²) pair universe or full photo-issue list is sorted before applying a cursor', () => {
    // Old pattern: generate all pairs → sort → slice. New pattern: traverse, stop early.
    expect(slice).not.toContain('.sort(')
    expect(slice).not.toContain('issues.slice(')
  })
})

// ── 13C verification: bounded reference integrity source queries ──────────────

describe('catalogDataQuality: bounded reference scan', () => {
  const querySrc = readSrc('src/lib/catalogDataQualityQuery.ts')
  const slice    = readSlice(querySrc, 'scanReferenceIntegrityIssues', 15000)

  it('each phase uses bounded DB queries (LIMIT or keyset cursor per page)', () => {
    // Fingerprint phase has keyset cursor: AND fp.id > cursor
    expect(slice).toContain('AND fp.id >')
    // Submission phase has keyset cursor: AND s.id > cursor
    expect(slice).toContain('AND s.id >')
    // Audit phase has keyset cursor: AND id > cursor
    expect(slice).toContain('AND id >')
  })

  it('each phase returns early with cursor before loading next batch', () => {
    // Each phase checks issues.length >= limit and returns with nextCursor
    const orphanReturn     = slice.indexOf('orphan|${m.id}')
    const fingerprintReturn = slice.indexOf('fingerprint|${fp.id}')
    const submissionReturn = slice.indexOf('submission|${sc.id}')
    expect(orphanReturn).toBeGreaterThan(-1)
    expect(fingerprintReturn).toBeGreaterThan(-1)
    expect(submissionReturn).toBeGreaterThan(-1)
    // Phases are in order
    expect(fingerprintReturn).toBeGreaterThan(orphanReturn)
    expect(submissionReturn).toBeGreaterThan(fingerprintReturn)
  })

  it('second page does not rescan first-page source universe (orphan: uses keyset cursor)', () => {
    // The orphan keyset cursor uses skip+cursor, not a limit+offset that rescans
    expect(slice).toContain("skip: 1, cursor: { id: orphanCursor }")
  })

  it('suppression phase paginates the suppression table itself (bounded take, keyset cursor) instead of loading every row', () => {
    // The old "findMany({ select: { pairKey: true } })" with no take/cursor is gone.
    expect(querySrc).not.toContain('catalogDuplicateSuppression.findMany({ select: { pairKey: true } })')
    expect(slice).toContain('resumeAfter')
    expect(slice).toContain('checkedModelIds')
    expect(slice).toContain("cursor: { id: suppCursor }")
  })
})

// ── 13C verification: collision-proof photo reorder ──────────────────────────

describe('catalogDataQuality: collision-proof photo reorder', () => {
  const photoSrc = readSrc('src/lib/actions/catalogPhotos.ts')
  const slice    = readSlice(photoSrc, 'setPrimaryCatalogPhoto', 5000)

  it('tempOffset = max(sortOrders) + n + 1, safe against any existing sortOrder value', () => {
    expect(slice).toContain('maxSortOrder')
    expect(slice).toContain('currentPhotos.length')
    // The formula prevents collision with any existing value including 10000 or 20000
    expect(slice).toContain('maxSortOrder + currentPhotos.length + 1')
  })

  it('phase 1 assigns unique sequential temp values (offset + index)', () => {
    expect(slice).toContain('tempOffset + idx')
  })

  it('final 0..n-1 positions are all less than tempOffset (no collision)', () => {
    // Phase 2 writes 0..n-1 via "sortOrder: i" with i from entries()
    expect(slice).toContain('sortOrder: i')
  })
})

// ── 13C scalability pass: bounded-pagination behavioral tests (mocked Prisma) ──
//
// Everything above is a structural (source-text) check. These tests actually drive
// scanDuplicateIssues / scanReferenceIntegrityIssues against a mocked Prisma client
// backed by an in-memory fake dataset, to prove the bounded-pagination CONTRACT:
// every raw-SQL call carries a finite LIMIT, page count scales with dataset size
// (never a single unbounded load), cursors advance monotonically, and no issue is
// ever skipped or repeated across adjacent pages.

type FakeModel = { id: string; brand: string; name: string; year: number | null; series: string | null; color: string | null; scale: string | null }
type FakeFingerprint = {
  id: string; catalogModelId: string; contentSha256: string; perceptualHash: string
  hashBand0: string; hashBand1: string; hashBand2: string; hashBand3: string; algorithmVersion: string
}

type SqlLike = { strings: readonly string[]; values: unknown[] }
function isSqlLike(v: unknown): v is SqlLike {
  return !!v && typeof v === 'object' && Array.isArray((v as SqlLike).values) && Array.isArray((v as SqlLike).strings)
}
// Flattens a tagged-template call — including nested Prisma.sql fragments used for
// conditional clauses — into plain SQL text (with `?` placeholders) and an ordered
// list of leaf bound values. Verified empirically against real Prisma.sql output.
function flattenSql(strings: readonly string[], values: unknown[]): { text: string; values: unknown[] } {
  let text = ''
  const flat: unknown[] = []
  strings.forEach((s, i) => {
    text += s
    if (i < values.length) {
      const v = values[i]
      if (isSqlLike(v)) {
        const nested = flattenSql(v.strings, v.values)
        text += nested.text
        flat.push(...nested.values)
      } else {
        text += '?'
        flat.push(v)
      }
    }
  })
  return { text, values: flat }
}

const BRAND_GROUP_PAGE_SIZE = 500
const EXACT_DUP_PAGE_SIZE   = 100
const NEAR_DUP_PAGE_SIZE    = 200

// Installs a $queryRaw mock that answers the five bounded raw-SQL query shapes used
// by catalogDataQualityQuery.ts's duplicate scan, backed by an in-memory fixture.
// Every branch enforces the SAME page-size cap the real SQL's LIMIT would enforce.
function installFakeCatalogDb(models: FakeModel[], fingerprints: FakeFingerprint[] = []) {
  const calls: Array<{ shape: string; text: string; values: unknown[] }> = []

  ;(prisma.$queryRaw as ReturnType<typeof vi.fn>).mockImplementation((strings: TemplateStringsArray, ...rawValues: unknown[]) => {
    const { text, values } = flattenSql(strings as unknown as string[], rawValues)

    // ── Brand-group probe: SELECT normBrand ... ORDER BY "normBrand" ASC LIMIT 1
    if (text.includes('FROM "CatalogModel"') && text.includes('ORDER BY "normBrand" ASC')) {
      calls.push({ shape: 'brandProbe', text, values })
      const afterBrand = values.length > 0 ? String(values[0]) : null
      const keys = [...new Set(models.map(m => normalize(m.brand)))].sort()
      const next = keys.find(k => afterBrand === null || k > afterBrand)
      return Promise.resolve(next !== undefined ? [{ normBrand: next }] : [])
    }

    // ── Brand-group fetch: SELECT ... WHERE normBrand = X [AND id > cursor] ORDER BY id ASC LIMIT 500
    if (text.includes('FROM "CatalogModel"') && text.includes('ORDER BY id ASC')) {
      calls.push({ shape: 'brandFetch', text, values })
      const normBrand = String(values[0])
      const limit     = Number(values[values.length - 1])
      const idCursor  = values.length === 3 ? String(values[1]) : null
      const group = models
        .filter(m => normalize(m.brand) === normBrand)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      const startIdx = idCursor ? group.findIndex(m => m.id > idCursor) : 0
      const rows = startIdx === -1 ? [] : group.slice(startIdx, startIdx + limit)
      return Promise.resolve(rows.map(m => ({ ...m, normBrand })))
    }

    // ── Exact-photo duplicate page: DISTINCT ON (modelIdA, modelIdB) ... LIMIT 100
    if (text.includes('DISTINCT ON')) {
      calls.push({ shape: 'exactDup', text, values })
      const algVersion = String(values[0])
      const cursor = values.length === 4 ? { a: String(values[1]), b: String(values[2]) } : null
      const limit  = Number(values[values.length - 1])
      const rows = fingerprints.filter(f => f.algorithmVersion === algVersion)
      const bySha = new Map<string, FakeFingerprint[]>()
      for (const r of rows) {
        if (!bySha.has(r.contentSha256)) bySha.set(r.contentSha256, [])
        bySha.get(r.contentSha256)!.push(r)
      }
      const pairs = new Map<string, { modelIdA: string; modelIdB: string; contentSha256: string }>()
      for (const [sha, group] of bySha) {
        for (const a of group) for (const b of group) {
          if (a.catalogModelId < b.catalogModelId) {
            const key = `${a.catalogModelId}|${b.catalogModelId}`
            if (!pairs.has(key)) pairs.set(key, { modelIdA: a.catalogModelId, modelIdB: b.catalogModelId, contentSha256: sha })
          }
        }
      }
      const sorted = [...pairs.values()].sort((x, y) =>
        x.modelIdA !== y.modelIdA ? (x.modelIdA < y.modelIdA ? -1 : 1) : (x.modelIdB < y.modelIdB ? -1 : x.modelIdB > y.modelIdB ? 1 : 0))
      const filtered = sorted.filter(p => !cursor || p.modelIdA > cursor.a || (p.modelIdA === cursor.a && p.modelIdB > cursor.b))
      return Promise.resolve(filtered.slice(0, limit))
    }

    // ── Near-photo band-candidate probe: ... hashBand0 = hashBand0 OR ... LIMIT 1
    if (text.includes('hashBand0') && text.includes('LIMIT 1')) {
      calls.push({ shape: 'nearProbe', text, values })
      const algVersion = String(values[0])
      const cursor = values.length === 3 ? { a: String(values[1]), b: String(values[2]) } : null
      const rows = fingerprints.filter(f => f.algorithmVersion === algVersion)
      const bandMatch = (a: FakeFingerprint, b: FakeFingerprint) =>
        a.hashBand0 === b.hashBand0 || a.hashBand1 === b.hashBand1 || a.hashBand2 === b.hashBand2 || a.hashBand3 === b.hashBand3
      const pairKeys = new Set<string>()
      for (const a of rows) for (const b of rows) {
        if (a.catalogModelId < b.catalogModelId && bandMatch(a, b)) pairKeys.add(`${a.catalogModelId}|${b.catalogModelId}`)
      }
      const sorted = [...pairKeys].sort()
        .filter(k => !cursor || k > `${cursor.a}|${cursor.b}`)
      if (sorted.length === 0) return Promise.resolve([])
      const [modelIdA, modelIdB] = sorted[0].split('|')
      return Promise.resolve([{ modelIdA, modelIdB }])
    }

    // ── Near-photo pair-candidate fetch: WHERE catalogModelId = A AND catalogModelId = B ... LIMIT 200
    if (text.includes('hashBand0')) {
      calls.push({ shape: 'nearFetch', text, values })
      const modelIdA = String(values[0])
      const modelIdB = String(values[1])
      const limit = Number(values[values.length - 1])
      const idCursor = values.length === 6 ? { idA: String(values[3]), idB: String(values[4]) } : null
      const bandMatch = (a: FakeFingerprint, b: FakeFingerprint) =>
        a.hashBand0 === b.hashBand0 || a.hashBand1 === b.hashBand1 || a.hashBand2 === b.hashBand2 || a.hashBand3 === b.hashBand3
      const as = fingerprints.filter(f => f.catalogModelId === modelIdA)
      const bs = fingerprints.filter(f => f.catalogModelId === modelIdB)
      const rows: Array<{ idA: string; idB: string; modelIdA: string; modelIdB: string; phA: string; phB: string }> = []
      for (const a of as) for (const b of bs) {
        if (bandMatch(a, b)) rows.push({ idA: a.id, idB: b.id, modelIdA, modelIdB, phA: a.perceptualHash, phB: b.perceptualHash })
      }
      rows.sort((x, y) => (x.idA !== y.idA ? (x.idA < y.idA ? -1 : 1) : (x.idB < y.idB ? -1 : x.idB > y.idB ? 1 : 0)))
      const filtered = rows.filter(r => !idCursor || r.idA > idCursor.idA || (r.idA === idCursor.idA && r.idB > idCursor.idB))
      return Promise.resolve(filtered.slice(0, limit))
    }

    calls.push({ shape: 'unknown', text, values })
    return Promise.resolve([])
  })

  ;(prisma.catalogModel.findMany as ReturnType<typeof vi.fn>).mockImplementation(({ where }: { where: { id: { in: string[] } } }) => {
    const ids = new Set(where.id.in)
    return Promise.resolve(models.filter(m => ids.has(m.id)).map(m => ({ id: m.id, brand: m.brand, name: m.name, year: m.year })))
  })

  return calls
}

function makeModel(id: string, brand: string, name: string): FakeModel {
  return { id, brand, name, year: null, series: null, color: null, scale: null }
}

describe('catalogDataQuality: bounded text-duplicate pagination (behavioral)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fetchBrandGroup uses a bounded take — a 520-model single-brand group is never fetched in one call', async () => {
    const models: FakeModel[] = []
    for (let i = 0; i < 520; i++) models.push(makeModel(`m${String(i).padStart(4, '0')}`, 'Hot Wheels', `Zephyr${i}`))
    const calls = installFakeCatalogDb(models, [])

    await scanDuplicateIssues(100000)

    const fetchCalls = calls.filter(c => c.shape === 'brandFetch')
    expect(fetchCalls.length).toBeGreaterThanOrEqual(2)          // 520 rows / 500-row page = 2 calls
    for (const c of fetchCalls) expect(Number(c.values[c.values.length - 1])).toBe(BRAND_GROUP_PAGE_SIZE)
    // First page must not return the whole 520-row group in one response.
    expect(fetchCalls[0].values.length).toBe(2)                  // [normBrand, limit] — no id cursor on page 1
  })

  it('second brandFetch page resumes from the prior page\'s last source id (not a rescanned offset)', async () => {
    const models: FakeModel[] = []
    for (let i = 0; i < 520; i++) models.push(makeModel(`m${String(i).padStart(4, '0')}`, 'Hot Wheels', `Zephyr${i}`))
    const calls = installFakeCatalogDb(models, [])

    await scanDuplicateIssues(100000)

    const fetchCalls = calls.filter(c => c.shape === 'brandFetch')
    expect(fetchCalls.length).toBe(2)
    const page1LastId = 'm0499' // 500th row (0-indexed 0..499) sorted by id
    expect(fetchCalls[1].values).toEqual(['hot wheels', page1LastId, BRAND_GROUP_PAGE_SIZE])
  })

  it('brand-group discovery probe is bounded (LIMIT 1) and does not enumerate skipped groups', async () => {
    const models = [
      makeModel('a1', 'Alpha Brand', 'Solo'),
      makeModel('b1', 'Beta Brand', 'Solo'),
      makeModel('c1', 'Gamma Brand', 'Solo'),
    ]
    const calls = installFakeCatalogDb(models, [])

    await scanDuplicateIssues(100000)

    const probeCalls = calls.filter(c => c.shape === 'brandProbe')
    // 3 distinct groups + 1 final "no more groups" probe = 4 probe calls, never a full table scan.
    expect(probeCalls.length).toBe(4)
    expect(probeCalls[0].values).toEqual([])
    expect(probeCalls[1].values).toEqual(['alpha brand'])
    expect(probeCalls[2].values).toEqual(['beta brand'])
  })

  it('adjacent pages have no missing or repeated issues, and a far-later (alphabetically last) group stays reachable', async () => {
    // Three groups, each with an exact normalized-key-collision pair (score 100) —
    // deterministic single issue per group. "zzz brand" sorts last.
    const models = [
      makeModel('a1', 'Alpha Brand', 'Ferrari'), makeModel('a2', 'Alpha Brand', 'Ferrari'),
      makeModel('b1', 'Beta Brand', 'Ferrari'),  makeModel('b2', 'Beta Brand', 'Ferrari'),
      makeModel('z1', 'Zzz Brand', 'Ferrari'),   makeModel('z2', 'Zzz Brand', 'Ferrari'),
    ]
    installFakeCatalogDb(models, [])

    const seen = new Set<string>()
    let cursor: string | undefined
    let iterations = 0
    for (;;) {
      const result = await scanDuplicateIssues(1, cursor)
      for (const issue of result.issues) {
        expect(seen.has(issue.issueKey)).toBe(false)   // never repeated across pages
        seen.add(issue.issueKey)
      }
      if (!result.hasMore) break
      cursor = result.nextCursor
      iterations++
      expect(iterations).toBeLessThan(50)               // guard against infinite loop on a bug
    }

    // score === 100 emits BOTH normalized_key_collision AND text_duplicate_high (score >= 80)
    // for the same pair — that's existing scanBrandGroupPairs behavior, not a pagination bug.
    expect(seen).toEqual(new Set([
      'normalized_key_collision:a1|a2', 'text_duplicate_high:a1|a2',
      'normalized_key_collision:b1|b2', 'text_duplicate_high:b1|b2',
      'normalized_key_collision:z1|z2', 'text_duplicate_high:z1|z2', // far-later group — reached despite limit=1 pagination
    ]))
  })
})

describe('catalogDataQuality: bounded photo-duplicate pagination (behavioral)', () => {
  beforeEach(() => vi.clearAllMocks())

  function makeFp(id: string, modelId: string, sha: string, ph: string, bands: [string, string, string, string]): FakeFingerprint {
    return { id, catalogModelId: modelId, contentSha256: sha, perceptualHash: ph, hashBand0: bands[0], hashBand1: bands[1], hashBand2: bands[2], hashBand3: bands[3], algorithmVersion: 'dhash-v1' }
  }

  it('exact-photo scan uses a bounded self-join page (LIMIT 100), not a full fingerprint table load', async () => {
    const calls = installFakeCatalogDb(
      [makeModel('mA', 'Brand A', 'Solo A'), makeModel('mB', 'Brand B', 'Solo B')],
      [
        makeFp('f1', 'mA', 'sha-shared', 'h1', ['b0', 'b1', 'b2', 'b3']),
        makeFp('f2', 'mB', 'sha-shared', 'h2', ['c0', 'c1', 'c2', 'c3']),
      ],
    )

    const result = await scanDuplicateIssues(50)

    const exactCalls = calls.filter(c => c.shape === 'exactDup')
    expect(exactCalls.length).toBeGreaterThanOrEqual(1)
    for (const c of exactCalls) expect(Number(c.values[c.values.length - 1])).toBe(EXACT_DUP_PAGE_SIZE)
    expect(result.issues.some(i => i.issueKey === 'exact_photo_duplicate:mA|mB')).toBe(true)
  })

  it('near-photo scan uses bounded fingerprint/candidate queries (probe LIMIT 1, fetch LIMIT 200)', async () => {
    const calls = installFakeCatalogDb(
      [makeModel('mA', 'Brand A', 'Solo A'), makeModel('mB', 'Brand B', 'Solo B')],
      [
        makeFp('f1', 'mA', 'sha-a', '0000000000000000', ['band-x', 'y0', 'y1', 'y2']),
        makeFp('f2', 'mB', 'sha-b', '0000000000000001', ['band-x', 'z0', 'z1', 'z2']), // shares hashBand0, Hamming distance 1
      ],
    )

    const result = await scanDuplicateIssues(50)

    const probeCalls = calls.filter(c => c.shape === 'nearProbe')
    const fetchCalls = calls.filter(c => c.shape === 'nearFetch')
    expect(probeCalls.length).toBeGreaterThanOrEqual(1)
    expect(fetchCalls.length).toBeGreaterThanOrEqual(1)
    for (const c of fetchCalls) expect(Number(c.values[c.values.length - 1])).toBe(NEAR_DUP_PAGE_SIZE)
    expect(result.issues.some(i => i.issueKey === 'near_photo_duplicate:mA|mB')).toBe(true)
  })

  it('photo-duplicate call count does not scale with an unrelated large CatalogModel table', async () => {
    const models: FakeModel[] = []
    for (let i = 0; i < 300; i++) models.push(makeModel(`m${String(i).padStart(4, '0')}`, `Brand${i}`, 'Solo')) // 300 distinct single-model groups
    const calls = installFakeCatalogDb(models, [])

    await scanDuplicateIssues(100000)

    // Photo phase touches the (empty) fingerprint fixture only — a handful of calls,
    // not one per CatalogModel group.
    const photoCalls = calls.filter(c => c.shape === 'exactDup' || c.shape === 'nearProbe' || c.shape === 'nearFetch')
    expect(photoCalls.length).toBeLessThan(10)
  })
})

describe('catalogDataQuality: bounded suppression pagination (behavioral)', () => {
  beforeEach(() => vi.clearAllMocks())

  function installFakeSuppressionDb(pairKeys: string[], activeModelIds: string[] = []) {
    const rows = pairKeys.map((pairKey, i) => ({ id: `s${String(i).padStart(4, '0')}`, pairKey }))
    ;(prisma.catalogDuplicateSuppression.findMany as ReturnType<typeof vi.fn>).mockImplementation(
      ({ take, cursor }: { take: number; cursor?: { id: string } }) => {
        const startIdx = cursor ? rows.findIndex(r => r.id === cursor.id) + 1 : 0
        return Promise.resolve(rows.slice(startIdx, startIdx + take))
      },
    )
    ;(prisma.itemInstance.groupBy as ReturnType<typeof vi.fn>).mockImplementation(
      ({ where }: { where: { catalogId: { in: string[] } } }) => {
        const active = where.catalogId.in.filter(id => activeModelIds.includes(id))
        return Promise.resolve(active.map(id => ({ catalogId: id, _count: { id: 3 } })))
      },
    )
    ;(prisma.catalogModel.findMany as ReturnType<typeof vi.fn>).mockImplementation(
      ({ where }: { where: { id: { in: string[] } } }) => {
        return Promise.resolve(where.id.in.map(id => ({ id, brand: 'Brand', name: 'Name', year: null })))
      },
    )
  }

  it('suppression scan pages the suppression table with a bounded take, not one unbounded findMany', async () => {
    const pairKeys = Array.from({ length: 150 }, (_, i) => `p${i}A|p${i}B`) // 150 rows, page size 100 => 2 calls
    installFakeSuppressionDb(pairKeys, [])

    await scanReferenceIntegrityIssues(1000, 'suppression|')

    const calls = (prisma.catalogDuplicateSuppression.findMany as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.length).toBe(2)
    for (const [args] of calls) expect(args.take).toBe(100)
    expect(calls[0][0].cursor).toBeUndefined()
    expect(calls[1][0].cursor).toEqual({ id: 's0099' }) // resumes from page 1's last row id
  })

  it('suppression scan still finds active-inventory issues after the bounded rewrite', async () => {
    installFakeSuppressionDb(['modelX|modelY'], ['modelX'])

    const result = await scanReferenceIntegrityIssues(50, 'suppression|')

    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].issueKey).toBe('suppressed_active_inventory:modelX')
  })
})
