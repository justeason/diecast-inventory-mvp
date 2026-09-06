// 19A: passwordHash.ts — Node built-in crypto.scrypt, self-describing encoded
// hash (scrypt$v1$N$r$p$salt$key). Real scrypt calls here (not mocked) since
// this file specifically tests the hashing primitive itself — kept to a small,
// bounded number of calls (~10-15 total across the whole file, each ~30ms
// locally per the 19A benchmark) rather than hundreds.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import crypto from 'crypto'
import { hashPassword, verifyPassword, getDummyHash, SCRYPT_N, SCRYPT_R, SCRYPT_P, KEY_LENGTH } from '@/lib/passwordHash'

describe('passwordHash: hash format', () => {
  it('hash never equals the plaintext password', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(hash).not.toBe('correct horse battery staple')
  })

  it('encoded hash has the expected scrypt$v1$N$r$p$salt$key shape', async () => {
    const hash = await hashPassword('a-reasonable-password')
    const parts = hash.split('$')
    expect(parts).toHaveLength(7)
    expect(parts[0]).toBe('scrypt')
    expect(parts[1]).toBe('v1')
    expect(Number(parts[2])).toBe(SCRYPT_N)
    expect(Number(parts[3])).toBe(SCRYPT_R)
    expect(Number(parts[4])).toBe(SCRYPT_P)
  })

  it('random salts: hashing the same password twice yields different stored strings', async () => {
    const [h1, h2] = await Promise.all([hashPassword('same-password-both-times'), hashPassword('same-password-both-times')])
    expect(h1).not.toBe(h2)
  })
})

describe('passwordHash: verification', () => {
  it('correct password verifies true', async () => {
    const hash = await hashPassword('my-real-password-123')
    expect(await verifyPassword('my-real-password-123', hash)).toBe(true)
  })

  it('wrong password verifies false', async () => {
    const hash = await hashPassword('my-real-password-123')
    expect(await verifyPassword('not-the-right-password', hash)).toBe(false)
  })

  it('Unicode passwords hash and verify correctly', async () => {
    const password = '密码パスワード🔒emoji-and-mixed-scripts'
    const hash = await hashPassword(password)
    expect(await verifyPassword(password, hash)).toBe(true)
    expect(await verifyPassword('wrong', hash)).toBe(false)
  })

  it('passwords with leading/trailing/internal spaces are never trimmed', async () => {
    const password = '  spaced out password  '
    const hash = await hashPassword(password)
    expect(await verifyPassword(password, hash)).toBe(true)
    expect(await verifyPassword(password.trim(), hash)).toBe(false)
  })
})

describe('passwordHash: malformed stored hash fails safely', () => {
  it('completely garbage string returns false, never throws', async () => {
    await expect(verifyPassword('anything', 'not-a-real-hash')).resolves.toBe(false)
  })

  it('wrong number of $-separated parts returns false', async () => {
    await expect(verifyPassword('anything', 'scrypt$v1$16384$8$1$onlysalt')).resolves.toBe(false)
  })

  it('wrong algorithm tag returns false', async () => {
    const hash = await hashPassword('x')
    const tampered = hash.replace(/^scrypt/, 'bcrypt')
    await expect(verifyPassword('x', tampered)).resolves.toBe(false)
  })

  it('wrong format version returns false', async () => {
    const hash = await hashPassword('x')
    const tampered = hash.replace('$v1$', '$v2$')
    await expect(verifyPassword('x', tampered)).resolves.toBe(false)
  })

  it('non-numeric N/r/p returns false', async () => {
    await expect(verifyPassword('x', 'scrypt$v1$abc$8$1$c2FsdA$a2V5')).resolves.toBe(false)
  })

  it('invalid base64url salt/key returns false, not a thrown error', async () => {
    await expect(verifyPassword('x', 'scrypt$v1$16384$8$1$!!!not-base64!!!$!!!also-not!!!')).resolves.toBe(false)
  })
})

// 19A Final Reconciliation §3/§9: passwordHash is STORED DATA — a corrupted or
// tampered row must never be able to make verification invoke crypto.scrypt
// with attacker-controlled cost or memory. Every case here spies on
// crypto.scrypt to PROVE it is never called at all for a rejected tuple —
// rejection must happen during parsing, before scrypt runs, so a huge stored N
// can never actually cost real CPU/memory even once.
describe('passwordHash: stored N/r/p/salt/key are validated against a fixed trusted tuple before crypto.scrypt ever runs', () => {
  // Spy is installed/restored per-test (not at describe-collection time) so it
  // never records calls made by unrelated tests elsewhere in this file — a
  // module-level vi.spyOn here would otherwise wrap crypto.scrypt for the
  // remainder of the whole file's run, accumulating call counts across
  // unrelated describe blocks.
  let scryptSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => { scryptSpy = vi.spyOn(crypto, 'scrypt') })
  afterEach(() => scryptSpy.mockRestore())

  const validSaltB64 = Buffer.alloc(16, 1).toString('base64url')
  const validKeyB64 = Buffer.alloc(64, 2).toString('base64url')

  async function expectRejectedWithoutScryptCall(encoded: string) {
    const result = await verifyPassword('anything', encoded)
    expect(result).toBe(false)
    expect(scryptSpy).not.toHaveBeenCalled()
  }

  it('absurdly large N is rejected without ever calling crypto.scrypt', async () => {
    await expectRejectedWithoutScryptCall(`scrypt$v1$1073741824$8$1$${validSaltB64}$${validKeyB64}`)
  })

  it('absurdly large r is rejected without ever calling crypto.scrypt', async () => {
    await expectRejectedWithoutScryptCall(`scrypt$v1$16384$999999999$1$${validSaltB64}$${validKeyB64}`)
  })

  it('absurdly large p is rejected without ever calling crypto.scrypt', async () => {
    await expectRejectedWithoutScryptCall(`scrypt$v1$16384$8$999999999$${validSaltB64}$${validKeyB64}`)
  })

  it('negative N/r/p is rejected without ever calling crypto.scrypt', async () => {
    await expectRejectedWithoutScryptCall(`scrypt$v1$-16384$8$1$${validSaltB64}$${validKeyB64}`)
    await expectRejectedWithoutScryptCall(`scrypt$v1$16384$-8$1$${validSaltB64}$${validKeyB64}`)
    await expectRejectedWithoutScryptCall(`scrypt$v1$16384$8$-1$${validSaltB64}$${validKeyB64}`)
  })

  it('NaN-like / non-canonical numeric text is rejected without ever calling crypto.scrypt', async () => {
    await expectRejectedWithoutScryptCall(`scrypt$v1$NaN$8$1$${validSaltB64}$${validKeyB64}`)
    await expectRejectedWithoutScryptCall(`scrypt$v1$Infinity$8$1$${validSaltB64}$${validKeyB64}`)
    await expectRejectedWithoutScryptCall(`scrypt$v1$1.6e4$8$1$${validSaltB64}$${validKeyB64}`)
    await expectRejectedWithoutScryptCall(`scrypt$v1$016384$8$1$${validSaltB64}$${validKeyB64}`) // non-canonical leading zero
    await expectRejectedWithoutScryptCall(`scrypt$v1$+16384$8$1$${validSaltB64}$${validKeyB64}`) // non-canonical leading +
  })

  it('wrong version tag is rejected without ever calling crypto.scrypt', async () => {
    await expectRejectedWithoutScryptCall(`scrypt$v2$16384$8$1$${validSaltB64}$${validKeyB64}`)
  })

  it('wrong algorithm tag is rejected without ever calling crypto.scrypt', async () => {
    await expectRejectedWithoutScryptCall(`bcrypt$v1$16384$8$1$${validSaltB64}$${validKeyB64}`)
  })

  it('invalid base64url salt/key is rejected without ever calling crypto.scrypt', async () => {
    await expectRejectedWithoutScryptCall(`scrypt$v1$16384$8$1$!!!not-base64!!!$${validKeyB64}`)
    await expectRejectedWithoutScryptCall(`scrypt$v1$16384$8$1$${validSaltB64}$!!!not-base64!!!`)
  })

  it('wrong salt length (0 or absurdly long) is rejected without ever calling crypto.scrypt', async () => {
    await expectRejectedWithoutScryptCall(`scrypt$v1$16384$8$1$$${validKeyB64}`)
    const hugeSalt = Buffer.alloc(10_000, 1).toString('base64url')
    await expectRejectedWithoutScryptCall(`scrypt$v1$16384$8$1$${hugeSalt}$${validKeyB64}`)
  })

  it('19A Final Salt-Format Tightening: v1 salt length must be EXACTLY 16 bytes — 15 and 17 both rejected without ever calling crypto.scrypt', async () => {
    const salt15 = Buffer.alloc(15, 1).toString('base64url')
    const salt17 = Buffer.alloc(17, 1).toString('base64url')
    await expectRejectedWithoutScryptCall(`scrypt$v1$16384$8$1$${salt15}$${validKeyB64}`)
    await expectRejectedWithoutScryptCall(`scrypt$v1$16384$8$1$${salt17}$${validKeyB64}`)
  })

  it('19A Final Salt-Format Tightening: a valid 16-byte salt takes the normal verify path (reaches crypto.scrypt, verifies correctly)', async () => {
    const salt16 = crypto.randomBytes(16)
    const derivedKey = await new Promise<Buffer>((resolve, reject) => {
      crypto.scrypt('control-password', salt16, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 }, (err, key) => {
        if (err) reject(err); else resolve(key)
      })
    })
    scryptSpy.mockClear()
    const encoded = ['scrypt', 'v1', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt16.toString('base64url'), derivedKey.toString('base64url')].join('$')

    expect(await verifyPassword('control-password', encoded)).toBe(true)
    expect(scryptSpy).toHaveBeenCalledTimes(1)
    expect(await verifyPassword('wrong-password', encoded)).toBe(false)
  })

  it('wrong derived-key length is rejected without ever calling crypto.scrypt', async () => {
    const shortKey = Buffer.alloc(8, 2).toString('base64url')
    await expectRejectedWithoutScryptCall(`scrypt$v1$16384$8$1$${validSaltB64}$${shortKey}`)
    const longKey = Buffer.alloc(4096, 2).toString('base64url')
    await expectRejectedWithoutScryptCall(`scrypt$v1$16384$8$1$${validSaltB64}$${longKey}`)
  })

  it('extra or missing $-separated components are rejected without ever calling crypto.scrypt', async () => {
    await expectRejectedWithoutScryptCall(`scrypt$v1$16384$8$1$${validSaltB64}$${validKeyB64}$extra`)
    await expectRejectedWithoutScryptCall(`scrypt$v1$16384$8$${validSaltB64}$${validKeyB64}`)
  })

  it('a genuinely valid stored hash DOES reach crypto.scrypt exactly once, with the fixed trusted tuple — proves the spy itself is wired correctly', async () => {
    const hash = await hashPassword('control-case')
    scryptSpy.mockClear()
    await verifyPassword('control-case', hash)
    expect(scryptSpy).toHaveBeenCalledTimes(1)
    const [, , , options] = scryptSpy.mock.calls[0]
    expect(options).toMatchObject({ N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
  })
})

describe('passwordHash: dummy hash for enumeration-timing resistance', () => {
  it('getDummyHash returns a valid, stable, non-matching hash', async () => {
    const dummy1 = await getDummyHash()
    const dummy2 = await getDummyHash()
    expect(dummy1).toBe(dummy2) // computed once, not per-call
    expect(dummy1.startsWith('scrypt$v1$')).toBe(true)
  })

  it('no real password verifies true against the dummy hash', async () => {
    const dummy = await getDummyHash()
    expect(await verifyPassword('password123', dummy)).toBe(false)
    expect(await verifyPassword('', dummy)).toBe(false)
  })
})

describe('passwordHash: key length', () => {
  it('derived key length matches KEY_LENGTH (64 bytes) when decoded', async () => {
    const hash = await hashPassword('check-key-length')
    const keyB64 = hash.split('$')[6]
    expect(Buffer.from(keyB64, 'base64url').length).toBe(KEY_LENGTH)
  })
})
