// 19A: postVerify allowlist redirect, credential-exposure structural guards,
// and UI-route existence checks. Magic-link core regression (returnTo,
// upsert-once, single-use token, authMethod='magic_link' stamping) is already
// covered end-to-end in customerModelIntent.test.ts (updated for 19A).
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import {
  isAllowedPostVerify,
  resolvePostVerifyDestination,
} from '@/lib/customerModelIntent'

const root = path.resolve(__dirname, '../../..')
function readSrc(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf-8')
}
function exists(rel: string): boolean {
  return fs.existsSync(path.join(root, rel))
}

// ── postVerify: closed allowlist, never an open redirect ────────────────────────

describe('postVerify: closed allowlist resolves only to fixed local destinations', () => {
  it('setup_password resolves to the fixed profile+setupPassword destination', () => {
    expect(resolvePostVerifyDestination('setup_password')).toBe('/account/profile?setupPassword=1')
  })

  it('password_recovery resolves to the fixed profile+passwordRecovery destination', () => {
    expect(resolvePostVerifyDestination('password_recovery')).toBe('/account/profile?passwordRecovery=1')
  })

  it('any other value (including an attempted arbitrary URL) resolves to null — never a passthrough destination', () => {
    expect(resolvePostVerifyDestination('https://evil.example')).toBeNull()
    expect(resolvePostVerifyDestination('//evil.example')).toBeNull()
    expect(resolvePostVerifyDestination('setup_password_extra')).toBeNull()
    expect(resolvePostVerifyDestination('')).toBeNull()
    expect(resolvePostVerifyDestination(null)).toBeNull()
    expect(resolvePostVerifyDestination(undefined)).toBeNull()
  })

  it('isAllowedPostVerify only accepts the exact two literal values', () => {
    expect(isAllowedPostVerify('setup_password')).toBe(true)
    expect(isAllowedPostVerify('password_recovery')).toBe(true)
    expect(isAllowedPostVerify('setup_password ')).toBe(false)
    expect(isAllowedPostVerify('SETUP_PASSWORD')).toBe(false)
    expect(isAllowedPostVerify(null)).toBe(false)
  })
})

describe('postVerify wiring in verifyBuyerLoginToken: returnTo always takes priority', () => {
  const src = readSrc('src/lib/actions/buyerAuth.ts')

  it('redirect precedence is safeReturnTo, then postVerifyDest, then the /account/orders default', () => {
    expect(src).toContain('redirect(safeReturnTo ?? postVerifyDest ?? \'/account/orders\')')
  })

  it('postVerify is re-validated server-side via resolvePostVerifyDestination, not trusted from formData directly', () => {
    expect(src).toContain('resolvePostVerifyDestination(rawPostVerify)')
  })

  it('createBuyerSession is stamped magic_link on every verify', () => {
    expect(src).toContain("await createBuyerSession(profile.id, 'magic_link')")
  })
})

describe('postVerify wiring in requestBuyerOrderLink: allowlisted before ever reaching the email URL', () => {
  const src = readSrc('src/lib/actions/buyerAuth.ts')

  it('postVerify is validated via isAllowedPostVerify before being embedded in verifyParams', () => {
    const idx = src.indexOf('const safePostVerify = isAllowedPostVerify(rawPostVerify)')
    const embedIdx = src.indexOf("if (safePostVerify) verifyParams.set('postVerify', safePostVerify)")
    expect(idx).toBeGreaterThan(-1)
    expect(embedIdx).toBeGreaterThan(idx)
  })
})

// ── Credential exposure protections ──────────────────────────────────────────────

describe('19A: CustomerCredential is never part of a generic CustomerProfile read', () => {
  it('CustomerProfile model itself has no passwordHash/passwordSalt field', () => {
    const schema = readSrc('prisma/schema.prisma')
    const idx = schema.indexOf('model CustomerProfile {')
    const block = schema.slice(idx, schema.indexOf('\n}', idx))
    expect(block).not.toContain('passwordHash')
    expect(block).not.toContain('passwordSalt')
    // The relation itself is fine — it's a pointer, not the hash.
    expect(block).toContain('credential')
  })

  it('CustomerCredential is a distinct model with its own passwordHash field, one-to-one on profileId', () => {
    const schema = readSrc('prisma/schema.prisma')
    const idx = schema.indexOf('model CustomerCredential {')
    expect(idx).toBeGreaterThan(-1)
    const block = schema.slice(idx, schema.indexOf('\n}', idx))
    expect(block).toContain('passwordHash String')
    expect(block).toContain('profileId    String          @unique')
    // No plaintext-shaped field anywhere in the model.
    expect(block).not.toMatch(/\bpassword\s+String/)
  })

  it('no admin page selects or renders passwordHash', () => {
    const adminDir = path.join(root, 'src/app/(admin)/admin/customers')
    const files = fs.existsSync(adminDir) ? fs.readdirSync(adminDir, { recursive: true }) as string[] : []
    for (const f of files) {
      if (typeof f !== 'string' || !f.endsWith('.tsx')) continue
      const src = fs.readFileSync(path.join(adminDir, f), 'utf-8')
      expect(src).not.toContain('passwordHash')
      expect(src).not.toContain('customerCredential')
    }
  })

  it('no analytics/CSV/export module references passwordHash or customerCredential', () => {
    const candidates = [
      'src/lib/businessAnalyticsQuery.ts',
      'src/lib/managementAnalyticsQuery.ts',
      'src/lib/catalogAnalyticsQuery.ts',
    ]
    for (const rel of candidates) {
      if (!exists(rel)) continue
      const src = readSrc(rel)
      expect(src).not.toContain('passwordHash')
      expect(src).not.toContain('customerCredential')
    }
  })

  it('setPassword/changePassword/loginWithPassword exported action states never carry a passwordHash-shaped field', () => {
    const src = readSrc('src/lib/actions/customerCredential.ts')
    for (const fnName of ['loginWithPassword', 'setPassword', 'changePassword']) {
      const start = src.indexOf(`export async function ${fnName}(`)
      const end = src.indexOf('\nexport async function', start + 1)
      const fnSrc = src.slice(start, end === -1 ? undefined : end)
      // passwordHash appears only in internal DB read/write plumbing
      // (resolveCredential's private return, prisma calls) — never in a `return
      // { ... }` action-state literal, which is what actually reaches the client.
      const returnStatements = fnSrc.match(/return \{[^}]*\}/gs) ?? []
      for (const stmt of returnStatements) {
        expect(stmt).not.toContain('passwordHash')
      }
    }
  })
})

// ── Plaintext-password protections ───────────────────────────────────────────────

describe('19A: no plaintext password logging or persistence', () => {
  it('customerCredential.ts never logs a raw password/currentPassword/newPassword value', () => {
    const src = readSrc('src/lib/actions/customerCredential.ts')
    // logger.warn calls in this file only ever pass event-name strings (which may
    // legitimately contain "password" as part of a dotted event name, e.g.
    // 'customer.password_login.rate_limited_ip') plus requestId/status — never a
    // reference to the actual form-field variables holding submitted values.
    const logCalls = src.match(/logger\.(warn|error|info)\([^)]*\)/gs) ?? []
    for (const call of logCalls) {
      expect(call).not.toMatch(/\bpassword\b|\bnewPassword\b|\bcurrentPassword\b|\bconfirmPassword\b/)
    }
  })

  it('no password field is ever placed in a query string, redirect URL, or hidden GET parameter', () => {
    for (const rel of [
      'src/lib/actions/customerCredential.ts',
      'src/lib/actions/buyerAuth.ts',
      'src/components/store/PasswordSignInForm.tsx',
      'src/components/store/SetPasswordForm.tsx',
      'src/components/store/ChangePasswordForm.tsx',
    ]) {
      const src = readSrc(rel)
      expect(src).not.toMatch(/redirect\([^)]*password/i)
      expect(src).not.toMatch(/URLSearchParams\([^)]*password/i)
    }
  })

  it('password inputs use type="password", not exposed in a visible/hidden text field', () => {
    for (const rel of ['src/components/store/PasswordSignInForm.tsx', 'src/components/store/SetPasswordForm.tsx', 'src/components/store/ChangePasswordForm.tsx']) {
      const src = readSrc(rel)
      const inputs = src.match(/<input[^>]*name="[^"]*[Pp]assword[^"]*"[^>]*>/g) ?? []
      expect(inputs.length).toBeGreaterThan(0)
      for (const input of inputs) {
        expect(input).toContain('type="password"')
      }
    }
  })

  it('CustomerCredential schema has no plaintext password column, only passwordHash', () => {
    const schema = readSrc('prisma/schema.prisma')
    const idx = schema.indexOf('model CustomerCredential {')
    const block = schema.slice(idx, schema.indexOf('\n}', idx))
    expect(block).toMatch(/passwordHash\s+String/)
    expect(block).not.toMatch(/\bplaintextPassword|\brawPassword/)
  })
})

// ── Password hashing/reversibility guard ─────────────────────────────────────────

describe('19A: password hashing never uses SHA-256(password) or reversible encryption', () => {
  it('passwordHash.ts uses crypto.scrypt, never crypto.createHash for the password itself', () => {
    const src = readSrc('src/lib/passwordHash.ts')
    expect(src).toContain('crypto.scrypt(')
    expect(src).not.toContain('createHash')
    expect(src).not.toContain('createCipher')
    expect(src).not.toContain('createDecipher')
  })

  it('no bcrypt/argon2 package import anywhere in the credential/hashing files', () => {
    for (const rel of ['src/lib/passwordHash.ts', 'src/lib/actions/customerCredential.ts']) {
      const src = readSrc(rel)
      expect(src).not.toMatch(/require\(['"]bcrypt|from ['"]bcrypt|from ['"]argon2/)
    }
  })

  it('package.json has zero new hashing dependencies', () => {
    const pkg = JSON.parse(readSrc('package.json'))
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
    for (const forbidden of ['bcrypt', 'bcryptjs', 'argon2']) {
      expect(allDeps).not.toHaveProperty(forbidden)
    }
  })
})

// ── UI routes exist with expected minimal shape ──────────────────────────────────

describe('19A: /account/sign-in exists with password + magic-link + create-account', () => {
  it('page exists', () => {
    expect(exists('src/app/(store)/account/sign-in/page.tsx')).toBe(true)
  })
  it('renders CustomerSignInPanel (composes password form, magic-link form, create-account link)', () => {
    const src = readSrc('src/app/(store)/account/sign-in/page.tsx')
    expect(src).toContain('<CustomerSignInPanel')
  })
  it('PasswordSignInForm has the Email or @handle label, Password field, and Sign In button', () => {
    const src = readSrc('src/components/store/PasswordSignInForm.tsx')
    expect(src).toContain('Email or @handle')
    expect(src).toContain('name="password"')
    expect(src).toContain('Sign In')
  })
  it('CustomerSignInPanel offers the magic-link alternative and a Create account link', () => {
    const src = readSrc('src/components/store/CustomerSignInPanel.tsx')
    expect(src).toContain('Forgot password?')
    expect(src).toContain('BuyerOrderAccessForm')
    expect(src).toContain('Create account')
  })
  it('identifier field uses autoComplete="username", password field uses autoComplete="current-password"', () => {
    const src = readSrc('src/components/store/PasswordSignInForm.tsx')
    expect(src).toContain('autoComplete="username"')
    expect(src).toContain('autoComplete="current-password"')
  })
})

describe('19A: /account/create-account is email-only, verification-first', () => {
  it('page exists', () => {
    expect(exists('src/app/(store)/account/create-account/page.tsx')).toBe(true)
  })
  it('does not render a password field', () => {
    const src = readSrc('src/app/(store)/account/create-account/page.tsx')
    expect(src).not.toMatch(/name="password"|type="password"/)
  })
  it('uses the existing BuyerOrderAccessForm with postVerify="setup_password" — no separate signup action', () => {
    const src = readSrc('src/app/(store)/account/create-account/page.tsx')
    expect(src).toContain('<BuyerOrderAccessForm postVerify="setup_password" />')
  })
  it('copy explains verification-first flow', () => {
    const src = readSrc('src/app/(store)/account/create-account/page.tsx')
    expect(src).toMatch(/verify your account/i)
    expect(src).toMatch(/set your password/i)
  })
})

describe('19A: /account/profile shows Set Password vs Change Password states', () => {
  const src = readSrc('src/app/(store)/account/profile/page.tsx')

  it('queries CustomerCredential existence narrowly (id only)', () => {
    expect(src).toContain('prisma.customerCredential.findUnique({')
    expect(src).toContain('select: { id: true }')
  })
  it('renders SetPasswordForm when no credential exists, ChangePasswordForm when one does', () => {
    expect(src).toContain('<SetPasswordForm')
    expect(src).toContain('<ChangePasswordForm')
    const idx = src.indexOf('credential ?')
    expect(idx).toBeGreaterThan(-1)
  })
  it('passes only a derived boolean (canSkipCurrentPassword) to ChangePasswordForm, never raw session fields', () => {
    expect(src).toContain('canSkipCurrentPassword={canSkipCurrentPassword}')
    expect(src).not.toMatch(/ChangePasswordForm[^/]*sessionContext/)
  })
})

describe('19A: no top-level nav item added', () => {
  it('customerNav.ts is untouched by 19A (no Sign In / Password / Security entry)', () => {
    const src = readSrc('src/lib/customerNav.ts')
    expect(src).not.toMatch(/Sign In|Password|Security/)
  })
})

// ── Scope guard ───────────────────────────────────────────────────────────────────

describe('19A scope guard: no 19B/OAuth/MFA/passkey/device-management overreach', () => {
  it('no guest-seller/OAuth/MFA/passkey/device-management keywords in the new 19A files', () => {
    for (const rel of [
      'src/lib/actions/customerCredential.ts',
      'src/lib/passwordHash.ts',
      'src/components/store/PasswordSignInForm.tsx',
      'src/components/store/CustomerSignInPanel.tsx',
      'src/components/store/SetPasswordForm.tsx',
      'src/components/store/ChangePasswordForm.tsx',
    ]) {
      const src = readSrc(rel)
      expect(src).not.toMatch(/guest.?seller|OAuth|passkey|MFA|device management|google|apple/i)
    }
  })
  it('no CustomerPasswordResetToken / reset-token model was created', () => {
    const schema = readSrc('prisma/schema.prisma')
    expect(schema).not.toContain('CustomerPasswordResetToken')
    expect(schema).not.toContain('model PasswordResetToken')
  })
})
