/**
 * 16G Final: Responsive catalog action UX — accessibility-correct interaction
 * model. Desktop uses a plain CSS hover/focus-within reveal with NO popup
 * semantics (so there is no ARIA state to disagree with reality); mobile/tablet
 * uses a real ARIA Disclosure popup whose panel is genuinely mounted/unmounted,
 * so aria-expanded always matches whether its controls actually exist. Pure
 * structural/source checks — this codebase's established pattern for
 * customer-facing component correctness.
 */
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

const cardSrc = readSrc('src/components/store/ListingCard.tsx')
const actionsSrc = readSrc('src/components/store/CatalogActions.tsx')
// 16L: wantAction/unwantAction/addToCollectionAction bodies relocated verbatim to
// this dedicated module-level "use server" file (required so the Client Component
// CaptureCandidateActions.tsx can invoke them directly) — re-exported unchanged
// from CatalogActions.tsx. Tests that inspect the actual function bodies read from
// here; tests that inspect the JSX component still read actionsSrc.
const domainActionsSrc = readSrc('src/lib/actions/catalogModelDomainActions.ts')
const popupSrc = readSrc('src/components/store/CatalogActionsPopup.tsx')
const pendingSrc = readSrc('src/components/store/PendingActionButton.tsx')
const browseSrc = readSrc('src/app/(store)/browse/page.tsx')
const marketSrc = readSrc('src/app/(store)/market/page.tsx')

const popupCode = stripComments(popupSrc)
const actionsCode = stripComments(actionsSrc)

describe('16G Final: closed mobile popup — genuine unmount, never opacity-only', () => {
  it('CatalogActionsPopup conditionally RENDERS the panel ({open && (...)}) — closed-state controls are not in the DOM at all, so they cannot be tabbed into', () => {
    expect(popupSrc).toContain('{open && (')
  })

  it('the panel is not merely opacity/pointer-events hidden — no opacity-0 / pointer-events-none pattern remains in the popup', () => {
    expect(popupSrc).not.toMatch(/opacity-0/)
    expect(popupSrc).not.toMatch(/pointer-events-none/)
  })

  it('the old CatalogActionsMenu.tsx (opacity-only fake-closed popup) no longer exists', () => {
    expect(fs.existsSync(path.join(root, 'src/components/store/CatalogActionsMenu.tsx'))).toBe(false)
  })
})

describe('16G Final: aria-expanded always matches the real mount/interactive state', () => {
  it('aria-expanded is bound to the exact same `open` state variable that gates the conditional render — one source of truth, never two', () => {
    expect(popupSrc).toContain('const [open, setOpen] = useState(false)')
    expect(popupSrc).toContain('aria-expanded={open}')
    expect(popupSrc).toContain('{open && (')
  })

  it('the desktop tray makes no aria-expanded (or any open/closed) claim at all — it is not a popup, so there is nothing for an ARIA attribute to contradict', () => {
    const desktopIdx = actionsSrc.indexOf('hidden md:flex')
    const desktopLine = actionsSrc.slice(desktopIdx - 20, desktopIdx + 200)
    expect(desktopLine).not.toContain('aria-expanded')
    expect(desktopLine).not.toContain('aria-haspopup')
  })
})

describe('16G Final: role="menu"/"menuitem" removed — ordinary link/button semantics only', () => {
  it('neither CatalogActionsPopup nor CatalogActions uses role="menu" or role="menuitem"', () => {
    expect(popupCode).not.toMatch(/role="menu"/)
    expect(popupCode).not.toMatch(/role="menuitem"/)
    expect(actionsCode).not.toMatch(/role="menu"/)
    expect(actionsCode).not.toMatch(/role="menuitem"/)
  })

  it('no aria-haspopup="menu" claim remains — this is an ARIA Disclosure (show/hide) pattern, not a menu button', () => {
    expect(popupCode).not.toContain('aria-haspopup')
  })

  it('the popup trigger uses the correct Disclosure pattern: aria-expanded + aria-controls pointing at the panel\'s own id', () => {
    expect(popupSrc).toContain('aria-controls={panelId}')
    expect(popupSrc).toContain('id={panelId}')
    expect(popupSrc).toContain('useId()')
  })

  it('menu items are ordinary semantic elements (Link -> <a>, PendingActionButton -> <button>), relying on native roles, not an explicit ARIA role override', () => {
    expect(actionsCode).not.toMatch(/role="menuitem"/)
  })
})

describe('16G Final: desktop keyboard access — no invisible focus stop, no hover requirement', () => {
  const desktopDivIdx = actionsSrc.indexOf('<div className="hidden md:flex')
  const desktopBlock = actionsSrc.slice(desktopDivIdx, actionsSrc.indexOf('</div>', desktopDivIdx))
  const desktopOpenTag = actionsSrc.slice(desktopDivIdx, actionsSrc.indexOf('>', desktopDivIdx))

  it('SecondaryActions is rendered unconditionally inside the desktop tray (no `open &&`/state gate) — always in the natural tab sequence', () => {
    expect(desktopDivIdx).toBeGreaterThan(-1)
    expect(desktopBlock).toContain('<SecondaryActions')
    expect(desktopBlock).not.toContain('{open')
  })

  it('the desktop tray reveals on both hover AND keyboard focus-within — visible mouse behavior and keyboard behavior are identical', () => {
    expect(desktopOpenTag).toContain('group-hover:opacity-100')
    expect(desktopOpenTag).toContain('group-focus-within:opacity-100')
  })

  it('moving the mouse away hides the tray visually, but focus-within keeps it visible while focus remains inside — a focused control is never hidden out from under the user', () => {
    expect(desktopOpenTag).toContain('opacity-0') // default (unhovered, unfocused) state
    expect(desktopOpenTag).toContain('group-focus-within:opacity-100') // overrides default while focus is inside
  })

  it('visible focus rings exist on every persistent and secondary control', () => {
    expect(actionsSrc.match(/focus-visible:outline/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
    expect(popupSrc).toContain('focus-visible:outline')
  })
})

describe('16G Final: mobile trigger — keyboard-operable, no hover dependency', () => {
  it('the trigger is a real <button type="button"> with onClick — operable by keyboard Enter/Space natively, no mouseenter/mouseover handler anywhere', () => {
    expect(popupSrc).toContain('type="button"')
    expect(popupSrc).toContain('onClick={() => setOpen((o) => !o)}')
    expect(popupSrc).not.toMatch(/onMouseEnter|onMouseOver/)
  })

  it('no window.innerWidth / resize-listener breakpoint detection was introduced — CSS (hidden md:flex / md:hidden) chooses presentation, not JS', () => {
    for (const src of [cardSrc, actionsSrc, popupSrc, pendingSrc]) {
      expect(src).not.toMatch(/window\.innerWidth|addEventListener\('resize'/)
    }
    expect(actionsSrc).toContain('hidden md:flex')
    expect(actionsSrc).toContain('md:hidden')
  })
})

describe('16G Final: Escape closes the popup and restores focus to the trigger', () => {
  it('Escape sets open=false and explicitly refocuses the trigger button — focus is never dropped to <body> after the panel unmounts', () => {
    const idx = popupSrc.indexOf("e.key === 'Escape'")
    const block = popupSrc.slice(idx, idx + 250)
    expect(block).toContain('setOpen(false)')
    expect(block).toContain('triggerRef.current?.focus()')
  })

  it('outside click (mousedown + touchstart) also closes the popup', () => {
    expect(popupSrc).toContain("addEventListener('mousedown'")
    expect(popupSrc).toContain("addEventListener('touchstart'")
  })

  it('document listeners are only attached while open — no stray global listeners when the popup is closed', () => {
    const effectIdx = popupSrc.indexOf('useEffect(() => {')
    const effectBlock = popupSrc.slice(effectIdx, effectIdx + 120)
    expect(effectBlock).toContain('if (!open) return')
  })
})

describe('16G Final: PendingActionButton stays presentation-only', () => {
  it('disables only itself via useFormStatus, no shared/global pending state', () => {
    expect(pendingSrc).toContain('useFormStatus')
    expect(pendingSrc).toContain('disabled={pending}')
    expect(pendingSrc).not.toMatch(/useContext|zustand|redux/i)
  })

  it('no optimistic Wanted/Collection domain state — no useState/useOptimistic in CatalogActions or PendingActionButton', () => {
    expect(actionsSrc).not.toMatch(/useState|useOptimistic/)
    expect(pendingSrc).not.toMatch(/useState|useOptimistic/)
  })
})

describe('16G Final: /market has no relationship UI and no empty reserved space', () => {
  it('CatalogActions only renders when catalogModelId is supplied — /market call sites supply neither prop', () => {
    expect(cardSrc).toContain('{catalogModelId && (')
    const calls = [...marketSrc.matchAll(/<ListingCard[\s\S]*?\/>/g)]
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call[0]).not.toContain('catalogModelId')
      expect(call[0]).not.toContain('relationship')
    }
  })

  it('no relationship query was added to /market', () => {
    expect(marketSrc).not.toMatch(/catalogRelationshipQuery|getCatalogRelationshipState/)
  })
})

describe('16G Final: zero new server queries / domain changes', () => {
  it('none of the presentation files import prisma, fetch, or make an API call', () => {
    for (const src of [cardSrc, actionsSrc, popupSrc, pendingSrc]) {
      expect(src).not.toMatch(/from '@\/lib\/prisma'|\bfetch\(|XMLHttpRequest/)
    }
  })

  it('browse/page.tsx still calls getCatalogRelationshipState exactly once, with the same two findMany call sites as before (listings + brand dropdown)', () => {
    const relMatches = [...browseSrc.matchAll(/getCatalogRelationshipState\(/g)]
    expect(relMatches.length).toBe(1)
    const findManyMatches = [...browseSrc.matchAll(/prisma\.\w+\.findMany\(/g)]
    expect(findManyMatches.length).toBe(2)
  })

  it('no schema/migration/domain-action file carries a 16G marker — this pass is presentation-only', () => {
    for (const rel of [
      'src/lib/actions/sellerSubmissions.ts',
      'src/lib/actions/collectionItems.ts',
      'src/lib/actions/wantedList.ts',
      'src/lib/catalogRelationshipQuery.ts',
    ]) {
      expect(readSrc(rel)).not.toMatch(/16G/)
    }
  })
})

describe('16G Final: regression — Want/Collection/Sell/Buy mutation semantics unchanged', () => {
  it('Want/Unwant/Add-to-Collection still call the same authoritative actions with the same field injection', () => {
    expect(domainActionsSrc).toContain("import { addToWantedList, removeFromWantedList } from '@/lib/actions/wantedList'")
    expect(domainActionsSrc).toContain("import { createCollectionItem } from '@/lib/actions/collectionItems'")
    const wantFnIdx = domainActionsSrc.indexOf('async function wantAction')
    const wantFnSrc = domainActionsSrc.slice(wantFnIdx, domainActionsSrc.indexOf('\n}', wantFnIdx))
    expect(wantFnSrc).toContain("formData.set('catalogModelId', catalogModelId)")
    expect(wantFnSrc).toContain('await addToWantedList(null, formData)')
  })

  it('Own N link and Sell One routing (owned vs unrecorded) are unchanged', () => {
    expect(actionsSrc).toContain('✓ Own')
    expect(actionsSrc).toContain('/account/collection/${collectionItemId}/sell')
    expect(actionsSrc).toContain('/account/sell/new?catalogId=${encodeURIComponent(catalogModelId)}')
  })

  it('Buy (AddToCartButton) remains outside CatalogActions entirely, unconditionally rendered', () => {
    const cartIdx = cardSrc.indexOf('<AddToCartButton')
    const actionsIdx = cardSrc.indexOf('<CatalogActions')
    expect(cartIdx).toBeGreaterThan(-1)
    expect(cartIdx).toBeLessThan(actionsIdx)
  })

  it('anonymous behavior is preserved in both the desktop tray and the mobile popup — SecondaryActions renders sign-in links for both when relationship is null', () => {
    expect(actionsSrc).toContain('if (!isAuthenticated) {')
    const fnIdx = actionsSrc.indexOf('function SecondaryActions')
    const fnSrc = actionsSrc.slice(fnIdx, actionsSrc.indexOf('function CatalogActions'))
    expect(fnSrc).toContain('Sign in to add')
    expect(fnSrc).toContain('Sign in to sell')
  })

  it('duplicate Listing cards for the same model still receive identical relationship data — CatalogActions/SecondaryActions have no fetching/caching of their own', () => {
    expect(actionsSrc).not.toMatch(/useEffect/)
  })
})

// ── 16G Final Test Coverage Reconciliation: restore genuinely-lost coverage ──────
// (Part 1/3 of the reconciliation pass — see report. These assert facts that were
// TRUE and TESTED before the accessibility rewrite and remain true after it; they
// are not re-assertions of the intentionally-removed opacity-hidden-popup/
// role="menu"/mixed hover-open-ARIA behaviors.)

describe('16G Final Reconciliation: ListingCard structure the responsive reveal depends on', () => {
  it('ListingCard\'s outer wrapper actually carries the `group` class the desktop tray\'s group-hover/group-focus-within depend on', () => {
    expect(cardSrc).toContain('<div className="group rounded-lg')
  })

  it('the model Link and the footer (AddToCartButton + CatalogActions) remain siblings, never nested — no button-inside-anchor', () => {
    const linkIdx = cardSrc.indexOf('<Link href={`/browse/${listing.id}`}')
    const linkCloseIdx = cardSrc.indexOf('</Link>', linkIdx)
    const insideLink = cardSrc.slice(linkIdx, linkCloseIdx)
    expect(insideLink).not.toContain('<CatalogActions')
    expect(insideLink).not.toContain('<AddToCartButton')
  })

  it('overflow-hidden lives only on the image wrapper (rounded-t-lg) — the outer card does not clip the popup panel', () => {
    const outerIdx = cardSrc.indexOf('<div className="group rounded-lg')
    const outerLine = cardSrc.slice(outerIdx, cardSrc.indexOf('\n', outerIdx))
    expect(outerLine).not.toContain('overflow-hidden')
    expect(cardSrc).toContain('aspect-square overflow-hidden rounded-t-lg relative')
  })
})

describe('16G Final Reconciliation: CatalogActionsPopup nesting and client-state facts', () => {
  it('CatalogActionsPopup\'s trigger/panel Links and forms are never nested inside another <a>/<Link>', () => {
    expect(popupSrc).not.toContain('<Link')
    expect(popupSrc).not.toContain('<a ')
  })

  it('CatalogActionsPopup is a real Client Component with its own interactive state — not a CSS-only construct', () => {
    expect(popupSrc).toContain("'use client'")
    expect(popupSrc).toContain('useState')
  })

  it('the popup trigger\'s accessible label includes model context, passed through from CatalogActions', () => {
    expect(actionsSrc).toContain('triggerLabel={`More actions for ${modelName}`}')
    expect(popupSrc).toContain('aria-label={triggerLabel}')
  })

  it('no clickable <div> stands in for a real interactive element anywhere in the tray/popup', () => {
    expect(actionsSrc).not.toMatch(/<div[^>]*onClick/)
    expect(popupSrc.match(/onClick/g)?.length).toBe(1) // only the trigger <button>'s onClick
  })
})

describe('16G Final Reconciliation: accessible-name plumbing and PendingActionButton usage sites', () => {
  it('Want, Unwant, and Add to Collection each render through PendingActionButton with an explicit ariaLabel prop (not left to default text)', () => {
    const wantFormIdx = actionsSrc.indexOf('wantAction.bind(null, catalogModelId)')
    const wantBlock = actionsSrc.slice(wantFormIdx - 50, wantFormIdx + 350)
    expect(wantBlock).toContain('PendingActionButton')
    expect(wantBlock).toContain('ariaLabel={`Want ${modelName}`}')

    const unwantFormIdx = actionsSrc.indexOf('unwantAction.bind')
    const unwantBlock = actionsSrc.slice(unwantFormIdx - 50, unwantFormIdx + 350)
    expect(unwantBlock).toContain('PendingActionButton')
    expect(unwantBlock).toContain('ariaLabel={`Remove ${modelName} from Wanted`}')

    const addFormIdx = actionsSrc.indexOf('addToCollectionAction.bind')
    const addBlock = actionsSrc.slice(addFormIdx - 50, addFormIdx + 350)
    expect(addBlock).toContain('PendingActionButton')
    expect(addBlock).toContain('ariaLabel={`Add ${modelName} to Collection`}')
  })

  it('PendingActionButton actually forwards its ariaLabel prop to the real DOM aria-label attribute', () => {
    expect(pendingSrc).toContain('aria-label={ariaLabel}')
  })
})

describe('16G Final Reconciliation: domain-regression facts specific to addToCollectionAction and scope guard', () => {
  it('addToCollectionAction still sets catalogId and calls the unchanged createCollectionItem(null, formData) — quantity/redirect behavior stays inside that untouched action', () => {
    const fnIdx = domainActionsSrc.indexOf('async function addToCollectionAction')
    const fnSrc = domainActionsSrc.slice(fnIdx, domainActionsSrc.indexOf('\n}', fnIdx))
    expect(fnSrc).toContain("formData.set('catalogId', catalogModelId)")
    expect(fnSrc).toContain('await createCollectionItem(null, formData)')
  })

  it('CatalogActions calls no matching engine (matchWantedList) or valuation helper — scope guard unchanged', () => {
    expect(actionsSrc).not.toMatch(/matchWantedList|getCatalogValuation/)
  })
})

describe('16G Final Reconciliation: authenticated relationship states can still combine independently', () => {
  it('the Want branch and the owned-status badge are sibling conditionals, not mutually exclusive — a model can show BOTH ♥ Wanted and ✓ Own N at once', () => {
    const wantedTernaryIdx = actionsSrc.indexOf('wanted ? (')
    const ownedGuardIdx = actionsSrc.indexOf('isAuthenticated && collectionItemId && (')
    expect(wantedTernaryIdx).toBeGreaterThan(-1)
    expect(ownedGuardIdx).toBeGreaterThan(-1)
    expect(ownedGuardIdx).toBeGreaterThan(wantedTernaryIdx) // sibling, not nested inside the want ternary
  })

  it('"Add to Collection" only renders (in either the desktop tray or mobile popup) when NOT owned — never shown alongside the owned badge', () => {
    expect(actionsSrc).toContain('{!collectionItemId && (')
  })

  it('Want/owned-badge remain persistent OUTSIDE SecondaryActions — never duplicated inside the desktop tray or mobile popup content', () => {
    const fnIdx = actionsSrc.indexOf('function SecondaryActions')
    const fnEnd = actionsSrc.indexOf('\n}', actionsSrc.indexOf('return (', fnIdx))
    const fnSrc = actionsSrc.slice(fnIdx, fnEnd)
    expect(fnSrc).not.toContain('♥ Wanted')
    expect(fnSrc).not.toContain('♡ Want')
    expect(fnSrc).not.toContain('✓ Own')
  })
})

describe('16G Final Reconciliation: no layout shift when the popup opens', () => {
  it('the popup panel is position:absolute, so mounting/unmounting it never pushes surrounding card content', () => {
    const panelIdx = popupSrc.indexOf('id={panelId}')
    const panelClassIdx = popupSrc.indexOf('className=', panelIdx)
    const panelClassLine = popupSrc.slice(panelClassIdx, popupSrc.indexOf('\n', panelClassIdx))
    expect(panelClassLine).toContain('absolute')
  })

  it('the desktop tray is always rendered (unconditional), so its reserved space never appears/disappears either', () => {
    const desktopDivIdx = actionsSrc.indexOf('<div className="hidden md:flex')
    expect(desktopDivIdx).toBeGreaterThan(-1)
    expect(actionsSrc.slice(desktopDivIdx, actionsSrc.indexOf('>', desktopDivIdx))).not.toMatch(/\{.*&&/)
  })
})
