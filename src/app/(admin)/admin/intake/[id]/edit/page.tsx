import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { CatalogModel } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { IntakeDraftForm } from '@/components/admin/IntakeDraftForm'
import { ConvertDraftForm } from '@/components/admin/ConvertDraftForm'
import { ExtractPhotosButton } from '@/components/admin/ExtractPhotosButton'
import { IntakePhotoUpload } from '@/components/admin/IntakePhotoUpload'
import {
  updateIntakeDraft,
  markDraftReviewed,
  rejectDraft,
  convertDraft,
  extractDraftFields,
  uploadIntakePhoto,
} from '@/lib/actions/intake'

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  reviewed: 'Reviewed',
  converted: 'Converted',
  rejected: 'Rejected',
}

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-yellow-100 text-yellow-700',
  reviewed: 'bg-blue-100 text-blue-700',
  converted: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
}

const CONDITION_LABELS: Record<string, string> = {
  mint: 'Mint',
  near_mint: 'Near Mint',
  good: 'Good',
  fair: 'Fair',
  poor: 'Poor',
  damaged: 'Damaged',
}

// Only counts SKUs matching exactly HW-#### (4 digits).
const HW_SKU_RE = /^HW-(\d{4})$/

async function getSkuSuggestion(): Promise<string> {
  const items = await prisma.itemInstance.findMany({
    where: { sku: { startsWith: 'HW-' } },
    select: { sku: true },
  })
  const nums = items
    .map((i) => {
      const m = HW_SKU_RE.exec(i.sku)
      return m ? parseInt(m[1], 10) : NaN
    })
    .filter((n): n is number => !isNaN(n))
  const max = nums.length > 0 ? Math.max(...nums) : 0
  return `HW-${String(max + 1).padStart(4, '0')}`
}

function buildListingTitle(draft: {
  brand: string | null
  name: string | null
  year: number | null
  color: string | null
}): string {
  const parts: string[] = []
  if (draft.brand) parts.push(draft.brand)
  if (draft.name) parts.push(draft.name)
  if (draft.year) parts.push(`(${draft.year})`)
  if (draft.color) parts.push(`— ${draft.color}`)
  return parts.join(' ')
}

export default async function EditIntakeDraftPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  const [draft, suggestedSku] = await Promise.all([
    prisma.intakeDraft.findUnique({
      where: { id },
      include: { convertedItem: { select: { id: true, sku: true, listing: { select: { id: true } } } } },
    }),
    getSkuSuggestion(),
  ])
  if (!draft) notFound()

  // For the conversion panel: fetch catalog match info when the draft is reviewed and has brand+name.
  let exactCatalogMatch: CatalogModel | null = null
  let similarCatalogModels: CatalogModel[] = []
  if (draft.status === 'reviewed' && draft.brand?.trim() && draft.name?.trim()) {
    const brand = draft.brand.trim()
    const name = draft.name.trim()
    const [exactMatch, allSimilar] = await Promise.all([
      prisma.catalogModel.findFirst({
        where: {
          brand,
          name,
          year:   draft.year          ?? null,
          series: draft.series?.trim() || null,
          color:  draft.color?.trim()  || null,
          scale:  draft.scale?.trim()  || null,
        },
      }),
      prisma.catalogModel.findMany({
        where: { brand, name },
        orderBy: [{ year: 'desc' }, { color: 'asc' }],
        take: 10,
      }),
    ])
    exactCatalogMatch = exactMatch
    similarCatalogModels = exactMatch
      ? allSimilar.filter((m) => m.id !== exactMatch.id)
      : allSimilar
  }

  const isTerminal = draft.status === 'converted' || draft.status === 'rejected'

  const updateAction      = updateIntakeDraft.bind(null, id)
  const reviewAction      = markDraftReviewed.bind(null, id)
  const rejectAction      = rejectDraft.bind(null, id)
  const convertAction     = convertDraft.bind(null, id)
  const extractAction     = extractDraftFields.bind(null, id)
  const uploadFrontAction = uploadIntakePhoto.bind(null, id, 'front')
  const uploadBackAction  = uploadIntakePhoto.bind(null, id, 'back')

  const frontUrl = draft.frontPhotoUrl ?? null
  const backUrl  = draft.backPhotoUrl  ?? null

  const suggestedTitle = buildListingTitle(draft)
  const suggestedPrice = draft.listPrice ?? null

  return (
    <>
      <div className="mb-6">
        <Link href="/admin/intake" className="text-sm text-gray-500 hover:text-gray-900">
          ← Back to Intake
        </Link>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">
          {isTerminal ? 'Intake Draft' : 'Edit Intake Draft'}
        </h1>
        <span
          className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-medium ${STATUS_COLORS[draft.status] ?? 'bg-gray-100 text-gray-600'}`}
        >
          {STATUS_LABELS[draft.status] ?? draft.status}
        </span>
      </div>

      {/* Converted: link to created item */}
      {draft.status === 'converted' && draft.convertedItem && (
        <div className="mb-6 rounded-md bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-800">
          Converted to item{' '}
          <Link
            href={`/admin/items/${draft.convertedItem.id}/edit`}
            className="font-medium underline hover:no-underline"
          >
            {draft.convertedItem.sku}
          </Link>
          {draft.convertedItem.listing && (
            <>
              {' '}·{' '}
              <Link
                href={`/admin/listings/${draft.convertedItem.listing.id}/edit`}
                className="font-medium underline hover:no-underline"
              >
                View Listing →
              </Link>
            </>
          )}
          .
        </div>
      )}

      {/* Rejected notice */}
      {draft.status === 'rejected' && (
        <div className="mb-6 rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800">
          This draft has been rejected and cannot be edited or converted.
        </div>
      )}

      {isTerminal ? (
        /* ── Terminal: read-only view ─────────────────────────────────────── */
        <div className="max-w-2xl space-y-4">
          {/* Read-only photo previews */}
          {(frontUrl || backUrl) && (
            <div className="flex flex-wrap gap-4">
              {frontUrl && (
                <div className="flex flex-col gap-1">
                  <p className="text-xs text-gray-500">Front</p>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={frontUrl}
                    alt="Front photo"
                    className="max-h-48 w-auto rounded-md border border-gray-200 object-contain bg-gray-50"
                  />
                </div>
              )}
              {backUrl && (
                <div className="flex flex-col gap-1">
                  <p className="text-xs text-gray-500">Back</p>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={backUrl}
                    alt="Back photo"
                    className="max-h-48 w-auto rounded-md border border-gray-200 object-contain bg-gray-50"
                  />
                </div>
              )}
            </div>
          )}

          {/* Field grid */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-md border border-gray-200 bg-gray-50 p-4 text-sm text-gray-700">
            <Field label="Brand" value={draft.brand} />
            <Field label="Name" value={draft.name} />
            <Field label="Year" value={draft.year?.toString()} />
            <Field label="Series" value={draft.series} />
            <Field label="Color" value={draft.color} />
            <Field label="Scale" value={draft.scale} />
            <Field label="Type" value={draft.cardedOrLoose} />
            <Field
              label="Condition"
              value={draft.condition ? (CONDITION_LABELS[draft.condition] ?? draft.condition) : null}
            />
            <Field label="Condition Notes" value={draft.conditionNotes} />
            <Field
              label="List Price"
              value={draft.listPrice != null ? `$${draft.listPrice.toFixed(2)}` : null}
            />
            <Field label="Storage Location" value={draft.storageLocation} />
            <Field label="Notes" value={draft.notes} />
          </div>

          {/* AI extraction notes */}
          {draft.aiExtractionNotes && (
            <details className="text-xs text-gray-500 rounded-md border border-gray-200 bg-gray-50 px-4 py-3">
              <summary className="cursor-pointer font-medium text-gray-600">
                AI extraction notes
              </summary>
              <p className="mt-2">{draft.aiExtractionNotes}</p>
              {draft.aiExtractionConfidence != null && (
                <p className="mt-1">
                  Confidence: {(draft.aiExtractionConfidence * 100).toFixed(0)}%
                </p>
              )}
            </details>
          )}
        </div>
      ) : (
        /* ── Editable: upload + form + actions ────────────────────────────── */
        <div className="max-w-2xl space-y-8">
          {/* Photo upload */}
          <div>
            <h2 className="text-sm font-semibold text-gray-700 mb-4">Photos</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
              <IntakePhotoUpload
                label="Front Photo"
                currentUrl={frontUrl}
                action={uploadFrontAction}
              />
              <IntakePhotoUpload
                label="Back Photo"
                currentUrl={backUrl}
                action={uploadBackAction}
              />
            </div>
          </div>

          {/* AI extraction */}
          <div>
            {frontUrl ? (
              <div className="space-y-2">
                <ExtractPhotosButton action={extractAction} />
                {draft.aiExtractionNotes && (
                  <details className="text-xs text-gray-500 rounded-md border border-gray-200 bg-gray-50 px-4 py-3">
                    <summary className="cursor-pointer font-medium text-gray-600">
                      Last AI extraction notes
                    </summary>
                    <p className="mt-2">{draft.aiExtractionNotes}</p>
                    {draft.aiExtractionConfidence != null && (
                      <p className="mt-1">
                        Confidence: {(draft.aiExtractionConfidence * 100).toFixed(0)}%
                      </p>
                    )}
                  </details>
                )}
              </div>
            ) : (
              <p className="text-xs text-gray-400 italic">
                Upload a front photo above to enable AI field extraction.
              </p>
            )}
          </div>

          {/* Draft fields form */}
          <IntakeDraftForm
            action={updateAction}
            defaultValues={draft}
            submitLabel="Save Changes"
          />

          {/* Status actions */}
          <div className="pt-6 border-t border-gray-200 space-y-6">
            {draft.status === 'draft' && (
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-2">Mark as Reviewed</h3>
                <p className="text-xs text-gray-500 mb-3">
                  Confirm you have inspected the item and the information above is correct.
                </p>
                <form action={reviewAction}>
                  <button
                    type="submit"
                    className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
                  >
                    Mark Reviewed
                  </button>
                </form>
              </div>
            )}

            {draft.status === 'reviewed' && (
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-2">Convert to Item</h3>
                <p className="text-xs text-gray-500 mb-3">
                  Creates a CatalogModel (or reuses an existing match), a new ItemInstance, and
                  Photo records. Optionally creates an active Listing in the same transaction.
                </p>
                <ConvertDraftForm
                  action={convertAction}
                  suggestedSku={suggestedSku}
                  suggestedTitle={suggestedTitle || undefined}
                  suggestedPrice={suggestedPrice}
                  exactCatalogMatch={exactCatalogMatch}
                  similarCatalogModels={similarCatalogModels}
                />
              </div>
            )}

            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-2">Reject Draft</h3>
              <p className="text-xs text-gray-500 mb-3">
                Marks this draft as rejected. This cannot be undone.
              </p>
              <form action={rejectAction}>
                <button
                  type="submit"
                  className="rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 transition-colors"
                >
                  Reject Draft
                </button>
              </form>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function Field({ label, value }: { label: string; value?: string | null }) {
  return (
    <div>
      <span className="text-xs text-gray-500">{label}</span>
      <p className="font-medium">{value ?? '—'}</p>
    </div>
  )
}
