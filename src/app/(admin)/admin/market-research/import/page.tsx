import type { Metadata } from 'next'
import Link from 'next/link'
import { ImportForm } from '@/components/admin/market-research/ImportForm'

export const metadata: Metadata = { title: 'Import Market Data | Admin' }

export default function MarketResearchImportPage() {
  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <Link href="/admin/market-research" className="text-sm text-gray-500 hover:text-gray-900">
          ← Market Research
        </Link>
        <h1 className="text-2xl font-bold text-gray-900 mt-2">Import Market Data</h1>
      </div>

      <div className="mb-6 rounded-md border border-gray-100 bg-gray-50 px-4 py-3 text-xs text-gray-500 space-y-1">
        <p><strong>CSV format:</strong> UTF-8, comma-separated, first row is header.</p>
        <p><strong>Required columns:</strong> title, observation_type (sold/active_ask), price, currency, total_price</p>
        <p><strong>Optional columns:</strong> external_id, source_url (https:// only), shipping_price, sold_at, listed_at, observed_at, condition, location_text</p>
        <p>Duplicate rows (same fingerprint or provider+external_id) are skipped automatically.</p>
        <p>Observations must be matched to catalog models before they appear in buyer-facing pages.</p>
      </div>

      <ImportForm />
    </div>
  )
}
