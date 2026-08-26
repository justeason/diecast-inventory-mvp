import type { Metadata } from 'next'
import { CaptureIdentify } from '@/components/store/CaptureIdentify'

export const metadata: Metadata = { title: 'Identify a Model | CollectNTrades' }

// 16K: public Quick Capture recognition entry point — no auth required. Distinct
// from /account/capture (the authenticated Quick Capture queue → Collection/Sell
// wizard, left unchanged). This route is identification only: it never creates a
// CollectionItem, WantedCatalogModel, SellerSubmission, or CustomerProfile record.
// Want/Own/Sell for a recognized model use the existing authenticated pathways on
// /catalog/[id] (CatalogModelActions), not a second implementation here.
export default function PublicCapturePage() {
  return (
    <div className="max-w-lg mx-auto py-4 px-4">
      <CaptureIdentify />
    </div>
  )
}
