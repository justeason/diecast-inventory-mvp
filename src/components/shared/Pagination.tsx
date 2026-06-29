import Link from 'next/link'

type Props = {
  page: number
  totalPages: number
  totalCount: number
  pageSize: number
  basePath: string
  params: Record<string, string>
}

function buildHref(basePath: string, params: Record<string, string>, targetPage: number): string {
  const p = new URLSearchParams(params)
  if (targetPage > 1) {
    p.set('page', String(targetPage))
  }
  const qs = p.toString()
  return qs ? `${basePath}?${qs}` : basePath
}

export function Pagination({ page, totalPages, totalCount, pageSize, basePath, params }: Props) {
  if (totalCount === 0) return null

  const startItem = (page - 1) * pageSize + 1
  const endItem = Math.min(page * pageSize, totalCount)

  return (
    <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-gray-500">
        Showing {startItem}–{endItem} of {totalCount}
      </p>
      {totalPages > 1 && (
        <div className="flex items-center gap-3">
          {page > 1 ? (
            <Link
              href={buildHref(basePath, params, page - 1)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
            >
              ← Previous
            </Link>
          ) : (
            <span className="rounded-md border border-gray-200 px-3 py-1.5 text-sm text-gray-300 select-none">
              ← Previous
            </span>
          )}
          <span className="text-sm text-gray-500">Page {page} of {totalPages}</span>
          {page < totalPages ? (
            <Link
              href={buildHref(basePath, params, page + 1)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
            >
              Next →
            </Link>
          ) : (
            <span className="rounded-md border border-gray-200 px-3 py-1.5 text-sm text-gray-300 select-none">
              Next →
            </span>
          )}
        </div>
      )}
    </div>
  )
}
