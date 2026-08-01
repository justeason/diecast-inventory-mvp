import Link from 'next/link'
import { prisma } from '@/lib/prisma'
import {
  deriveIntakeOperations,
  deriveIntakeWarnings,
  INTAKE_STAGE_LABELS,
  INTAKE_WARNING_LABELS,
  type IntakeOperationalStage,
  type IntakeWarning,
  type IntakeRecord,
} from '@/lib/intakeOperations'
import { BulkStorageAssignForm } from '@/components/admin/BulkStorageAssignForm'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 100
// Rows fetched per DB round-trip when chunked scanning is active.
// Larger values reduce round-trips at the cost of more rows discarded per chunk.
const CHUNK_SIZE = 200

const STAGE_COLORS: Record<IntakeOperationalStage, string> = {
  expected:         'bg-gray-100 text-gray-600',
  received:         'bg-blue-100 text-blue-700',
  in_review:        'bg-amber-100 text-amber-700',
  ready_to_convert: 'bg-green-100 text-green-700',
  action_required:  'bg-red-100 text-red-700',
  rejected:         'bg-red-50 text-red-500',
  converted:        'bg-green-50 text-green-600',
  returned:         'bg-purple-100 text-purple-700',
  closed:           'bg-gray-50 text-gray-400',
}

const SECTION_ORDER: IntakeOperationalStage[] = [
  'action_required',
  'ready_to_convert',
  'received',
  'in_review',
  'expected',
  'converted',
  'returned',
  'rejected',
]

const AGE_BUCKETS = [
  { label: 'All ages', value: '' },
  { label: '< 7 days', value: 'fresh' },
  { label: '7–30 days', value: 'aging' },
  { label: '> 30 days', value: 'stale' },
]

// Warnings that qualify a row for the "attention" filter
const ATTENTION_WARNINGS: IntakeWarning[] = [
  'stale_received', 'stale_reviewed', 'converted_no_item', 'rejected_with_item', 'returned_with_listing',
]

// Shared select shape for IntakeDraft queries
const DRAFT_SELECT = {
  id: true,
  status: true,
  brand: true,
  name: true,
  receivedAt: true,
  receivedQuantity: true,
  expectedQuantity: true,
  storageLocationId: true,
  intakeLocation: { select: { label: true } },
  convertedItemId: true,
  convertedItem: { select: { id: true, listing: { select: { status: true } } } },
  sellerSubmissionId: true,
  sellerSubmission: {
    select: {
      id: true,
      status: true,
      quantity: true,
      brand: true,
      name: true,
      catalogId: true,
      profile: { select: { sellerProfile: { select: { displayName: true } } } },
      agreements: { select: { id: true, type: true, status: true } },
      lifecycleCases: {
        select: { status: true, caseType: true, intakeDraftId: true, returnedAt: true },
      },
    },
  },
  createdAt: true,
} as const

export default async function IntakeOperationsPage({
  searchParams,
}: {
  searchParams: Promise<{
    stage?: string
    seller?: string
    ageBucket?: string
    storageStatus?: string
    agreementType?: string
    catalogMatch?: string
    attention?: string
    page?: string
    showAll?: string
  }>
}) {
  const {
    stage, seller, ageBucket, storageStatus, agreementType,
    catalogMatch, attention, page, showAll,
  } = await searchParams
  const now = new Date()
  const sevenDaysAgo  = new Date(now.getTime() - 7  * 86_400_000)
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86_400_000)
  const threeDaysAgo  = new Date(now.getTime() - 3  * 86_400_000)
  const pageNum = Math.max(1, parseInt(page ?? '1', 10) || 1)
  const skip = (pageNum - 1) * PAGE_SIZE

  // ── DB-level filter clauses (applied to IntakeDraft queries) ─────────────────
  const storageWhere =
    storageStatus === 'assigned'   ? { storageLocationId: { not: null } }
    : storageStatus === 'unassigned' ? { storageLocationId: null }
    : {}

  const draftSellerWhere = seller?.trim()
    ? { sellerSubmission: { profile: { sellerProfile: { displayName: { contains: seller.trim(), mode: 'insensitive' as const } } } } }
    : {}

  const draftAgreementWhere =
    agreementType === 'buyout'
      ? { sellerSubmission: { agreements: { some: { type: 'buyout', status: 'accepted' } } } }
      : agreementType === 'consignment'
      ? { sellerSubmission: { agreements: { some: { type: 'consignment', status: 'accepted' } } } }
      : {}

  // ageBucket uses createdAt as stable proxy reference date
  const ageBucketWhere =
    ageBucket === 'fresh' ? { createdAt: { gte: sevenDaysAgo } }
    : ageBucket === 'aging' ? { createdAt: { gte: thirtyDaysAgo, lt: sevenDaysAgo } }
    : ageBucket === 'stale' ? { createdAt: { lt: thirtyDaysAgo } }
    : {}

  const draftCatalogMatchWhere =
    catalogMatch === 'linked'
      ? { sellerSubmission: { catalogId: { not: null } } }
      : catalogMatch === 'unlinked'
      ? { sellerSubmissionId: { not: null }, sellerSubmission: { catalogId: null } }
      : {}

  // Attention pre-filter: narrows DB candidates before in-memory refinement
  const attentionWhere = attention
    ? {
        OR: [
          { status: 'rejected' as const, sellerSubmission: { lifecycleCases: { some: { status: { in: ['open', 'action_required'] }, caseType: 'intake_rejection' } } } },
          { status: 'draft' as const, receivedAt: { lt: sevenDaysAgo } },
          { status: 'reviewed' as const, receivedAt: { lt: threeDaysAgo } },
          { status: 'converted' as const, convertedItemId: null },
          { status: 'rejected' as const, convertedItemId: { not: null } },
        ],
      }
    : {}

  // Active-status OR clause (determines which drafts appear at all)
  const statusOr: object[] = [
    { status: { in: ['draft', 'reviewed'] } },
    { status: 'converted', createdAt: { gte: thirtyDaysAgo } },
    {
      status: 'rejected',
      sellerSubmission: { lifecycleCases: { some: { status: { in: ['open', 'action_required'] } } } },
    },
  ]
  if (showAll) statusOr.push({ status: 'rejected' })

  // ── DB-level filter clauses (applied to SellerSubmission / pending) ──────────
  const pendingSellerWhere = seller?.trim()
    ? { profile: { sellerProfile: { displayName: { contains: seller.trim(), mode: 'insensitive' as const } } } }
    : {}
  const pendingAgreementWhere =
    agreementType === 'buyout'
      ? { agreements: { some: { type: 'buyout', status: 'accepted' } } }
      : agreementType === 'consignment'
      ? { agreements: { some: { type: 'consignment', status: 'accepted' } } }
      : agreementType === 'none'
      ? { agreements: { none: { status: 'accepted' } } }
      : {}
  const pendingCatalogMatchWhere =
    catalogMatch === 'linked'   ? { catalogId: { not: null } }
    : catalogMatch === 'unlinked' ? { catalogId: null }
    : {}

  // ── Helpers (close over `now` for derived computations) ─────────────────────
  type DraftPayload = Awaited<ReturnType<typeof prisma.intakeDraft.findMany<{ select: typeof DRAFT_SELECT }>>>[number]

  function makeRecord(draft: DraftPayload): IntakeRecord {
    return {
      submission: draft.sellerSubmission
        ? {
            id: draft.sellerSubmission.id,
            status: draft.sellerSubmission.status,
            quantity: draft.sellerSubmission.quantity,
            catalogId: draft.sellerSubmission.catalogId ?? null,
            agreements: draft.sellerSubmission.agreements,
            lifecycleCases: draft.sellerSubmission.lifecycleCases,
            createdAt: draft.createdAt,
          }
        : null,
      intake: {
        id: draft.id,
        status: draft.status,
        receivedAt: draft.receivedAt,
        receivedQuantity: draft.receivedQuantity,
        expectedQuantity: draft.expectedQuantity,
        storageLocationId: draft.storageLocationId,
        convertedItemId: draft.convertedItemId,
        hasActiveListing: draft.convertedItem?.listing?.status === 'active',
        createdAt: draft.createdAt,
      },
      now,
    }
  }

  function makeDraftRow(draft: DraftPayload) {
    return {
      draft,
      ops: deriveIntakeOperations(makeRecord(draft)),
      sellerName: draft.sellerSubmission?.profile?.sellerProfile?.displayName ?? null,
      itemLabel: [draft.brand, draft.name].filter(Boolean).join(' ') || 'Untitled',
      hasCatalog: !!(draft.sellerSubmission?.catalogId),
    }
  }

  function passesInMemoryFilters(row: ReturnType<typeof makeDraftRow>): boolean {
    if (stage && row.ops.stage !== stage) return false
    if (attention) {
      const needsAttention =
        row.ops.stage === 'action_required' ||
        row.ops.warnings.some((w) => ATTENTION_WARNINGS.includes(w))
      if (!needsAttention) return false
    }
    if (
      agreementType === 'none' &&
      row.draft.sellerSubmission != null &&
      row.draft.sellerSubmission.agreements.some((a) => a.status === 'accepted')
    ) {
      return false
    }
    return true
  }

  // Builds the WHERE for IntakeDraft queries, appending a keyset cursor condition
  // when provided. Stable ordering: createdAt DESC, id DESC.
  function buildDraftWhere(cursor: { createdAt: Date; id: string } | null) {
    const clauses: object[] = [
      storageWhere,
      draftSellerWhere,
      draftAgreementWhere,
      ageBucketWhere,
      draftCatalogMatchWhere,
      attentionWhere,
      { OR: statusOr },
    ]
    if (cursor) {
      clauses.push({
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } },
        ],
      })
    }
    return { AND: clauses }
  }

  // ── Query: active drafts ─────────────────────────────────────────────────────
  const hasInMemoryFilter = !!(stage || attention || agreementType === 'none')

  type DraftRow = ReturnType<typeof makeDraftRow>
  let rows: DraftRow[] = []
  let hasNextPage = false

  if (hasInMemoryFilter) {
    // Chunked scanning: scan ordered chunks using a keyset cursor until we have
    // enough filtered rows for the requested page + hasNextPage signal.
    // No fixed ceiling — scanning continues until data is exhausted.
    const needed = pageNum * PAGE_SIZE + 1
    const allRows: DraftRow[] = []
    let cursorCreatedAt: Date | null = null
    let cursorId: string | null = null

    scan: while (allRows.length < needed) {
      const chunkCursor: { createdAt: Date; id: string } | null =
        cursorCreatedAt && cursorId ? { createdAt: cursorCreatedAt, id: cursorId } : null
      const chunk: DraftPayload[] = await prisma.intakeDraft.findMany({
        where: buildDraftWhere(chunkCursor),
        select: DRAFT_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: CHUNK_SIZE,
      })

      if (chunk.length === 0) break scan

      for (const draft of chunk) {
        const row = makeDraftRow(draft)
        if (passesInMemoryFilters(row)) {
          allRows.push(row)
          if (allRows.length >= needed) break scan
        }
      }

      if (chunk.length < CHUNK_SIZE) break scan
      cursorCreatedAt = chunk[chunk.length - 1].createdAt
      cursorId = chunk[chunk.length - 1].id
    }

    rows = allRows.slice(skip, skip + PAGE_SIZE)
    hasNextPage = allRows.length > pageNum * PAGE_SIZE
  } else {
    // All filters are DB-level: standard offset pagination (one query)
    const dbRows = await prisma.intakeDraft.findMany({
      where: buildDraftWhere(null),
      select: DRAFT_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: PAGE_SIZE,
      skip,
    })
    rows = dbRows.map(makeDraftRow)
    hasNextPage = dbRows.length === PAGE_SIZE
  }

  // ── Query: pending submissions (approved, no active intake) ──────────────────
  // Only fetch if stage filter is absent or explicitly set to 'expected'.
  // Apply the same active filters so pending rows respect all filter params.
  const shouldFetchPending = !stage || stage === 'expected'
  const pendingSubmissions = shouldFetchPending
    ? await prisma.sellerSubmission.findMany({
        where: {
          status: 'approved_for_intake',
          intakeDrafts: { none: { status: { in: ['draft', 'reviewed'] } } },
          ...pendingSellerWhere,
          ...pendingAgreementWhere,
          ...ageBucketWhere,
          ...pendingCatalogMatchWhere,
        },
        select: {
          id: true,
          status: true,
          quantity: true,
          brand: true,
          name: true,
          catalogId: true,
          profile: { select: { sellerProfile: { select: { displayName: true } } } },
          agreements: { select: { id: true, type: true, status: true } },
          lifecycleCases: { select: { status: true, caseType: true, intakeDraftId: true, returnedAt: true } },
          createdAt: true,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 50,
      })
    : []

  type SubRow = (typeof pendingSubmissions)[number]
  const pendingRows = pendingSubmissions.map((sub: SubRow) => {
    const rec: IntakeRecord = {
      submission: {
        id: sub.id,
        status: sub.status,
        quantity: sub.quantity,
        catalogId: sub.catalogId ?? null,
        agreements: sub.agreements,
        lifecycleCases: sub.lifecycleCases,
        createdAt: sub.createdAt,
      },
      intake: null,
      now,
    }
    return {
      sub,
      sellerName: sub.profile?.sellerProfile?.displayName ?? null,
      itemLabel: [sub.brand, sub.name].filter(Boolean).join(' ') || 'Untitled',
      warnings: deriveIntakeWarnings(rec, 'expected'),
    }
  })

  // ── Grouping and summary ─────────────────────────────────────────────────────
  const grouped = new Map<IntakeOperationalStage, DraftRow[]>()
  for (const row of rows) {
    const s = row.ops.stage
    if (!grouped.has(s)) grouped.set(s, [])
    grouped.get(s)!.push(row)
  }

  const needsStorage = rows.filter(
    (r) =>
      (r.ops.stage === 'received' || r.ops.stage === 'in_review' || r.ops.stage === 'ready_to_convert') &&
      !r.draft.storageLocationId
  )

  const totalNeedsAttention =
    (grouped.get('action_required')?.length ?? 0) +
    rows.filter((r) => r.ops.warnings.some((w) => w === 'stale_received' || w === 'stale_reviewed')).length

  function buildHref(overrides: Record<string, string | undefined>) {
    const p = new URLSearchParams()
    const current: Record<string, string | undefined> = {
      stage, seller, ageBucket, storageStatus, agreementType, catalogMatch, attention, showAll,
    }
    const merged = { ...current, ...overrides }
    for (const [k, v] of Object.entries(merged)) {
      if (v) p.set(k, v)
    }
    return `/admin/intake/operations${p.size ? '?' + p.toString() : ''}`
  }

  const isFiltered = !!(stage || seller?.trim() || ageBucket || storageStatus || agreementType || catalogMatch || attention)

  return (
    <>
      <div className="mb-6 flex items-start justify-between">
        <div>
          <Link href="/admin/intake" className="text-sm text-gray-500 hover:text-gray-900">
            ← Back to Intake
          </Link>
          <h1 className="text-2xl font-bold text-gray-900 mt-2">Intake Operations</h1>
          <p className="text-sm text-gray-500 mt-1">
            {rows.length} draft{rows.length !== 1 ? 's' : ''}{' '}
            {pendingRows.length > 0 && `· ${pendingRows.length} pending`}
            {totalNeedsAttention > 0 && (
              <span className="ml-2 text-red-600 font-medium">{totalNeedsAttention} need attention</span>
            )}
          </p>
        </div>
      </div>

      {totalNeedsAttention > 0 && (
        <div className="mb-6 rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800">
          {totalNeedsAttention} item{totalNeedsAttention !== 1 ? 's' : ''} require attention.
        </div>
      )}

      {/* Filters */}
      <form method="GET" action="/admin/intake/operations" className="flex flex-wrap gap-2 mb-6">
        <select
          name="stage"
          defaultValue={stage ?? ''}
          className="rounded-md border border-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">All stages</option>
          {Object.entries(INTAKE_STAGE_LABELS).map(([key, label]) => (
            <option key={key} value={key}>{label}</option>
          ))}
        </select>

        <select
          name="ageBucket"
          defaultValue={ageBucket ?? ''}
          className="rounded-md border border-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {AGE_BUCKETS.map((b) => (
            <option key={b.value} value={b.value}>{b.label}</option>
          ))}
        </select>

        <select
          name="storageStatus"
          defaultValue={storageStatus ?? ''}
          className="rounded-md border border-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">Any storage</option>
          <option value="assigned">Storage assigned</option>
          <option value="unassigned">No storage</option>
        </select>

        <select
          name="agreementType"
          defaultValue={agreementType ?? ''}
          className="rounded-md border border-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">Any agreement</option>
          <option value="buyout">Buyout</option>
          <option value="consignment">Consignment</option>
          <option value="none">No accepted agreement</option>
        </select>

        <select
          name="catalogMatch"
          defaultValue={catalogMatch ?? ''}
          className="rounded-md border border-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">Any catalog status</option>
          <option value="linked">Catalog linked</option>
          <option value="unlinked">No catalog link</option>
        </select>

        <input
          type="text"
          name="seller"
          defaultValue={seller ?? ''}
          placeholder="Seller name…"
          className="rounded-md border border-gray-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />

        <label className="flex items-center gap-1.5 text-sm text-gray-600 cursor-pointer">
          <input type="checkbox" name="attention" value="1" defaultChecked={!!attention} />
          Needs attention
        </label>

        {showAll && <input type="hidden" name="showAll" value="1" />}

        <button
          type="submit"
          className="px-3 py-1.5 rounded-md bg-gray-800 text-white text-sm hover:bg-gray-900"
        >
          Filter
        </button>
        {isFiltered && (
          <Link
            href={`/admin/intake/operations${showAll ? '?showAll=1' : ''}`}
            className="px-3 py-1.5 rounded-md border border-gray-200 text-sm text-gray-600 hover:bg-gray-50"
          >
            Clear
          </Link>
        )}
        {!showAll && (
          <Link
            href={buildHref({ showAll: '1', page: undefined })}
            className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-900"
          >
            Show all rejected
          </Link>
        )}
      </form>

      {/* Pending submissions (approved, no intake created yet) */}
      {pendingRows.length > 0 && (
        <Section title="Expected — no intake started">
          {pendingRows.map(({ sub, sellerName, itemLabel, warnings }) => (
            <Row
              key={`sub-${sub.id}`}
              stage="expected"
              itemLabel={itemLabel}
              sellerName={sellerName}
              ageDays={Math.floor((now.getTime() - sub.createdAt.getTime()) / 86_400_000)}
              warnings={warnings}
              linkHref={`/admin/seller-submissions/${sub.id}`}
              linkLabel="Submission →"
              note={sub.catalogId ? 'Catalog: linked' : 'No catalog link'}
            />
          ))}
        </Section>
      )}

      {SECTION_ORDER.map((sectionStage) => {
        const sectionRows = grouped.get(sectionStage)
        if (!sectionRows || sectionRows.length === 0) return null
        return (
          <Section key={sectionStage} title={INTAKE_STAGE_LABELS[sectionStage]}>
            {sectionRows.map(({ draft, ops, sellerName, itemLabel, hasCatalog }) => (
              <Row
                key={draft.id}
                stage={sectionStage}
                itemLabel={itemLabel}
                sellerName={sellerName}
                ageDays={ops.ageDays}
                warnings={ops.warnings}
                linkHref={`/admin/intake/${draft.id}/edit`}
                linkLabel="Edit →"
                storageLabel={draft.intakeLocation?.label}
                note={
                  sectionStage === 'received' && draft.receivedQuantity != null
                    ? `Qty: ${draft.receivedQuantity}`
                    : sectionStage === 'converted' && draft.convertedItemId
                    ? 'Converted'
                    : hasCatalog
                    ? 'Catalog: linked'
                    : undefined
                }
                submissionHref={
                  draft.sellerSubmissionId
                    ? `/admin/seller-submissions/${draft.sellerSubmissionId}`
                    : undefined
                }
              />
            ))}
          </Section>
        )
      })}

      {rows.length === 0 && pendingRows.length === 0 && (
        <div className="rounded-md bg-gray-50 border border-gray-200 px-4 py-6 text-sm text-gray-500 text-center">
          No intake operations match the current filters.
        </div>
      )}

      {/* Pagination */}
      <div className="mt-4 flex gap-4">
        {pageNum > 1 && (
          <Link
            href={buildHref({ page: String(pageNum - 1) })}
            className="text-sm text-blue-600 hover:underline"
          >
            ← Previous
          </Link>
        )}
        {hasNextPage && (
          <Link
            href={buildHref({ page: String(pageNum + 1) })}
            className="text-sm text-blue-600 hover:underline"
          >
            Next →
          </Link>
        )}
        {pageNum > 1 && (
          <span className="text-xs text-gray-400">Page {pageNum}</span>
        )}
      </div>

      {/* Bulk storage assignment */}
      {needsStorage.length > 0 && (
        <div className="mt-8">
          <h2 className="text-lg font-semibold text-gray-900 mb-3">Bulk Storage Assignment</h2>
          <p className="text-sm text-gray-500 mb-4">
            {needsStorage.length} received/reviewing item{needsStorage.length !== 1 ? 's' : ''} without storage.
          </p>
          <BulkStorageAssignForm
            intakes={needsStorage.map((r) => ({
              id: r.draft.id,
              label: r.itemLabel + (r.sellerName ? ` (${r.sellerName})` : ''),
            }))}
          />
        </div>
      )}
    </>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-8">
      <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">{title}</h2>
      <div className="divide-y divide-gray-100 rounded-md border border-gray-200 bg-white">
        {children}
      </div>
    </div>
  )
}

function Row({
  stage,
  itemLabel,
  sellerName,
  ageDays,
  warnings,
  linkHref,
  linkLabel,
  storageLabel,
  note,
  submissionHref,
}: {
  stage: IntakeOperationalStage
  itemLabel: string
  sellerName: string | null
  ageDays: number
  warnings: IntakeWarning[]
  linkHref: string
  linkLabel: string
  storageLabel?: string | null
  note?: string
  submissionHref?: string
}) {
  return (
    <div className="flex items-center gap-4 px-4 py-3">
      <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${STAGE_COLORS[stage]}`}>
        {INTAKE_STAGE_LABELS[stage]}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-900 truncate">
          {itemLabel}
          {sellerName && <span className="ml-2 text-gray-400 font-normal">· {sellerName}</span>}
        </p>
        <p className="text-xs text-gray-500">
          {ageDays}d old
          {storageLabel && <span className="ml-2">· {storageLabel}</span>}
          {note && <span className="ml-2 text-gray-400">· {note}</span>}
        </p>
        {warnings.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {warnings.map((w) => (
              <span key={w} className="rounded-full bg-amber-100 text-amber-700 px-2 py-0.5 text-xs">
                {INTAKE_WARNING_LABELS[w] ?? w}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="shrink-0 flex gap-3 items-center">
        {submissionHref && (
          <Link href={submissionHref} className="text-xs text-gray-500 hover:text-gray-900">
            Submission
          </Link>
        )}
        <Link href={linkHref} className="text-sm font-medium text-blue-600 hover:underline">
          {linkLabel}
        </Link>
      </div>
    </div>
  )
}
