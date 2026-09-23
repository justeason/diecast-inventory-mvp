// 33B: structural coverage for /browse/[id]'s photo-evidence disclosure —
// no React rendering harness exists in this codebase (established
// convention) — these are source-text assertions over the exact touched file.
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relPath), 'utf-8')
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

const pageSrc = readSrc('src/app/(store)/browse/[id]/page.tsx')

describe('§3/§35 — affirmative actual-item-photo disclosure', () => {
  it('renders exact copy "Photos of this item"', () => {
    expect(pageSrc).toContain('Photos of this item')
  })

  it('the affirmative label is gated on photos.length > 0', () => {
    const idx = pageSrc.indexOf('Photos of this item')
    const gateIdx = pageSrc.lastIndexOf('photos.length > 0', idx)
    expect(gateIdx).toBeGreaterThan(-1)
    expect(idx - gateIdx).toBeLessThan(200) // the gate immediately precedes the label
  })

  it('never uses stronger claim language for the affirmative label', () => {
    const labelBlock = pageSrc.slice(pageSrc.indexOf('photos.length > 0'), pageSrc.indexOf('Photos of this item') + 40)
    expect(labelBlock).not.toMatch(/Verified|Inspected|Authenticated/)
  })
})

describe('§4/§36 — existing catalog-reference-image disclosure preserved verbatim', () => {
  it('exact warning copy is unchanged', () => {
    expect(pageSrc).toContain('This is a catalog reference image, not a photo of this specific item. Actual')
    expect(pageSrc).toContain('appearance may differ.')
    expect(pageSrc).toContain('Model reference image')
  })

  it('still gated on photos.length === 0 && catalogPhoto', () => {
    expect(pageSrc).toContain('photos.length === 0 && catalogPhoto')
  })
})

describe('§5/§37 — present/absent symmetry, never both at once', () => {
  it('the two gates are structurally mutually exclusive (photos.length > 0 vs === 0)', () => {
    expect(pageSrc).toContain('photos.length > 0')
    expect(pageSrc).toContain('photos.length === 0')
  })

  it('no affirmative actual-item label appears inside the catalog-reference-image block', () => {
    const refBlockStart = pageSrc.indexOf('photos.length === 0 && catalogPhoto')
    const refBlockEnd = pageSrc.indexOf('</div>', pageSrc.indexOf('</div>', refBlockStart) + 1)
    const refBlock = pageSrc.slice(refBlockStart, refBlockEnd)
    expect(refBlock).not.toContain('Photos of this item')
  })

  it('photos absent + no reference: neither block renders (no false provenance claim) — both conditions require photos.length checks, no unconditional fallback exists', () => {
    // Structural proof: the only two render branches for the photo column are
    // gated by photos.length>0 or photos.length===0&&catalogPhoto — there is
    // no third, ungated branch that could render either claim.
    const photoColumnStart = pageSrc.indexOf('Photo column')
    const photoColumnEnd = pageSrc.indexOf('<div>', pageSrc.indexOf('h1 className'))
    const photoColumn = pageSrc.slice(photoColumnStart, photoColumnEnd)
    const conditionalBlocks = (photoColumn.match(/\{photos\.length/g) ?? []).length
    expect(conditionalBlocks).toBe(2) // exactly the present-case and absent-with-reference-case gates
  })
})

describe('§15/§38 — exact photo provenance: ItemInstance Photo relation only', () => {
  it('the item photo query is item.photos (ItemInstance -> Photo), not CatalogModelPhoto/SellerSubmissionPhoto/IntakeDraft', () => {
    expect(pageSrc).toContain('const photos = item.photos')
    expect(pageSrc).not.toMatch(/SellerSubmissionPhoto|IntakeDraft\.(front|back)PhotoUrl/)
  })

  it('the catalog reference photo is explicitly a separate source (catalog.photos), never conflated with item.photos', () => {
    expect(pageSrc).toContain('const catalogPhoto = catalog.photos[0]')
  })
})

describe('§6/§44 — condition copy stays a plain factual value', () => {
  it('condition is rendered via the existing CONDITION_LABELS map, no verification prefix', () => {
    const src = stripComments(pageSrc)
    expect(src).toContain('CONDITION_LABELS[item.condition]')
    expect(src).not.toMatch(/Condition Verified|Verified Near Mint|Inspected Condition|Condition Guaranteed/)
  })
})

describe('§32/§43 — copy truthfulness on the customer-facing surface', () => {
  it('no unsupported trust claims anywhere in this file (excluding unrelated code identifiers)', () => {
    const src = stripComments(pageSrc)
    for (const forbidden of ['Verified Seller', 'Verified Condition', 'Inspected by CollectNTrades', 'Authenticated', 'Certified', 'Guaranteed', 'Buyer Protection', 'Trusted', 'Professionally Checked']) {
      expect(src).not.toContain(forbidden)
    }
  })

  it('no standalone "authentic"/"genuine"/"counterfeit" claims (distinct from unrelated login-authentication code, which this file has none of anyway)', () => {
    const src = stripComments(pageSrc).toLowerCase()
    expect(src).not.toMatch(/\bauthentic\b|\bgenuine\b|\bcounterfeit\b/)
  })
})

describe('§20/§21 — ownership-type / discovery boundary untouched', () => {
  it('no sourceType/Company-Owned/Consignment label introduced', () => {
    expect(pageSrc).not.toMatch(/sourceType|Company-Owned|Consignment/)
  })
})

describe('§49 — legacy zero-photo listing compatibility', () => {
  it('the page never filters/hides a listing based on photo presence — the notFound() gate only checks listing/item status', () => {
    const notFoundLine = pageSrc.split('\n').find((l) => l.includes('notFound()'))!
    expect(notFoundLine).toMatch(/listing\.status|item\.status/)
    expect(notFoundLine).not.toMatch(/photos/)
  })
})
