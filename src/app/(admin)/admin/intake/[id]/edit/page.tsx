import Link from 'next/link'
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { IntakeDraftForm } from '@/components/admin/IntakeDraftForm'
import { ConvertDraftForm } from '@/components/admin/ConvertDraftForm'
import { ExtractPhotosButton } from '@/components/admin/ExtractPhotosButton'
import {
  updateIntakeDraft,
  markDraftReviewed,
  rejectDraft,
  convertDraft,
  extractDraftFields,
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

export default async function EditIntakeDraftPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  const draft = await prisma.intakeDraft.findUnique({
    where: { id },
    include: { convertedItem: { select: { id: true, sku: true } } },
  })
  if (!draft) notFound()

  const isTerminal = draft.status === 'converted' || draft.status === 'rejected'

  const updateAction = updateIntakeDraft.bind(null, id)
  const reviewAction = markDraftReviewed.bind(null, id)
  const rejectAction = rejectDraft.bind(null, id)
  const convertAction = convertDraft.bind(null, id)
  const extractAction = extractDraftFields.bind(null, id)

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

      {/* Converted: show link to the created item */}
      {draft.status === 'converted' && draft.convertedItem && (
        <div className="mb-6 rounded-md bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-800">
          Converted to item{' '}
          <Link
            href={`/admin/items/${draft.convertedItem.id}/edit`}
            className="font-medium underline hover:no-underline"
          >
            {draft.convertedItem.sku}
          </Link>
          .
        </div>
      )}

      {/* Rejected notice */}
      {draft.status === 'rejected' && (
        <div className="mb-6 rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800">
          This draft has been rejected and cannot be edited or converted.
        </div>
      )}

      {/* Read-only summary for terminal drafts */}
      {isTerminal ? (
        <div className="max-w-2xl space-y-4">
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
              value={
                draft.condition
                  ? (CONDITION_LABELS[draft.condition] ?? draft.condition)
                  : null
              }
            />
            <Field label="Condition Notes" value={draft.conditionNotes} />
            <Field
              label="List Price"
              value={draft.listPrice != null ? `$${draft.listPrice.toFixed(2)}` : null}
            />
            <Field label="Storage Location" value={draft.storageLocation} />
            <Field label="Notes" value={draft.notes} />
            {draft.frontPhotoUrl && <Field label="Front Photo" value={draft.frontPhotoUrl} />}
            {draft.backPhotoUrl && <Field label="Back Photo" value={draft.backPhotoUrl} />}
          </div>

          {/* AI extraction metadata for terminal drafts (read-only) */}
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
        /* Editable form for draft / reviewed */
        <div className="max-w-2xl space-y-6">
          {/* AI extraction section — shown only when frontPhotoUrl is set */}
          {draft.frontPhotoUrl ? (
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
              Add a front photo URL above to enable AI field extraction.
            </p>
          )}

          <IntakeDraftForm
            action={updateAction}
            defaultValues={draft}
            submitLabel="Save Changes"
          />

          {/* Action buttons */}
          <div className="pt-6 border-t border-gray-200 space-y-6">
            {/* Mark Reviewed — only when still draft */}
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

            {/* Convert — only when reviewed */}
            {draft.status === 'reviewed' && (
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-2">Convert to Item</h3>
                <p className="text-xs text-gray-500 mb-3">
                  Creates a CatalogModel (or reuses an existing match), a new ItemInstance, and
                  Photo records. Enter a unique SKU to proceed.
                </p>
                <ConvertDraftForm action={convertAction} />
              </div>
            )}

            {/* Reject */}
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
