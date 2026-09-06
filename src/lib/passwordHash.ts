import crypto from 'crypto'

// 19A: self-describing scrypt password hash. Node's crypto.scrypt is a built-in,
// memory-hard KDF — no bcrypt/argon2 native dependency (the prior Sharp/Vercel
// native-binary deployment problem is the reason to avoid that class of package
// here). NEVER reuse hashToken() (plain SHA-256) for passwords — that function
// hashes an already-high-entropy random token, not a low-entropy human password,
// and offers no memory-hardness against brute force.
//
// Encoding: scrypt$v1$N$r$p$saltB64url$keyB64url — every parameter needed to
// verify travels with the hash itself, so a future parameter upgrade (new N/r/p)
// can be introduced for newly-hashed passwords while existing stored hashes keep
// verifying correctly under their own original parameters. No schema column for
// N/r/p — they live only inside this one string.
const ALGO_TAG = 'scrypt'
const FORMAT_VERSION = 'v1'

// RFC 7914 "interactive" parameters: N=2^14, r=8, p=1 — targets a bounded,
// interactive-login-appropriate cost (see passwordHash.bench.ts for the measured
// local duration). Memory required is roughly 128 * N * r bytes = 16MiB, safely
// under Node's default scrypt maxmem (32MiB) — set explicitly below anyway so a
// future default change in Node can never silently break this.
export const SCRYPT_N = 16384
export const SCRYPT_R = 8
export const SCRYPT_P = 1
export const KEY_LENGTH = 64
const SALT_LENGTH = 16
const MAX_MEM = 64 * 1024 * 1024

function scryptAsync(password: string, salt: Buffer, keylen: number, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, { N, r, p, maxmem: MAX_MEM }, (err, derivedKey) => {
      if (err) reject(err)
      else resolve(derivedKey)
    })
  })
}

function toB64Url(buf: Buffer): string {
  return buf.toString('base64url')
}

// Password is passed through completely unmodified — no trimming, no case
// folding. Unicode/spaces/paste all flow through as the caller provided them.
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_LENGTH)
  const derivedKey = await scryptAsync(password, salt, KEY_LENGTH, SCRYPT_N, SCRYPT_R, SCRYPT_P)
  return [ALGO_TAG, FORMAT_VERSION, SCRYPT_N, SCRYPT_R, SCRYPT_P, toB64Url(salt), toB64Url(derivedKey)].join('$')
}

// passwordHash is STORED DATA — a corrupted or tampered row must never be able
// to make verification invoke crypto.scrypt with attacker-controlled cost or
// memory. So N/r/p/keyLength are never parsed as "any positive integer": each
// supported format VERSION maps to exactly one fixed, trusted-code parameter
// tuple, and the stored N/r/p must match that tuple's CANONICAL decimal string
// exactly (this also rejects non-canonical forms like "016384", "+16384",
// "1.6e4", "NaN", "Infinity" for free, since none of those string-equal the
// expected literal). A future parameter upgrade adds a new version key here
// deliberately — verification never widens to accept arbitrary stored values.
// maxmem (in scryptAsync above) is likewise always the fixed trusted-code
// constant, never derived from stored data.
const SUPPORTED_PARAMS: Record<string, { N: number; r: number; p: number; keyLength: number; saltLength: number }> = {
  [FORMAT_VERSION]: { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, keyLength: KEY_LENGTH, saltLength: SALT_LENGTH },
}

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/

// Parses and validates an encoded hash. Returns null for anything malformed —
// callers must treat null as "verification failed", never throw a raw parse
// error toward the caller (which could otherwise leak internal state via error
// messages or timing).
type ParsedHash = { N: number; r: number; p: number; keyLength: number; salt: Buffer; key: Buffer }

function parseEncodedHash(encoded: string): ParsedHash | null {
  if (typeof encoded !== 'string' || encoded.length === 0 || encoded.length > 512) return null

  const parts = encoded.split('$')
  if (parts.length !== 7) return null
  const [algo, version, nStr, rStr, pStr, saltB64, keyB64] = parts
  if (algo !== ALGO_TAG) return null

  const supported = SUPPORTED_PARAMS[version]
  if (!supported) return null
  if (nStr !== String(supported.N) || rStr !== String(supported.r) || pStr !== String(supported.p)) return null

  // Node's base64url Buffer decoding does NOT throw on invalid characters — it
  // silently ignores them and decodes whatever it can, so "!!!garbage!!!" would
  // otherwise decode to some small non-empty buffer instead of being rejected.
  // Strict format validation must happen on the STRING first.
  if (!BASE64URL_RE.test(saltB64) || !BASE64URL_RE.test(keyB64)) return null

  let salt: Buffer
  let key: Buffer
  try {
    salt = Buffer.from(saltB64, 'base64url')
    key = Buffer.from(keyB64, 'base64url')
  } catch {
    return null
  }
  // 19A Final Salt-Format Tightening: v1's generator always produces exactly
  // SALT_LENGTH bytes — accepting any other decoded length adds no legitimate
  // compatibility (there is no historical v1 hash with a different salt size)
  // and only widens the attack surface. A future salt-size change belongs to a
  // new supported version, not a widened range on this one.
  if (salt.length !== supported.saltLength) return null
  // keyLength is likewise the trusted tuple's fixed value, never the decoded
  // buffer's own length — a mismatch here is rejected before scrypt ever runs.
  if (key.length !== supported.keyLength) return null

  return { N: supported.N, r: supported.r, p: supported.p, keyLength: supported.keyLength, salt, key }
}

// Verifies a plaintext password against a stored encoded hash, deriving the
// candidate key using the TRUSTED parameter tuple resolved by parseEncodedHash
// (never raw stored integers) — this is what makes future parameter upgrades
// safe: an old hash keeps verifying under its own original supported version's
// tuple forever, while never accepting a tuple outside SUPPORTED_PARAMS.
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parsed = parseEncodedHash(encoded)
  if (!parsed) return false

  try {
    const candidateKey = await scryptAsync(password, parsed.salt, parsed.keyLength, parsed.N, parsed.r, parsed.p)
    if (candidateKey.length !== parsed.key.length) return false
    return crypto.timingSafeEqual(candidateKey, parsed.key)
  } catch {
    return false
  }
}

// Fixed, never-matching dummy hash for enumeration-timing resistance — computed
// once at module load (not per-request, not stored in the DB) using the SAME
// production parameters, so a lookup miss (unknown email/handle, or a profile
// with no CustomerCredential row) still pays the same scrypt cost as a real
// wrong-password check.
let dummyHashPromise: Promise<string> | null = null

export function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword('dummy-password-never-matches-any-real-account')
  }
  return dummyHashPromise
}
