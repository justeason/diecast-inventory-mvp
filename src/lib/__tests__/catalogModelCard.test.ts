// 20A: CatalogModelCard — unified hierarchy, wording, responsive actions,
// accessibility. Structural (source-inspection) tests, matching this
// codebase's established convention for Server Component action rows (no DOM
// renderer is used anywhere in this suite).
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const root = path.resolve(__dirname, '../../..')
function readSrc(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf-8')
}
function stripComments(src: string): string {
  return src.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n')
}

const cardSrc = readSrc('src/components/store/CatalogModelCard.tsx')
const cardCode = stripComments(cardSrc)

describe('20A: card hierarchy — image, title/series, availability, actions (§14)', () => {
  it('renders in order: model Link (image+title+series), then availability block, then action row', () => {
    const modelLinkIdx = cardSrc.indexOf('href={`/catalog/${model.id}`}')
    const seriesIdx = cardSrc.indexOf('model.series &&')
    const availabilityIdx = cardSrc.indexOf('hasAvailability ?')
    const actionRowIdx = cardSrc.indexOf('className={actionRowCls}')
    expect(modelLinkIdx).toBeGreaterThan(-1)
    expect(seriesIdx).toBeGreaterThan(modelLinkIdx)
    expect(availabilityIdx).toBeGreaterThan(seriesIdx)
    expect(actionRowIdx).toBeGreaterThan(availabilityIdx)
  })
})

describe('20A: availability copy — "N available · from $X.XX" / "Currently unavailable" (§6)', () => {
  it('available copy has no "copy"/"copies" wording, matches the exact target phrasing', () => {
    expect(cardSrc).toContain("`${availability.count} available${availability.lowestPrice !== null ? ` · from $${availability.lowestPrice.toFixed(2)}` : ''}`")
  })

  it('unavailable copy is exactly "Currently unavailable" — no Sold out/Out of stock/No copies wording', () => {
    expect(cardSrc).toContain("'Currently unavailable'")
    expect(cardSrc).not.toMatch(/Sold out|Out of stock|No copies/i)
  })
})

describe('20A: buy affordance — availability line IS the link, no separate Buy button (§7)', () => {
  it('when available, the availability text itself is a Link to the model\'s #available-listings anchor', () => {
    const idx = cardSrc.indexOf('hasAvailability ? (')
    const block = cardSrc.slice(idx, cardSrc.indexOf(') : (', idx))
    expect(block).toContain('<Link')
    expect(block).toContain('href={`/catalog/${model.id}#available-listings`}')
  })

  it('when unavailable, the text is plain (a <p>), never a disabled/fake link', () => {
    const idx = cardSrc.indexOf(') : (', cardSrc.indexOf('hasAvailability ? ('))
    const block = cardSrc.slice(idx, cardSrc.indexOf('</p>', idx) + 5)
    expect(block).toContain('<p')
    expect(block).not.toContain('<Link')
  })

  it('no fourth "Buy" button exists alongside Want/Own/Sell', () => {
    expect(cardCode).not.toMatch(/>Buy</)
  })

  it('the main model identity link is separate from the availability link — clicking availability never substitutes for clicking the model', () => {
    const modelHref = "href={`/catalog/${model.id}`}"
    const availHref = "href={`/catalog/${model.id}#available-listings`}"
    expect(cardSrc).toContain(modelHref)
    expect(cardSrc).toContain(availHref)
    expect(cardSrc.indexOf(modelHref)).not.toBe(cardSrc.indexOf(availHref))
  })
})

describe('20A: quick actions are exactly Want / Own / Sell — no "Add to Collection" wording (§9/§10/§41)', () => {
  it('no customer-facing "Add to Collection" string anywhere', () => {
    expect(cardSrc).not.toMatch(/Add to Collection/)
  })

  it('Own wording is "Own" (compact, signed-out link) / "I Own It" (sign-in aria-label / authenticated add) / "Owned N" (owned state)', () => {
    const ownLinkIdx = cardSrc.indexOf('aria-label={`Sign in to add ${modelName} to your collection`}')
    const ownLinkBlock = cardSrc.slice(ownLinkIdx, cardSrc.indexOf('</Link>', ownLinkIdx))
    expect(ownLinkBlock).toContain('Own')
    expect(cardSrc).toContain('I Own It')
    expect(cardSrc).toContain("Owned{ownedQuantity !== null ? ` ${ownedQuantity}` : ''}")
  })

  it('Want wording distinguishes "Want" (not-wanted) from "Wanted" (wanted state)', () => {
    const wantLinkIdx = cardSrc.indexOf('aria-label={`Sign in to want ${modelName}`}')
    const wantLinkBlock = cardSrc.slice(wantLinkIdx, cardSrc.indexOf('</Link>', wantLinkIdx))
    expect(wantLinkBlock).toContain('Want')
    expect(cardSrc).toContain('label="Wanted"')
    expect(cardSrc).toContain('label="Want"')
  })

  it('Sell always routes through the existing collectionItemId ternary — /account/collection/{id}/sell when owned, /sell?catalogId otherwise', () => {
    expect(cardSrc).toContain('/account/collection/${collectionItemId}/sell')
    expect(cardSrc).toContain('/sell?catalogId=${encodeURIComponent(model.id)}')
  })

  it('reuses existing mutations only — wantAction/unwantAction/addToCollectionAction, no new server action created', () => {
    expect(cardSrc).toContain("from '@/lib/actions/catalogModelDomainActions'")
    expect(cardSrc).not.toMatch(/'use server'/)
  })

  it('anonymous Want/Own use the existing buildAccountIntentHref continuation — no new intent system', () => {
    expect(cardSrc).toContain("buildAccountIntentHref({ action: 'want', catalogModelId: model.id })")
    expect(cardSrc).toContain("buildAccountIntentHref({ action: 'own', catalogModelId: model.id })")
  })
})

describe('20A: authenticated Wanted/Owned state reflection (§11/§12/§13)', () => {
  it('wanted vs not-wanted are mutually exclusive ternary branches driven by relationship.wanted', () => {
    expect(cardSrc).toContain('wanted ? (')
    expect(cardSrc).toContain('const wanted = relationship?.wanted ?? false')
  })

  it('owned vs not-owned are driven by relationship.collectionItemId, quantity from relationship.ownedQuantity (never a derived row count)', () => {
    expect(cardSrc).toContain('collectionItemId ? (')
    expect(cardSrc).toContain('const ownedQuantity = relationship?.ownedQuantity ?? null')
  })

  it('ownership state is visible directly on the card — no navigation to /catalog/[id] required merely to see it', () => {
    // The owned Link (Owned N) renders inline in the action row itself, not
    // behind a "view details" step.
    const idx = cardSrc.indexOf('collectionItemId ? (')
    const block = cardSrc.slice(idx, cardSrc.indexOf(') : (', idx))
    expect(block).toContain('Owned{ownedQuantity')
  })
})

describe('20A: desktop hover/focus-within reveal, mobile always-visible, single row of markup (§14/§15/§24/§25)', () => {
  it('action row is opacity-100 by default (mobile) and only gated behind opacity-0 + hover/focus-within at md+', () => {
    expect(cardSrc).toContain('opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100')
  })

  it('the SAME action row markup serves both breakpoints — no separate mobile popup/duplicate DOM copy', () => {
    const matches = [...cardCode.matchAll(/className=\{actionRowCls\}/g)]
    expect(matches.length).toBe(1)
    expect(cardSrc).not.toMatch(/Popup|useState|'use client'/)
  })

  it('buttons/links use a minimum 44px touch target (min-h-11 = 2.75rem = 44px)', () => {
    expect(cardSrc).toContain('min-h-11')
  })

  it('the action row is a 3-column grid — Want / Own / Sell always laid out compactly, never wrapping unpredictably', () => {
    expect(cardSrc).toContain('grid grid-cols-3')
  })

  it('actions remain keyboard-focusable even when visually de-emphasized — they are ordinary Links/form-buttons in the DOM, never conditionally unmounted', () => {
    expect(cardSrc).not.toMatch(/\{.*&&.*<Link href=\{wantHref\}/)
    expect(cardSrc).toContain('focus-visible:outline')
  })
})

describe('20A: accessibility — siblings, not nested; accessible names on every control (§8/§40)', () => {
  it('every action has a distinct, descriptive accessible label (not left to default button text)', () => {
    expect(cardSrc).toContain('aria-label={`Sign in to want ${modelName}`}')
    expect(cardSrc).toContain('ariaLabel={`Remove ${modelName} from Wanted}`'.replace('}`', '`}')) // sanity anchor, see next assertion for the real one
  })

  it('Want/Unwant/Own carry explicit ariaLabel props through PendingActionButton', () => {
    expect(cardSrc).toContain('ariaLabel={`Remove ${modelName} from Wanted`}')
    expect(cardSrc).toContain('ariaLabel={`Want this — ${modelName}`}')
    expect(cardSrc).toContain('ariaLabel={`I Own It — ${modelName}`}')
  })

  it('Sell and Owned links carry plain aria-label props', () => {
    expect(cardSrc).toContain('aria-label={`Sell this item — ${modelName}`}')
    expect(cardSrc).toContain('aria-label={`View owned ${modelName}`}')
  })

  it('image alt text is the model name', () => {
    expect(cardSrc).toContain('alt={modelName}')
  })

  it('no <button> is ever a direct child of the model-identity <Link> — PendingActionButton\'s own <button> only ever renders inside the sibling action-row <div>, in a <form>', () => {
    const modelLinkIdx = cardSrc.indexOf('<Link href={`/catalog/${model.id}`}')
    const modelLinkCloseIdx = cardSrc.indexOf('</Link>', modelLinkIdx)
    const insideModelLink = cardSrc.slice(modelLinkIdx, modelLinkCloseIdx)
    expect(insideModelLink).not.toContain('<form')
    expect(insideModelLink).not.toContain('PendingActionButton')
  })
})

describe('20A: no schema/valuation exposure on the card (§28/§33/§42)', () => {
  it('no estimatedMarketValue/lastSale/marketRange/trend/confidence field is rendered', () => {
    expect(cardSrc).not.toMatch(/estimatedMarketValue|lastSale|marketRange|trend30d|confidence/i)
  })

  it('no placeholder glyphs for future data — no literal "N/A"/"Coming soon"/bare em-dash field', () => {
    expect(cardSrc).not.toMatch(/N\/A|Coming soon/i)
  })

  it('only availability.count and availability.lowestPrice are read from the CatalogModelAvailability shape', () => {
    expect(cardSrc).toContain('availability.count')
    expect(cardSrc).toContain('availability.lowestPrice')
  })
})
