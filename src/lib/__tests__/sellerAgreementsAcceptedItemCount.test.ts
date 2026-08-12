// 15A-review sections 1 & 5: structural guarantees around the authoritative
// SellerAgreement.acceptedItemCount field that are impractical to cover with
// prisma-mocked behavioral tests (recordSellerAgreementAcceptance/createSellerAgreement/
// updateSellerAgreement are 'use server' actions that call redirect() on success, and
// this codebase does not unit-test the action layer directly — see the absence of a
// src/lib/actions/__tests__ directory; DB-boundary logic is instead tested at the
// commissionPolicyQuery.ts / commissionPolicy.ts / sellerAgreementValidation.ts layer,
// covered elsewhere). These grep-based checks pin down the specific guarantees this
// review called out: never trust a browser-provided accepted count at acceptance time,
// snapshot it exactly once, and never re-tier after acceptance.
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relPath), 'utf-8')
}

const ACTIONS_SRC = readSrc('src/lib/actions/sellerAgreements.ts')

function acceptanceFnBody(): string {
  const start = ACTIONS_SRC.indexOf('export async function recordSellerAgreementAcceptance')
  const nextExport = ACTIONS_SRC.indexOf('\nexport async function', start + 1)
  return ACTIONS_SRC.slice(start, nextExport === -1 ? undefined : nextExport)
}

describe('sellerAgreements.ts: acceptance never trusts a browser-provided accepted count (section 1/5)', () => {
  it('recordSellerAgreementAcceptance does not read acceptedItemCount from formData', () => {
    const body = acceptanceFnBody()
    expect(body).not.toMatch(/formData\.get\(['"]acceptedItemCount['"]\)/)
  })

  it('recordSellerAgreementAcceptance re-fetches acceptedItemCount from the DB inside the transaction (fresh.acceptedItemCount)', () => {
    const body = acceptanceFnBody()
    expect(body).toMatch(/acceptedItemCount:\s*true/) // present in the `fresh` select
    expect(body).toMatch(/fresh\.acceptedItemCount/)
  })

  it('recordSellerAgreementAcceptance validates the accepted count (>= 1, <= re-fetched submitted quantity) before resolving', () => {
    // 15B: for a portfolio-linked agreement, the re-fetched value comes from the
    // portfolio (resolvePortfolioAcceptedItemCount) instead of the agreement's own
    // last-saved snapshot — see the section 5 describe block below. Either way it is
    // captured into a local `acceptedItemCount`, re-fetched fresh inside this same
    // transaction, and validated before being used — never a browser-supplied value.
    const body = acceptanceFnBody()
    expect(body).toMatch(/let acceptedItemCount = fresh\.acceptedItemCount/)
    expect(body).toMatch(/acceptedItemCount === null \|\| acceptedItemCount < 1/)
    expect(body).toMatch(/resolveSubmittedQuantityCap\(tx,/)
    expect(body).toMatch(/acceptedItemCount > submittedQuantity/)
  })

  it('the value passed into resolveCommissionForFinalization is the re-fetched local acceptedItemCount, not a browser-supplied one', () => {
    const body = acceptanceFnBody()
    expect(body).toMatch(/acceptedItemCount,\n\s*asOf: new Date\(\),/)
  })
})

describe('sellerAgreements.ts: acceptedItemCount is frozen after acceptance, never re-tiered (section 1)', () => {
  it('resolveCommissionForFinalization (the only re-resolution entry point) is called exactly once, inside acceptance', () => {
    const occurrences = ACTIONS_SRC.match(/resolveCommissionForFinalization\(/g) ?? []
    expect(occurrences.length).toBe(1)
    expect(acceptanceFnBody()).toContain('resolveCommissionForFinalization(')
  })

  it('createSellerAgreement/updateSellerAgreement (draft mutation paths) never call resolveCommissionForFinalization — only the live preview resolver', () => {
    const createStart = ACTIONS_SRC.indexOf('export async function createSellerAgreement')
    const updateStart = ACTIONS_SRC.indexOf('export async function updateSellerAgreement')
    const proposeStart = ACTIONS_SRC.indexOf('export async function proposeSellerAgreement')
    const draftSrc = ACTIONS_SRC.slice(createStart, proposeStart)
    expect(draftSrc.indexOf('createSellerAgreement')).toBeGreaterThanOrEqual(0)
    expect(updateStart).toBeGreaterThan(createStart)
    expect(draftSrc).not.toMatch(/resolveCommissionForFinalization/)
    // Both createSellerAgreement and updateSellerAgreement delegate to the shared
    // resolveDraftCommissionFields helper (defined earlier in the file), which is the
    // sole call site of previewCommissionForSubmission.
    expect((draftSrc.match(/resolveDraftCommissionFields\(/g) ?? []).length).toBe(2)
    expect((ACTIONS_SRC.match(/previewCommissionForSubmission\(/g) ?? []).length).toBe(1)
  })

  it('no code path outside recordSellerAgreementAcceptance writes SellerAgreement.acceptedItemCount from a resolution result once status is accepted', () => {
    // The only two writers of `acceptedItemCount:` are the draft resolver (pre-acceptance,
    // mutable) and the acceptance snapshot (frozen at that point) — cancelSellerAgreement
    // and proposeSellerAgreement never touch it.
    const cancelStart = ACTIONS_SRC.indexOf('export async function cancelSellerAgreement')
    const cancelSrc = ACTIONS_SRC.slice(cancelStart)
    expect(cancelSrc).not.toMatch(/acceptedItemCount/)
    const proposeStart = ACTIONS_SRC.indexOf('export async function proposeSellerAgreement')
    const acceptStart = ACTIONS_SRC.indexOf('export async function recordSellerAgreementAcceptance')
    const proposeSrc = ACTIONS_SRC.slice(proposeStart, acceptStart)
    expect(proposeSrc).not.toMatch(/acceptedItemCount/)
  })
})

describe('sellerAgreements.ts: accepted-quantity cap check runs before commission resolution on every draft save (section 1)', () => {
  it('createSellerAgreement validates the cap via validateAcceptedItemCountCap before resolveDraftCommissionFields', () => {
    const createStart = ACTIONS_SRC.indexOf('export async function createSellerAgreement')
    const updateStart = ACTIONS_SRC.indexOf('export async function updateSellerAgreement')
    const createSrc = ACTIONS_SRC.slice(createStart, updateStart)
    const capIdx = createSrc.indexOf('validateAcceptedItemCountCap(')
    const resolveIdx = createSrc.indexOf('resolveDraftCommissionFields(')
    expect(capIdx).toBeGreaterThan(-1)
    expect(resolveIdx).toBeGreaterThan(-1)
    expect(capIdx).toBeLessThan(resolveIdx)
  })

  it('updateSellerAgreement validates the cap via validateAcceptedItemCountCap before resolveDraftCommissionFields', () => {
    const updateStart = ACTIONS_SRC.indexOf('export async function updateSellerAgreement')
    const proposeStart = ACTIONS_SRC.indexOf('export async function proposeSellerAgreement')
    const updateSrc = ACTIONS_SRC.slice(updateStart, proposeStart)
    const capIdx = updateSrc.indexOf('validateAcceptedItemCountCap(')
    const resolveIdx = updateSrc.indexOf('resolveDraftCommissionFields(')
    expect(capIdx).toBeGreaterThan(-1)
    expect(resolveIdx).toBeGreaterThan(-1)
    expect(capIdx).toBeLessThan(resolveIdx)
  })
})

describe('SellerAgreementForm.tsx: accepted-quantity edits instantly recompute the preview client-side (section 1 UX)', () => {
  const formSrc = readSrc('src/components/admin/SellerAgreementForm.tsx')

  it('the live preview is derived from acceptedItemCount state via the SAME pure resolveCommissionTerms engine (no duplicated tier logic, no network call)', () => {
    expect(formSrc).toContain("import { resolveCommissionTerms } from '@/lib/commissionPolicy'")
    expect(formSrc).toMatch(/useMemo\(\(\) => \{[\s\S]*?resolveCommissionTerms\(/)
  })

  it('the accepted-quantity input is a controlled field (value+onChange), not defaultValue — so preview updates on every keystroke', () => {
    const inputBlock = formSrc.slice(
      formSrc.indexOf('name="acceptedItemCount"') - 200,
      formSrc.indexOf('name="acceptedItemCount"') + 200,
    )
    expect(inputBlock).toMatch(/value=\{acceptedItemCount\}/)
    expect(inputBlock).toMatch(/onChange=\{\(ev\) => setAcceptedItemCount/)
  })
})
