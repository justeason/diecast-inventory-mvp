import crypto from 'crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'

export const MAX_CSV_BYTES  = 5 * 1024 * 1024  // 5 MB
export const MAX_ROW_COUNT  = 5_000
export const MAX_FIELD_LEN  = 2_000             // per-field safety cap for rawSnapshot

// title is independently validated to 500 chars; total_price is optional (computed).
const REQUIRED_COLUMNS = ['title', 'observation_type', 'price', 'currency'] as const
const VALID_OBSERVATION_TYPES = new Set(['sold', 'active_ask'])

export type ImportRowResult = {
  rowIndex: number
  status: 'imported' | 'duplicate' | 'error'
  reason?: string
  observationId?: string
}

// Batch import result.
// Invariant: rowCount === importedCount + duplicateCount + errorCount
export type ImportBatchResult = {
  batchId: string
  rowCount: number
  importedCount: number
  duplicateCount: number
  errorCount: number
  rows: ImportRowResult[]
}

// ── CSV parser ────────────────────────────────────────────────────────────────

// RFC 4180-compatible: handles quoted fields, embedded newlines, doubled-quote escapes.
function parseCsvAll(text: string): string[][] {
  const rows: string[][] = []
  let i = 0

  while (i < text.length) {
    const row: string[] = []

    while (true) {
      if (text[i] === '"') {
        i++
        let field = ''
        while (i < text.length) {
          if (text[i] === '"') {
            if (text[i + 1] === '"') { field += '"'; i += 2 }
            else { i++; break }
          } else {
            field += text[i++]
          }
        }
        row.push(field)
      } else {
        let field = ''
        while (i < text.length && text[i] !== ',' && text[i] !== '\n') {
          field += text[i++]
        }
        row.push(field.trimEnd())
      }

      if (i >= text.length || text[i] === '\n') { i++; break }
      i++ // skip ','
    }

    if (!(row.length === 1 && row[0] === '')) rows.push(row)
  }

  return rows
}

export function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const allRows = parseCsvAll(normalized)
  if (allRows.length === 0) return { headers: [], rows: [] }

  const headers = allRows[0].map(h => h.trim().toLowerCase())
  const dataRows: Record<string, string>[] = []

  for (let i = 1; i < allRows.length; i++) {
    if (allRows[i].length === 0) continue
    const obj: Record<string, string> = {}
    for (let j = 0; j < headers.length; j++) {
      // Truncate fields exceeding the per-field cap to keep rawSnapshot bounded.
      const raw = allRows[i][j]?.trim() ?? ''
      obj[headers[j]] = raw.length > MAX_FIELD_LEN ? raw.slice(0, MAX_FIELD_LEN) : raw
    }
    dataRows.push(obj)
  }

  return { headers, rows: dataRows }
}

// ── Decimal helpers ───────────────────────────────────────────────────────────

// Parse a string as a positive Decimal (> 0). Returns null on failure.
// Always uses the string constructor to avoid float representation artefacts.
function parsePositiveDecimal(val: string): Prisma.Decimal | null {
  const trimmed = val?.trim()
  if (!trimmed) return null
  try {
    const d = new Prisma.Decimal(trimmed)
    return d.gt(new Prisma.Decimal('0')) ? d : null
  } catch {
    return null
  }
}

// Parse a string as a non-negative Decimal (>= 0). Returns null on failure.
function parseNonNegDecimal(val: string): Prisma.Decimal | null {
  const trimmed = val?.trim()
  if (!trimmed) return null
  try {
    const d = new Prisma.Decimal(trimmed)
    return d.gte(new Prisma.Decimal('0')) ? d : null
  } catch {
    return null
  }
}

function parseOptionalDate(val: string): Date | null {
  if (!val?.trim()) return null
  const d = new Date(val.trim())
  return isNaN(d.getTime()) ? null : d
}

// ── Row validation ────────────────────────────────────────────────────────────

export type ValidatedRow = {
  observationType: 'sold' | 'active_ask'
  title: string
  price: Prisma.Decimal
  currency: string
  totalPrice: Prisma.Decimal         // price + (shippingPrice ?? 0), or admin-provided total_price
  externalId: string | null
  sourceUrl: string | null
  shippingPrice: Prisma.Decimal | null
  soldAt: Date | null
  listedAt: Date | null
  observedAt: Date
  condition: string | null
  locationText: string | null
  rawSnapshot: Record<string, string>
}

export function validateRow(
  row: Record<string, string>,
  importTime: Date,
): { ok: true; data: ValidatedRow } | { ok: false; reason: string } {
  for (const col of REQUIRED_COLUMNS) {
    if (!row[col]) return { ok: false, reason: `Missing required column: ${col}` }
  }

  const observationType = row['observation_type'].toLowerCase()
  if (!VALID_OBSERVATION_TYPES.has(observationType)) {
    return { ok: false, reason: `Invalid observation_type: "${row['observation_type']}" — must be "sold" or "active_ask"` }
  }

  const title = row['title'].trim()
  if (title.length === 0 || title.length > 500) {
    return { ok: false, reason: 'Title must be 1–500 characters' }
  }

  const price = parsePositiveDecimal(row['price'])
  if (!price) return { ok: false, reason: `Invalid price: "${row['price']}"` }

  const currency = row['currency'].trim().toUpperCase()
  if (!/^[A-Z]{2,5}$/.test(currency)) {
    return { ok: false, reason: `Invalid currency: "${row['currency']}"` }
  }

  const sourceUrl = row['source_url']?.trim() || null
  if (sourceUrl && !sourceUrl.startsWith('https://')) {
    return { ok: false, reason: 'source_url must start with "https://"' }
  }

  let shippingPrice: Prisma.Decimal | null = null
  if (row['shipping_price']?.trim()) {
    shippingPrice = parseNonNegDecimal(row['shipping_price'])
    if (!shippingPrice) return { ok: false, reason: `Invalid shipping_price: "${row['shipping_price']}"` }
  }

  // totalPrice: use admin-provided total_price if present; otherwise compute price + shipping.
  // Decimal addition ensures no floating-point artefact (e.g. 19.99 + 4.95 = 24.9400 exactly).
  let totalPrice: Prisma.Decimal
  if (row['total_price']?.trim()) {
    const adminTotal = parsePositiveDecimal(row['total_price'])
    if (!adminTotal) return { ok: false, reason: `Invalid total_price: "${row['total_price']}"` }
    totalPrice = adminTotal
  } else {
    totalPrice = price.plus(shippingPrice ?? new Prisma.Decimal('0'))
  }

  const soldAt = parseOptionalDate(row['sold_at'] ?? '')
  if (row['sold_at']?.trim() && !soldAt) {
    return { ok: false, reason: `Invalid sold_at: "${row['sold_at']}"` }
  }

  const listedAt = parseOptionalDate(row['listed_at'] ?? '')
  if (row['listed_at']?.trim() && !listedAt) {
    return { ok: false, reason: `Invalid listed_at: "${row['listed_at']}"` }
  }

  const observedAtParsed = parseOptionalDate(row['observed_at'] ?? '')
  if (row['observed_at']?.trim() && !observedAtParsed) {
    return { ok: false, reason: `Invalid observed_at: "${row['observed_at']}"` }
  }

  return {
    ok: true,
    data: {
      observationType: observationType as 'sold' | 'active_ask',
      title,
      price,
      currency,
      totalPrice,
      externalId: row['external_id']?.trim() || null,
      sourceUrl,
      shippingPrice,
      soldAt,
      listedAt,
      observedAt: observedAtParsed ?? importTime,
      condition: row['condition']?.trim() || null,
      locationText: row['location_text']?.trim() || null,
      rawSnapshot: { ...row },
    },
  }
}

// ── Fingerprint ───────────────────────────────────────────────────────────────

function sha256hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex')
}

// Deterministic dedup identity.
// With externalId: namespace "extid" prevents collision with content-based keys.
// Without: content key includes price (4dp), currency, and key date.
export function computeFingerprint(provider: string, data: ValidatedRow): string {
  if (data.externalId) {
    return sha256hex(`extid:${provider}|${data.observationType}|${data.externalId}`)
  }
  const keyDate = data.soldAt ?? data.listedAt ?? data.observedAt
  const contentKey = [
    data.title.toLowerCase().trim(),
    data.price.toFixed(4),
    data.currency,
    keyDate.toISOString(),
  ].join('|')
  return sha256hex(`content:${provider}|${data.observationType}|${contentKey}`)
}

export function computeImportHash(csvText: string): string {
  return sha256hex(csvText)
}

// ── Ingestion ─────────────────────────────────────────────────────────────────

export async function ingestCsvImport(
  csvText: string,
  provider: string,
  fileName: string | null,
  adminInfo: string | null,
): Promise<ImportBatchResult> {
  // Enforce file size limit before hashing or parsing.
  if (Buffer.byteLength(csvText, 'utf8') > MAX_CSV_BYTES) {
    throw new Error(`CSV exceeds the maximum size of ${MAX_CSV_BYTES / 1024 / 1024} MB`)
  }

  const importHash = computeImportHash(csvText)

  const existingBatch = await prisma.externalMarketImportBatch.findUnique({ where: { importHash } })
  if (existingBatch) {
    throw new Error(`This CSV has already been imported (batch ${existingBatch.id})`)
  }

  const { headers, rows } = parseCsv(csvText)

  if (headers.length === 0) {
    throw new Error('CSV is empty or has no headers')
  }

  const missingRequired = REQUIRED_COLUMNS.filter(c => !headers.includes(c))
  if (missingRequired.length > 0) {
    throw new Error(`CSV is missing required columns: ${missingRequired.join(', ')}`)
  }

  // Enforce row count limit before processing.
  if (rows.length > MAX_ROW_COUNT) {
    throw new Error(`CSV exceeds maximum of ${MAX_ROW_COUNT} rows (found ${rows.length})`)
  }

  const importTime = new Date()

  const batch = await prisma.externalMarketImportBatch.create({
    data: {
      provider,
      sourceType: 'csv_manual',
      originalFileName: fileName,
      importHash,
      rowCount: rows.length,
      adminInfo,
    },
  })

  const rowResults: ImportRowResult[] = []
  let importedCount  = 0
  let duplicateCount = 0
  let errorCount     = 0

  for (let idx = 0; idx < rows.length; idx++) {
    const rowIndex = idx + 1
    const raw = rows[idx]
    const validation = validateRow(raw, importTime)

    if (!validation.ok) {
      rowResults.push({ rowIndex, status: 'error', reason: validation.reason })
      errorCount++
      continue
    }

    const data = validation.data
    const fingerprint = computeFingerprint(provider, data)

    // Pre-flight uniqueness check (optimistic; DB constraint is the authoritative guard).
    const existingByFp = await prisma.externalMarketObservation.findUnique({ where: { fingerprint } })
    if (existingByFp) {
      rowResults.push({ rowIndex, status: 'duplicate', reason: `Duplicate fingerprint (observation ${existingByFp.id})` })
      duplicateCount++
      continue
    }

    if (data.externalId) {
      const existingByExtId = await prisma.externalMarketObservation.findFirst({
        where: { provider, externalId: data.externalId },
      })
      if (existingByExtId) {
        rowResults.push({ rowIndex, status: 'duplicate', reason: `Duplicate external ID (observation ${existingByExtId.id})` })
        duplicateCount++
        continue
      }
    }

    try {
      const obs = await prisma.externalMarketObservation.create({
        data: {
          importBatchId: batch.id,
          provider,
          externalId:   data.externalId,
          fingerprint,
          observationType: data.observationType,
          matchStatus: 'unmatched',
          title:      data.title,
          sourceUrl:  data.sourceUrl,
          currency:   data.currency,
          // Store with 4dp precision, rounded half-up.
          price:         data.price.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP),
          shippingPrice: data.shippingPrice
            ? data.shippingPrice.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP)
            : null,
          totalPrice: data.totalPrice.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP),
          soldAt:    data.soldAt,
          listedAt:  data.listedAt,
          observedAt: data.observedAt,
          condition:   data.condition,
          locationText: data.locationText,
          rawSnapshot:  data.rawSnapshot,
        },
      })
      rowResults.push({ rowIndex, status: 'imported', observationId: obs.id })
      importedCount++
    } catch (e) {
      // Catch DB-level unique constraint violations (concurrent duplicate import).
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        rowResults.push({ rowIndex, status: 'duplicate', reason: 'Concurrent duplicate detected by database' })
        duplicateCount++
      } else {
        const msg = e instanceof Error ? e.message : 'Unknown error'
        rowResults.push({ rowIndex, status: 'error', reason: `DB error: ${msg}` })
        errorCount++
      }
    }
  }

  // Finalize batch counts. Invariant: rowCount === importedCount + duplicateCount + errorCount.
  await prisma.externalMarketImportBatch.update({
    where: { id: batch.id },
    data: { importedCount, duplicateCount, errorCount },
  })

  return { batchId: batch.id, rowCount: rows.length, importedCount, duplicateCount, errorCount, rows: rowResults }
}
