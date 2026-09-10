// 16M: one shared vocabulary for "anonymous customer wants to do X to CatalogModel Y"
// — used by every public action surface (Capture, Catalog hub, Browse) and by the
// authenticated continuation route/magic-link returnTo. Pure, no server-only
// imports, so it is safe to import from both Client and Server Components.

export type CustomerModelIntent = 'want' | 'own' | 'sell'

const VALID_INTENTS: readonly CustomerModelIntent[] = ['want', 'own', 'sell']

export function parseCustomerModelIntent(raw: string | null | undefined): CustomerModelIntent | null {
  if (!raw) return null
  return (VALID_INTENTS as readonly string[]).includes(raw) ? (raw as CustomerModelIntent) : null
}

// CatalogModel.id is a cuid() — this is a permissive character-class check (not an
// exact cuid validator). Its only job is to keep injection characters out of a URL
// we build ourselves; the database lookup remains the sole authority on whether the
// id is genuine.
const SAFE_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/

export function isSafeCatalogModelId(raw: string | null | undefined): raw is string {
  return typeof raw === 'string' && SAFE_ID_RE.test(raw)
}

// The one canonical destination for every anonymous model action.
export function buildAccountIntentHref({
  action,
  catalogModelId,
}: {
  action: CustomerModelIntent
  catalogModelId: string
}): string {
  const params = new URLSearchParams({ action, catalogId: catalogModelId })
  return `/account/continue?${params.toString()}`
}

// 19C: guest seller batch claim has no catalogModelId to carry (it's batch-wide,
// not model-relative), so it can't fit the /account/continue?action=&catalogId=
// shape above. Rather than retrofit that hardened, heavily-tested route with a
// "no specific model" mode, this is a second, CLOSED set of exact-literal
// destinations — same non-parameterized-fixed-string approach as PostVerifyMode
// below, just reusing the `returnTo` plumbing (already wired through password
// login, magic-link request/verify, AND account creation) instead of a third
// parallel intent channel. Exact string equality only — never a prefix/startsWith
// match — so no query string, trailing slash, or encoded trick can ride along.
const FIXED_SAFE_RETURN_TARGETS: ReadonlySet<string> = new Set(['/account/sell/claim'])

// Open-redirect defense (Part M): never pass an untrusted `returnTo` string
// through to redirect()/href as-is. Requires the literal local prefix (rejects any
// scheme, host, protocol-relative "//", or backslash trick outright, since none of
// those can match this exact prefix), then extracts only the two fields we
// actually need and REBUILDS the URL via buildAccountIntentHref — so no stray
// byte sequence from the original string can survive into the final destination.
export function isSafeAccountReturnTo(raw: string | null | undefined): string | null {
  if (!raw) return null
  if (FIXED_SAFE_RETURN_TARGETS.has(raw)) return raw
  if (!raw.startsWith('/account/continue?')) return null
  const params = new URLSearchParams(raw.slice('/account/continue?'.length))
  const action = parseCustomerModelIntent(params.get('action'))
  const catalogModelId = params.get('catalogId')
  if (!action || !isSafeCatalogModelId(catalogModelId)) return null
  return buildAccountIntentHref({ action, catalogModelId })
}

// 19A: a small, CLOSED set of post-verification destinations for the
// create-account and forgot-password flows — deliberately NOT a general
// returnTo. The value only ever selects one of these two fixed, hardcoded local
// paths; it can never carry an arbitrary destination, so tampering with it can
// at worst choose the other allowlisted page, never an open redirect.
export type PostVerifyMode = 'setup_password' | 'password_recovery'

const POST_VERIFY_DESTINATIONS: Record<PostVerifyMode, string> = {
  setup_password: '/account/profile?setupPassword=1',
  password_recovery: '/account/profile?passwordRecovery=1',
}

export function isAllowedPostVerify(raw: string | null | undefined): raw is PostVerifyMode {
  return raw === 'setup_password' || raw === 'password_recovery'
}

export function resolvePostVerifyDestination(raw: string | null | undefined): string | null {
  return isAllowedPostVerify(raw) ? POST_VERIFY_DESTINATIONS[raw] : null
}
