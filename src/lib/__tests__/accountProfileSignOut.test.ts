/**
 * 16O: /account/profile "Account access" (Sign out) placement + regression
 * coverage for AccountNav/CustomerHeader/global-nav/route architecture.
 * Structural/source-regex checks, mirroring the established convention.
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const root = path.resolve(__dirname, '../../..')
function readSrc(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf-8')
}
function exists(rel: string): boolean {
  return fs.existsSync(path.join(root, rel))
}
function stripComments(src: string): string {
  return src.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n')
}

const pageSrc = readSrc('src/app/(store)/account/profile/page.tsx')
const pageCode = stripComments(pageSrc)

// ── Part G/Q/W/X/AQ: /account/profile Account access section ───────────────────

describe('/account/profile: Account access section (Sign out placement)', () => {
  it('imports signOutBuyer and PendingActionButton', () => {
    expect(pageSrc).toContain("import { signOutBuyer } from '@/lib/actions/buyerAuth'")
    expect(pageSrc).toContain("import { PendingActionButton } from '@/components/store/PendingActionButton'")
  })

  it('renders an "Account access" heading with "Signed in as {email}" using the SAME accountInfo already fetched for the profile form — no second query', () => {
    expect(pageSrc).toContain('Account access')
    expect(pageSrc).toContain('Signed in as')
    expect(pageSrc).toContain('{accountInfo.email}')
    const findManyOrUniqueCalls = [...pageSrc.matchAll(/prisma\.customerProfile\.findUnique\(/g)]
    expect(findManyOrUniqueCalls.length).toBe(1)
  })

  it('Sign out is a real <form action={signOutBuyer}> — not a <Link>/GET navigation', () => {
    expect(pageSrc).toContain('<form action={signOutBuyer}>')
    expect(pageCode).not.toMatch(/<Link[^>]*href="\/logout"|<a[^>]*href="\/logout"/)
  })

  it('uses PendingActionButton (existing useFormStatus pattern) for pending feedback, not a bespoke button', () => {
    expect(pageSrc).toContain('<PendingActionButton')
    expect(pageSrc).toContain('label="Sign out"')
    expect(pageSrc).toContain('pendingLabel="Signing out…"')
  })

  it('Account Info form and Account access form are SIBLING sections, never nested — Save changes cannot trigger sign-out and vice versa', () => {
    const infoSectionIdx = pageSrc.indexOf('<section className="mb-10">')
    const infoSectionEnd = pageSrc.indexOf('</section>', infoSectionIdx)
    const accessSectionIdx = pageSrc.indexOf('Account access')
    expect(accessSectionIdx).toBeGreaterThan(infoSectionEnd)
    // The Account Info section does not itself contain a second <form>.
    const infoSectionBlock = pageSrc.slice(infoSectionIdx, infoSectionEnd)
    expect((infoSectionBlock.match(/<form/g) ?? []).length).toBeLessThanOrEqual(1)
  })

  it('no confirmation dialog / "Are you sure?" — one explicit button is enough', () => {
    expect(pageCode).not.toMatch(/[Aa]re you sure|confirm\(/)
  })

  it('accessible: aria-label present, focus-visible styling present', () => {
    expect(pageSrc).toContain('ariaLabel="Sign out of your account"')
    expect(pageSrc).toContain('focus-visible:outline')
  })

  it('anonymous branch renders no Sign out button, no email/name/phone', () => {
    const anonIdx = pageSrc.indexOf('if (!session) {')
    const anonEnd = pageSrc.indexOf('\n  }\n', anonIdx)
    const anonBlock = pageSrc.slice(anonIdx, anonEnd)
    expect(anonBlock).not.toContain('signOutBuyer')
    expect(anonBlock).not.toContain('accountInfo')
  })

  it('the whole Account access section is gated behind the authenticated accountInfo fetch — never rendered without a resolved session', () => {
    const accessIdx = pageSrc.indexOf('Account access')
    const guardIdx = pageSrc.lastIndexOf('{accountInfo && (', accessIdx)
    expect(guardIdx).toBeGreaterThan(-1)
  })
})

// ── Part D/S: sign-out DB architecture confirmation (no schema, no raw token exposure) ──

describe('Session architecture confirmation (16O verification, no changes expected)', () => {
  it('the buyer_session cookie stores the RAW token; the DB stores only its hash — confirmed, never inverted', () => {
    const src = readSrc('src/lib/buyerSession.ts')
    expect(src).toContain('cookieStore.set(COOKIE_NAME, rawToken,')
    expect(src).toContain('const sessionHash = hashToken(rawToken)')
    // Exact create-call fields:
    expect(src).toContain('data: { profileId, sessionHash, expiresAt }')
  })

  it('no raw session token, session hash, or CustomerSession id is ever rendered/passed to a client component', () => {
    for (const rel of ['src/app/(store)/account/profile/page.tsx', 'src/components/store/CustomerAccountInfoForm.tsx']) {
      const src = readSrc(rel)
      expect(src).not.toMatch(/sessionHash|session\.id|rawToken/)
    }
  })

  it('7-day session lifetime, httpOnly/sameSite=lax/secure-in-production/path=/ cookie options — unchanged', () => {
    const src = readSrc('src/lib/buyerSession.ts')
    expect(src).toContain('const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7')
    expect(src).toContain('httpOnly: true')
    expect(src).toContain("sameSite: 'lax' as const")
    expect(src).toContain("secure: process.env.NODE_ENV === 'production'")
    expect(src).toContain("path: '/'")
  })
})

// ── Part AW: admin session boundary ──────────────────────────────────────────────

describe('Admin session boundary: buyer sign-out never touches admin_session', () => {
  it('buyerAuth.ts / buyerSession.ts never reference admin_session or admin auth helpers', () => {
    for (const rel of ['src/lib/actions/buyerAuth.ts', 'src/lib/buyerSession.ts']) {
      const src = readSrc(rel)
      expect(src).not.toMatch(/admin_session|isAdminAuthenticated|adminAuth/)
    }
  })
  it('admin logout (if any) is a separate, untouched action', () => {
    const adminAuthSrc = readSrc('src/lib/adminAuth.ts')
    expect(adminAuthSrc).toContain('admin_session')
    expect(adminAuthSrc).not.toMatch(/buyer_session|CustomerSession/)
  })
})

// ── Part H/AG/AH: CustomerHeader / AccountNav / global nav — no new UI concept ──

describe('CustomerHeader already has Sign Out (desktop dropdown + mobile menu) — no new dropdown built for 16O', () => {
  const headerSrc = readSrc('src/components/store/CustomerHeader.tsx')

  it('imports and uses the same signOutBuyer action, in both the desktop menu and mobile menu', () => {
    expect(headerSrc).toContain("import { signOutBuyer } from '@/lib/actions/buyerAuth'")
    const formUsages = [...headerSrc.matchAll(/<form action=\{signOutBuyer\}/g)]
    expect(formUsages.length).toBe(2)
  })

  it('16O added no new dropdown/menu component to CustomerHeader.tsx', () => {
    const src = stripComments(headerSrc)
    expect(src).not.toMatch(/16O/)
  })
})

describe('AccountNav: still exactly Overview/Orders/Collection/Wanted & Alerts/Selling/Profile — no Security/Settings/Logout tab', () => {
  it('CUSTOMER_ACCOUNT_LINKS has exactly 6 entries, no new key added', () => {
    const src = readSrc('src/lib/customerNav.ts')
    const arrayMatch = src.match(/CUSTOMER_ACCOUNT_LINKS: CustomerAccountLink\[\] = \[([\s\S]*?)\]/)
    expect(arrayMatch).toBeTruthy()
    const keys = [...(arrayMatch![1].matchAll(/key: '(\w+)'/g))].map((m) => m[1])
    expect(keys).toEqual(['overview', 'orders', 'collection', 'wanted', 'selling', 'settings'])
  })
  it('no "Security", "Settings" (as a distinct nav label), or "Logout" nav entry exists', () => {
    const src = readSrc('src/lib/customerNav.ts')
    expect(src).not.toMatch(/label: 'Security'|label: 'Settings'|label: 'Logout'/)
  })
})

describe('Global nav: still exactly Shop/Sell/Community/Order Status — Account handled separately, no new top-level item', () => {
  it('CUSTOMER_PRIMARY_NAV has exactly 4 entries, unchanged', () => {
    const src = readSrc('src/lib/customerNav.ts')
    const arrayMatch = src.match(/CUSTOMER_PRIMARY_NAV: CustomerNavItem\[\] = \[([\s\S]*?)\]/)
    const keys = [...(arrayMatch![1].matchAll(/key: '(\w+)'/g))].map((m) => m[1])
    expect(keys).toEqual(['shop', 'sell', 'community', 'orderStatus'])
  })
})

// ── Part AF: /account/profile and /account/community remain separate ───────────

describe('/account/profile and /account/community remain separate routes/concerns (16N invariant preserved)', () => {
  it('both routes still exist independently', () => {
    expect(exists('src/app/(store)/account/profile/page.tsx')).toBe(true)
    expect(exists('src/app/(store)/account/community/page.tsx')).toBe(true)
  })
  it('/account/community was not touched by 16O — no signOutBuyer/PendingActionButton reference added there', () => {
    const communitySrc = readSrc('src/app/(store)/account/community/page.tsx')
    expect(communitySrc).not.toContain('signOutBuyer')
  })
})

// ── Part AI: generic auth email copy preserved ──────────────────────────────────

describe('Generic auth email copy preserved (not reverted by 16O)', () => {
  it('magic-link email subject remains "Sign in to your CollectNTrades account"', () => {
    const src = readSrc('src/lib/email/magicLinkEmail.ts')
    expect(src).toContain("const subject = 'Sign in to your CollectNTrades account'")
    expect(src).not.toMatch(/view your order/i)
  })
})

// ── Part AX: no schema/migration changes ────────────────────────────────────────

describe('No schema/migration changes for 16O', () => {
  it('CustomerSession model definition is unchanged (still id/profileId/sessionHash/expiresAt/createdAt)', () => {
    const schema = readSrc('prisma/schema.prisma')
    const block = schema.slice(schema.indexOf('model CustomerSession {'), schema.indexOf('model CustomerSession {') + 400)
    expect(block).toContain('sessionHash String   @unique')
    expect(block).toContain('@@index([profileId])')
  })
})

// ── Part AY: scope guard — no security-milestone functionality ─────────────────

describe('Scope guard: no 16O overreach into future security/settings functionality', () => {
  it('no change-email, password, MFA, passkey, OAuth, device-list, or account-deletion keywords in the sign-out/profile files', () => {
    for (const rel of [
      'src/lib/actions/buyerAuth.ts',
      'src/lib/buyerSession.ts',
      'src/app/(store)/account/profile/page.tsx',
    ]) {
      const src = readSrc(rel)
      expect(src).not.toMatch(/password|MFA|passkey|OAuth|device list|deleteAccount|export my data|trusted device/i)
    }
  })
  it('no /account/security or /account/settings route was created', () => {
    expect(exists('src/app/(store)/account/security')).toBe(false)
    expect(exists('src/app/(store)/account/settings')).toBe(false)
  })
  it('no "Sign out everywhere" / "log out all devices" capability exists', () => {
    for (const rel of ['src/lib/actions/buyerAuth.ts', 'src/lib/buyerSession.ts', 'src/app/(store)/account/profile/page.tsx']) {
      const src = readSrc(rel)
      expect(src).not.toMatch(/everywhere|all devices|deleteMany\(\{\s*where:\s*\{\s*profileId/i)
    }
  })
})

// ── Route regression ──────────────────────────────────────────────────────────────

describe('Route regression: no customer route deleted', () => {
  it('all customer-facing routes from the 16M/16N/16O series still exist', () => {
    for (const rel of [
      'src/app/(store)/account/page.tsx',
      'src/app/(store)/account/profile/page.tsx',
      'src/app/(store)/account/community/page.tsx',
      'src/app/(store)/account/orders/page.tsx',
      'src/app/(store)/account/collection/page.tsx',
      'src/app/(store)/account/wanted/page.tsx',
      'src/app/(store)/account/portfolios/page.tsx',
      'src/app/(store)/account/sell/page.tsx',
      'src/app/(store)/account/continue/page.tsx',
      'src/app/(store)/catalog/page.tsx',
      'src/app/(store)/capture/page.tsx',
    ]) {
      expect(exists(rel)).toBe(true)
    }
  })
})
