// 15D-review section 1: the ONE authoritative IntakeDraft → ItemInstance conversion
// primitive. Both the manual admin intake flow (actions/intake.ts convertDraft) and
// the bulk intake workbench (actions/intakeWorkbench.ts confirmWorkbenchItem) call
// this — neither reimplements draft-status gating, commercial-provenance resolution,
// catalog resolution, SKU handling, buyout payout-line creation, shipment/portfolio/
// agreement lineage, or the converted-status/linkage write. This function does NOT
// open its own transaction or acquire its own top-level lock ordering (submission vs.
// shipment locking is caller-specific) — it expects to run inside a transaction the
// caller already opened, and owns only the final "lock + convert this specific draft"
// step, which is the last lock in both callers' canonical ordering.

import { Prisma } from '@prisma/client'
import { resolveConversionEligibility, validateConversionConfirmation } from '@/lib/sellerAgreementInventory'
import { buildBuyoutSourceKey, calculateBuyoutPayoutSnapshot } from '@/lib/sellerPayoutCalculation'

type TxClient = Prisma.TransactionClient

function trimOrNull(v: string | null | undefined): string | null {
  const t = v?.trim()
  return t || null
}

const HW_SKU_RE = /^HW-(\d+)$/

// Bounded (O(1)) SKU generator — a single `orderBy desc, take 1` lookup, not the
// legacy full-table `getNextHwSku()` scan. Relies on ItemInstance.sku's existing
// @unique constraint + the caller's outer P2002 handling for the rare concurrent-
// collision case; a losing conversion simply fails cleanly and can be retried.
export async function generateNextIntakeSku(tx: TxClient): Promise<string> {
  const latest = await tx.itemInstance.findFirst({
    where: { sku: { startsWith: 'HW-' } },
    orderBy: { sku: 'desc' },
    select: { sku: true },
  })
  const match = latest ? HW_SKU_RE.exec(latest.sku) : null
  const next = (match ? parseInt(match[1], 10) : 0) + 1
  return `HW-${String(next).padStart(4, '0')}`
}

export type ConvertIntakeDraftOptions = {
  draftId: string
  locationId: string
  // Manual flow lets the admin pick (or change) an exact CatalogModel at conversion
  // time via a form field, independent of anything pre-stored on the draft. When
  // provided this takes precedence over draft.catalogModelId; the workbench instead
  // pre-resolves and stores catalogModelId on the draft itself at creation time, so it
  // never needs to pass this. Falls back to legacy fuzzy brand/name match-or-create
  // when neither is set.
  catalogModelId?: string | null
  // Provided (manual flow, admin-typed, pre-validated for uniqueness) or omitted
  // (workbench — auto-generated here via generateNextIntakeSku).
  sku?: string
  // Manual-flow-only commercial confirmation gate. Omit entirely (both undefined) to
  // skip the check — used by the workbench, where batch-level agreement acceptance
  // already establishes consent once for the whole shipment, not per physical unit.
  confirmBuyout?: boolean
  confirmConsignment?: boolean
}

export type ConvertIntakeDraftResult =
  | {
      ok: true
      itemId: string
      sku: string
      catalogId: string
      buyoutLineId?: string
      sellerSubmissionId: string | null
    }
  | { ok: false; field: string; message: string }

export async function convertIntakeDraft(
  tx: TxClient,
  options: ConvertIntakeDraftOptions,
): Promise<ConvertIntakeDraftResult> {
  // Final lock in canonical ordering for both callers (manual: SellerSubmission →
  // IntakeDraft; workbench: SellerInboundShipment → [create draft] → IntakeDraft).
  // For a workbench draft created moments earlier in the SAME transaction this is a
  // harmless no-op re-lock (the row is only visible to this transaction anyway).
  await tx.$queryRaw`SELECT id FROM "IntakeDraft" WHERE id = ${options.draftId} FOR UPDATE`

  const draft = await tx.intakeDraft.findUnique({ where: { id: options.draftId } })
  if (!draft) return { ok: false, field: 'form', message: 'Draft not found.' }
  if (draft.status !== 'reviewed') {
    return { ok: false, field: 'form', message: 'Draft must be in reviewed status to convert. Reload and try again.' }
  }

  const brand = draft.brand?.trim()
  const name = draft.name?.trim()
  // A draft either already has (or is given at conversion time) an exact resolved
  // CatalogModel (15D: workbench search/image-match/manual selection) OR carries the
  // legacy brand/name string fields used for fuzzy match-or-create. Requiring one or
  // the other — never both unconditionally — is what lets a workbench draft (no
  // brand/name strings at all) convert correctly.
  if (!options.catalogModelId && !draft.catalogModelId && (!brand || !name)) {
    return { ok: false, field: 'form', message: 'Draft is missing required fields. Please update and retry.' }
  }
  if (!draft.condition || !draft.cardedOrLoose) {
    return { ok: false, field: 'form', message: 'Draft is missing required fields. Please update and retry.' }
  }

  // Detect conflict between pre-assigned draft storage and the submitted locationId.
  // Both are admin-set; disagreement means the caller's form/state is stale.
  if (draft.storageLocationId && draft.storageLocationId !== options.locationId) {
    return {
      ok: false, field: 'locationId',
      message: 'The pre-assigned storage location on this draft differs from the selected location. Reload the form and try again.',
    }
  }
  const locationRow = await tx.storageLocation.findUnique({ where: { id: options.locationId }, select: { id: true } })
  if (!locationRow) return { ok: false, field: 'locationId', message: 'Storage location was deleted. Please select another.' }

  // ── Commercial provenance — resolved fresh inside the transaction, never trusted
  // from pre-transaction/caller state. ────────────────────────────────────────────
  let sourceType: 'company_owned' | 'buyout' | 'consignment' = 'company_owned'
  let agreementId: string | null = null
  let buyoutAgreedAmount: Prisma.Decimal | null = null
  // 15D-review (final approval pass): the authoritative, SIGNED physical-unit count
  // for a buyout agreement — never a live/converted-so-far count (that would make
  // cost treatment depend on conversion order). null/undefined = unspecified.
  let buyoutAcceptedItemCount: number | null = null
  let portfolioId: string | null = null

  if (draft.sellerSubmissionId) {
    const agreements = await tx.sellerAgreement.findMany({
      where: { submissionId: draft.sellerSubmissionId, status: { not: 'cancelled' } },
      select: { id: true, type: true, status: true, agreedBuyoutAmount: true, sellerPortfolioId: true, acceptedItemCount: true },
    })
    const eligibility = resolveConversionEligibility(draft.sellerSubmissionId, agreements)
    if (!eligibility.eligible) return { ok: false, field: 'form', message: eligibility.reason }

    sourceType = eligibility.sourceType
    agreementId = eligibility.acceptedAgreementId
    portfolioId = agreements.find((a) => a.id === agreementId)?.sellerPortfolioId ?? null

    if (options.confirmBuyout !== undefined || options.confirmConsignment !== undefined) {
      const confirmation = validateConversionConfirmation(
        sourceType,
        options.confirmBuyout ? 'on' : null,
        options.confirmConsignment ? 'on' : null,
      )
      if (!confirmation.valid) return { ok: false, field: 'form', message: confirmation.error }
    }

    if (sourceType === 'buyout') {
      const accepted = agreements.find((a) => a.id === agreementId)
      if (!accepted?.agreedBuyoutAmount) {
        return { ok: false, field: 'form', message: 'Accepted buyout agreement is missing the agreed buyout amount.' }
      }
      const amt = parseFloat(accepted.agreedBuyoutAmount.toFixed(2))
      if (!Number.isFinite(amt) || amt <= 0) {
        return { ok: false, field: 'form', message: 'Buyout amount in the accepted agreement is not valid.' }
      }
      buyoutAgreedAmount = accepted.agreedBuyoutAmount
      buyoutAcceptedItemCount = accepted.acceptedItemCount
    }
  }

  // ── Catalog resolution: prefer the draft's own already-resolved exact FK (set by
  // 15D's search/image-match/manual selection); fall back to the legacy fuzzy
  // match-or-create from brand/name string fields for pre-15D-style drafts. ───────
  const resolvedCatalogModelId = options.catalogModelId ?? draft.catalogModelId
  let catalog: { id: string; brand: string; name: string }
  if (resolvedCatalogModelId) {
    const found = await tx.catalogModel.findUnique({ where: { id: resolvedCatalogModelId }, select: { id: true, brand: true, name: true } })
    if (!found) return { ok: false, field: 'form', message: 'Selected catalog model no longer exists. Please refresh and try again.' }
    catalog = found
  } else {
    let found = await tx.catalogModel.findFirst({
      where: { brand: brand!, name: name!, year: draft.year ?? null, series: trimOrNull(draft.series), color: trimOrNull(draft.color), scale: trimOrNull(draft.scale) },
      select: { id: true, brand: true, name: true },
    })
    if (!found) {
      found = await tx.catalogModel.create({
        data: {
          brand: brand!, name: name!,
          year: draft.year ?? undefined, series: trimOrNull(draft.series) ?? undefined,
          color: trimOrNull(draft.color) ?? undefined, scale: trimOrNull(draft.scale) ?? undefined,
        },
        select: { id: true, brand: true, name: true },
      })
    }
    catalog = found
  }

  // ── SKU: admin-typed (manual, re-validated for uniqueness) or auto-generated
  // (workbench). Either way, immutable and written exactly once here. ─────────────
  let sku = options.sku
  if (sku) {
    const existing = await tx.itemInstance.findUnique({ where: { sku }, select: { id: true } })
    if (existing) return { ok: false, field: 'sku', message: 'SKU is already in use.' }
  } else {
    sku = await generateNextIntakeSku(tx)
  }

  // 15D-review (final approval pass) section 1: SellerAgreement.agreedBuyoutAmount is
  // authoritatively documented as "the total seller payment for the ENTIRE agreement"
  // (see actions/sellerPayouts.ts) — a batch/agreement total in general. It is
  // recorded exactly once as the agreement-level SellerPayoutLine (below) regardless
  // of the branch taken here — that record is always authoritative for the buyout
  // financial obligation.
  //
  // Item-level cost basis (ItemInstance.purchasePrice) is assigned ONLY when the
  // agreement's own SIGNED physical-unit count (SellerAgreement.acceptedItemCount,
  // admin-entered on the agreement itself — never a live/converted-so-far count,
  // which would make cost treatment depend on conversion order) is EXACTLY 1: in that
  // case the total and the single item's cost are mathematically identical. Any other
  // value — null (unspecified), or >1 (multi-item, no per-item allocation rule
  // exists) — leaves purchasePrice unallocated. Never: assign the total to an
  // arbitrary first item, divide it equally, infer from valuation/listing price, or
  // treat null as $0.
  const purchasePrice: number | null =
    sourceType === 'buyout' && buyoutAcceptedItemCount === 1 && buyoutAgreedAmount
      ? parseFloat(buyoutAgreedAmount.toFixed(2))
      : null

  // ── Create ItemInstance. Shipment lineage (section 2) comes straight from the
  // draft's own field — explicit, set once at draft-creation time, never guessed. ──
  const item = await tx.itemInstance.create({
    data: {
      sku,
      catalogId: catalog.id,
      locationId: options.locationId,
      cardedOrLoose: draft.cardedOrLoose!,
      condition: draft.condition!,
      conditionNotes: trimOrNull(draft.conditionNotes) ?? undefined,
      listPrice: draft.listPrice ?? undefined,
      status: 'available',
      notes: trimOrNull(draft.notes) ?? undefined,
      sourceType,
      sellerAgreementId: agreementId ?? undefined,
      sellerPortfolioId: portfolioId ?? undefined,
      sellerInboundShipmentId: draft.sellerInboundShipmentId ?? undefined,
      purchasePrice: purchasePrice ?? undefined,
    },
  })

  let buyoutLineId: string | undefined
  if (sourceType === 'buyout' && agreementId && buyoutAgreedAmount) {
    const submission = await tx.sellerSubmission.findUnique({ where: { id: draft.sellerSubmissionId! }, select: { profileId: true } })
    if (!submission) return { ok: false, field: 'form', message: 'Seller submission not found.' }
    const sourceKey = buildBuyoutSourceKey(agreementId)
    const existingLine = await tx.sellerPayoutLine.findUnique({ where: { sourceKey } })
    if (!existingLine) {
      const snap = calculateBuyoutPayoutSnapshot(buyoutAgreedAmount)
      const line = await tx.sellerPayoutLine.create({
        data: {
          sourceKey, lineType: 'buyout', status: 'eligible', currency: 'USD',
          customerProfileId: submission.profileId, agreementId,
          agreedBuyoutAmount: snap.agreedBuyoutAmount, netAmount: snap.netAmount,
          eligibleAt: new Date(),
        },
      })
      buyoutLineId = line.id
    }
  }

  const front = draft.frontPhotoUrl?.trim()
  if (front) await tx.photo.create({ data: { itemId: item.id, url: front, type: 'front', sortOrder: 0 } })
  const back = draft.backPhotoUrl?.trim()
  if (back) await tx.photo.create({ data: { itemId: item.id, url: back, type: 'back', sortOrder: 1 } })

  // 15F-review section 1: intake conversion no longer creates a Listing directly.
  // This function used to accept an optional `createListing` option, but that path
  // could never be risk-gated without either (a) reimplementing a second listing-risk
  // formula here, or (b) evaluating/consuming approval mid-transaction after the
  // ItemInstance already exists — neither is acceptable (see 15F-review). Converting
  // intake and activating a listing are separate risk boundaries: this function's job
  // ends at "physical item exists, ready, unlisted." Listing activation always goes
  // through the one authoritative, fully risk-gated path: actions/listings.ts
  // createListing (which the admin is directed to immediately after conversion).

  // Only reached when every prior step succeeded — the draft is marked converted and
  // linked to its ItemInstance in the SAME transaction as the ItemInstance write
  // above, so a converted draft with no ItemInstance (or vice versa) cannot occur.
  await tx.intakeDraft.update({ where: { id: options.draftId }, data: { status: 'converted', convertedItemId: item.id } })

  return { ok: true, itemId: item.id, sku, catalogId: catalog.id, buyoutLineId, sellerSubmissionId: draft.sellerSubmissionId }
}
