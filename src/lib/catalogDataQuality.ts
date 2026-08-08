// Pure catalog data quality types and detection logic — no DB or server dependencies.

import { ALGORITHM_VERSION } from '@/lib/catalogImageFingerprint'

// ── Types ─────────────────────────────────────────────────────────────────────

export type IssueType =
  // Completeness
  | 'missing_brand'
  | 'missing_name'
  | 'missing_year'
  | 'missing_primary_photo'
  | 'photo_missing_fingerprint'
  | 'invalid_photo_url'
  // Formatting
  | 'whitespace_brand'
  | 'whitespace_name'
  | 'whitespace_series'
  | 'control_chars'
  | 'invalid_year'
  | 'placeholder_value'
  | 'brand_in_name'
  // Duplicate risk
  | 'text_duplicate_high'
  | 'text_duplicate_medium'
  | 'exact_photo_duplicate'
  | 'near_photo_duplicate'
  | 'normalized_key_collision'
  // Reference integrity
  | 'orphan_no_refs_no_photos'
  | 'fingerprint_model_mismatch'
  | 'suppressed_active_inventory'
  | 'submission_metadata_conflict'
  | 'merge_target_missing'

export type IssueCategory =
  | 'completeness'
  | 'formatting'
  | 'duplicate_risk'
  | 'reference_integrity'

export type IssueSeverity = 'error' | 'warning' | 'info'

export type RepairAction =
  | 'trim_whitespace'
  | 'null_empty_optionals'
  | 'regenerate_fingerprint'

export type DataQualityIssue = {
  issueKey:              string          // deterministic stable key
  issueType:             IssueType
  category:              IssueCategory
  severity:              IssueSeverity
  catalogModelId:        string
  relatedCatalogModelId?: string         // set for cross-model issues (duplicate pairs)
  detail:                string          // human-readable, no PII
  repairAction?:         RepairAction    // absent = view-only
  repairPreview?:        string          // before → after description
}

export const ISSUE_SEVERITY: Record<IssueType, IssueSeverity> = {
  missing_brand:              'error',
  missing_name:               'error',
  missing_year:               'info',
  missing_primary_photo:      'warning',
  photo_missing_fingerprint:  'warning',
  invalid_photo_url:          'warning',
  whitespace_brand:           'warning',
  whitespace_name:            'warning',
  whitespace_series:          'warning',
  control_chars:              'error',
  invalid_year:               'warning',
  placeholder_value:          'warning',
  brand_in_name:              'info',
  text_duplicate_high:        'error',
  text_duplicate_medium:      'warning',
  exact_photo_duplicate:      'warning',
  near_photo_duplicate:       'info',
  normalized_key_collision:   'error',
  orphan_no_refs_no_photos:     'info',
  fingerprint_model_mismatch:   'warning',
  suppressed_active_inventory:  'warning',
  submission_metadata_conflict: 'warning',
  merge_target_missing:         'warning',
}

export const ISSUE_CATEGORY: Record<IssueType, IssueCategory> = {
  missing_brand:              'completeness',
  missing_name:               'completeness',
  missing_year:               'completeness',
  missing_primary_photo:      'completeness',
  photo_missing_fingerprint:  'completeness',
  invalid_photo_url:          'completeness',
  whitespace_brand:           'formatting',
  whitespace_name:            'formatting',
  whitespace_series:          'formatting',
  control_chars:              'formatting',
  invalid_year:               'formatting',
  placeholder_value:          'formatting',
  brand_in_name:              'formatting',
  text_duplicate_high:        'duplicate_risk',
  text_duplicate_medium:      'duplicate_risk',
  exact_photo_duplicate:      'duplicate_risk',
  near_photo_duplicate:       'duplicate_risk',
  normalized_key_collision:   'duplicate_risk',
  orphan_no_refs_no_photos:     'reference_integrity',
  fingerprint_model_mismatch:   'reference_integrity',
  suppressed_active_inventory:  'reference_integrity',
  submission_metadata_conflict: 'reference_integrity',
  merge_target_missing:         'reference_integrity',
}

// Issue types for which a safe repair action exists.
export const REPAIRABLE_ISSUE_TYPES = new Set<IssueType>([
  'whitespace_brand',
  'whitespace_name',
  'whitespace_series',
  'control_chars',
  'photo_missing_fingerprint',
])

// ── Validation bounds ─────────────────────────────────────────────────────────

export const BRAND_MAX     = 80
export const NAME_MAX      = 160
export const SERIES_MAX    = 120
export const YEAR_MIN      = 1945
export const YEAR_MAX      = new Date().getFullYear() + 2

// ── Detection helpers ─────────────────────────────────────────────────────────

const CONTROL_CHAR_RE = /[\x00-\x1F\x7F]/

const PLACEHOLDER_SET = new Set([
  'unknown', 'test', 'n/a', 'na', 'tbd', 'tba', 'none', 'null', '?', '-', 'placeholder',
])

export function hasWhitespaceIssue(s: string): boolean {
  return s !== s.trim() || /\s{2,}/.test(s)
}

export function hasControlChars(s: string): boolean {
  return CONTROL_CHAR_RE.test(s)
}

export function isPlaceholderValue(s: string): boolean {
  const normalized = s.trim().toLowerCase().replace(/[^\w]/g, '')
  return PLACEHOLDER_SET.has(normalized) || PLACEHOLDER_SET.has(s.trim().toLowerCase())
}

export function isValidPhotoUrl(url: string): boolean {
  return /^https?:\/\/.{4,}/.test(url)
}

export function trimNormalize(s: string): string {
  return s.trim().replace(/\s+/g, ' ')
}

export function removeControlChars(s: string): string {
  return s.replace(CONTROL_CHAR_RE, '').trim().replace(/\s+/g, ' ')
}

function normalizeForComparison(s: string): string {
  return s.trim().toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim()
}

// ── Main detection ─────────────────────────────────────────────────────────────

export type ModelForDetection = {
  id:     string
  brand:  string
  name:   string
  series: string | null
  year:   number | null
  photos: Array<{
    id:           string
    url:          string
    fingerprints: Array<{ algorithmVersion: string }>
  }>
}

export function detectModelIssues(model: ModelForDetection): DataQualityIssue[] {
  const issues: DataQualityIssue[] = []
  const mid = model.id
  const alg = ALGORITHM_VERSION

  // ── Completeness ────────────────────────────────────────────────────────────
  if (!model.brand || model.brand.trim() === '') {
    issues.push({
      issueKey: `missing_brand:${mid}`,
      issueType: 'missing_brand',
      category: 'completeness', severity: 'error',
      catalogModelId: mid,
      detail: 'Brand is empty.',
    })
  }

  if (!model.name || model.name.trim() === '') {
    issues.push({
      issueKey: `missing_name:${mid}`,
      issueType: 'missing_name',
      category: 'completeness', severity: 'error',
      catalogModelId: mid,
      detail: 'Name is empty.',
    })
  }

  if (model.year === null) {
    issues.push({
      issueKey: `missing_year:${mid}`,
      issueType: 'missing_year',
      category: 'completeness', severity: 'info',
      catalogModelId: mid,
      detail: 'Year is not set.',
    })
  }

  if (model.photos.length === 0) {
    issues.push({
      issueKey: `missing_primary_photo:${mid}`,
      issueType: 'missing_primary_photo',
      category: 'completeness', severity: 'warning',
      catalogModelId: mid,
      detail: 'No photos. Add a reference image to improve catalog quality.',
    })
  }

  for (const photo of model.photos) {
    if (!isValidPhotoUrl(photo.url)) {
      issues.push({
        issueKey: `invalid_photo_url:${mid}:${photo.id}`,
        issueType: 'invalid_photo_url',
        category: 'completeness', severity: 'warning',
        catalogModelId: mid,
        detail: `Photo ${photo.id.slice(0, 8)}… has an invalid or unsupported URL format.`,
      })
    }

    const hasCurrent = photo.fingerprints.some(f => f.algorithmVersion === alg)
    if (!hasCurrent) {
      issues.push({
        issueKey: `photo_missing_fingerprint:${mid}:${photo.id}`,
        issueType: 'photo_missing_fingerprint',
        category: 'completeness', severity: 'warning',
        catalogModelId: mid,
        detail: `Photo ${photo.id.slice(0, 8)}… is missing a ${alg} fingerprint. Use the Image Intelligence backfill to regenerate.`,
        repairAction: 'regenerate_fingerprint',
        repairPreview: `Compute and store a new ${alg} fingerprint for this photo.`,
      })
    }
  }

  // ── Formatting ──────────────────────────────────────────────────────────────
  if (model.brand && hasWhitespaceIssue(model.brand)) {
    issues.push({
      issueKey: `whitespace_brand:${mid}`,
      issueType: 'whitespace_brand',
      category: 'formatting', severity: 'warning',
      catalogModelId: mid,
      detail: `Brand has whitespace issues.`,
      repairAction: 'trim_whitespace',
      repairPreview: `"${model.brand}" → "${trimNormalize(model.brand)}"`,
    })
  }

  if (model.name && hasWhitespaceIssue(model.name)) {
    issues.push({
      issueKey: `whitespace_name:${mid}`,
      issueType: 'whitespace_name',
      category: 'formatting', severity: 'warning',
      catalogModelId: mid,
      detail: `Name has whitespace issues.`,
      repairAction: 'trim_whitespace',
      repairPreview: `"${model.name}" → "${trimNormalize(model.name)}"`,
    })
  }

  if (model.series && hasWhitespaceIssue(model.series)) {
    issues.push({
      issueKey: `whitespace_series:${mid}`,
      issueType: 'whitespace_series',
      category: 'formatting', severity: 'warning',
      catalogModelId: mid,
      detail: `Series has whitespace issues.`,
      repairAction: 'trim_whitespace',
      repairPreview: `"${model.series}" → "${trimNormalize(model.series)}"`,
    })
  }

  // Control characters across all text fields
  const textFields: Array<[string, string | null]> = [
    ['brand', model.brand],
    ['name', model.name],
    ['series', model.series],
  ]
  for (const [field, value] of textFields) {
    if (value && hasControlChars(value)) {
      issues.push({
        issueKey: `control_chars:${mid}:${field}`,
        issueType: 'control_chars',
        category: 'formatting', severity: 'error',
        catalogModelId: mid,
        detail: `Field "${field}" contains control characters.`,
        repairAction: 'trim_whitespace',
        repairPreview: `Remove control characters from "${field}".`,
      })
    }
  }

  if (model.year !== null && (model.year < YEAR_MIN || model.year > YEAR_MAX)) {
    issues.push({
      issueKey: `invalid_year:${mid}`,
      issueType: 'invalid_year',
      category: 'formatting', severity: 'warning',
      catalogModelId: mid,
      detail: `Year ${model.year} is outside the expected range ${YEAR_MIN}–${YEAR_MAX}.`,
    })
  }

  for (const [field, value] of textFields) {
    if (value && isPlaceholderValue(value)) {
      issues.push({
        issueKey: `placeholder_value:${mid}:${field}`,
        issueType: 'placeholder_value',
        category: 'formatting', severity: 'warning',
        catalogModelId: mid,
        detail: `Field "${field}" appears to contain a placeholder value: "${value}".`,
      })
    }
  }

  // Brand duplicated at start of name (deterministic)
  if (model.brand && model.name) {
    const normBrand = normalizeForComparison(model.brand)
    const normName  = normalizeForComparison(model.name)
    if (normBrand.length >= 3 && normName.startsWith(normBrand + ' ')) {
      issues.push({
        issueKey: `brand_in_name:${mid}`,
        issueType: 'brand_in_name',
        category: 'formatting', severity: 'info',
        catalogModelId: mid,
        detail: `Name starts with brand ("${model.brand}"): consider removing the redundant prefix.`,
      })
    }
  }

  return issues
}

// ── Bulk whitespace repair helper ─────────────────────────────────────────────

export type WhitespaceRepairFields = {
  brand:  string
  name:   string
  series: string | null
}

export function computeWhitespaceRepair(fields: WhitespaceRepairFields): WhitespaceRepairFields {
  return {
    brand:  removeControlChars(fields.brand),
    name:   removeControlChars(fields.name),
    series: fields.series !== null ? (removeControlChars(fields.series) || null) : null,
  }
}

export function needsWhitespaceRepair(fields: WhitespaceRepairFields): boolean {
  const repaired = computeWhitespaceRepair(fields)
  return (
    repaired.brand  !== fields.brand  ||
    repaired.name   !== fields.name   ||
    (repaired.series ?? null) !== (fields.series ?? null)
  )
}

// ── Null-empty-optionals helper ───────────────────────────────────────────────

export type OptionalFields = {
  series: string | null
  color:  string | null
  scale:  string | null
  notes:  string | null
}

export function computeOptionalNulls(fields: OptionalFields): OptionalFields {
  return {
    series: fields.series?.trim() || null,
    color:  fields.color?.trim()  || null,
    scale:  fields.scale?.trim()  || null,
    notes:  fields.notes?.trim()  || null,
  }
}

export function needsOptionalNulls(fields: OptionalFields): boolean {
  const nulled = computeOptionalNulls(fields)
  return (
    nulled.series !== fields.series ||
    nulled.color  !== fields.color  ||
    nulled.scale  !== fields.scale  ||
    nulled.notes  !== fields.notes
  )
}
