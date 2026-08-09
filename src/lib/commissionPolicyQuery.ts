// 15A: DB boundary for the commission policy engine. All resolution logic lives in
// commissionPolicy.ts (resolveCommissionTerms) — this file only fetches rows and
// calls it. Preview (admin UI) and snapshot (agreement finalization) both go through
// the SAME resolver call, so they can never drift.

import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import {
  resolveCommissionTerms,
  validatePolicy,
  validateNoOverlappingActivePolicies,
  validateNoOverlappingSellerOverrides,
} from '@/lib/commissionPolicy'
import type {
  CommissionPolicyDef,
  CommissionResolution,
  SellerOverrideDef,
  AgreementOverrideDef,
} from '@/lib/commissionPolicy'

type PrismaTx = Prisma.TransactionClient

// An agreement-level override never needs a policy to exist (e.g. a brand-new
// marketplace with no policy configured yet, or a fully bespoke deal). Every other
// resolution path requires an active policy — shared by both preview and
// finalization so they can never drift (section 20).
function resolveWithOptionalPolicy(params: {
  policy: CommissionPolicyDef | null
  sellerOverride: SellerOverrideDef | null
  agreementOverride: AgreementOverrideDef | null
  acceptedItemCount: number
  asOf: Date
}): { ok: true; resolution: CommissionResolution } | { ok: false; error: 'NO_ACTIVE_POLICY' } {
  const { policy, sellerOverride, agreementOverride, acceptedItemCount, asOf } = params
  if (!policy && !agreementOverride) return { ok: false, error: 'NO_ACTIVE_POLICY' }
  const resolution = resolveCommissionTerms({
    agreementOverride,
    sellerOverride,
    policy: policy ?? { id: '', name: 'None', defaultCommissionBps: 0, minimumFeeCents: 0, tiers: [] },
    acceptedItemCount,
    asOf,
  })
  return { ok: true, resolution: { ...resolution, policyId: policy?.id ?? null } }
}

// ── Active policy / override lookups ──────────────────────────────────────────────

async function fetchActivePolicy(client: PrismaTx | typeof prisma, asOf: Date): Promise<CommissionPolicyDef | null> {
  const row = await client.commissionPolicy.findFirst({
    where: {
      status: 'active',
      effectiveFrom: { lte: asOf },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: asOf } }],
    },
    orderBy: { effectiveFrom: 'desc' },
    include: { tiers: { orderBy: { minItems: 'asc' } } },
  })
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    defaultCommissionBps: row.defaultCommissionBps,
    minimumFeeCents: row.minimumFeeCents,
    tiers: row.tiers.map(t => ({
      id: t.id,
      minItems: t.minItems,
      commissionBps: t.commissionBps,
      minimumFeeCents: t.minimumFeeCents,
    })),
  }
}

async function fetchActiveSellerOverride(
  client: PrismaTx | typeof prisma,
  sellerProfileId: string,
  asOf: Date,
): Promise<SellerOverrideDef | null> {
  const row = await client.sellerCommissionOverride.findFirst({
    where: {
      sellerProfileId,
      effectiveFrom: { lte: asOf },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: asOf } }],
    },
    orderBy: { effectiveFrom: 'desc' },
  })
  if (!row) return null
  return {
    id: row.id,
    commissionBps: row.commissionBps,
    minimumFeeCents: row.minimumFeeCents,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
  }
}

// UI/action-layer helper only — NOT used by the resolver. Gives callers the
// seller-requested quantity to (a) seed the accepted-quantity field's initial value
// on a brand-new draft and (b) cap-check an admin-entered accepted quantity against
// it. The resolver itself never derives its denominator from this (see
// commissionPolicy.ts header comment) — 15B's Portfolio can supply acceptedItemCount
// from a different source entirely with no change to previewCommissionForSubmission
// or resolveCommissionForFinalization's signatures.
export async function fetchSubmissionQuantity(client: PrismaTx | typeof prisma, submissionId: string): Promise<number> {
  const submission = await client.sellerSubmission.findUnique({
    where: { id: submissionId },
    select: { quantity: true },
  })
  return submission?.quantity ?? 0
}

export type CommissionResolutionOutcome =
  | { ok: true; resolution: CommissionResolution }
  | { ok: false; error: 'NO_ACTIVE_POLICY' }

// Section 16 (and 15A-review section 1): live preview, reusable by both the admin
// agreement page and any future pre-finalization UI. No business mutation —
// read-only. acceptedItemCount is caller-supplied (the authoritative
// SellerAgreement.acceptedItemCount draft value), never derived internally from
// SellerSubmission — keeps this resolver's denominator source swappable (15B).
export async function previewCommissionForSubmission(
  submissionId: string,
  acceptedItemCount: number,
  asOf: Date = new Date(),
  agreementOverride: AgreementOverrideDef | null = null,
): Promise<CommissionResolutionOutcome> {
  const submission = await prisma.sellerSubmission.findUnique({
    where: { id: submissionId },
    select: { profileId: true },
  })
  const sellerProfile = submission
    ? await prisma.sellerProfile.findUnique({ where: { profileId: submission.profileId }, select: { id: true } })
    : null

  const [policy, sellerOverride] = await Promise.all([
    fetchActivePolicy(prisma, asOf),
    sellerProfile ? fetchActiveSellerOverride(prisma, sellerProfile.id, asOf) : Promise.resolve(null),
  ])

  return resolveWithOptionalPolicy({ policy, sellerOverride, agreementOverride, acceptedItemCount, asOf })
}

// Section 9/19 (and 15A-review sections 1/5): called INSIDE the agreement-finalization
// transaction. Re-fetches policy/override fresh from the SAME transaction client
// (never trusts browser state or a pre-transaction read), so concurrent finalizations
// cannot race on stale data. acceptedItemCount is caller-supplied — the caller is
// responsible for re-fetching the authoritative SellerAgreement.acceptedItemCount
// value inside the same transaction lock before calling this (never trust a
// browser-provided count). Returns the exact field values to persist on
// SellerAgreement — the caller does the actual `update`, keeping this function's only
// job "resolve," not "write."
export async function resolveCommissionForFinalization(
  tx: PrismaTx,
  params: { sellerProfileId: string | null; agreementOverride: AgreementOverrideDef | null; acceptedItemCount: number; asOf: Date },
): Promise<CommissionResolutionOutcome> {
  const { sellerProfileId, agreementOverride, acceptedItemCount, asOf } = params

  const [policy, sellerOverride] = await Promise.all([
    fetchActivePolicy(tx, asOf),
    sellerProfileId ? fetchActiveSellerOverride(tx, sellerProfileId, asOf) : Promise.resolve(null),
  ])

  return resolveWithOptionalPolicy({ policy, sellerOverride, agreementOverride, acceptedItemCount, asOf })
}

// 15A-review section 1: exposes the raw resolution ingredients (not a resolved
// outcome) so a client component can re-run the SAME pure resolveCommissionTerms
// engine in the browser as the admin edits the accepted-quantity field — giving an
// instant tier/commission preview with no network round-trip and zero risk of the
// client-side preview drifting from the server-side resolver (it IS the server-side
// resolver, just re-invoked with different local input).
export async function fetchCommissionResolutionInputs(
  submissionId: string,
  asOf: Date = new Date(),
): Promise<{ policy: CommissionPolicyDef | null; sellerOverride: SellerOverrideDef | null }> {
  const submission = await prisma.sellerSubmission.findUnique({
    where: { id: submissionId },
    select: { profileId: true },
  })
  const sellerProfile = submission
    ? await prisma.sellerProfile.findUnique({ where: { profileId: submission.profileId }, select: { id: true } })
    : null

  const [policy, sellerOverride] = await Promise.all([
    fetchActivePolicy(prisma, asOf),
    sellerProfile ? fetchActiveSellerOverride(prisma, sellerProfile.id, asOf) : Promise.resolve(null),
  ])

  return { policy, sellerOverride }
}

// ── Admin: policy CRUD ──────────────────────────────────────────────────────────────

export type PolicyListRow = {
  id: string
  name: string
  status: string
  effectiveFrom: Date
  effectiveTo: Date | null
  defaultCommissionBps: number
  minimumFeeCents: number
  tierCount: number
}

export async function listCommissionPolicies(): Promise<PolicyListRow[]> {
  const rows = await prisma.commissionPolicy.findMany({
    orderBy: { effectiveFrom: 'desc' },
    include: { _count: { select: { tiers: true } } },
  })
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    status: r.status,
    effectiveFrom: r.effectiveFrom,
    effectiveTo: r.effectiveTo,
    defaultCommissionBps: r.defaultCommissionBps,
    minimumFeeCents: r.minimumFeeCents,
    tierCount: r._count.tiers,
  }))
}

export async function getCommissionPolicyDetail(id: string) {
  return prisma.commissionPolicy.findUnique({
    where: { id },
    include: { tiers: { orderBy: { minItems: 'asc' } } },
  })
}

export type CreatePolicyInput = {
  name: string
  effectiveFrom: Date
  effectiveTo: Date | null
  defaultCommissionBps: number
  minimumFeeCents: number
  tiers: Array<{ minItems: number; commissionBps: number; minimumFeeCents: number | null }>
  activateImmediately: boolean
}

export type CreatePolicyResult = { ok: true; id: string } | { ok: false; error: string }

// 15A-review section 2: a plain "transaction → check overlap → insert" is NOT
// concurrency-safe under Postgres's default READ COMMITTED isolation — two
// concurrent transactions can both run the overlap-check SELECT before either
// commits its INSERT, so both pass and both write, producing two ambiguous active
// policies. pg_advisory_xact_lock serializes writers on a single named lock (held for
// the lifetime of the transaction, released automatically on commit/rollback — never
// needs a manual unlock), so the second concurrent createCommissionPolicy call blocks
// here until the first fully commits or rolls back, and then re-reads a
// now-up-to-date `existingActive` list. Scoped policy-wide (not per-row) because
// ANY two active policies anywhere can overlap and become ambiguous.
const COMMISSION_POLICY_LOCK_KEY = 'commission_policy_active'

// Section 18/19: validated, then checked against other ACTIVE policies for
// overlapping effective windows before being written — a transaction so the
// overlap-check and insert are atomic against concurrent policy creation.
export async function createCommissionPolicy(input: CreatePolicyInput): Promise<CreatePolicyResult> {
  const validation = validatePolicy({
    defaultCommissionBps: input.defaultCommissionBps,
    minimumFeeCents: input.minimumFeeCents,
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo,
    tiers: input.tiers,
  })
  if (!validation.valid) return { ok: false, error: validation.error }

  try {
    const id = await prisma.$transaction(async (tx) => {
      if (input.activateImmediately) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${COMMISSION_POLICY_LOCK_KEY})::bigint)`

        const existingActive = await tx.commissionPolicy.findMany({
          where: { status: 'active' },
          select: { id: true, effectiveFrom: true, effectiveTo: true },
        })
        const overlapCheck = validateNoOverlappingActivePolicies([
          ...existingActive,
          { id: 'new', effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo },
        ])
        if (!overlapCheck.valid) throw new Error(overlapCheck.error)
      }

      const policy = await tx.commissionPolicy.create({
        data: {
          name: input.name,
          status: input.activateImmediately ? 'active' : 'draft',
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo,
          defaultCommissionBps: input.defaultCommissionBps,
          minimumFeeCents: input.minimumFeeCents,
          tiers: { create: input.tiers },
        },
      })
      return policy.id
    })
    return { ok: true, id }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to create policy.' }
  }
}

export async function endDateCommissionPolicy(id: string, effectiveTo: Date): Promise<CreatePolicyResult> {
  const policy = await prisma.commissionPolicy.findUnique({ where: { id }, select: { effectiveFrom: true } })
  if (!policy) return { ok: false, error: 'Policy not found.' }
  if (effectiveTo.getTime() <= policy.effectiveFrom.getTime()) {
    return { ok: false, error: 'End date must be after the policy effective start.' }
  }
  await prisma.commissionPolicy.update({
    where: { id },
    data: { effectiveTo, status: 'ended' },
  })
  return { ok: true, id }
}

// ── Admin: seller overrides ─────────────────────────────────────────────────────────

export type CreateSellerOverrideInput = {
  sellerProfileId: string
  commissionBps: number | null
  minimumFeeCents: number | null
  effectiveFrom: Date
  effectiveTo: Date | null
  reason: string
  createdBy: string | null
}

// 15A-review section 3: seller-scoped lock key — deliberately includes
// sellerProfileId so unrelated sellers' override writes never block each other (unlike
// the policy-wide lock in section 2, where ANY two active policies can collide).
function sellerOverrideLockKey(sellerProfileId: string): string {
  return `commission_seller_override:${sellerProfileId}`
}

export async function createSellerCommissionOverride(input: CreateSellerOverrideInput): Promise<CreatePolicyResult> {
  if (!input.reason.trim()) return { ok: false, error: 'A reason is required for a seller-specific override.' }
  if (input.commissionBps === null && input.minimumFeeCents === null) {
    return { ok: false, error: 'Provide at least a commission rate or a minimum fee override.' }
  }
  if (input.commissionBps !== null) {
    if (!Number.isInteger(input.commissionBps) || input.commissionBps < 0 || input.commissionBps > 10_000) {
      return { ok: false, error: 'Commission rate must be an integer between 0 and 10000 basis points.' }
    }
  }
  if (input.minimumFeeCents !== null) {
    if (!Number.isInteger(input.minimumFeeCents) || input.minimumFeeCents < 0) {
      return { ok: false, error: 'Minimum fee must be a non-negative integer number of cents.' }
    }
  }
  if (input.effectiveTo !== null && input.effectiveTo.getTime() <= input.effectiveFrom.getTime()) {
    return { ok: false, error: 'Override end date must be after the start date.' }
  }

  try {
    // A plain create with no lock/overlap-check would let two concurrent requests
    // both write overlapping windows for the same seller, making
    // fetchActiveSellerOverride's findFirst pick an arbitrary row at resolution time.
    // The advisory lock is seller-scoped so a burst of overrides for DIFFERENT
    // sellers never contend with each other.
    const id = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${sellerOverrideLockKey(input.sellerProfileId)})::bigint)`

      const existing = await tx.sellerCommissionOverride.findMany({
        where: { sellerProfileId: input.sellerProfileId },
        select: { id: true, effectiveFrom: true, effectiveTo: true },
      })
      const overlapCheck = validateNoOverlappingSellerOverrides([
        ...existing,
        { id: 'new', effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo },
      ])
      if (!overlapCheck.valid) throw new Error(overlapCheck.error)

      const row = await tx.sellerCommissionOverride.create({
        data: {
          sellerProfileId: input.sellerProfileId,
          commissionBps: input.commissionBps,
          minimumFeeCents: input.minimumFeeCents,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo,
          reason: input.reason.trim(),
          createdBy: input.createdBy,
        },
      })
      return row.id
    })
    return { ok: true, id }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to create seller override.' }
  }
}

export async function endSellerCommissionOverride(id: string, effectiveTo: Date): Promise<CreatePolicyResult> {
  const row = await prisma.sellerCommissionOverride.findUnique({ where: { id }, select: { effectiveFrom: true } })
  if (!row) return { ok: false, error: 'Override not found.' }
  if (effectiveTo.getTime() <= row.effectiveFrom.getTime()) {
    return { ok: false, error: 'End date must be after the override start.' }
  }
  await prisma.sellerCommissionOverride.update({ where: { id }, data: { effectiveTo } })
  return { ok: true, id }
}

export async function listSellerCommissionOverrides(sellerProfileId: string) {
  return prisma.sellerCommissionOverride.findMany({
    where: { sellerProfileId },
    orderBy: { effectiveFrom: 'desc' },
  })
}
