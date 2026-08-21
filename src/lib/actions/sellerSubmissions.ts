'use server'

import { prisma } from '@/lib/prisma'
import { getBuyerSession } from '@/lib/buyerSession'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { checkRateLimit } from '@/lib/rateLimit'

// 10 new submissions per hour per profile (instance-local)
const SUBMIT_MAX    = 10
const SUBMIT_WINDOW = 60 * 60 * 1000

const VALID_SALE_TYPE_PREFS = ['consignment', 'buyout', 'unsure'] as const
const VALID_CONDITIONS = ['mint', 'near_mint', 'good', 'fair', 'poor', 'damaged'] as const
const ACTIVE_STATUSES = ['submitted', 'under_review', 'needs_info'] as const
const WITHDRAWABLE_STATUSES = ['submitted', 'needs_info'] as const
const VALID_CARDED_LOOSE = ['carded', 'loose'] as const
const ADMIN_ALLOWED_STATUSES = ['submitted', 'under_review', 'needs_info', 'approved_for_intake', 'declined'] as const
const REVIEWED_STATUSES = new Set(['under_review', 'needs_info', 'approved_for_intake', 'declined'])

export type SellerSubmissionActionState = { errors: Record<string, string[]> } | null

function trimOrNull(v: string | undefined | null): string | null {
  const t = v?.trim()
  return t || null
}

export async function submitCollectionItemForSale(
  collectionItemId: string,
  _prev: SellerSubmissionActionState,
  formData: FormData
): Promise<SellerSubmissionActionState> {
  const session = await getBuyerSession()
  if (!session) {
    return { errors: { form: ['You must be signed in to submit a sell request.'] } }
  }

  const { allowed, resetMs } = checkRateLimit(
    `seller_submit:${session.profileId}`,
    SUBMIT_MAX,
    SUBMIT_WINDOW,
  )
  if (!allowed) {
    const secs = Math.ceil(resetMs / 1000)
    return { errors: { form: [`Too many submissions. Please wait ${secs} seconds.`] } }
  }

  const item = await prisma.collectionItem.findFirst({
    where: { id: collectionItemId, profileId: session.profileId },
    select: {
      id: true,
      brand: true,
      name: true,
      series: true,
      year: true,
      color: true,
      scale: true,
      cardedOrLoose: true,
      condition: true,
      conditionNotes: true,
      quantity: true,
      catalogId: true,
    },
  })
  if (!item) {
    return { errors: { form: ['Collection item not found.'] } }
  }

  const existingActive = await prisma.sellerSubmission.findFirst({
    where: {
      collectionItemId: item.id,
      profileId: session.profileId,
      status: { in: [...ACTIVE_STATUSES] },
    },
    select: { id: true },
  })
  if (existingActive) {
    return { errors: { form: ['You already have an active sell request for this item.'] } }
  }

  const rawSaleType = formData.get('saleTypePreference')?.toString().trim() ?? ''
  const rawExpectedPrice = formData.get('expectedPrice')?.toString().trim() ?? ''
  const rawQuantity = formData.get('quantity')?.toString().trim() ?? ''
  const rawCondition = trimOrNull(formData.get('condition')?.toString())
  const rawConditionNotes = trimOrNull(formData.get('conditionNotes')?.toString())
  const rawUserNotes = trimOrNull(formData.get('userNotes')?.toString())

  if (!rawSaleType || !(VALID_SALE_TYPE_PREFS as readonly string[]).includes(rawSaleType)) {
    return { errors: { saleTypePreference: ['Please select how you would like to sell.'] } }
  }

  let expectedPrice: number | null = null
  if (rawExpectedPrice) {
    const n = parseFloat(rawExpectedPrice)
    if (!Number.isFinite(n) || n < 0) {
      return { errors: { expectedPrice: ['Expected price must be 0 or more.'] } }
    }
    expectedPrice = n
  }

  let quantity = item.quantity
  if (rawQuantity) {
    const n = parseInt(rawQuantity, 10)
    if (isNaN(n) || n < 1) {
      return { errors: { quantity: ['Quantity must be 1 or more.'] } }
    }
    if (n > item.quantity) {
      return {
        errors: {
          quantity: [`Quantity cannot exceed your collection quantity of ${item.quantity}.`],
        },
      }
    }
    quantity = n
  }

  if (rawCondition && !(VALID_CONDITIONS as readonly string[]).includes(rawCondition)) {
    return { errors: { condition: ['Invalid condition value.'] } }
  }

  if (rawConditionNotes && rawConditionNotes.length > 500) {
    return { errors: { conditionNotes: ['Condition notes must be 500 characters or fewer.'] } }
  }

  if (rawUserNotes && rawUserNotes.length > 1000) {
    return { errors: { userNotes: ['Notes must be 1000 characters or fewer.'] } }
  }

  await prisma.sellerSubmission.create({
    data: {
      profileId: session.profileId,
      collectionItemId: item.id,
      catalogId: item.catalogId ?? null,
      brand: item.brand,
      name: item.name,
      series: item.series,
      year: item.year,
      color: item.color,
      scale: item.scale,
      cardedOrLoose: item.cardedOrLoose,
      condition: rawCondition ?? item.condition,
      conditionNotes: rawConditionNotes ?? item.conditionNotes,
      quantity,
      saleTypePreference: rawSaleType,
      expectedPrice,
      userNotes: rawUserNotes,
    },
  })

  revalidatePath('/account/sell')
  revalidatePath('/account/collection')
  revalidatePath(`/account/collection/${collectionItemId}`)
  redirect('/account/sell')
}

export async function submitManualSellRequest(
  _prev: SellerSubmissionActionState,
  formData: FormData
): Promise<SellerSubmissionActionState> {
  const session = await getBuyerSession()
  if (!session) {
    return { errors: { form: ['You must be signed in to submit a sell request.'] } }
  }

  const { allowed: submitAllowed, resetMs: submitResetMs } = checkRateLimit(
    `seller_submit:${session.profileId}`,
    SUBMIT_MAX,
    SUBMIT_WINDOW,
  )
  if (!submitAllowed) {
    const secs = Math.ceil(submitResetMs / 1000)
    return { errors: { form: [`Too many submissions. Please wait ${secs} seconds.`] } }
  }

  // 16F Final Persistence Integrity Pass: two truthful, non-overlapping modes.
  //
  // MODE A (catalog-context): an explicit catalogId was supplied. It must
  // reference a real CatalogModel — a forged/stale/nonexistent id is a hard error
  // here (never silently downgraded to freeform, since supplying catalogId means
  // the customer's flow explicitly established known-model context; silently
  // discarding it would hide tampering or a stale link). When valid, the
  // AUTHORITATIVE identity fields (brand/name/series/year/color/scale) are taken
  // from the re-fetched CatalogModel itself, never from browser-submitted text —
  // so catalogId and the identity fields on the resulting SellerSubmission can
  // never contradict each other, no matter what the form happened to display or
  // what a tampered request tried to submit for those fields.
  //
  // MODE B (freeform): no catalogId was supplied at all. Identity is exactly
  // whatever brand/name/etc the customer typed, catalogId stays null — unchanged
  // from this action's original behavior.
  //
  // In BOTH modes, physical/customer fields (condition, cardedOrLoose,
  // conditionNotes, quantity, saleTypePreference, expectedPrice, userNotes) always
  // come from the submitted form — CatalogModel has no opinion on a specific
  // physical copy's condition or how the customer wants to sell it.
  const rawCatalogId = trimOrNull(formData.get('catalogId')?.toString())

  let catalogMode: { id: string; brand: string; name: string; series: string | null; year: number | null; color: string | null; scale: string | null } | null = null
  if (rawCatalogId) {
    const found = await prisma.catalogModel.findUnique({
      where: { id: rawCatalogId },
      select: { id: true, brand: true, name: true, series: true, year: true, color: true, scale: true },
    })
    if (!found) {
      return { errors: { catalogId: ['This catalog reference is no longer valid. Please go back and try again.'] } }
    }
    catalogMode = found
  }

  const rawBrand = trimOrNull(formData.get('brand')?.toString())
  const rawName = trimOrNull(formData.get('name')?.toString())
  const rawSeries = trimOrNull(formData.get('series')?.toString())
  const rawYear = formData.get('year')?.toString().trim() ?? ''
  const rawColor = trimOrNull(formData.get('color')?.toString())
  const rawScale = trimOrNull(formData.get('scale')?.toString())
  const rawCardedOrLoose = trimOrNull(formData.get('cardedOrLoose')?.toString())
  const rawCondition = trimOrNull(formData.get('condition')?.toString())
  const rawConditionNotes = trimOrNull(formData.get('conditionNotes')?.toString())
  const rawQuantity = formData.get('quantity')?.toString().trim() ?? ''
  const rawSaleType = formData.get('saleTypePreference')?.toString().trim() ?? ''
  const rawExpectedPrice = formData.get('expectedPrice')?.toString().trim() ?? ''
  const rawUserNotes = trimOrNull(formData.get('userNotes')?.toString())

  // Identity-field validation only applies in MODE B (freeform) — in MODE A
  // (catalogMode set) these fields are never read from the form at all (see the
  // create call below), so validating browser text for them here would be
  // pointless at best and misleading at worst.
  let year: number | null = null
  if (!catalogMode) {
    if (!rawBrand && !rawName) {
      return { errors: { brandOrName: ['Please provide at least a brand or model name.'] } }
    }
    if (rawBrand && rawBrand.length > 100) {
      return { errors: { brand: ['Brand must be 100 characters or fewer.'] } }
    }
    if (rawName && rawName.length > 150) {
      return { errors: { name: ['Model name must be 150 characters or fewer.'] } }
    }
    if (rawSeries && rawSeries.length > 150) {
      return { errors: { series: ['Series must be 150 characters or fewer.'] } }
    }
    if (rawColor && rawColor.length > 100) {
      return { errors: { color: ['Color must be 100 characters or fewer.'] } }
    }
    if (rawScale && rawScale.length > 50) {
      return { errors: { scale: ['Scale must be 50 characters or fewer.'] } }
    }
    if (rawYear) {
      const n = parseInt(rawYear, 10)
      if (isNaN(n) || n < 1900 || n > 2100) {
        return { errors: { year: ['Year must be between 1900 and 2100.'] } }
      }
      year = n
    }
  }

  // Physical/customer fields are validated in both modes — CatalogModel has no
  // opinion on a specific physical copy's condition/packaging state.
  if (rawCardedOrLoose && !(VALID_CARDED_LOOSE as readonly string[]).includes(rawCardedOrLoose)) {
    return { errors: { cardedOrLoose: ['Invalid value.'] } }
  }
  if (rawCondition && !(VALID_CONDITIONS as readonly string[]).includes(rawCondition)) {
    return { errors: { condition: ['Invalid condition value.'] } }
  }
  if (rawConditionNotes && rawConditionNotes.length > 500) {
    return { errors: { conditionNotes: ['Condition notes must be 500 characters or fewer.'] } }
  }

  const quantity = parseInt(rawQuantity, 10)
  if (isNaN(quantity) || quantity < 1) {
    return { errors: { quantity: ['Quantity must be 1 or more.'] } }
  }

  if (!rawSaleType || !(VALID_SALE_TYPE_PREFS as readonly string[]).includes(rawSaleType)) {
    return { errors: { saleTypePreference: ['Please select how you would like to sell.'] } }
  }

  let expectedPrice: number | null = null
  if (rawExpectedPrice) {
    const n = parseFloat(rawExpectedPrice)
    if (!Number.isFinite(n) || n < 0) {
      return { errors: { expectedPrice: ['Expected price must be 0 or more.'] } }
    }
    expectedPrice = n
  }

  if (rawUserNotes && rawUserNotes.length > 1000) {
    return { errors: { userNotes: ['Notes must be 1000 characters or fewer.'] } }
  }

  // MODE A: identity fields come from the re-fetched CatalogModel, never from the
  // form — catalogId and identity can never contradict, even if a tampered
  // request submitted different brand/name/etc alongside a valid catalogId.
  // MODE B: identity is exactly whatever the customer typed, catalogId is null.
  await prisma.sellerSubmission.create({
    data: {
      profileId:          session.profileId,
      collectionItemId:   null,
      catalogId:          catalogMode ? catalogMode.id : null,
      brand:              catalogMode ? catalogMode.brand : rawBrand,
      name:               catalogMode ? catalogMode.name : rawName,
      series:             catalogMode ? catalogMode.series : rawSeries,
      year:               catalogMode ? catalogMode.year : year,
      color:              catalogMode ? catalogMode.color : rawColor,
      scale:              catalogMode ? catalogMode.scale : rawScale,
      cardedOrLoose:      rawCardedOrLoose,
      condition:          rawCondition,
      conditionNotes:     rawConditionNotes,
      quantity,
      saleTypePreference: rawSaleType,
      expectedPrice,
      userNotes:          rawUserNotes,
    },
  })

  revalidatePath('/account/sell')
  redirect('/account/sell')
}

export async function updateSellerSubmissionStatus(
  submissionId: string,
  _prev: SellerSubmissionActionState,
  formData: FormData
): Promise<SellerSubmissionActionState> {
  // Admin suggestion actions rely on the (admin) route group middleware for auth,
  // consistent with all other admin server actions in this repo.
  const rawStatus = formData.get('status')?.toString().trim() ?? ''
  const rawAdminNotes = formData.get('adminNotes')?.toString() ?? ''
  const rawUserMessage = formData.get('userMessage')?.toString() ?? ''

  if (!(ADMIN_ALLOWED_STATUSES as readonly string[]).includes(rawStatus)) {
    return { errors: { status: ['Invalid status.'] } }
  }

  const userMessage = rawUserMessage.trim() || null
  if ((rawStatus === 'needs_info' || rawStatus === 'declined') && !userMessage) {
    return { errors: { userMessage: ['A message to the seller is required for this status.'] } }
  }
  if (userMessage && userMessage.length > 1000) {
    return { errors: { userMessage: ['Message must be 1000 characters or fewer.'] } }
  }

  const adminNotes = rawAdminNotes.trim() || null
  if (adminNotes && adminNotes.length > 2000) {
    return { errors: { adminNotes: ['Admin notes must be 2000 characters or fewer.'] } }
  }

  const submission = await prisma.sellerSubmission.findUnique({
    where: { id: submissionId },
    select: { id: true, status: true, collectionItemId: true },
  })
  if (!submission) return { errors: { form: ['Sell request not found.'] } }

  await prisma.sellerSubmission.update({
    where: { id: submission.id },
    data: {
      status: rawStatus,
      adminNotes,
      userMessage,
      ...(REVIEWED_STATUSES.has(rawStatus) ? { reviewedAt: new Date() } : {}),
    },
  })

  revalidatePath('/admin/seller-submissions')
  revalidatePath(`/admin/seller-submissions/${submissionId}`)
  revalidatePath('/account/sell')
  revalidatePath(`/account/sell/${submissionId}`)
  revalidatePath('/account/collection')
  if (submission.collectionItemId) {
    revalidatePath(`/account/collection/${submission.collectionItemId}`)
  }
  redirect(`/admin/seller-submissions/${submissionId}`)
}

export async function adminLinkSubmissionCatalog(
  submissionId: string,
  _prev: SellerSubmissionActionState,
  formData: FormData
): Promise<SellerSubmissionActionState> {
  const rawCatalogId = formData.get('catalogId')?.toString().trim() ?? ''

  if (!rawCatalogId) {
    return { errors: { catalogId: ['Select a catalog model to link.'] } }
  }

  type TxResult = SellerSubmissionActionState
  let txResult: TxResult = null

  try {
    await prisma.$transaction(async (tx) => {
      // Acquire the same row-level lock used by convertDraft — serializes relink
      // against concurrent conversion so only one can win after reading fresh state.
      await tx.$queryRaw`SELECT id FROM "SellerSubmission" WHERE id = ${submissionId} FOR UPDATE`

      const [submission, catalog] = await Promise.all([
        tx.sellerSubmission.findUnique({
          where: { id: submissionId },
          select: { id: true, intakeDrafts: { select: { convertedItemId: true } } },
        }),
        tx.catalogModel.findUnique({ where: { id: rawCatalogId }, select: { id: true } }),
      ])

      if (!submission) {
        txResult = { errors: { form: ['Seller submission not found.'] } }
        throw new Error('TX_VALIDATION')
      }
      if (!catalog) {
        txResult = { errors: { catalogId: ['Catalog model not found.'] } }
        throw new Error('TX_VALIDATION')
      }
      if (submission.intakeDrafts.some((d) => d.convertedItemId !== null)) {
        txResult = { errors: { form: ['Cannot relink: this submission has converted inventory. Edit the item directly if needed.'] } }
        throw new Error('TX_VALIDATION')
      }

      // Postgres acquires FOR KEY SHARE on the CatalogModel row when writing this FK.
      // If a merge TX holds FOR UPDATE on that row, this update blocks until the merge
      // commits. If the merge deleted the model, this throws P2003 (FK constraint failed).
      await tx.sellerSubmission.update({
        where: { id: submissionId },
        data: { catalogId: rawCatalogId },
      })
    })
  } catch (err) {
    if ((err as Error).message === 'TX_VALIDATION') return txResult
    // FK constraint failed: the catalog model was deleted by a concurrent merge.
    if ((err as { code?: string }).code === 'P2003') {
      return { errors: { catalogId: ['The selected catalog model was just deleted. Please refresh and select another.'] } }
    }
    throw err
  }

  revalidatePath(`/admin/seller-submissions/${submissionId}`)
  return null
}

export async function withdrawSellerSubmission(
  _prev: SellerSubmissionActionState,
  formData: FormData
): Promise<SellerSubmissionActionState> {
  const session = await getBuyerSession()
  if (!session) {
    return { errors: { form: ['You must be signed in.'] } }
  }

  const submissionId = formData.get('submissionId')?.toString().trim() ?? ''
  if (!submissionId) {
    return { errors: { form: ['Sell request not found.'] } }
  }

  const submission = await prisma.sellerSubmission.findFirst({
    where: { id: submissionId, profileId: session.profileId },
    select: { id: true, status: true, collectionItemId: true },
  })
  if (!submission) {
    return { errors: { form: ['Sell request not found.'] } }
  }

  if (!(WITHDRAWABLE_STATUSES as readonly string[]).includes(submission.status)) {
    return { errors: { form: ['This sell request can no longer be withdrawn.'] } }
  }

  await prisma.sellerSubmission.update({
    where: { id: submission.id },
    data: { status: 'withdrawn' },
  })

  revalidatePath('/account/sell')
  revalidatePath(`/account/sell/${submissionId}`)
  revalidatePath('/account/collection')
  if (submission.collectionItemId) {
    revalidatePath(`/account/collection/${submission.collectionItemId}`)
  }
  redirect(`/account/sell/${submissionId}`)
}
