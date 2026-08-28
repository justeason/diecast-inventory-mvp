/**
 * Account Info: buyer-editable name/phone with a read-only login email.
 * Behavioral tests for updateCustomerAccountInfo (mocked prisma/session) plus
 * structural/source-regex checks for the form component and the /account/community
 * page wiring, mirroring the established convention used throughout this app.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'

const root = path.resolve(__dirname, '../../..')
function readSrc(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf-8')
}
function stripComments(src: string): string {
  return src.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n')
}

type Mock = ReturnType<typeof vi.fn>

vi.mock('@/lib/prisma', () => ({
  prisma: { customerProfile: { updateMany: vi.fn() } },
}))
vi.mock('@/lib/buyerSession', () => ({ getBuyerSession: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { prisma } from '@/lib/prisma'
import { getBuyerSession } from '@/lib/buyerSession'
import { revalidatePath } from 'next/cache'
import { updateCustomerAccountInfo } from '@/lib/actions/customerAccount'

beforeEach(() => vi.resetAllMocks())

function fd(fields: Record<string, string>): FormData {
  const f = new FormData()
  for (const [k, v] of Object.entries(fields)) f.set(k, v)
  return f
}

const VALID_TS = new Date('2024-01-01T00:00:00.000Z').toISOString()

// ── Auth gate ──────────────────────────────────────────────────────────────────

describe('updateCustomerAccountInfo: auth gate', () => {
  it('anonymous → generic sign-in error, no DB call', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue(null)
    const result = await updateCustomerAccountInfo(null, fd({ name: 'Bob', phone: '', expectedUpdatedAt: VALID_TS }))
    expect(result).toEqual({ errors: { _form: ['You must be signed in.'] } })
    expect(prisma.customerProfile.updateMany).not.toHaveBeenCalled()
  })
})

// ── Validation ─────────────────────────────────────────────────────────────────

describe('updateCustomerAccountInfo: name validation', () => {
  beforeEach(() => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
  })

  it('name over 100 chars is rejected, no DB call', async () => {
    const result = await updateCustomerAccountInfo(null, fd({ name: 'x'.repeat(101), phone: '', expectedUpdatedAt: VALID_TS }))
    expect(result?.errors?.name?.[0]).toMatch(/100 characters/)
    expect(prisma.customerProfile.updateMany).not.toHaveBeenCalled()
  })

  it('name with control characters is rejected', async () => {
    const result = await updateCustomerAccountInfo(null, fd({ name: 'Bob\x00', phone: '', expectedUpdatedAt: VALID_TS }))
    expect(result?.errors?.name?.[0]).toMatch(/invalid characters/)
  })

  it('a normal name is accepted', async () => {
    ;(prisma.customerProfile.updateMany as Mock).mockResolvedValue({ count: 1 })
    const result = await updateCustomerAccountInfo(null, fd({ name: 'Bob Smith', phone: '', expectedUpdatedAt: VALID_TS }))
    expect(result).toEqual({ success: true })
  })

  it('blank name is accepted and stored as null (schema allows optional name)', async () => {
    ;(prisma.customerProfile.updateMany as Mock).mockResolvedValue({ count: 1 })
    await updateCustomerAccountInfo(null, fd({ name: '   ', phone: '', expectedUpdatedAt: VALID_TS }))
    const call = (prisma.customerProfile.updateMany as Mock).mock.calls[0][0]
    expect(call.data.name).toBeNull()
  })
})

describe('updateCustomerAccountInfo: phone validation', () => {
  beforeEach(() => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
  })

  it('phone over 30 chars is rejected', async () => {
    const result = await updateCustomerAccountInfo(null, fd({ name: '', phone: '1'.repeat(31), expectedUpdatedAt: VALID_TS }))
    expect(result?.errors?.phone?.[0]).toMatch(/30 characters/)
  })

  it('phone with letters/injection characters is rejected', async () => {
    const result = await updateCustomerAccountInfo(null, fd({ name: '', phone: '<script>alert(1)</script>', expectedUpdatedAt: VALID_TS }))
    expect(result?.errors?.phone?.[0]).toBe('Enter a valid phone number.')
  })

  it('common phone formats (digits, spaces, parens, dashes, plus) are accepted', async () => {
    ;(prisma.customerProfile.updateMany as Mock).mockResolvedValue({ count: 1 })
    for (const phone of ['(555) 555-5555', '+1 555 555 5555', '555.555.5555', '5555555555']) {
      const result = await updateCustomerAccountInfo(null, fd({ name: '', phone, expectedUpdatedAt: VALID_TS }))
      expect(result).toEqual({ success: true })
    }
  })

  it('blank phone is accepted and stored as null (optional field)', async () => {
    ;(prisma.customerProfile.updateMany as Mock).mockResolvedValue({ count: 1 })
    await updateCustomerAccountInfo(null, fd({ name: '', phone: '', expectedUpdatedAt: VALID_TS }))
    const call = (prisma.customerProfile.updateMany as Mock).mock.calls[0][0]
    expect(call.data.phone).toBeNull()
  })
})

// ── Email is never editable via this action ─────────────────────────────────────

describe('updateCustomerAccountInfo: email is read-only — never accepted or written', () => {
  it('an "email" field in formData is silently ignored — never read, never passed to updateMany', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
    ;(prisma.customerProfile.updateMany as Mock).mockResolvedValue({ count: 1 })
    await updateCustomerAccountInfo(null, fd({ name: 'Bob', phone: '', email: 'attacker@evil.com', expectedUpdatedAt: VALID_TS }))
    const call = (prisma.customerProfile.updateMany as Mock).mock.calls[0][0]
    expect(call.data).not.toHaveProperty('email')
  })

  it('source: the action never reads formData.get(\'email\')', () => {
    const src = readSrc('src/lib/actions/customerAccount.ts')
    expect(src).not.toContain("formData.get('email')")
  })
})

// ── Concurrency ────────────────────────────────────────────────────────────────

describe('updateCustomerAccountInfo: optimistic concurrency (expectedUpdatedAt)', () => {
  beforeEach(() => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
  })

  it('missing expectedUpdatedAt → safe error, no DB call', async () => {
    const result = await updateCustomerAccountInfo(null, fd({ name: 'Bob', phone: '' }))
    expect(result?.errors?._form?.[0]).toMatch(/refresh/i)
    expect(prisma.customerProfile.updateMany).not.toHaveBeenCalled()
  })

  it('malformed expectedUpdatedAt → safe error, no DB call', async () => {
    const result = await updateCustomerAccountInfo(null, fd({ name: 'Bob', phone: '', expectedUpdatedAt: 'not-a-date' }))
    expect(result?.errors?._form?.[0]).toMatch(/refresh/i)
    expect(prisma.customerProfile.updateMany).not.toHaveBeenCalled()
  })

  it('updateMany count:0 (stale row — updated elsewhere) → safe conflict error', async () => {
    ;(prisma.customerProfile.updateMany as Mock).mockResolvedValue({ count: 0 })
    const result = await updateCustomerAccountInfo(null, fd({ name: 'Bob', phone: '', expectedUpdatedAt: VALID_TS }))
    expect(result?.errors?._form?.[0]).toMatch(/updated elsewhere/i)
  })

  it('updateMany is scoped by both id AND updatedAt in its where clause — never id alone', async () => {
    ;(prisma.customerProfile.updateMany as Mock).mockResolvedValue({ count: 1 })
    await updateCustomerAccountInfo(null, fd({ name: 'Bob', phone: '', expectedUpdatedAt: VALID_TS }))
    const call = (prisma.customerProfile.updateMany as Mock).mock.calls[0][0]
    expect(call.where).toEqual({ id: 'p1', updatedAt: new Date(VALID_TS) })
  })
})

// ── Ownership scoping ──────────────────────────────────────────────────────────

describe('updateCustomerAccountInfo: scoped to the session\'s own profile only', () => {
  it('the where clause uses session.profileId, never a client-supplied id', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
    ;(prisma.customerProfile.updateMany as Mock).mockResolvedValue({ count: 1 })
    await updateCustomerAccountInfo(null, fd({ name: 'Bob', phone: '', id: 'someone-elses-id', expectedUpdatedAt: VALID_TS }))
    const call = (prisma.customerProfile.updateMany as Mock).mock.calls[0][0]
    expect(call.where.id).toBe('p1')
  })
})

// ── Revalidation ───────────────────────────────────────────────────────────────

describe('updateCustomerAccountInfo: narrow revalidation on success only', () => {
  it('revalidates /account/profile only on success — /account/community and /account overview neither display name/phone, so neither needs it (16N)', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
    ;(prisma.customerProfile.updateMany as Mock).mockResolvedValue({ count: 1 })
    await updateCustomerAccountInfo(null, fd({ name: 'Bob', phone: '', expectedUpdatedAt: VALID_TS }))
    expect(revalidatePath).toHaveBeenCalledWith('/account/profile')
    expect(revalidatePath).toHaveBeenCalledTimes(1)
  })

  it('/account overview genuinely does not display CustomerProfile.name/phone (proves the dropped /account revalidation is safe, not just assumed)', () => {
    const overviewPageSrc = readSrc('src/app/(store)/account/page.tsx')
    expect(overviewPageSrc).not.toMatch(/\.name\b|\.phone\b/)
  })

  it('/account/community genuinely does not read CustomerProfile.name/phone (proves the dropped revalidation there is safe)', () => {
    const communityPageSrc = readSrc('src/app/(store)/account/community/page.tsx')
    expect(communityPageSrc).not.toContain('prisma.customerProfile.findUnique')
  })

  it('does not revalidate on validation failure or concurrency conflict', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
    await updateCustomerAccountInfo(null, fd({ name: 'x'.repeat(200), phone: '', expectedUpdatedAt: VALID_TS }))
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('never broadly revalidates the whole layout', () => {
    const src = readSrc('src/lib/actions/customerAccount.ts')
    expect(src).not.toMatch(/revalidatePath\('\/',\s*'layout'\)/)
  })
})

// ── No forbidden scope (password/deletion/address/notification redesign) ───────

describe('scope guard: no password/deletion/address/notification-redesign functionality added', () => {
  const actionSrc = stripComments(readSrc('src/lib/actions/customerAccount.ts'))
  const formSrc = stripComments(readSrc('src/components/store/CustomerAccountInfoForm.tsx'))
  const pageSrc = readSrc('src/app/(store)/account/community/page.tsx')

  it('no password field/hashing/auth-redesign keywords', () => {
    for (const src of [actionSrc, formSrc]) {
      expect(src).not.toMatch(/password|bcrypt|argon2/i)
    }
  })
  it('no account-deletion capability', () => {
    for (const src of [actionSrc, formSrc]) {
      expect(src).not.toMatch(/deleteAccount|customerProfile\.delete/i)
    }
  })
  it('no address/payment-method form fields (name="address" etc.)', () => {
    for (const src of [actionSrc, formSrc]) {
      expect(src).not.toMatch(/name="address"|paymentMethod|creditCard|billingAddress/i)
    }
  })
  it('no change-email workflow (no email input field, no email-verification-token issuance in this action)', () => {
    expect(formSrc).not.toMatch(/<input[^>]*name="email"/)
    expect(actionSrc).not.toMatch(/CustomerLoginToken|verifyEmailChange/)
  })
  it('no notification-preference redesign (BuyerAlertPreference untouched)', () => {
    expect(actionSrc).not.toMatch(/BuyerAlertPreference|alertPreference/)
    expect(pageSrc).not.toMatch(/BuyerAlertPreference|alertPreference/)
  })
})

// ── Component structural checks ─────────────────────────────────────────────────

describe('CustomerAccountInfoForm: email read-only, name/phone editable', () => {
  const formSrc = readSrc('src/components/store/CustomerAccountInfoForm.tsx')
  const formCode = stripComments(formSrc)

  it('email is rendered as plain text, not an input', () => {
    expect(formSrc).toContain('{existing.email}')
    expect(formCode).not.toMatch(/<input[^>]*existing\.email/)
  })

  it('name and phone are real inputs with matching labels (htmlFor/id pairs)', () => {
    expect(formSrc).toContain('htmlFor="account-name"')
    expect(formSrc).toContain('id="account-name"')
    expect(formSrc).toContain('name="name"')
    expect(formSrc).toContain('htmlFor="account-phone"')
    expect(formSrc).toContain('id="account-phone"')
    expect(formSrc).toContain('name="phone"')
  })

  it('expectedUpdatedAt is submitted as a hidden field, sourced from the server-fetched `existing` prop', () => {
    expect(formSrc).toContain('<input type="hidden" name="expectedUpdatedAt" value={existing.updatedAt} />')
  })

  it('reuses the established useActionState + useFormStatus pending-button pattern', () => {
    expect(formSrc).toContain("import { useActionState } from 'react'")
    expect(formSrc).toContain("import { useFormStatus } from 'react-dom'")
  })
})

// ── Page wiring ────────────────────────────────────────────────────────────────

// 16N: Account Info moved OUT of /account/community onto its own canonical
// private route, /account/profile — private account/contact identity
// (CustomerProfile: email/name/phone) must never live primarily under the public
// Community persona route (CustomerCommunityProfile: handle/displayName/bio).

describe('/account/profile: canonical private account/contact identity route', () => {
  const pageSrc = readSrc('src/app/(store)/account/profile/page.tsx')
  const pageCode = stripComments(pageSrc)

  it('exists', () => {
    expect(fs.existsSync(path.join(root, 'src/app/(store)/account/profile/page.tsx'))).toBe(true)
  })

  it('fetches CustomerProfile name/phone/email/updatedAt for the current session only — notes is never selected (stays internal)', () => {
    expect(pageSrc).toContain('prisma.customerProfile.findUnique({')
    expect(pageSrc).toContain('where: { id: session.profileId }')
    expect(pageSrc).toContain('select: { name: true, phone: true, email: true, updatedAt: true }')
    expect(pageSrc).not.toMatch(/notes:\s*true/)
  })

  it('renders CustomerAccountInfoForm only — no CommunityProfileForm/handle/bio/avatar editing here', () => {
    expect(pageSrc).toContain('<CustomerAccountInfoForm')
    expect(pageCode).not.toMatch(/CommunityProfileForm|handle|displayName|bio|avatar/i)
  })

  it('exactly one h1 renders per request — anonymous and authenticated branches are mutually exclusive, both labelled "Profile"', () => {
    const h1s = [...pageCode.matchAll(/<h1/g)]
    expect(h1s.length).toBe(2)
    expect(pageSrc.match(/>Profile<\/h1>/g)?.length).toBe(2)
  })

  it('anonymous visitors see the existing sign-in form, no CustomerProfile data fetched, no row created merely by visiting', () => {
    const anonIdx = pageSrc.indexOf('if (!session) {')
    const anonEnd = pageSrc.indexOf('\n  }\n', anonIdx)
    const anonBlock = pageSrc.slice(anonIdx, anonEnd)
    expect(anonBlock).toContain('<BuyerOrderAccessForm')
    expect(anonBlock).not.toContain('customerProfile.findUnique')
    expect(pageCode).not.toMatch(/customerProfile\.(create|upsert)/)
  })

  it('AccountNav "Profile" entry now resolves here', () => {
    const navSrc = readSrc('src/lib/customerNav.ts')
    expect(navSrc).toContain("{ key: 'settings', label: 'Profile', href: '/account/profile' }")
  })
})

describe('/account/community: restored to Community-only scope, no private identity form', () => {
  const pageSrc = readSrc('src/app/(store)/account/community/page.tsx')
  const pageCode = stripComments(pageSrc)

  it('still exists', () => {
    expect(fs.existsSync(path.join(root, 'src/app/(store)/account/community/page.tsx'))).toBe(true)
  })

  it('h1 reads "Community Profile" again, not generic "Profile"', () => {
    expect(pageSrc).toContain('>Community Profile</h1>')
  })

  it('renders CommunityProfileForm only — CustomerAccountInfoForm is NOT present', () => {
    expect(pageSrc).toContain('<CommunityProfileForm')
    expect(pageCode).not.toContain('CustomerAccountInfoForm')
  })

  it('never fetches CustomerProfile.name/phone/email — only CustomerCommunityProfile fields', () => {
    expect(pageSrc).not.toContain('prisma.customerProfile.findUnique')
    expect(pageSrc).toContain('prisma.customerCommunityProfile.findUnique({')
    expect(pageSrc).toContain('select: { handle: true, displayName: true, bio: true, isPublic: true, showOnLeaderboards: true }')
  })

  it('offers an optional contextual link to /account/profile (not required, but present)', () => {
    expect(pageSrc).toContain('href="/account/profile"')
  })

  it('metadata title reads "Community Profile", not generic "Profile"', () => {
    expect(pageSrc).toContain("title: 'Community Profile | CollectNTrades'")
  })
})

// ── Identity boundary: neither write path touches the other's fields ───────────

describe('Identity boundary: private account identity and public Community identity never write into each other', () => {
  const accountActionSrc = stripComments(readSrc('src/lib/actions/customerAccount.ts'))
  const communityActionSrc = stripComments(readSrc('src/lib/actions/community.ts'))

  it('updateCustomerAccountInfo never references customerCommunityProfile (handle/displayName/bio/isPublic/showOnLeaderboards)', () => {
    expect(accountActionSrc).not.toMatch(/customerCommunityProfile/)
  })

  it('saveCommunityProfile never references customerProfile.update/upsert (email/name/phone)', () => {
    expect(communityActionSrc).not.toMatch(/customerProfile\.(update|upsert|create)/)
  })

  it('CustomerCommunityProfile.displayName is a genuinely separate field from CustomerProfile.name — confirmed via schema, not assumed', () => {
    const schema = readSrc('prisma/schema.prisma')
    const communityBlock = schema.slice(schema.indexOf('model CustomerCommunityProfile {'), schema.indexOf('model CustomerCommunityProfile {') + 500)
    expect(communityBlock).toContain('displayName')
    expect(communityBlock).not.toContain('name               String?') // that's CustomerProfile's own field shape, not present here
  })

  it('no synchronization code exists between the two models (no read-then-write-the-other-model pattern)', () => {
    for (const src of [accountActionSrc, communityActionSrc]) {
      expect(src).not.toMatch(/synchroniz|\bmirror\b/i)
    }
  })
})

// ── First-time (16M) customer — email-only profile works immediately ───────────

describe('First-time 16M customer: email-set/name-null/phone-null profile is fully usable on /account/profile', () => {
  it('a freshly-verified profile (name: null, phone: null) saves successfully — no mandatory Community setup required first', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'first-timer' })
    ;(prisma.customerProfile.updateMany as Mock).mockResolvedValue({ count: 1 })
    const result = await updateCustomerAccountInfo(null, fd({ name: 'New Customer', phone: '', expectedUpdatedAt: VALID_TS }))
    expect(result).toEqual({ success: true })
  })

  it('the page renders CustomerAccountInfoForm unconditionally whenever accountInfo exists — not gated on a Community profile existing', () => {
    const pageSrc = readSrc('src/app/(store)/account/profile/page.tsx')
    expect(pageSrc).not.toMatch(/communityProfile|customerCommunityProfile/)
  })
})

// ── Consecutive saves: expectedUpdatedAt must not go stale after success ───────

describe('Consecutive successful edits: hidden expectedUpdatedAt refreshes without a hard reload', () => {
  it('the hidden field value is derived directly from the `existing` prop every render — no useState/useRef snapshot frozen at mount', () => {
    const formSrc = readSrc('src/components/store/CustomerAccountInfoForm.tsx')
    expect(formSrc).toContain('<input type="hidden" name="expectedUpdatedAt" value={existing.updatedAt} />')
    expect(formSrc).not.toMatch(/useState.*updatedAt|useRef.*updatedAt/i)
  })

  it('a successful save calls revalidatePath(\'/account/profile\') — the exact route whose Server Component re-fetches accountInfo.updatedAt and re-renders CustomerAccountInfoForm with the fresh prop on the next request', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
    ;(prisma.customerProfile.updateMany as Mock).mockResolvedValue({ count: 1 })
    await updateCustomerAccountInfo(null, fd({ name: 'Jane', phone: '', expectedUpdatedAt: VALID_TS }))
    expect(revalidatePath).toHaveBeenCalledWith('/account/profile')
  })

  it('two sequential saves each succeed independently when each carries the updatedAt returned by the PRIOR successful save (simulates the real re-render cycle)', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })

    ;(prisma.customerProfile.updateMany as Mock).mockResolvedValueOnce({ count: 1 })
    const first = await updateCustomerAccountInfo(null, fd({ name: 'Jane', phone: '', expectedUpdatedAt: VALID_TS }))
    expect(first).toEqual({ success: true })

    // Server re-fetch after the first save would return a NEW updatedAt (Prisma's
    // @updatedAt bumps on every write) — the second save uses that new value, not
    // the original VALID_TS, exactly as the re-rendered hidden field would.
    const secondTimestamp = new Date('2024-01-01T00:05:00.000Z').toISOString()
    ;(prisma.customerProfile.updateMany as Mock).mockResolvedValueOnce({ count: 1 })
    const second = await updateCustomerAccountInfo(null, fd({ name: 'Jane Smith', phone: '', expectedUpdatedAt: secondTimestamp }))
    expect(second).toEqual({ success: true })

    const secondCall = (prisma.customerProfile.updateMany as Mock).mock.calls[1][0]
    expect(secondCall.where.updatedAt).toEqual(new Date(secondTimestamp))
  })
})

// ── IDOR / mass-assignment protection ───────────────────────────────────────────

describe('IDOR / mass-assignment protection (unchanged by the route move)', () => {
  it('updateMany writes ONLY name/phone — never an arbitrary formData field (e.g. a spoofed "email" or "id" key)', async () => {
    ;(getBuyerSession as Mock).mockResolvedValue({ profileId: 'p1' })
    ;(prisma.customerProfile.updateMany as Mock).mockResolvedValue({ count: 1 })
    await updateCustomerAccountInfo(null, fd({
      name: 'Bob', phone: '', expectedUpdatedAt: VALID_TS,
      id: 'attacker-id', email: 'attacker@evil.com', notes: 'injected', isAdmin: 'true',
    }))
    const call = (prisma.customerProfile.updateMany as Mock).mock.calls[0][0]
    expect(Object.keys(call.data).sort()).toEqual(['name', 'phone'])
  })

  it('the where clause is always keyed by the session\'s own profileId, never any client-supplied identifier', () => {
    const src = stripComments(readSrc('src/lib/actions/customerAccount.ts'))
    expect(src).toContain('where: { id: session.profileId, updatedAt: expectedUpdatedAt }')
  })
})

// ── notes remain private ────────────────────────────────────────────────────────

describe('CustomerProfile.notes stays internal/admin-only — never selected, rendered, or writable here', () => {
  it('the action never reads or writes `notes`', () => {
    const src = stripComments(readSrc('src/lib/actions/customerAccount.ts'))
    expect(src).not.toMatch(/notes/)
  })
  it('the /account/profile page select clause omits `notes`', () => {
    const pageSrc = readSrc('src/app/(store)/account/profile/page.tsx')
    expect(pageSrc).toContain('select: { name: true, phone: true, email: true, updatedAt: true }')
    expect(pageSrc).not.toMatch(/notes:\s*true/)
  })
  it('the form component never renders a notes field', () => {
    const formSrc = readSrc('src/components/store/CustomerAccountInfoForm.tsx')
    expect(formSrc).not.toMatch(/notes/i)
  })
})
