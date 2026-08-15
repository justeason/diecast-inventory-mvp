// 15E: pure logic for the intake exception queue — the ONE exception source of truth
// remains IntakeDraft (no parallel IntakeException table). No DB access (see
// intakeExceptionQueueQuery.ts for that boundary). Mirrors the itemLifecycle.ts /
// itemLifecycleQuery.ts pure/DB-boundary split.
//
// ── Section 1/2: current, actually-persisted exception codes (from 15D
// actions/intakeWorkbench.ts) — reused verbatim, never renamed/duplicated:
//   unknown_model      — no catalog model resolved
//   invalid_storage    — no valid storage location resolved
//   missing_condition  — condition/cardedOrLoose absent
//   unexpected_overage — would exceed the shipment's recorded received quantity
//   conversion_failed  — the shared convertIntakeDraft() primitive itself rejected an
//                        already-classified-normal unit (rare race)
// No other exception code is ever written anywhere in this codebase today. In
// particular:
//   - no "agreement mismatch" / "portfolio-agreement conflict" code exists — an
//     eligibility failure (no accepted agreement, wrong type, etc.) is a WHOLE-CONFIRM
//     error in confirmWorkbenchItem (nothing is created, no draft to enqueue), never a
//     per-unit exception draft. Only unexpected_overage is a real persisted
//     "commercial/quantity blocker" code.
//   - no technical-duplicate exception code exists — the workbenchClientToken unique
//     constraint prevents duplicates at the DB level (P2002), it never produces an
//     exception draft with a "duplicate" code. There is therefore no
//     duplicate/identity category with real data in 15E; it is intentionally omitted
//     below rather than represented as an empty/fake category.
//   - mobile capture (MobileCaptureSession/MobileCaptureItem) never creates an
//     IntakeDraft at all — it is a wholly separate buyer-side flow (see
//     actions/mobileCapture.ts) feeding CollectionItem/SellerSubmission, not intake
//     conversion. It has no intersection with this queue.

export const INTAKE_EXCEPTION_CODES = [
  'unknown_model',
  'invalid_storage',
  'missing_condition',
  'unexpected_overage',
  'conversion_failed',
] as const

export type IntakeExceptionCode = (typeof INTAKE_EXCEPTION_CODES)[number]

export function isKnownExceptionCode(code: string): code is IntakeExceptionCode {
  return (INTAKE_EXCEPTION_CODES as readonly string[]).includes(code)
}

export const EXCEPTION_LABELS: Record<IntakeExceptionCode, string> = {
  unknown_model: 'Unknown model',
  invalid_storage: 'Invalid storage',
  missing_condition: 'Missing condition',
  unexpected_overage: 'Overage',
  conversion_failed: 'Conversion failed',
}

// Section 4: deterministic UX-only categories — never used to silently change
// resolution behavior, only to group/filter/explain in the queue UI.
export type ExceptionCategory = 'data_fixable' | 'retryable' | 'commercial_blocker'

export const EXCEPTION_CATEGORY: Record<IntakeExceptionCode, ExceptionCategory> = {
  unknown_model: 'data_fixable',
  invalid_storage: 'data_fixable',
  missing_condition: 'data_fixable',
  conversion_failed: 'retryable',
  unexpected_overage: 'commercial_blocker',
}

export const EXCEPTION_CATEGORY_LABELS: Record<ExceptionCategory, string> = {
  data_fixable: 'Data fixable',
  retryable: 'Retryable',
  commercial_blocker: 'Commercial blocker',
}

export function categorizeExceptionCode(code: string): ExceptionCategory | null {
  return isKnownExceptionCode(code) ? EXCEPTION_CATEGORY[code] : null
}

export function codesForCategory(category: ExceptionCategory): IntakeExceptionCode[] {
  return INTAKE_EXCEPTION_CODES.filter((c) => EXCEPTION_CATEGORY[c] === category)
}

// Section 8: deterministic operational priority — never an opaque/invented risk
// score. Lower index = higher priority (surfaced first when an admin filters/scans).
export const EXCEPTION_PRIORITY_ORDER: IntakeExceptionCode[] = [
  'unexpected_overage',
  'conversion_failed',
  'unknown_model',
  'invalid_storage',
  'missing_condition',
]

export function exceptionPriorityRank(code: string): number {
  const idx = EXCEPTION_PRIORITY_ORDER.indexOf(code as IntakeExceptionCode)
  return idx === -1 ? EXCEPTION_PRIORITY_ORDER.length : idx
}

// Deterministic comparator for a bounded, already-fetched page (never used to drive
// keyset pagination itself — see intakeExceptionQueueQuery.ts for why the DB-level
// sort stays createdAt-based).
export function compareExceptionPriority(
  a: { code: string; createdAt: Date },
  b: { code: string; createdAt: Date },
): number {
  const rankDiff = exceptionPriorityRank(a.code) - exceptionPriorityRank(b.code)
  if (rankDiff !== 0) return rankDiff
  return a.createdAt.getTime() - b.createdAt.getTime()
}

// ── Section 2: the open-exception predicate — the ONE definition, reused by the
// queue query, the portfolio/shipment counts, and confirmWorkbenchItem's own overage
// check, so they can never silently drift apart. Structurally mirrors the Prisma
// `where` shape but has no Prisma dependency (safe to import from pure/test code). ──
export type OpenIntakeExceptionWhere = {
  workbenchExceptionCode: { not: null }
  convertedItemId: null
  status: { not: 'rejected' }
}

export function openIntakeExceptionWhere(): OpenIntakeExceptionWhere {
  return { workbenchExceptionCode: { not: null }, convertedItemId: null, status: { not: 'rejected' } }
}

// Pure mirror of the same predicate for a single already-loaded row (tests / detail
// guards) — must stay logically identical to openIntakeExceptionWhere().
export function isOpenIntakeException(draft: { workbenchExceptionCode: string | null; convertedItemId: string | null; status: string }): boolean {
  return draft.workbenchExceptionCode !== null && draft.convertedItemId === null && draft.status !== 'rejected'
}

// ── Section 29: age formatting/grouping — operational visibility, not an SLA. ──────

export function formatExceptionAge(createdAt: Date, now: Date): string {
  const ms = Math.max(0, now.getTime() - createdAt.getTime())
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${Math.max(1, minutes)} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hr`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'}`
}

export type ExceptionAgeGroup = '<1h' | '1-24h' | '1-3d' | '>3d'

export function exceptionAgeGroup(createdAt: Date, now: Date): ExceptionAgeGroup {
  const hours = (now.getTime() - createdAt.getTime()) / 3_600_000
  if (hours < 1) return '<1h'
  if (hours < 24) return '1-24h'
  if (hours < 72) return '1-3d'
  return '>3d'
}
