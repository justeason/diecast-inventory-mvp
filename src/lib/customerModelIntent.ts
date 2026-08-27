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

// Open-redirect defense (Part M): never pass an untrusted `returnTo` string
// through to redirect()/href as-is. Requires the literal local prefix (rejects any
// scheme, host, protocol-relative "//", or backslash trick outright, since none of
// those can match this exact prefix), then extracts only the two fields we
// actually need and REBUILDS the URL via buildAccountIntentHref — so no stray
// byte sequence from the original string can survive into the final destination.
export function isSafeAccountReturnTo(raw: string | null | undefined): string | null {
  if (!raw || !raw.startsWith('/account/continue?')) return null
  const params = new URLSearchParams(raw.slice('/account/continue?'.length))
  const action = parseCustomerModelIntent(params.get('action'))
  const catalogModelId = params.get('catalogId')
  if (!action || !isSafeCatalogModelId(catalogModelId)) return null
  return buildAccountIntentHref({ action, catalogModelId })
}
